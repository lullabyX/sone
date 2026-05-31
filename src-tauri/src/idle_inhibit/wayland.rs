use std::sync::mpsc;

use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use wayland_client::backend::{Backend, ObjectId};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::protocol::wl_surface::WlSurface;
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::wp::idle_inhibit::zv1::client::{
    zwp_idle_inhibit_manager_v1::ZwpIdleInhibitManagerV1,
    zwp_idle_inhibitor_v1::ZwpIdleInhibitorV1,
};

/// Minimal dispatch sink. We only ever send requests (bind, create_inhibitor,
/// destroy); none of these objects emit events we care about.
struct State;

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &WlRegistry, _: <WlRegistry as Proxy>::Event,
        _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<ZwpIdleInhibitManagerV1, ()> for State {
    fn event(_: &mut Self, _: &ZwpIdleInhibitManagerV1,
        _: <ZwpIdleInhibitManagerV1 as Proxy>::Event, _: &(),
        _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<ZwpIdleInhibitorV1, ()> for State {
    fn event(_: &mut Self, _: &ZwpIdleInhibitorV1,
        _: <ZwpIdleInhibitorV1 as Proxy>::Event, _: &(),
        _: &Connection, _: &QueueHandle<Self>) {}
}

/// All fields are Send (wayland-client sys objects are Send+Sync). Only the
/// initial pointer acquisition + create_inhibitor must run on the GTK main thread.
pub struct WaylandInhibitor {
    _conn: Connection,
    inhibitor: ZwpIdleInhibitorV1,
}

impl WaylandInhibitor {
    /// Build an inhibitor for the given window. MUST be called from the GTK main
    /// thread (does GDK pointer access). Returns None if not on Wayland, the
    /// surface isn't realized, or the compositor lacks idle-inhibit.
    fn build(window: &tauri::WebviewWindow) -> Option<Self> {
        let gtk_win = window.gtk_window().ok()?;
        let gdk_win = gtk_win.window()?; // realized only after show
        let gdk_display = gdk_win.display();

        let display_ptr_gdk: *mut gdk::ffi::GdkDisplay = gdk_display.to_glib_none().0;
        let window_ptr_gdk: *mut gdk::ffi::GdkWindow = gdk_win.to_glib_none().0;
        let display_ptr = unsafe {
            gdk_wayland_sys::gdk_wayland_display_get_wl_display(display_ptr_gdk as *mut _)
        };
        let surface_ptr = unsafe {
            gdk_wayland_sys::gdk_wayland_window_get_wl_surface(window_ptr_gdk as *mut _)
        };
        if display_ptr.is_null() || surface_ptr.is_null() {
            log::warn!("GDK wl_display/wl_surface unavailable (not realized or not Wayland)");
            return None;
        }

        let backend = unsafe { Backend::from_foreign_display(display_ptr as *mut _) };
        let conn = Connection::from_backend(backend);

        let (globals, mut queue) = registry_queue_init::<State>(&conn).ok()?;
        let qh = queue.handle();
        let manager: ZwpIdleInhibitManagerV1 = match globals.bind::<ZwpIdleInhibitManagerV1, _, _>(&qh, 1..=1, ()) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("compositor has no zwp_idle_inhibit_manager_v1: {e}");
                return None;
            }
        };

        let id = unsafe {
            ObjectId::from_ptr(WlSurface::interface(), surface_ptr as *mut _).ok()?
        };
        let surface = WlSurface::from_id(&conn, id).ok()?;

        let inhibitor = manager.create_inhibitor(&surface, &qh, ());
        let _ = queue.flush();
        let mut state = State;
        let _ = queue.roundtrip(&mut state);
        log::info!("Wayland idle inhibitor created");

        Some(Self { _conn: conn, inhibitor })
    }

    /// Public entry: hops to the GTK main thread to build the inhibitor.
    pub fn start(window: &tauri::WebviewWindow) -> Option<Self> {
        let (tx, rx) = mpsc::channel::<Option<WaylandInhibitor>>();
        let win = window.clone();
        if window.run_on_main_thread(move || {
            let _ = tx.send(WaylandInhibitor::build(&win));
        }).is_err() {
            return None;
        }
        rx.recv().ok().flatten()
    }

    pub fn stop(self) {
        self.inhibitor.destroy();
        log::info!("Wayland idle inhibitor destroyed");
    }
}
