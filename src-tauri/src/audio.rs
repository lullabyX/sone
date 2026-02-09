use rodio::{Decoder, OutputStream, Sink, Source};
use std::io::Cursor;
use std::sync::mpsc::{channel, Sender};
use std::thread;
use std::time::Instant;

pub enum AudioCommand {
    Play(Vec<u8>),
    Pause,
    Resume,
    Stop,
    SetVolume(f32),
    Seek(f32),
    GetPosition(std::sync::mpsc::Sender<f32>),
    IsFinished(std::sync::mpsc::Sender<bool>),
}

pub struct AudioPlayer {
    sender: Sender<AudioCommand>,
}

impl AudioPlayer {
    pub fn new() -> Self {
        let (sender, receiver) = channel::<AudioCommand>();

        thread::spawn(move || {
            let (_stream, stream_handle) = OutputStream::try_default().unwrap();
            let sink = Sink::try_new(&stream_handle).unwrap();
            let mut play_start: Option<Instant> = None;
            let mut accumulated_time: f32 = 0.0;
            let mut is_paused = false;
            let mut current_bytes: Option<Vec<u8>> = None;

            loop {
                match receiver.recv() {
                    Ok(AudioCommand::Play(bytes)) => {
                        sink.stop();
                        let cursor = Cursor::new(bytes.clone());
                        current_bytes = Some(bytes);
                        if let Ok(source) = Decoder::new(cursor) {
                            sink.append(source);
                            sink.play();
                            play_start = Some(Instant::now());
                            accumulated_time = 0.0;
                            is_paused = false;
                        }
                    }
                    Ok(AudioCommand::Pause) => {
                        if let Some(start) = play_start {
                            accumulated_time += start.elapsed().as_secs_f32();
                        }
                        sink.pause();
                        is_paused = true;
                        play_start = None;
                    }
                    Ok(AudioCommand::Resume) => {
                        sink.play();
                        play_start = Some(Instant::now());
                        is_paused = false;
                    }
                    Ok(AudioCommand::Stop) => {
                        sink.stop();
                        play_start = None;
                        accumulated_time = 0.0;
                        current_bytes = None;
                    }
                    Ok(AudioCommand::SetVolume(level)) => {
                        sink.set_volume(level);
                    }
                    Ok(AudioCommand::Seek(position_secs)) => {
                        let pos = std::time::Duration::from_secs_f32(position_secs);
                        let seek_ok = sink.try_seek(pos).is_ok();
                        if seek_ok {
                            accumulated_time = position_secs;
                            if !is_paused {
                                play_start = Some(Instant::now());
                            } else {
                                play_start = None;
                            }
                        } else if let Some(ref bytes) = current_bytes {
                            // Fallback for codecs that don't support seeking (e.g. FLAC)
                            // Re-decode from stored bytes and skip to the target position
                            let vol = sink.volume();
                            sink.stop();
                            let cursor = Cursor::new(bytes.clone());
                            if let Ok(source) = Decoder::new(cursor) {
                                sink.append(source.skip_duration(pos));
                                sink.set_volume(vol);
                                if is_paused {
                                    sink.pause();
                                }
                                accumulated_time = position_secs;
                                if !is_paused {
                                    play_start = Some(Instant::now());
                                } else {
                                    play_start = None;
                                }
                            }
                        }
                    }
                    Ok(AudioCommand::GetPosition(reply)) => {
                        let pos = if is_paused {
                            accumulated_time
                        } else if let Some(start) = play_start {
                            accumulated_time + start.elapsed().as_secs_f32()
                        } else {
                            0.0
                        };
                        let _ = reply.send(pos);
                    }
                    Ok(AudioCommand::IsFinished(reply)) => {
                        let _ = reply.send(sink.empty());
                    }
                    Err(_) => break,
                }
            }
        });

        Self { sender }
    }

    pub fn play(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.sender
            .send(AudioCommand::Play(bytes))
            .map_err(|e| e.to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.sender
            .send(AudioCommand::Pause)
            .map_err(|e| e.to_string())
    }

    pub fn resume(&self) -> Result<(), String> {
        self.sender
            .send(AudioCommand::Resume)
            .map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.sender
            .send(AudioCommand::Stop)
            .map_err(|e| e.to_string())
    }

    pub fn set_volume(&self, level: f32) -> Result<(), String> {
        self.sender
            .send(AudioCommand::SetVolume(level))
            .map_err(|e| e.to_string())
    }

    pub fn seek(&self, position_secs: f32) -> Result<(), String> {
        self.sender
            .send(AudioCommand::Seek(position_secs))
            .map_err(|e| e.to_string())
    }

    pub fn get_position(&self) -> Result<f32, String> {
        let (reply_tx, reply_rx) = channel();
        self.sender
            .send(AudioCommand::GetPosition(reply_tx))
            .map_err(|e| e.to_string())?;
        reply_rx.recv().map_err(|e| e.to_string())
    }

    pub fn is_finished(&self) -> Result<bool, String> {
        let (reply_tx, reply_rx) = channel();
        self.sender
            .send(AudioCommand::IsFinished(reply_tx))
            .map_err(|e| e.to_string())?;
        reply_rx.recv().map_err(|e| e.to_string())
    }
}
