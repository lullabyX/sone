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
    SetStatusText {
        text: String,
    },
    Connect,
    Disconnect,
}

pub struct DiscordHandle {
    tx: mpsc::Sender<DiscordCommand>,
}

#[derive(Default)]
struct CurrentActivity {
    title: String,
    artist: String,
    album: String,
    art_url: String,
    duration_secs: f64,
    url: String,
    quality_text: String,
    status_text: String,
    is_playing: bool,
    play_start_epoch: i64,
}

impl DiscordHandle {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<DiscordCommand>();

        std::thread::spawn(move || {
            let mut client = DiscordIpcClient::new(APPLICATION_ID);

            let mut connected = false;
            let mut want_connected = false;
            let mut current = CurrentActivity::default();

            // Try to establish or re-establish the IPC connection.
            // Always creates a fresh client to avoid stale socket issues.
            let try_connect = |client: &mut DiscordIpcClient, connected: &mut bool| -> bool {
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
                        if connected
                            && current.is_playing
                            && !current.title.is_empty()
                            && publish_activity(&mut client, &current).is_err()
                        {
                            client.close().ok();
                            connected = false;
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
                        current.title = title;
                        current.artist = artist;
                        current.album = album;
                        current.art_url = art_url;
                        current.duration_secs = duration_secs;
                        current.url = url;
                        current.quality_text = quality_text;

                        if current.is_playing {
                            current.play_start_epoch = now_epoch_secs();
                        }

                        if want_connected {
                            try_connect(&mut client, &mut connected);
                            if connected && publish_activity(&mut client, &current).is_err() {
                                client.close().ok();
                                connected = false;
                            }
                        }
                    }
                    DiscordCommand::SetPlaying {
                        is_playing: playing,
                        position_secs,
                    } => {
                        current.is_playing = playing;

                        if playing {
                            current.play_start_epoch = now_epoch_secs() - position_secs as i64;
                        }

                        if want_connected {
                            try_connect(&mut client, &mut connected);
                            if connected {
                                let failed = if !playing {
                                    client.clear_activity().is_err()
                                } else {
                                    publish_activity(&mut client, &current).is_err()
                                };
                                if failed {
                                    client.close().ok();
                                    connected = false;
                                }
                            }
                        }
                    }
                    DiscordCommand::SetStatusText { text } => {
                        current.status_text = text;
                        if want_connected
                            && connected
                            && current.is_playing
                            && !current.title.is_empty()
                            && publish_activity(&mut client, &current).is_err()
                        {
                            client.close().ok();
                            connected = false;
                        }
                    }
                    DiscordCommand::Stop => {
                        current.title.clear();
                    }
                    DiscordCommand::Seeked { position_secs } => {
                        if current.is_playing {
                            current.play_start_epoch = now_epoch_secs() - position_secs as i64;
                            if want_connected
                                && connected
                                && publish_activity(&mut client, &current).is_err()
                            {
                                client.close().ok();
                                connected = false;
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

fn publish_activity(client: &mut DiscordIpcClient, current: &CurrentActivity) -> Result<(), ()> {
    let state_text = if current.artist.is_empty() {
        current.album.clone()
    } else if current.album.is_empty() {
        format!("by {}", current.artist)
    } else {
        format!("by {} on {}", current.artist, current.album)
    };

    let mut act = activity::Activity::new()
        .activity_type(activity::ActivityType::Listening)
        .details(current.title.clone())
        .state(&state_text);

    if !current.status_text.trim().is_empty() {
        let custom_name = render_status_text(
            &current.status_text,
            &current.title,
            &current.artist,
            &current.album,
        );
        if !custom_name.trim().is_empty() {
            act = act.name(custom_name);
        }
    }

    // Timestamps: show elapsed time while playing
    let timestamps;
    if current.is_playing && current.play_start_epoch > 0 {
        timestamps = if current.duration_secs > 0.0 {
            activity::Timestamps::new()
                .start(current.play_start_epoch)
                .end(current.play_start_epoch + current.duration_secs as i64)
        } else {
            activity::Timestamps::new().start(current.play_start_epoch)
        };
        act = act.timestamps(timestamps);
    }

    // Album art + quality hover text
    let assets;
    if !current.art_url.is_empty() {
        let mut a = activity::Assets::new().large_image(current.art_url.clone());
        if !current.quality_text.is_empty() {
            a = a.large_text(current.quality_text.clone());
        }
        assets = a;
        act = act.assets(assets);
    }

    // "Listen on TIDAL" button
    let buttons;
    if !current.url.is_empty() {
        buttons = vec![activity::Button::new(
            "Listen on TIDAL",
            current.url.clone(),
        )];
        act = act.buttons(buttons);
    }

    if let Err(e) = client.set_activity(act) {
        log::warn!("Failed to set Discord activity: {e}");
        return Err(());
    }
    Ok(())
}

fn render_status_text(template: &str, title: &str, artist: &str, album: &str) -> String {
    template
        .replace("{track}", title)
        .replace("{artist}", artist)
        .replace("{album}", album)
}
