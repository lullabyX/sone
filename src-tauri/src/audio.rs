use gstreamer as gst;
use gst::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct AudioPlayer {
    pipeline: gst::Element,
    eos: Arc<AtomicBool>,
}

impl AudioPlayer {
    pub fn new() -> Self {
        gst::init().expect("Failed to initialize GStreamer");

        let pipeline = gst::ElementFactory::make("playbin")
            .build()
            .expect("Failed to create playbin");

        let eos = Arc::new(AtomicBool::new(false));

        // Listen for EOS / errors on the bus in a background thread.
        let bus = pipeline.bus().expect("Pipeline has no bus");
        let eos_flag = Arc::clone(&eos);
        std::thread::spawn(move || {
            for msg in bus.iter_timed(gst::ClockTime::NONE) {
                match msg.view() {
                    gst::MessageView::Eos(..) => {
                        eos_flag.store(true, Ordering::SeqCst);
                    }
                    gst::MessageView::Error(err) => {
                        eprintln!(
                            "GStreamer error: {} (debug: {:?})",
                            err.error(),
                            err.debug()
                        );
                        eos_flag.store(true, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }
        });

        Self { pipeline, eos }
    }

    pub fn play_url(&self, uri: &str) -> Result<(), String> {
        self.pipeline
            .set_state(gst::State::Null)
            .map_err(|e| format!("Failed to reset pipeline: {}", e))?;

        self.eos.store(false, Ordering::SeqCst);
        self.pipeline.set_property("uri", uri);

        self.pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("Failed to start playback: {}", e))?;

        Ok(())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| format!("Failed to pause: {}", e))?;
        Ok(())
    }

    pub fn resume(&self) -> Result<(), String> {
        self.pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("Failed to resume: {}", e))?;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.pipeline
            .set_state(gst::State::Null)
            .map_err(|e| format!("Failed to stop: {}", e))?;
        self.eos.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn set_volume(&self, level: f32) -> Result<(), String> {
        // GStreamer playbin volume is a f64, 1.0 = 100%.
        self.pipeline.set_property("volume", level as f64);
        Ok(())
    }

    pub fn seek(&self, position_secs: f32) -> Result<(), String> {
        let pos = gst::ClockTime::from_nseconds((position_secs as f64 * 1_000_000_000.0) as u64);
        self.pipeline
            .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, pos)
            .map_err(|e| format!("Seek failed: {}", e))?;
        Ok(())
    }

    pub fn get_position(&self) -> Result<f32, String> {
        match self.pipeline.query_position::<gst::ClockTime>() {
            Some(pos) => Ok(pos.nseconds() as f32 / 1_000_000_000.0),
            None => Ok(0.0),
        }
    }

    pub fn is_finished(&self) -> Result<bool, String> {
        Ok(self.eos.load(Ordering::SeqCst))
    }
}

unsafe impl Send for AudioPlayer {}
unsafe impl Sync for AudioPlayer {}
