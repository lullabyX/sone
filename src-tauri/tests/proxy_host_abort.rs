//! A malformed proxy URI aborts souphttpsrc inside GLib
//! (`gst_soup_uri_to_string: code should not be reached`, SIGABRT / exit 134).
//! Validation must reject such hosts before any element sees them, so this
//! guards the boundary from outside the test process.
//!
//! Two of the three hosts below abort; `[::1]` does not, and is here for a
//! different reason. Each one carries its own, so the distinction cannot be
//! lost again — an earlier version of this file asserted all three abort.

use std::process::Command;

use tauri_app_lib::proxy::{self, HostCaps, PlanError};
use tauri_app_lib::{ProxySettings, ProxyType};

/// Hosts `proxy::plan` must reject, each paired with the rejection it owes,
/// and with why that host is on this list at all.
///
/// Only `1.2.3.4:9999` and `[[::1]]` were observed to abort the element
/// (exit 134). `[::1]` builds a well-formed URI and exits 0 — it is rejected
/// as a normalization choice, not as a crash guard. See the note at the probe
/// below.
const REJECTED_HOSTS: &[(&str, PlanError, Aborts)] = &[
    ("[::1]", PlanError::BracketedHost, Aborts::No),
    ("1.2.3.4:9999", PlanError::EmbeddedPort, Aborts::Yes),
    ("[[::1]]", PlanError::BracketedHost, Aborts::Yes),
];

/// Whether the host was observed to abort `souphttpsrc`, as opposed to being
/// rejected for another reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Aborts {
    Yes,
    No,
}

fn settings_for(host: &str) -> ProxySettings {
    ProxySettings {
        enabled: true,
        proxy_type: ProxyType::Http,
        host: host.to_string(),
        port: 8080,
        username: None,
        password: None,
    }
}

fn python_available() -> bool {
    Command::new("python3")
        .arg("-c")
        .arg("import gi; gi.require_version('Gst','1.0')")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn proxy_hosts_that_must_never_reach_an_element_are_rejected_upstream() {
    // The invariant. Runs everywhere, including CI machines that have the
    // GStreamer dev headers but no runtime plugins and no python3-gi.
    for (host, expected, _) in REJECTED_HOSTS {
        let plan = proxy::plan(&settings_for(host), &HostCaps::assume_all_present());
        assert_eq!(
            plan.err().as_ref(),
            Some(expected),
            "proxy::plan must reject {host:?} before it can reach an element",
        );
    }

    // The evidence for why. Best effort only: without python3, the gi
    // bindings, or a GStreamer runtime there is nothing to observe, and the
    // invariant above stands on its own.
    if !python_available() {
        eprintln!("skipping element probe: python3 gi/Gst unavailable");
        return;
    }

    for (host, _, aborts) in REJECTED_HOSTS {
        let script = format!(
            r#"
import gi, sys
gi.require_version('Gst','1.0')
from gi.repository import Gst
Gst.init(None)
src = Gst.ElementFactory.make('souphttpsrc','s')
src.set_property('location','http://127.0.0.1:1/x')
src.set_property('proxy','http://{host}:8080')
p = Gst.Pipeline.new('p'); sink = Gst.ElementFactory.make('fakesink','f')
p.add(src); p.add(sink); src.link(sink)
p.set_state(Gst.State.PLAYING)
p.get_bus().timed_pop_filtered(2*Gst.SECOND, Gst.MessageType.ERROR|Gst.MessageType.EOS)
p.set_state(Gst.State.NULL)
sys.exit(0)
"#
        );
        let Ok(out) = Command::new("python3").arg("-c").arg(&script).output() else {
            eprintln!("skipping element probe for {host:?}: python3 failed to spawn");
            continue;
        };

        // Documents the hazard: if a host that aborts stops aborting upstream,
        // the rejection in proxy::validate_host may be relaxed — but not
        // before. Observed locally on GStreamer 1.26: `1.2.3.4:9999` and
        // `[[::1]]` exit 134 (SIGABRT); `[::1]` builds a well-formed URI and
        // exits 0.
        //
        // `[::1]` is rejected for a different reason, and calling it a crash
        // guard has confused this file before. `authority()` would emit a
        // perfectly correct `[::1]:8080` for it — a bracketed literal does not
        // parse as an `Ipv6Addr`, so the bracketing step is skipped and the
        // value passes through intact. The rejection is a normalization
        // choice: the host field holds exactly one spelling of an address, a
        // bare literal, and `authority()` is the single place that brackets
        // it. Accepting a second spelling means every consumer decides for
        // itself whether to bracket — and `[[::1]]`, which *does* abort, is
        // precisely what that produces when one of them decides twice.
        eprintln!("host {host:?} -> status {:?} (aborts: {aborts:?})", out.status);
    }
}
