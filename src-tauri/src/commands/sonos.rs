//! Tauri command surface for the Play-on-Sonos feature. The frontend's
//! playback actions branch to these when `playbackTargetAtom` is a Sonos
//! group; the speaker streams natively from TIDAL (see `sonos::didl`).

use std::time::Duration;

use tauri::State;

use tauri::Emitter;

use crate::error::SoneError;
use crate::sonos::mirror::{plan_sync, MirrorEntry, SyncPlan};
use crate::sonos::{self, avtransport, didl, rendering, session};
use crate::AppState;

/// Emitted whenever the speaker-side queue was rebuilt (connect,
/// play_track's clear+reseed) so the frontend mirror re-syncs the tail.
const EVENT_QUEUE_RESET: &str = "sonos-queue-reset";

const DISCOVERY_WAIT: Duration = Duration::from_secs(3);

fn manual_ips(state: &AppState) -> Vec<String> {
    state
        .load_settings()
        .map(|s| s.sonos_manual_ips)
        .unwrap_or_default()
}

fn update_settings(state: &AppState, mutate: impl FnOnce(&mut crate::Settings)) {
    let mut settings = state.load_settings().unwrap_or_default();
    mutate(&mut settings);
    if let Err(e) = state.save_settings(&settings) {
        log::warn!("Failed to persist Sonos settings: {e}");
    }
}

async fn refresh_groups(state: &AppState) -> Result<Vec<sonos::SonosGroupInfo>, SoneError> {
    let groups =
        sonos::discover_groups(&state.sonos.client, &manual_ips(state), DISCOVERY_WAIT).await?;
    *state.sonos.groups.lock().unwrap() = groups.clone();
    Ok(groups)
}

/// The active session's coordinator, or a typed error when not casting.
async fn session_info(state: &AppState) -> Result<session::SessionInfo, SoneError> {
    state
        .sonos
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.info.clone())
        .ok_or_else(|| SoneError::SonosProtocol("no active Sonos session".into()))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_discover(
    state: State<'_, AppState>,
) -> Result<Vec<sonos::SonosGroupInfo>, SoneError> {
    log::debug!("[sonos_discover]");
    refresh_groups(state.inner()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_add_manual_ip(
    state: State<'_, AppState>,
    ip: String,
) -> Result<Vec<sonos::SonosGroupInfo>, SoneError> {
    let ip = ip.trim().to_string();
    // Validate before persisting — this is also the UX for "is this a Sonos?"
    sonos::discovery::probe_ip(&state.sonos.client, &ip).await?;
    update_settings(state.inner(), |settings| {
        if !settings.sonos_manual_ips.contains(&ip) {
            settings.sonos_manual_ips.push(ip.clone());
        }
    });
    refresh_groups(state.inner()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_remove_manual_ip(
    state: State<'_, AppState>,
    ip: String,
) -> Result<Vec<sonos::SonosGroupInfo>, SoneError> {
    update_settings(state.inner(), |settings| {
        settings.sonos_manual_ips.retain(|existing| existing != &ip);
    });
    refresh_groups(state.inner()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_get_manual_ips(state: State<'_, AppState>) -> Result<Vec<String>, SoneError> {
    Ok(manual_ips(state.inner()))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    group_uuid: String,
) -> Result<session::SessionInfo, SoneError> {
    log::info!("[sonos_connect] {group_uuid}");
    let group = {
        let cached = state.sonos.groups.lock().unwrap().clone();
        cached
            .into_iter()
            .find(|g| g.group.coordinator_uuid == group_uuid)
    };
    let group = match group {
        Some(g) => g,
        None => refresh_groups(state.inner())
            .await?
            .into_iter()
            .find(|g| g.group.coordinator_uuid == group_uuid)
            .ok_or_else(|| SoneError::SonosUnreachable(format!("group {group_uuid} not found")))?,
    };

    let info = session::SessionInfo {
        coordinator_ip: group.group.coordinator_ip.clone(),
        coordinator_uuid: group.group.coordinator_uuid.clone(),
        room_name: group.group.name.clone(),
    };

    // Reachability check before the UI commits to this target.
    avtransport::get_transport_state(&state.sonos.client, &info.coordinator_ip).await?;

    let mut session_slot = state.sonos.session.lock().await;
    if let Some(old) = session_slot.take() {
        old.stop();
        // Switching rooms: the old group would otherwise keep playing its
        // queue entry with nothing controlling it. Best effort.
        if old.info.coordinator_uuid != info.coordinator_uuid {
            let _ = avtransport::pause(&state.sonos.client, &old.info.coordinator_ip).await;
        }
    }
    {
        let mut mirror = state.sonos.mirror.lock().await;
        mirror.entries.clear();
        mirror.seeded = false;
    }
    *session_slot = Some(session::spawn(
        app.clone(),
        state.sonos.client.clone(),
        info.clone(),
        state.sonos.mirror.clone(),
    ));
    drop(session_slot);
    let _ = app.emit(EVENT_QUEUE_RESET, ());

    update_settings(state.inner(), |settings| {
        settings.sonos_last_group_uuid = Some(group_uuid);
    });

    Ok(info)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_disconnect(
    state: State<'_, AppState>,
    pause_remote: bool,
) -> Result<(), SoneError> {
    log::info!("[sonos_disconnect] pause_remote={pause_remote}");
    let taken = state.sonos.session.lock().await.take();
    {
        let mut mirror = state.sonos.mirror.lock().await;
        mirror.entries.clear();
        mirror.seeded = false;
    }
    if let Some(session) = taken {
        session.stop();
        if pause_remote {
            // Best effort — the speaker may already be stopped/gone.
            let _ = avtransport::pause(&state.sonos.client, &session.info.coordinator_ip).await;
        }
    }
    Ok(())
}

/// Replace the group's queue with one TIDAL track and play it. The speaker
/// fetches the audio from TIDAL itself via its linked account.
#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_play_track(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track_id: u64,
    meta: didl::TrackMeta,
    start: bool,
) -> Result<(), SoneError> {
    log::debug!("[sonos_play_track] {track_id} start={start}");
    let info = session_info(state.inner()).await?;
    let client = &state.sonos.client;
    let ip = &info.coordinator_ip;

    // The mirror lock serializes every queue-mutating SOAP sequence; this
    // rebuild voids any mirrored tail.
    let mut mirror = state.sonos.mirror.lock().await;
    mirror.entries.clear();

    avtransport::remove_all_tracks_from_queue(client, ip).await?;

    let didl_xml = didl::track_didl(track_id, &meta);
    let bare = didl::track_enqueue_uri(track_id, &didl::TrackUriStyle::Bare);
    if let Err(first_err) =
        avtransport::add_uri_to_queue(client, ip, &bare, &didl_xml, 0, false).await
    {
        // Retry with the explicit service URI only on a definitive UPnP
        // rejection. A timeout/transport error may mean the enqueue actually
        // LANDED and the response was lost — retrying would double-enqueue.
        if !matches!(first_err, SoneError::SonosUpnp { .. }) {
            return Err(first_err);
        }
        // Some firmware/account combinations want the explicit service URI.
        let serial = state
            .sonos
            .groups
            .lock()
            .unwrap()
            .iter()
            .find_map(|g| g.tidal_serial.clone())
            .unwrap_or_else(|| "1".to_string());
        let http = didl::track_enqueue_uri(
            track_id,
            &didl::TrackUriStyle::SonosHttp {
                account_serial: serial,
            },
        );
        log::warn!("[sonos_play_track] bare enqueue failed ({first_err}); retrying x-sonos-http");
        avtransport::add_uri_to_queue(client, ip, &http, &didl_xml, 0, false)
            .await
            .map_err(|_| first_err)?;
    }

    avtransport::set_av_transport_uri(client, ip, &didl::queue_uri(&info.coordinator_uuid), "")
        .await?;
    // Play order is SONE-authoritative; never let the speaker shuffle/loop.
    if let Err(e) = avtransport::set_play_mode(client, ip, "NORMAL").await {
        log::warn!("[sonos_play_track] SetPlayMode(NORMAL) failed: {e}");
    }
    if start {
        avtransport::play(client, ip).await?;
    }
    mirror.seeded = true;
    drop(mirror);
    // Tail is gone — ask the frontend mirror to re-sync it.
    let _ = app.emit(EVENT_QUEUE_RESET, ());
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailTrack {
    pub track_id: u64,
    pub qid: String,
    pub meta: didl::TrackMeta,
}

/// Make the speaker's queue tail match the frontend's up-next list
/// (append when extended, otherwise wipe-and-re-add). The speaker then
/// self-advances gaplessly — and keeps playing even if SONE exits.
#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_sync_queue_tail(
    state: State<'_, AppState>,
    tracks: Vec<TailTrack>,
) -> Result<(), SoneError> {
    let info = session_info(state.inner()).await?;
    let client = &state.sonos.client;
    let ip = &info.coordinator_ip;

    let desired: Vec<MirrorEntry> = tracks
        .iter()
        .map(|t| MirrorEntry {
            track_id: t.track_id,
            qid: t.qid.clone(),
        })
        .collect();

    let mut mirror = state.sonos.mirror.lock().await;
    if !mirror.seeded {
        // The speaker queue doesn't hold SONE's current track yet (cast
        // handshake in progress) — play_track emits sonos-queue-reset when
        // it's time to mirror.
        log::debug!("[sonos_sync_queue_tail] skipped: queue not seeded");
        return Ok(());
    }
    let plan = plan_sync(&mirror.entries, &desired);
    log::debug!(
        "[sonos_sync_queue_tail] {} mirrored, {} desired → {plan:?}",
        mirror.entries.len(),
        desired.len()
    );
    let append_from = match plan {
        SyncPlan::NoOp => return Ok(()),
        SyncPlan::Append { skip } => skip,
        SyncPlan::Rewrite => {
            let media = avtransport::get_media_info(client, ip).await?;
            let pos = avtransport::get_position_info(client, ip).await?;
            let current_nr = pos.track_nr.max(1);
            if media.nr_tracks > current_nr {
                avtransport::remove_track_range_from_queue(
                    client,
                    ip,
                    current_nr + 1,
                    media.nr_tracks - current_nr,
                )
                .await?;
            }
            mirror.entries.clear();
            0
        }
    };
    for t in &tracks[append_from..] {
        let uri = didl::track_enqueue_uri(t.track_id, &didl::TrackUriStyle::Bare);
        let didl_xml = didl::track_didl(t.track_id, &t.meta);
        avtransport::add_uri_to_queue(client, ip, &uri, &didl_xml, 0, false).await?;
        // Record incrementally so a mid-append failure leaves the mirror
        // matching what actually landed on the speaker.
        mirror.entries.push_back(MirrorEntry {
            track_id: t.track_id,
            qid: t.qid.clone(),
        });
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_pause(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[sonos_pause]");
    let info = session_info(state.inner()).await?;
    let result = avtransport::pause(&state.sonos.client, &info.coordinator_ip).await;
    // Only pause the scrobble clock if the speaker actually paused —
    // otherwise the listen keeps running remotely while nothing is counted.
    if result.is_ok() {
        state.scrobble_manager.on_pause().await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_resume(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[sonos_resume]");
    let info = session_info(state.inner()).await?;
    let result = avtransport::play(&state.sonos.client, &info.coordinator_ip).await;
    if result.is_ok() {
        state.scrobble_manager.on_resume().await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_seek(state: State<'_, AppState>, position_secs: f64) -> Result<(), SoneError> {
    log::debug!("[sonos_seek] {position_secs}");
    let info = session_info(state.inner()).await?;
    let result =
        avtransport::seek_rel_time(&state.sonos.client, &info.coordinator_ip, position_secs).await;
    if result.is_ok() {
        // Same side-effect surface as the local seek_track.
        #[cfg(target_os = "linux")]
        state
            .mpris
            .send(crate::mpris::MprisCommand::Seeked { position_secs });
        state
            .discord
            .send(crate::discord::DiscordCommand::Seeked { position_secs });
        state.scrobble_manager.on_seek().await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_get_position(state: State<'_, AppState>) -> Result<f64, SoneError> {
    let info = session_info(state.inner()).await?;
    let pos = avtransport::get_position_info(&state.sonos.client, &info.coordinator_ip).await?;
    Ok(pos.position_secs.unwrap_or(0.0))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_set_volume(state: State<'_, AppState>, volume: u8) -> Result<(), SoneError> {
    log::debug!("[sonos_set_volume] {volume}");
    let info = session_info(state.inner()).await?;
    rendering::set_group_volume(&state.sonos.client, &info.coordinator_ip, volume).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_set_mute(state: State<'_, AppState>, muted: bool) -> Result<(), SoneError> {
    log::debug!("[sonos_set_mute] {muted}");
    let info = session_info(state.inner()).await?;
    rendering::set_group_mute(&state.sonos.client, &info.coordinator_ip, muted).await
}

/// Everything the frontend needs to silently re-adopt a still-playing cast
/// session from a previous app run.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReattachInfo {
    #[serde(flatten)]
    pub session: session::SessionInfo,
    pub track_id: u64,
    pub position_secs: f64,
    pub volume: u8,
    pub muted: bool,
}

/// Best-effort reattach to the last cast group if it is still playing SONE's
/// queue (it kept going while SONE was closed). Every failure path returns
/// Ok(None) — reattach is never an error, just absent.
#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_try_reattach(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ReattachInfo>, SoneError> {
    let Some(group_uuid) = state.load_settings().and_then(|s| s.sonos_last_group_uuid) else {
        return Ok(None);
    };
    let Ok(groups) = refresh_groups(state.inner()).await else {
        return Ok(None);
    };
    let Some(group) = groups
        .into_iter()
        .find(|g| g.group.coordinator_uuid == group_uuid)
    else {
        return Ok(None);
    };
    let client = &state.sonos.client;
    let ip = group.group.coordinator_ip.clone();

    // Reattach only when the speaker is actively playing SONE's queue.
    let Ok(media) = avtransport::get_media_info(client, &ip).await else {
        return Ok(None);
    };
    if media.current_uri != didl::queue_uri(&group_uuid) {
        return Ok(None);
    }
    let Ok(avtransport::TransportState::Playing) =
        avtransport::get_transport_state(client, &ip).await
    else {
        return Ok(None);
    };
    let Ok(pos) = avtransport::get_position_info(client, &ip).await else {
        return Ok(None);
    };
    let Some(track_id) = didl::parse_track_uri(&pos.track_uri) else {
        return Ok(None);
    };

    let info = session::SessionInfo {
        coordinator_ip: ip.clone(),
        coordinator_uuid: group_uuid,
        room_name: group.group.name.clone(),
    };

    // The tail on the speaker predates this app run and the mirror knows
    // nothing about it — trim it so the frontend mirror rebuilds
    // deterministically from the restored queue.
    if media.nr_tracks > pos.track_nr && pos.track_nr > 0 {
        let _ = avtransport::remove_track_range_from_queue(
            client,
            &ip,
            pos.track_nr + 1,
            media.nr_tracks - pos.track_nr,
        )
        .await;
    }

    let volume = rendering::get_group_volume(client, &ip).await.unwrap_or(0);
    let muted = rendering::get_group_mute(client, &ip)
        .await
        .unwrap_or(false);

    let mut session_slot = state.sonos.session.lock().await;
    if let Some(old) = session_slot.take() {
        old.stop();
    }
    {
        let mut mirror = state.sonos.mirror.lock().await;
        mirror.entries.clear();
        // Verified above: the speaker is playing SONE's queue (trimmed to just
        // the current track) — tail mirroring may resume immediately.
        mirror.seeded = true;
    }
    *session_slot = Some(session::spawn(
        app.clone(),
        state.sonos.client.clone(),
        info.clone(),
        state.sonos.mirror.clone(),
    ));
    drop(session_slot);
    let _ = app.emit(EVENT_QUEUE_RESET, ());

    Ok(Some(ReattachInfo {
        session: info,
        track_id,
        position_secs: pos.position_secs.unwrap_or(0.0),
        volume,
        muted,
    }))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosNowPlaying {
    pub track_id: Option<u64>,
    pub state: avtransport::TransportState,
    pub volume: u8,
    pub muted: bool,
}

/// Snapshot of the active session's transport — cast-start sanity check and
/// (later) restart reattach.
#[tauri::command(rename_all = "camelCase")]
pub async fn sonos_get_now_playing(
    state: State<'_, AppState>,
) -> Result<SonosNowPlaying, SoneError> {
    let info = session_info(state.inner()).await?;
    let client = &state.sonos.client;
    let ip = &info.coordinator_ip;
    let transport = avtransport::get_transport_state(client, ip).await?;
    let position = avtransport::get_position_info(client, ip).await?;
    let volume = rendering::get_group_volume(client, ip).await.unwrap_or(0);
    let muted = rendering::get_group_mute(client, ip).await.unwrap_or(false);
    Ok(SonosNowPlaying {
        track_id: didl::parse_track_uri(&position.track_uri),
        state: transport,
        volume,
        muted,
    })
}
