use gstreamer as gst;
use gst::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use tauri::Emitter;

/// Reply channel: a one-shot response sender using std::sync::mpsc.
type Reply<T> = mpsc::Sender<T>;

enum AudioCommand {
    PlayUrl { uri: String, reply: Reply<Result<(), String>> },
    Pause { reply: Reply<Result<(), String>> },
    Resume { reply: Reply<Result<(), String>> },
    Stop { reply: Reply<Result<(), String>> },
    SetVolume { level: f32, reply: Reply<Result<(), String>> },
    SetNormalizationGain { gain: f64, reply: Reply<Result<(), String>> },
    Seek { position_secs: f32, reply: Reply<Result<(), String>> },
    GetPosition { reply: Reply<Result<f32, String>> },
    IsFinished { reply: Reply<Result<bool, String>> },
}

/// Thread-safe audio player that communicates with a dedicated GStreamer thread.
/// All GStreamer operations happen on a single OS thread, avoiding the need for
/// `unsafe impl Send + Sync` on the pipeline element.
pub struct AudioPlayer {
    cmd_tx: mpsc::Sender<AudioCommand>,
}

// mpsc::Sender is Send + Sync naturally — no unsafe needed.

impl AudioPlayer {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<AudioCommand>();

        std::thread::spawn(move || {
            gst::init().expect("Failed to initialize GStreamer");

            let pipeline = gst::ElementFactory::make("playbin")
                .build()
                .expect("Failed to create playbin");

            // Dedicated volume element for normalization gain, separate from
            // playbin's own volume property (user volume).
            let norm_volume = gst::ElementFactory::make("volume")
                .property("volume", 1.0_f64)
                .build()
                .expect("Failed to create normalization volume element");
            pipeline.set_property("audio-filter", &norm_volume);

            let eos = Arc::new(AtomicBool::new(false));
            let has_uri = AtomicBool::new(false);

            // Bus listener thread — detects EOS/Error, sets flag + emits Tauri event.
            let bus = pipeline.bus().expect("Pipeline has no bus");
            let eos_flag = Arc::clone(&eos);
            let app_handle_clone = app_handle.clone();
            std::thread::spawn(move || {
                for msg in bus.iter_timed(gst::ClockTime::NONE) {
                    match msg.view() {
                        gst::MessageView::Eos(..) => {
                            eos_flag.store(true, Ordering::SeqCst);
                            app_handle_clone.emit("track-finished", ()).ok();
                        }
                        gst::MessageView::Error(err) => {
                            log::error!(
                                "GStreamer error: {} (debug: {:?})",
                                err.error(),
                                err.debug()
                            );
                            eos_flag.store(true, Ordering::SeqCst);
                            app_handle_clone.emit("track-finished", ()).ok();
                        }
                        _ => {}
                    }
                }
            });

            // Command dispatch loop — owns pipeline, runs until sender is dropped.
            for cmd in cmd_rx {
                match cmd {
                    AudioCommand::PlayUrl { uri, reply } => {
                        let result = (|| -> Result<(), String> {
                            pipeline
                                .set_state(gst::State::Null)
                                .map_err(|e| format!("Failed to reset pipeline: {}", e))?;
                            eos.store(false, Ordering::SeqCst);
                            has_uri.store(true, Ordering::SeqCst);
                            pipeline.set_property("uri", &uri);
                            pipeline
                                .set_state(gst::State::Playing)
                                .map_err(|e| format!("Failed to start playback: {}", e))?;
                            Ok(())
                        })();
                        reply.send(result).ok();
                    }
                    AudioCommand::Pause { reply } => {
                        let result = pipeline
                            .set_state(gst::State::Paused)
                            .map(|_| ())
                            .map_err(|e| format!("Failed to pause: {}", e));
                        reply.send(result).ok();
                    }
                    AudioCommand::Resume { reply } => {
                        let result = pipeline
                            .set_state(gst::State::Playing)
                            .map(|_| ())
                            .map_err(|e| format!("Failed to resume: {}", e));
                        reply.send(result).ok();
                    }
                    AudioCommand::Stop { reply } => {
                        let result = pipeline
                            .set_state(gst::State::Null)
                            .map(|_| {
                                eos.store(false, Ordering::SeqCst);
                                has_uri.store(false, Ordering::SeqCst);
                            })
                            .map_err(|e| format!("Failed to stop: {}", e));
                        reply.send(result).ok();
                    }
                    AudioCommand::SetVolume { level, reply } => {
                        pipeline.set_property("volume", level as f64);
                        reply.send(Ok(())).ok();
                    }
                    AudioCommand::SetNormalizationGain { gain, reply } => {
                        norm_volume.set_property("volume", gain);
                        reply.send(Ok(())).ok();
                    }
                    AudioCommand::Seek { position_secs, reply } => {
                        let pos = gst::ClockTime::from_nseconds(
                            (position_secs as f64 * 1_000_000_000.0) as u64,
                        );
                        let result = pipeline
                            .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, pos)
                            .map_err(|e| format!("Seek failed: {}", e));
                        reply.send(result).ok();
                    }
                    AudioCommand::GetPosition { reply } => {
                        let pos = match pipeline.query_position::<gst::ClockTime>() {
                            Some(pos) => pos.nseconds() as f32 / 1_000_000_000.0,
                            None => 0.0,
                        };
                        reply.send(Ok(pos)).ok();
                    }
                    AudioCommand::IsFinished { reply } => {
                        let finished = eos.load(Ordering::SeqCst)
                            || !has_uri.load(Ordering::SeqCst);
                        reply.send(Ok(finished)).ok();
                    }
                }
            }
        });

        Self { cmd_tx }
    }

    /// Send a command and wait for the reply.
    fn send_cmd<T>(&self, build: impl FnOnce(Reply<T>) -> AudioCommand) -> T {
        let (tx, rx) = mpsc::channel();
        let cmd = build(tx);
        self.cmd_tx
            .send(cmd)
            .expect("Audio thread dead");
        rx.recv().expect("Audio thread dead")
    }

    pub fn play_url(&self, uri: &str) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::PlayUrl {
            uri: uri.to_string(),
            reply,
        })
    }

    pub fn pause(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Pause { reply })
    }

    pub fn resume(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Resume { reply })
    }

    pub fn stop(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Stop { reply })
    }

    pub fn set_volume(&self, level: f32) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetVolume { level, reply })
    }

    pub fn set_normalization_gain(&self, gain: f64) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetNormalizationGain { gain, reply })
    }

    pub fn seek(&self, position_secs: f32) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Seek { position_secs, reply })
    }

    pub fn get_position(&self) -> Result<f32, String> {
        self.send_cmd(|reply| AudioCommand::GetPosition { reply })
    }

    pub fn is_finished(&self) -> Result<bool, String> {
        self.send_cmd(|reply| AudioCommand::IsFinished { reply })
    }
}
