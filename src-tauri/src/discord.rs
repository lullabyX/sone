use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

const APPLICATION_ID: &str = "1482171472167436308";

pub enum DiscordCommand {
    SetMetadata {
        title: String,
        artist: String,
        album: String,
        art_url: String,
        duration_secs: f64,
        url: String,
        quality_text: String,
    },
    SetPlaying {
        is_playing: bool,
        position_secs: f64,
    },
    Stop,
    Seeked {
        position_secs: f64,
    },
    Connect,
    Disconnect,
}

pub struct DiscordHandle {
    tx: mpsc::Sender<DiscordCommand>,
}

impl DiscordHandle {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<DiscordCommand>();

        std::thread::spawn(move || {
            let mut client = DiscordIpcClient::new(APPLICATION_ID);

            let mut connected = false;
            let mut want_connected = false;
            let mut current_title = String::new();
            let mut current_artist = String::new();
            let mut current_album = String::new();
            let mut current_art_url = String::new();
            let mut current_duration_secs: f64 = 0.0;
            let mut current_url = String::new();
            let mut current_quality_text = String::new();
            let mut is_playing = false;
            let mut play_start_epoch: i64 = 0;

            // Try to establish or re-establish the IPC connection.
            // Always creates a fresh client to avoid stale socket issues.
            let try_connect =
                |client: &mut DiscordIpcClient, connected: &mut bool| -> bool {
                    if *connected {
                        return true;
                    }
                    *client = DiscordIpcClient::new(APPLICATION_ID);
                    match client.connect() {
                        Ok(()) => {
                            *connected = true;
                            log::info!("Discord Rich Presence connected");
                            true
                        }
                        Err(e) => {
                            log::warn!("Failed to connect Discord IPC: {e}");
                            false
                        }
                    }
                };

            for cmd in rx {
                match cmd {
                    DiscordCommand::Connect => {
                        want_connected = true;
                        try_connect(&mut client, &mut connected);
                        if connected && is_playing && !current_title.is_empty() {
                            if set_activity(
                                &mut client,
                                &current_title,
                                &current_artist,
                                &current_album,
                                &current_art_url,
                                current_duration_secs,
                                is_playing,
                                play_start_epoch,
                                &current_url,
                                &current_quality_text,
                            )
                            .is_err()
                            {
                                client.close().ok();
                                connected = false;
                            }
                        }
                    }
                    DiscordCommand::Disconnect => {
                        want_connected = false;
                        if connected {
                            client.clear_activity().ok();
                            client.close().ok();
                            connected = false;
                            log::info!("Discord Rich Presence disconnected");
                        }
                    }
                    DiscordCommand::SetMetadata {
                        title,
                        artist,
                        album,
                        art_url,
                        duration_secs,
                        url,
                        quality_text,
                    } => {
                        current_title = title;
                        current_artist = artist;
                        current_album = album;
                        current_art_url = art_url;
                        current_duration_secs = duration_secs;
                        current_url = url;
                        current_quality_text = quality_text;

                        if is_playing {
                            play_start_epoch = now_epoch_secs();
                        }

                        if want_connected {
                            try_connect(&mut client, &mut connected);
                            if connected {
                                if set_activity(
                                    &mut client,
                                    &current_title,
                                    &current_artist,
                                    &current_album,
                                    &current_art_url,
                                    current_duration_secs,
                                    is_playing,
                                    play_start_epoch,
                                    &current_url,
                                    &current_quality_text,
                                )
                                .is_err()
                                {
                                    client.close().ok();
                                    connected = false;
                                }
                            }
                        }
                    }
                    DiscordCommand::SetPlaying { is_playing: playing, position_secs } => {
                        is_playing = playing;

                        if playing {
                            play_start_epoch = now_epoch_secs() - position_secs as i64;
                        }

                        if want_connected {
                            try_connect(&mut client, &mut connected);
                            if connected {
                                let failed = if !playing {
                                    client.clear_activity().is_err()
                                } else {
                                    set_activity(
                                        &mut client,
                                        &current_title,
                                        &current_artist,
                                        &current_album,
                                        &current_art_url,
                                        current_duration_secs,
                                        is_playing,
                                        play_start_epoch,
                                        &current_url,
                                        &current_quality_text,
                                    )
                                    .is_err()
                                };
                                if failed {
                                    client.close().ok();
                                    connected = false;
                                }
                            }
                        }
                    }
                    DiscordCommand::Stop => {
                        current_title.clear();
                    }
                    DiscordCommand::Seeked { position_secs } => {
                        if is_playing {
                            play_start_epoch = now_epoch_secs() - position_secs as i64;
                            if want_connected && connected {
                                if set_activity(
                                    &mut client,
                                    &current_title,
                                    &current_artist,
                                    &current_album,
                                    &current_art_url,
                                    current_duration_secs,
                                    is_playing,
                                    play_start_epoch,
                                    &current_url,
                                    &current_quality_text,
                                )
                                .is_err()
                                {
                                    client.close().ok();
                                    connected = false;
                                }
                            }
                        }
                    }
                }
            }

            // Channel closed — clean up
            if connected {
                client.clear_activity().ok();
                client.close().ok();
            }
        });

        Self { tx }
    }

    pub fn send(&self, cmd: DiscordCommand) {
        self.tx.send(cmd).ok();
    }
}

fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn set_activity(
    client: &mut DiscordIpcClient,
    title: &str,
    artist: &str,
    album: &str,
    art_url: &str,
    duration_secs: f64,
    is_playing: bool,
    play_start_epoch: i64,
    url: &str,
    quality_text: &str,
) -> Result<(), ()> {
    let state_text = if artist.is_empty() {
        album.to_string()
    } else if album.is_empty() {
        format!("by {artist}")
    } else {
        format!("by {artist} on {album}")
    };

    let mut act = activity::Activity::new()
        .activity_type(activity::ActivityType::Listening)
        .details(title)
        .state(&state_text);

    // Timestamps: show elapsed time while playing
    let timestamps;
    if is_playing && play_start_epoch > 0 {
        timestamps = if duration_secs > 0.0 {
            activity::Timestamps::new()
                .start(play_start_epoch)
                .end(play_start_epoch + duration_secs as i64)
        } else {
            activity::Timestamps::new().start(play_start_epoch)
        };
        act = act.timestamps(timestamps);
    }

    // Album art + quality hover text
    let assets;
    if !art_url.is_empty() {
        let mut a = activity::Assets::new().large_image(art_url);
        if !quality_text.is_empty() {
            a = a.large_text(quality_text);
        }
        assets = a;
        act = act.assets(assets);
    }

    // "Listen on TIDAL" button
    let buttons;
    if !url.is_empty() {
        buttons = vec![activity::Button::new("Listen on TIDAL", url)];
        act = act.buttons(buttons);
    }

    if let Err(e) = client.set_activity(act) {
        log::warn!("Failed to set Discord activity: {e}");
        return Err(());
    }
    Ok(())
}
