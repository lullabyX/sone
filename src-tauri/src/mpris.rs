use mpris_server::{LoopStatus, Metadata, PlaybackStatus, Player, Time, TrackId};
use std::rc::Rc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

pub enum MprisCommand {
    SetMetadata {
        track_id: u64,
        title: String,
        artist: String,
        album: String,
        art_url: String,
        duration_secs: f64,
        url: Option<String>,
        album_artist: Option<String>,
        track_number: Option<u32>,
        disc_number: Option<u32>,
        content_created: Option<String>,
        user_rating: Option<f64>,
    },
    SetPlaybackStatus {
        is_playing: bool,
    },
    SetVolume {
        volume: f64,
    },
    Seeked {
        position_secs: f64,
    },
    SetShuffle {
        enabled: bool,
    },
    SetLoopStatus {
        mode: u8,
    },
    SetFullscreen {
        fullscreen: bool,
    },
    Stop,
}

pub struct MprisHandle {
    tx: mpsc::UnboundedSender<MprisCommand>,
}

impl MprisHandle {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<MprisCommand>();

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to build MPRIS tokio runtime");

            let local = tokio::task::LocalSet::new();

            local.block_on(&rt, async move {
                let app_handle_for_tick = app_handle.clone();
                let player = match Player::builder("io.github.lullabyX.sone")
                    .can_play(true)
                    .can_pause(true)
                    .can_go_next(true)
                    .can_go_previous(true)
                    .can_seek(true)
                    .can_control(true)
                    .can_quit(true)
                    .can_raise(true)
                    .can_set_fullscreen(true)
                    .fullscreen(false)
                    .has_track_list(false)
                    .supported_uri_schemes(vec!["tidal".to_string()])
                    .supported_mime_types(vec![
                        "audio/flac".to_string(),
                        "audio/mpeg".to_string(),
                        "audio/mp4".to_string(),
                        "audio/x-m4a".to_string(),
                    ])
                    .rate(1.0)
                    .minimum_rate(1.0)
                    .maximum_rate(1.0)
                    .shuffle(false)
                    .loop_status(LoopStatus::None)
                    .build()
                    .await
                {
                    Ok(p) => Rc::new(p),
                    Err(e) => {
                        log::error!("Failed to build MPRIS player: {e}");
                        return;
                    }
                };

                // Identity + desktop entry so KDE/GNOME can associate with the window
                player.set_identity("SONE").await.ok();
                player
                    .set_desktop_entry("io.github.lullabyX.sone")
                    .await
                    .ok();

                // Wire control callbacks — reuse existing tray event system
                let app = app_handle.clone();
                player.connect_play_pause(move |_| {
                    app.emit("tray:toggle-play", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_play(move |_| {
                    app.emit("mpris:play", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_pause(move |_| {
                    app.emit("mpris:pause", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_stop(move |_| {
                    app.emit("mpris:stop", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_next(move |_| {
                    app.emit("tray:next-track", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_previous(move |_| {
                    app.emit("tray:prev-track", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_seek(move |_, offset| {
                    let offset_secs = offset.as_micros() as f64 / 1_000_000.0;
                    app.emit("mpris:seek", offset_secs).ok();
                });

                let app = app_handle.clone();
                player.connect_set_volume(move |_, volume| {
                    app.emit("mpris:set-volume", volume).ok();
                });

                let app = app_handle.clone();
                player.connect_set_shuffle(move |_, shuffle| {
                    app.emit("mpris:set-shuffle", shuffle).ok();
                });

                let app = app_handle.clone();
                player.connect_set_loop_status(move |_, status| {
                    let mode: u8 = match status {
                        LoopStatus::None => 0,
                        LoopStatus::Playlist => 1,
                        LoopStatus::Track => 2,
                    };
                    app.emit("mpris:set-loop-status", mode).ok();
                });

                let app = app_handle.clone();
                player.connect_raise(move |_| {
                    crate::tray::restore_window(&app);
                });

                let app = app_handle.clone();
                player.connect_quit(move |_| {
                    app.exit(0);
                });

                let app = app_handle.clone();
                player.connect_set_fullscreen(move |_, fullscreen| {
                    app.emit("mpris:set-fullscreen", fullscreen).ok();
                });

                player.connect_set_rate(move |_, _rate| {
                    // SONE plays at fixed 1.0×; MinimumRate=MaximumRate=1.0 advertises this.
                });

                let app = app_handle.clone();
                player.connect_open_uri(move |_, uri| {
                    app.emit("mpris:open-uri", uri).ok();
                });

                let app = app_handle.clone();
                player.connect_set_position(move |_, _track_id, position| {
                    let secs = position.as_micros() as f64 / 1_000_000.0;
                    app.emit("mpris:set-position", secs).ok();
                });

                // Run the D-Bus server in the background
                tokio::task::spawn_local(player.run());

                // Publish the live playback position to MPRIS so external media
                // widgets (Plasma, gnome-shell, KDE Connect) show an advancing
                // seek bar. The spec-mandated `Position` property is non-signaled,
                // so clients re-poll on UI updates or extrapolate from the last
                // value — either way they need a fresh anchor.
                let player_for_tick = Rc::clone(&player);
                tokio::task::spawn_local(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(1));
                    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
                    interval.tick().await; // skip immediate first tick
                    loop {
                        interval.tick().await;
                        if player_for_tick.playback_status() != PlaybackStatus::Playing {
                            continue;
                        }
                        let Some(state) = app_handle_for_tick.try_state::<crate::AppState>()
                        else {
                            continue;
                        };
                        if let Ok(secs) = state.audio_player.get_position() {
                            let micros = (secs as f64 * 1_000_000.0) as i64;
                            player_for_tick.set_position(Time::from_micros(micros));
                        }
                    }
                });

                log::info!("MPRIS D-Bus server started");

                // Process commands from the main app
                while let Some(cmd) = rx.recv().await {
                    match cmd {
                        MprisCommand::SetMetadata {
                            track_id,
                            title,
                            artist,
                            album,
                            art_url,
                            duration_secs,
                            url,
                            album_artist,
                            track_number,
                            disc_number,
                            content_created,
                            user_rating,
                        } => {
                            let mut metadata = Metadata::new();
                            let track_path =
                                format!("/org/mpris/MediaPlayer2/Track/{}", track_id);
                            if let Ok(tid) = TrackId::try_from(track_path.as_str()) {
                                metadata.set_trackid(Some(tid));
                            }
                            metadata.set_title(Some(&title));
                            metadata.set_artist(Some([&artist]));
                            metadata.set_album(Some(&album));
                            if !art_url.is_empty() {
                                metadata.set_art_url(Some(art_url));
                            }
                            metadata.set_length(Some(Time::from_micros(
                                (duration_secs * 1_000_000.0) as i64,
                            )));
                            if let Some(u) = url.filter(|s| !s.is_empty()) {
                                metadata.set_url(Some(u));
                            }
                            if let Some(aa) = album_artist.filter(|s| !s.is_empty()) {
                                metadata.set_album_artist(Some([aa]));
                            }
                            if let Some(n) = track_number {
                                metadata.set_track_number(Some(n as i32));
                            }
                            if let Some(n) = disc_number {
                                metadata.set_disc_number(Some(n as i32));
                            }
                            if let Some(d) = content_created.filter(|s| !s.is_empty()) {
                                metadata.set_content_created(Some(d));
                            }
                            if let Some(r) = user_rating {
                                metadata.set_user_rating(Some(r));
                            }
                            player.set_metadata(metadata).await.ok();
                            player.set_position(Time::ZERO);
                        }
                        MprisCommand::SetPlaybackStatus { is_playing } => {
                            let status = if is_playing {
                                PlaybackStatus::Playing
                            } else {
                                PlaybackStatus::Paused
                            };
                            player.set_playback_status(status).await.ok();
                        }
                        MprisCommand::SetVolume { volume } => {
                            player.set_volume(volume).await.ok();
                        }
                        MprisCommand::Seeked { position_secs } => {
                            let time = Time::from_micros((position_secs * 1_000_000.0) as i64);
                            player.set_position(time);
                            player.seeked(time).await.ok();
                        }
                        MprisCommand::SetShuffle { enabled } => {
                            player.set_shuffle(enabled).await.ok();
                        }
                        MprisCommand::SetLoopStatus { mode } => {
                            let status = match mode {
                                1 => LoopStatus::Playlist,
                                2 => LoopStatus::Track,
                                _ => LoopStatus::None,
                            };
                            player.set_loop_status(status).await.ok();
                        }
                        MprisCommand::SetFullscreen { fullscreen } => {
                            player.set_fullscreen(fullscreen).await.ok();
                        }
                        MprisCommand::Stop => {
                            player
                                .set_playback_status(PlaybackStatus::Stopped)
                                .await
                                .ok();
                        }
                    }
                }
            });
        });

        Self { tx }
    }

    pub fn send(&self, cmd: MprisCommand) {
        self.tx.send(cmd).ok();
    }
}
