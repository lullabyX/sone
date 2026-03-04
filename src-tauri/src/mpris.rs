use mpris_server::{Metadata, PlaybackStatus, Player, Time};
use tauri::Emitter;
use tokio::sync::mpsc;

pub enum MprisCommand {
    SetMetadata {
        title: String,
        artist: String,
        album: String,
        art_url: String,
        duration_secs: f64,
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
                let player = match Player::builder("io.github.lullabyX.sone")
                    .can_play(true)
                    .can_pause(true)
                    .can_go_next(true)
                    .can_go_previous(true)
                    .can_seek(true)
                    .can_control(true)
                    .build()
                    .await
                {
                    Ok(p) => p,
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
                    app.emit("tray:toggle-play", ()).ok();
                });

                let app = app_handle.clone();
                player.connect_pause(move |_| {
                    app.emit("tray:toggle-play", ()).ok();
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

                // Run the D-Bus server in the background
                tokio::task::spawn_local(player.run());

                log::info!("MPRIS D-Bus server started");

                // Process commands from the main app
                while let Some(cmd) = rx.recv().await {
                    match cmd {
                        MprisCommand::SetMetadata {
                            title,
                            artist,
                            album,
                            art_url,
                            duration_secs,
                        } => {
                            let mut metadata = Metadata::new();
                            metadata.set_title(Some(&title));
                            metadata.set_artist(Some([&artist]));
                            metadata.set_album(Some(&album));
                            if !art_url.is_empty() {
                                metadata.set_art_url(Some(art_url));
                            }
                            metadata.set_length(Some(Time::from_micros(
                                (duration_secs * 1_000_000.0) as i64,
                            )));
                            player.set_metadata(metadata).await.ok();
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
                            player.seeked(time).await.ok();
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
