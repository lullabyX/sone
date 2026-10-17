use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

pub struct ClientSession {
    pub device_id: String,
    pub tx: mpsc::Sender<Message>,
    pub session_id: Arc<RwLock<Option<String>>>,
    pub media_seq_no: AtomicU32,
    pub request_id: AtomicU32,
    pub position_secs: Arc<AtomicU32>,
    pub is_finished: Arc<AtomicBool>,
    pub has_media: Arc<AtomicBool>,
    pub current_media: Arc<RwLock<Option<serde_json::Value>>>,
}

#[derive(Clone)]
pub struct TidalConnectClient {
    session: Arc<RwLock<Option<ClientSession>>>,
    app_handle: Arc<StdRwLock<Option<tauri::AppHandle>>>,
    /// True while a LinkPlay push-URL cast is in flight. The reader task
    /// suppresses `tidal-connect:disconnected` while this is set so an idle
    /// WebSocket teardown (30 s receiver timeout) does not drop the cast in
    /// the frontend.
    cast_active: Arc<AtomicBool>,
}

impl TidalConnectClient {
    pub fn new() -> Self {
        Self {
            session: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(StdRwLock::new(None)),
            cast_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Flip the cast-activity flag that gates `tidal-connect:disconnected`.
    pub fn set_cast_active(&self, active: bool) {
        self.cast_active.store(active, Ordering::Relaxed);
    }

    pub fn cast_active(&self) -> bool {
        self.cast_active.load(Ordering::Relaxed)
    }

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        if let Ok(mut lock) = self.app_handle.write() {
            *lock = Some(handle);
        }
    }

    pub async fn is_connected(&self) -> bool {
        self.session.read().await.is_some()
    }

    pub async fn connected_device_id(&self) -> Option<String> {
        self.session.read().await.as_ref().map(|s| s.device_id.clone())
    }

    pub async fn connect(
        &self,
        device_id: &str,
        host: &str,
        port: u16,
        app: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
        // Quiet teardown: an in-flight session being replaced by a new one is
        // a transport re-establish, not a user-facing disconnect; the emitter
        // lives on the explicit `disconnect()` path only.
        self.teardown_session().await;

        if let Some(a) = app {
            if let Ok(mut lock) = self.app_handle.write() {
                *lock = Some(a);
            }
        }

        let url = format!("wss://{}:{}/", host, port);
        log::info!("Connecting to TIDAL Connect receiver at {}", url);

        let mut tls_builder = native_tls::TlsConnector::builder();
        tls_builder.danger_accept_invalid_certs(true);
        tls_builder.danger_accept_invalid_hostnames(true);
        let tls_connector = tls_builder
            .build()
            .map_err(|e| format!("Failed to build TLS connector: {}", e))?;
        let connector = Connector::NativeTls(tls_connector);

        let (ws_stream, response) = tokio_tungstenite::connect_async_tls_with_config(
            &url,
            None,
            false,
            Some(connector),
        )
        .await
        .map_err(|e| format!("WebSocket handshake failed to {}: {}", url, e))?;

        log::info!(
            "Connected to TIDAL Connect receiver. Handshake HTTP status: {}",
            response.status()
        );

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Message>(32);

        let session_id = Arc::new(RwLock::new(None));
        let session_id_clone = session_id.clone();
        let position_secs = Arc::new(AtomicU32::new(0));
        let position_secs_clone = position_secs.clone();
        let is_finished = Arc::new(AtomicBool::new(false));
        let is_finished_clone = is_finished.clone();
        let has_media = Arc::new(AtomicBool::new(false));
        let current_media = Arc::new(RwLock::new(None));
        let current_media_clone = current_media.clone();
        let tx_reader = tx.clone();
        let app_handle_clone = self.app_handle.clone();
        let session_clear = self.session.clone();

        // Writer task. Also emits a control-frame ping every 20 s: the
        // receiver historically tears down idle sessions, and outbound
        // activity keeps the channel alive.
        tokio::spawn(async move {
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
            keepalive.tick().await;
            loop {
                tokio::select! {
                    maybe_msg = rx.recv() => {
                        let Some(msg) = maybe_msg else { break };
                        if let Message::Text(text) = &msg {
                            log::debug!("TIDAL Connect send: {}", text);
                        }
                        if let Err(e) = write.send(msg).await {
                            log::error!("TIDAL Connect WebSocket write error: {}", e);
                            break;
                        }
                    }
                    _ = keepalive.tick() => {
                        if let Err(e) = write.send(Message::Ping(Default::default())).await {
                            log::error!("TIDAL Connect WebSocket keepalive error: {}", e);
                            break;
                        }
                    }
                }
            }
        });

        // Reader task
        let dev_id_clone = device_id.to_string();
        let cast_active_shared = Arc::clone(&self.cast_active);
        tokio::spawn(async move {
            // A98 firmware answers every new session with a single
            // notifyDeviceStatusChanged advertising the tisoc app layer's
            // stale volume (observed constant 0.11) regardless of the actual
            // audible LinkPlay volume register (httpapi `vol`). Trusting it
            // snapped the renderer's volume indicator down on every
            // skip/track switch because every push-URL cast re-establishes
            // the idle-closed WS session. Suppress that one advertisement;
            // later notifies are genuine mid-session hardware changes.
            let mut suppress_next_volume = false;
            while let Some(msg_res) = read.next().await {
                match msg_res {
                    Ok(Message::Text(text)) => {
                        log::info!("TIDAL Connect [{}] recv: {}", dev_id_clone, text);
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(cmd) = parsed.get("command").and_then(|c| c.as_str()) {
                                match cmd {
                                    "notifySessionStarted" | "startSession" => {
                                        if let Some(sid) = parsed.get("sessionId").and_then(|s| s.as_str()) {
                                            let mut lock = session_id_clone.write().await;
                                            *lock = Some(sid.to_string());
                                            log::info!("TIDAL Connect session active: {}", sid);
                                        }
                                        suppress_next_volume = true;
                                    }
                                    "notifyDeviceStatusChanged" => {
                                        if suppress_next_volume {
                                            suppress_next_volume = false;
                                            log::debug!(
                                                "TIDAL Connect [{}] suppressing session-start volume advertisement \
                                                 (A98 reports stale tisoc-app volume; LinkPlay register is authoritative)",
                                                dev_id_clone
                                            );
                                            continue;
                                        }
                                        if let Some(vol) = parsed.get("volume") {
                                            if let Some(lvl) = vol
                                                .get("level")
                                                .and_then(|l| l.as_f64().or_else(|| l.as_i64().map(|i| i as f64)))
                                            {
                                                let normalized = if lvl > 1.0 {
                                                    (lvl / 100.0).clamp(0.0, 1.0)
                                                } else {
                                                    lvl.clamp(0.0, 1.0)
                                                };
                                                log::info!(
                                                    "TIDAL Connect [{}] remote device status volume: {:.2}",
                                                    dev_id_clone,
                                                    normalized
                                                );
                                                let app_opt = app_handle_clone.read().ok().and_then(|g| g.clone());
                                                if let Some(app) = app_opt {
                                                    use tauri::Emitter;
                                                    let _ = app.emit("tidal-connect:volume", normalized);
                                                }
                                            }
                                        }
                                    }
                                    "notifySessionEnded" => {
                                        log::info!(
                                            "TIDAL Connect [{}] session ended by remote receiver",
                                            dev_id_clone
                                        );
                                    }
                                    "notifyPlayerStatusChanged" => {
                                        if let Some(prog) = parsed.get("progress").and_then(|p| p.as_f64().or_else(|| p.as_i64().map(|i| i as f64))) {
                                            position_secs_clone.store(prog as u32, Ordering::Relaxed);
                                        }
                                        if let Some(st) = parsed.get("playerState").and_then(|s| s.as_str()) {
                                            log::info!("TIDAL Connect remote player status: {}", st);
                                            if st == "COMPLETED" || st == "STOPPED" {
                                                is_finished_clone.store(true, Ordering::Relaxed);
                                            } else if st == "PLAYING" {
                                                is_finished_clone.store(false, Ordering::Relaxed);
                                            }
                                        }
                                    }
                                    "requestQueueItems" => {
                                        let queue_req_id = parsed
                                            .get("packet")
                                            .and_then(|p| p.get("queueRequestId"))
                                            .and_then(|r| r.as_u64())
                                            .or_else(|| parsed.get("queueRequestId").and_then(|r| r.as_u64()))
                                            .unwrap_or(0);

                                        let cur_media = current_media_clone.read().await.clone();
                                        let media_infos = if let Some(m) = cur_media {
                                            vec![m]
                                        } else {
                                            vec![]
                                        };

                                        let resp = json!({
                                            "command": "respondQueueItems",
                                            "packet": {
                                                "queueRequestId": queue_req_id,
                                                "mediaInfos": media_infos,
                                                "hasBegin": true,
                                                "hasEnd": true
                                            }
                                        });

                                        log::info!(
                                            "TIDAL Connect [{}] responding to requestQueueItems (queueRequestId={})",
                                            dev_id_clone,
                                            queue_req_id
                                        );
                                        let _ = tx_reader.send(Message::Text(resp.to_string())).await;
                                    }
                                    "notifyPlaybackError" => {
                                        log::warn!("TIDAL Connect remote error: {:?}", parsed);
                                    }
                                    _ => {
                                        log::debug!("TIDAL Connect unhandled event: {}", cmd);
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        log::info!("TIDAL Connect [{}] closed: {:?}", dev_id_clone, frame);
                        break;
                    }
                    // Reply to receiver pings: in a split stream tokio-tungstenite
                    // does not auto-pong, and an unanswered ping makes the
                    // receiver close the session after roughly 10 seconds.
                    Ok(Message::Ping(data)) => {
                        let _ = tx_reader.send(Message::Pong(data)).await;
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(_) => {}
                    Err(e) => {
                        log::warn!("TIDAL Connect [{}] read error: {}", dev_id_clone, e);
                        break;
                    }
                }
            }

            log::info!("TIDAL Connect [{}] reader loop terminated, clearing session", dev_id_clone);
            {
                let mut lock = session_clear.write().await;
                *lock = None;
            }
            let app_opt = app_handle_clone.read().ok().and_then(|g| g.clone());
            if let Some(app) = app_opt {
                use tauri::Emitter;
                // While a push-URL cast is active, an idle WebSocket teardown
                // must NOT reset the caster (the transport lives on the
                // LinkPlay side, not this session).
                let still_casting = cast_active_shared.load(Ordering::Relaxed);
                if !still_casting {
                    let _ = app.emit("tidal-connect:disconnected", ());
                } else {
                    log::info!(
                        "TIDAL Connect [{}] session idle-closed; push-URL cast continues",
                        dev_id_clone
                    );
                }
            }
        });

        let new_session = ClientSession {
            device_id: device_id.to_string(),
            tx: tx.clone(),
            session_id: session_id.clone(),
            media_seq_no: AtomicU32::new(1),
            request_id: AtomicU32::new(1),
            position_secs: position_secs.clone(),
            is_finished: is_finished.clone(),
            has_media: has_media.clone(),
            current_media: current_media.clone(),
        };

        // Send startSession handshake
        let start_cmd = json!({
            "command": "startSession",
            "appInfo": {
                "appId": "sone",
                "appName": "Sone",
                "sessionCredential": "sone-credential"
            }
        });

        tx.send(Message::Text(start_cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to dispatch startSession: {}", e))?;

        let mut lock = self.session.write().await;
        *lock = Some(new_session);

        Ok(())
    }

    /// Drop any live WS session without notifying the UI.
    ///
    /// Used by `connect_until_ok` housekeeping before establishing a new
    /// session (reconnect after the receiver idle-closes the previous one). A
    /// push-URL cast survives idle session closures, and emitting
    /// `tidal-connect:disconnected` here would reset the renderer's
    /// `activeDeviceAtom` to local mid-cast on EVERY skip or album switch.
    async fn teardown_session(&self) {
        let mut lock = self.session.write().await;
        if let Some(session) = lock.take() {
            let end_cmd = json!({
                "command": "endSession"
            });
            let _ = session.tx.send(Message::Text(end_cmd.to_string())).await;
        }
    }

    pub async fn disconnect(&self) {
        let was_device = self.connected_device_id().await;
        self.teardown_session().await;
        let app_opt = self.app_handle.read().ok().and_then(|g| g.clone());
        if let Some(app) = app_opt {
            use tauri::Emitter;
            log::info!(
                "TIDAL Connect session for {:?} ended; notifying UI of disconnect",
                was_device
            );
            let _ = app.emit("tidal-connect:disconnected", ());
        }
    }

    pub async fn has_media(&self) -> bool {
        let lock = self.session.read().await;
        if let Some(session) = lock.as_ref() {
            session.has_media.load(Ordering::Relaxed)
        } else {
            false
        }
    }

    pub async fn set_media(
        &self,
        track_id: u64,
        stream_url: &str,
        access_token: &str,
        refresh_token: &str,
        title: &str,
        artists: &[String],
        album_title: Option<&str>,
        duration_secs: u32,
    ) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;

        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);

        let media_item = json!({
            "itemId": track_id.to_string(),
            "mediaId": track_id.to_string(),
            "mediaType": 0,
            "srcUrl": stream_url,
            "metadata": {
                "title": title,
                "artists": artists,
                "albumTitle": album_title.unwrap_or(""),
                "duration": duration_secs
            }
        });

        // Cache the media item so requestQueueItems responses can supply it
        *session.current_media.write().await = Some(media_item.clone());

        let content_server_info = json!({
            "serverUrl": "https://api.tidal.com/v1",
            "headerAuth": format!("Bearer {}", access_token),
            "authInfo": {
                "headerAuth": format!("Bearer {}", access_token),
                "oauthServerInfo": {
                    "serverUrl": "https://auth.tidal.com/v1",
                    "authInfo": {
                        "headerAuth": format!("Bearer {}", access_token),
                        "oauthParameters": {
                            "accessToken": access_token,
                            "refreshToken": refresh_token
                        }
                    }
                }
            },
            "oauthServerInfo": {
                "serverUrl": "https://auth.tidal.com/v1",
                "authInfo": {
                    "headerAuth": format!("Bearer {}", access_token),
                    "oauthParameters": {
                        "accessToken": access_token,
                        "refreshToken": refresh_token
                    }
                }
            }
        });

        let queue_cmd = json!({
            "command": "loadLocalQueue",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "contentServerInfo": &content_server_info,
            "packet": {
                "contentServerInfo": content_server_info,
                "queueInfo": {
                    "queueId": format!("sone-{}", track_id),
                    "queueRequestId": req_id,
                    "repeatMode": "OFF",
                    "shuffled": false,
                    "maxBeforeSize": 0,
                    "maxAfterSize": 0,
                    "items": [ &media_item ]
                },
                "mediaInfos": [ &media_item ],
                "currentMediaInfo": media_item,
                "hasBegin": true,
                "hasEnd": true,
                "autoplay": true,
                "position": 0
            }
        });

        log::info!("TIDAL Connect dispatching loadLocalQueue for track {}", track_id);
        session
            .tx
            .send(Message::Text(queue_cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send loadLocalQueue: {}", e))?;

        session.has_media.store(true, Ordering::SeqCst);

        Ok(())
    }

    pub async fn play(&self) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;
        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);

        let cmd = json!({
            "command": "play",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "packet": {
                "requestId": req_id
            }
        });

        log::info!("TIDAL Connect dispatching play");
        session
            .tx
            .send(Message::Text(cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send play: {}", e))
    }

    pub async fn pause(&self) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;
        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);

        let cmd = json!({
            "command": "pause",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "packet": {
                "requestId": req_id
            }
        });

        log::info!("TIDAL Connect dispatching pause");
        session
            .tx
            .send(Message::Text(cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send pause: {}", e))
    }

    pub async fn stop(&self) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;
        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);

        let cmd = json!({
            "command": "stop",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "packet": {
                "requestId": req_id
            }
        });

        log::info!("TIDAL Connect dispatching stop");
        session
            .tx
            .send(Message::Text(cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send stop: {}", e))
    }

    pub async fn seek(&self, position_secs: f64) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;
        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);
        let pos_u32 = position_secs.max(0.0) as u32;

        let cmd = json!({
            "command": "seek",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "packet": {
                "position": pos_u32,
                "requestId": req_id
            },
            "position": pos_u32
        });

        log::info!("TIDAL Connect dispatching seek ({}s)", pos_u32);
        session
            .tx
            .send(Message::Text(cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send seek: {}", e))
    }

    pub async fn set_volume(&self, level: f64) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;
        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);
        let clamped = level.clamp(0.0, 1.0);

        let cmd = json!({
            "command": "setVolume",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "packet": {
                "level": clamped,
                "requestId": req_id
            }
        });

        log::info!("TIDAL Connect dispatching setVolume ({:.2})", clamped);
        session
            .tx
            .send(Message::Text(cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send setVolume: {}", e))
    }

    pub async fn set_mute(&self, mute: bool) -> Result<(), String> {
        let lock = self.session.read().await;
        let session = lock.as_ref().ok_or_else(|| "No active TIDAL Connect session".to_string())?;
        let seq = session.media_seq_no.fetch_add(1, Ordering::SeqCst);
        let req_id = session.request_id.fetch_add(1, Ordering::SeqCst);

        let cmd = json!({
            "command": "setMute",
            "mediaSeqNo": seq,
            "requestId": req_id,
            "packet": {
                "mute": mute,
                "requestId": req_id
            }
        });

        log::info!("TIDAL Connect dispatching setMute ({})", mute);
        session
            .tx
            .send(Message::Text(cmd.to_string()))
            .await
            .map_err(|e| format!("Failed to send setMute: {}", e))
    }

    pub async fn set_volume_mute(&self, volume: f64, mute: bool) -> Result<(), String> {
        self.set_volume(volume).await?;
        if mute {
            self.set_mute(true).await?;
        }
        Ok(())
    }

    pub async fn get_position(&self) -> f32 {
        let lock = self.session.read().await;
        if let Some(session) = lock.as_ref() {
            session.position_secs.load(Ordering::Relaxed) as f32
        } else {
            0.0
        }
    }

    pub async fn is_finished(&self) -> bool {
        let lock = self.session.read().await;
        if let Some(session) = lock.as_ref() {
            session.is_finished.load(Ordering::Relaxed)
        } else {
            false
        }
    }
}
