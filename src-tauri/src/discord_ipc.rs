//! Socket discovery and IPC transport for Discord Rich Presence.
//!
//! Replaces `discord_rich_presence::DiscordIpcClient`, whose `find_pipe()`
//! commits to the first path that merely *exists* and never falls through.
//! A Flatpak sandbox routinely holds a bind to an unlinked socket inode after
//! Discord restarts: it still stats as a socket, but every connect refuses.

use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Duration;

use discord_rich_presence::error::Error;
use discord_rich_presence::DiscordIpc;
use serde_json::json;

type IpcResult<T> = std::result::Result<T, Error>;

/// Per-read/per-write socket timeout (`SO_RCVTIMEO`/`SO_SNDTIMEO`) applied to
/// every dialled candidate.
///
/// This is *not* a budget for a whole handshake: a handshake reads several
/// frames, two reads each, so a peer that answers just inside every deadline
/// can legally spend many multiples of this on a single candidate. Use
/// [`CONNECT_DEADLINE`] when you need a bound on the search.
const HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Wall-clock budget for one whole `connect()` call — the entire candidate
/// scan, not one candidate.
///
/// `candidate_paths` can yield hundreds of entries, `UnixStream::connect` has
/// no timeout at all, and [`HANDSHAKE_READ_TIMEOUT`] only bounds a single read,
/// so nothing else caps the total. A slow or silent peer must not let one tick
/// run long enough to back up the command channel behind it.
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);

/// Directory prefixes, relative to a runtime dir, where a Discord client may
/// publish its IPC socket.
///
/// These mirror the `--filesystem` grants in the Flathub manifest, which lives
/// in the separate `flathub/io.github.lullabyX.sone` repository and cannot be
/// checked from this working tree. Verify against a built package with
/// `flatpak info --show-permissions io.github.lullabyX.sone`.
pub(crate) const APP_SUBPATHS: [&str; 9] = [
    "",
    "app/com.discordapp.Discord/",
    "app/com.discordapp.DiscordCanary/",
    "app/dev.vencord.Vesktop/",
    ".flatpak/com.discordapp.Discord/xdg-run/",
    ".flatpak/com.discordapp.DiscordCanary/xdg-run/",
    ".flatpak/dev.vencord.Vesktop/xdg-run/",
    "snap.discord/",
    "snap.discord-canary/",
];

/// Every path a Discord IPC socket could live at, in probe order.
///
/// Takes its bases as an argument so it stays pure and testable; reading the
/// environment happens in [`base_dirs`].
pub(crate) fn candidate_paths(bases: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(bases.len() * 10 * APP_SUBPATHS.len());
    for base in bases {
        for i in 0..10 {
            let name = format!("discord-ipc-{i}");
            for sub in APP_SUBPATHS {
                out.push(base.join(sub).join(&name));
            }
        }
    }
    out
}

/// Expand a Snap `XDG_RUNTIME_DIR` into every runtime dir worth searching.
///
/// Under Snap, `XDG_RUNTIME_DIR` points at the app's private `.../snap.<name>`
/// subdir, so the real runtime dir is one level up. Both are returned:
///
/// * the parent is where Discord actually publishes its socket, and
/// * the private dir is the only one strict confinement lets us connect to.
///
/// Under strict confinement the AppArmor profile denies `connect` on anything
/// outside the private dir, so the parent is discoverable but unusable — a
/// relay socket placed in the private dir is the one route that works, and it
/// is worthless if we never look there. Parent first, so a build that *can*
/// reach the real socket (classic confinement, or a future snapd) still
/// prefers it.
///
/// Returns nothing for a value with no usable parent; that is not a runtime
/// dir layout we understand.
pub(crate) fn snap_runtime_dirs(val: &str) -> Vec<PathBuf> {
    match val.rsplit_once('/') {
        Some((parent, _)) if !parent.is_empty() => {
            vec![PathBuf::from(parent), PathBuf::from(val)]
        }
        _ => Vec::new(),
    }
}

/// Runtime directories to search, in priority order.
///
/// Deduped because `XDG_RUNTIME_DIR` and `TMPDIR` can resolve to the same
/// directory. See [`snap_runtime_dirs`] for the Snap expansion.
pub(crate) fn base_dirs() -> Vec<PathBuf> {
    const KEYS: [&str; 4] = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"];
    let under_snap = std::env::var("SNAP").is_ok();

    let mut out = Vec::new();
    for (idx, key) in KEYS.iter().enumerate() {
        let Ok(val) = std::env::var(key) else {
            continue;
        };
        let paths = if under_snap && idx == 0 {
            snap_runtime_dirs(&val)
        } else {
            vec![PathBuf::from(val)]
        };
        for path in paths {
            if path.is_dir() && !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// Why [`dial`] gave up on a candidate.
pub(crate) enum DialError {
    /// Nothing usable here: no such path, not an AF_UNIX socket, or a connect
    /// that failed for any reason other than sandbox policy. The normal answer
    /// for all but one or two of the candidates on any given scan.
    Unavailable,
    /// The socket is there and we are not allowed to talk to it. Distinct
    /// because it is the *only* outcome the user can act on — see
    /// [`SoneDiscordClient::connect`].
    Denied,
}

/// Connect to `path`, but only if it is genuinely an AF_UNIX socket.
///
/// `std::fs::metadata` follows symlinks, so a link pointing at a live socket
/// works and a dangling link is rejected. Treat any stat error as "skip".
///
/// The timeouts are load-bearing: a peer that accepts and never answers would
/// otherwise block `read_exact` forever and wedge the whole Discord thread,
/// and `connect()` now dials many more candidates than upstream did.
///
/// Note the socket-type check is a fast filter, not a correctness guarantee —
/// an unlinked inode still stats as a socket. The connect is what rejects it.
pub(crate) fn dial(path: &Path) -> Result<UnixStream, DialError> {
    let meta = std::fs::metadata(path).map_err(|_| DialError::Unavailable)?;
    if !meta.file_type().is_socket() {
        return Err(DialError::Unavailable);
    }
    let stream = UnixStream::connect(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => DialError::Denied,
        _ => DialError::Unavailable,
    })?;
    stream
        .set_read_timeout(Some(HANDSHAKE_READ_TIMEOUT))
        .map_err(|_| DialError::Unavailable)?;
    stream
        .set_write_timeout(Some(HANDSHAKE_READ_TIMEOUT))
        .map_err(|_| DialError::Unavailable)?;
    Ok(stream)
}

/// Log a sandbox denial once per process.
///
/// Without this the failure is silent: a denied connect is indistinguishable
/// from an absent socket, so a packaged build reports "Discord not running"
/// while Discord is plainly running. Once is the right granularity — sandbox
/// policy is fixed for the life of the process, and `connect()` re-runs on
/// every 30s retry tick, so anything finer would repeat the same line forever.
fn report_sandbox_denial(path: &Path) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        log::warn!(
            "Discord IPC socket at {} exists but the sandbox denied the connection; \
             Rich Presence cannot reach Discord from this package",
            path.display()
        );
    });
}

/// A Discord IPC client that validates each candidate before committing.
pub(crate) struct SoneDiscordClient {
    client_id: String,
    bases: Vec<PathBuf>,
    socket: Option<UnixStream>,
}

impl SoneDiscordClient {
    pub(crate) fn new(client_id: &str) -> Self {
        Self::with_bases(client_id, base_dirs())
    }

    /// Same client, explicit search roots.
    ///
    /// Exists so `connect()` can be tested without mutating the environment —
    /// `tests/source_guards.rs` forbids setting or removing environment
    /// variables anywhere under `src/`, which would otherwise make this type
    /// untestable.
    pub(crate) fn with_bases(client_id: &str, bases: Vec<PathBuf>) -> Self {
        Self {
            client_id: client_id.to_string(),
            bases,
            socket: None,
        }
    }

    /// Send the v1 handshake and require a `READY` dispatch back.
    ///
    /// The crate's `send_handshake` discards the response, so a socket that is
    /// connectable but not Discord would be accepted. This does not.
    ///
    /// Discord's reference client answers a PING before READY, so read a few
    /// frames rather than exactly one. Opcode 2 is CLOSE and terminal; code
    /// 4000 means our application ID was rejected, which a developer needs to
    /// see (the accompanying message string is not stable).
    ///
    /// `recv()` sizes its buffer from the peer's own length header, so an
    /// unvalidated peer can make us allocate. Left as is deliberately: the
    /// framing lives in the crate's private `pack_unpack`, so capping it would
    /// mean reimplementing `send`/`recv` wholesale. The read timeout bounds how
    /// long such a peer can hold us.
    fn handshake_ok(&mut self) -> bool {
        const MAX_FRAMES: usize = 4;

        let id = self.client_id.clone();
        if self.send(json!({ "v": 1, "client_id": id }), 0).is_err() {
            return false;
        }

        for _ in 0..MAX_FRAMES {
            let Ok((op, value)) = self.recv() else {
                return false;
            };
            match op {
                1 if value.get("evt").and_then(|e| e.as_str()) == Some("READY") => {
                    return true;
                }
                2 => {
                    if value.get("code").and_then(serde_json::Value::as_u64) == Some(4000) {
                        log::warn!("Discord rejected SONE's application ID: {value}");
                    } else {
                        log::debug!("Discord IPC closed the handshake: {value}");
                    }
                    return false;
                }
                // PING before READY: answer with PONG and keep reading.
                3 if self.send(value, 4).is_err() => {
                    return false;
                }
                _ => {}
            }
        }
        false
    }
}

impl DiscordIpc for SoneDiscordClient {
    fn get_client_id(&self) -> &str {
        &self.client_id
    }

    /// Required by the trait. Prefer [`DiscordIpc::connect`], which is
    /// overridden below to validate the handshake — this accepts the first
    /// dialable candidate without proving it is Discord. Only the trait's
    /// defaulted `reconnect()` reached it, and `reconnect()` is now overridden
    /// below to route through `connect()`, so nothing arrives here by default.
    fn connect_ipc(&mut self) -> IpcResult<()> {
        self.socket = None;

        for path in candidate_paths(&self.bases) {
            if let Ok(stream) = dial(&path) {
                self.socket = Some(stream);
                return Ok(());
            }
        }
        Err(Error::IPCNotFound)
    }

    /// Overrides the trait default so fallthrough happens at the *handshake*
    /// layer. A candidate that connects but fails the handshake is discarded
    /// and the search continues, rather than failing the whole attempt.
    ///
    /// Clears `socket` up front so an `Err` return always means "not
    /// connected"; otherwise a scan that dials nothing would leave the previous
    /// stream in place behind a failure.
    ///
    /// Bounded by [`CONNECT_DEADLINE`]: hundreds of candidates times an
    /// untimed `UnixStream::connect` plus multi-read handshakes is otherwise
    /// unbounded, and this runs on every retry tick and every queued command.
    fn connect(&mut self) -> IpcResult<()> {
        self.socket = None;

        let started = std::time::Instant::now();
        let mut dialled_any = false;

        for path in candidate_paths(&self.bases) {
            if started.elapsed() >= CONNECT_DEADLINE {
                log::debug!("Discord IPC scan hit its deadline at {}", path.display());
                break;
            }

            let stream = match dial(&path) {
                Ok(stream) => stream,
                Err(DialError::Denied) => {
                    report_sandbox_denial(&path);
                    continue;
                }
                Err(DialError::Unavailable) => continue,
            };
            dialled_any = true;
            self.socket = Some(stream);

            if self.handshake_ok() {
                log::info!("Discord IPC connected at {}", path.display());
                return Ok(());
            }

            log::debug!("Discord IPC handshake failed at {}", path.display());
            self.socket = None;
        }

        Err(if dialled_any {
            Error::IPCConnectionFailed
        } else {
            Error::IPCNotFound
        })
    }

    /// Overrides the trait default, which would `close()`, `connect_ipc()` and
    /// `send_handshake()` — the unvalidated first-dialable path, reintroducing
    /// exactly the stale-socket bug [`Self::connect`] exists to fix.
    fn reconnect(&mut self) -> IpcResult<()> {
        self.close().ok();
        self.connect()
    }

    fn write(&mut self, data: &[u8]) -> IpcResult<()> {
        let socket = self.socket.as_mut().ok_or(Error::NotConnected)?;
        socket.write_all(data).map_err(Error::WriteError)
    }

    fn read(&mut self, buffer: &mut [u8]) -> IpcResult<()> {
        let socket = self.socket.as_mut().ok_or(Error::NotConnected)?;
        socket.read_exact(buffer).map_err(Error::ReadError)
    }

    /// Diverges from upstream by clearing the socket, so a later `set_activity`
    /// fails fast with `NotConnected` instead of `EPIPE`. Every caller in
    /// `discord.rs` discards the result, so the extra `Err` is invisible.
    fn close(&mut self) -> IpcResult<()> {
        let _ = self.send(json!({}), 2);
        let socket = self.socket.as_mut().ok_or(Error::NotConnected)?;
        socket.flush().map_err(Error::FlushError)?;
        let _ = socket.shutdown(Shutdown::Both);
        self.socket = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_paths_cover_every_index_and_subpath() {
        let base = PathBuf::from("/run/user/1000");
        let paths = candidate_paths(std::slice::from_ref(&base));

        assert_eq!(paths.len(), 10 * APP_SUBPATHS.len());
        assert_eq!(paths[0], PathBuf::from("/run/user/1000/discord-ipc-0"));
        assert!(paths.contains(&PathBuf::from(
            "/run/user/1000/app/com.discordapp.Discord/discord-ipc-0"
        )));
        assert!(paths.contains(&PathBuf::from(
            "/run/user/1000/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-9"
        )));
    }

    #[test]
    fn the_bare_runtime_dir_is_probed_before_any_app_subpath() {
        let base = PathBuf::from("/run/user/1000");
        let paths = candidate_paths(std::slice::from_ref(&base));

        let bare = paths
            .iter()
            .position(|p| p == &PathBuf::from("/run/user/1000/discord-ipc-0"))
            .unwrap();
        let sub = paths
            .iter()
            .position(|p| {
                p == &PathBuf::from("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0")
            })
            .unwrap();
        assert!(bare < sub, "native Discord's path must be tried first");
    }

    #[test]
    fn snap_searches_the_real_runtime_dir_and_its_own_private_one() {
        let dirs = snap_runtime_dirs("/run/user/1000/snap.sone");

        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/run/user/1000"),
                PathBuf::from("/run/user/1000/snap.sone"),
            ],
            "the private dir is where a relay socket has to live, and strict \
             confinement lets us connect to nothing else"
        );
    }

    #[test]
    fn snap_runtime_dirs_rejects_a_value_with_no_parent() {
        assert!(snap_runtime_dirs("snap.sone").is_empty());
        assert!(snap_runtime_dirs("/run").is_empty());
    }

    use std::os::unix::net::UnixListener;

    /// Read one length-prefixed IPC frame, discarding its body.
    fn read_frame(s: &mut UnixStream) -> Option<()> {
        let mut header = [0u8; 8];
        s.read_exact(&mut header).ok()?;
        let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let mut body = vec![0u8; len];
        s.read_exact(&mut body).ok()
    }

    fn write_frame(s: &mut UnixStream, opcode: u32, body: &[u8]) {
        let _ = s.write_all(&opcode.to_le_bytes());
        let _ = s.write_all(&(body.len() as u32).to_le_bytes());
        let _ = s.write_all(body);
    }

    /// Serve handshakes with the frame real Discord sends, for as long as the
    /// test runs. Accepted streams are held open so the client's socket stays
    /// valid after the handshake.
    ///
    /// The receiver fires once per answered handshake, so a test can assert
    /// *which* peer a connect attempt actually landed on, and how many times.
    fn spawn_fake_discord_reporting(listener: UnixListener) -> std::sync::mpsc::Receiver<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            while let Ok((mut s, _)) = listener.accept() {
                if read_frame(&mut s).is_none() {
                    continue;
                }
                write_frame(
                    &mut s,
                    1,
                    br#"{"cmd":"DISPATCH","data":{"v":1},"evt":"READY","nonce":null}"#,
                );
                // A dropped receiver just means the test only wanted a live
                // peer, not a report; keep serving either way.
                let _ = tx.send(());
                held.push(s);
            }
        });
        rx
    }

    fn spawn_fake_discord(listener: UnixListener) {
        drop(spawn_fake_discord_reporting(listener));
    }

    /// Accept connections, read the handshake, then answer CLOSE (opcode 2)
    /// instead of READY — a peer that is dialable but deliberately rejects the
    /// handshake, as opposed to one that never answers at all. Serves
    /// repeatedly so it stays an impostor across more than one scan.
    fn spawn_impostor(listener: UnixListener) {
        std::thread::spawn(move || {
            while let Ok((mut s, _)) = listener.accept() {
                if read_frame(&mut s).is_none() {
                    continue;
                }
                write_frame(&mut s, 2, br#"{"code":4000,"message":"impostor"}"#);
            }
        });
    }

    #[test]
    fn dial_skips_a_zero_byte_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("discord-ipc-0");
        std::fs::write(&stale, b"").unwrap();

        assert!(dial(&stale).is_err());
    }

    #[test]
    fn dial_connects_to_a_real_socket() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("discord-ipc-0");
        let _listener = UnixListener::bind(&live).unwrap();

        assert!(dial(&live).is_ok());
    }

    /// The Snap case: the socket is discoverable but policy refuses the
    /// connect. Reproduced here with file permissions rather than AppArmor —
    /// both surface as `ErrorKind::PermissionDenied`, which is what `dial`
    /// branches on. Skipped for root, who is refused nothing.
    #[test]
    fn dial_reports_a_refused_connect_as_denied_not_missing() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("discord-ipc-0");
        let _listener = UnixListener::bind(&live).unwrap();
        std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o000)).unwrap();

        assert!(
            matches!(dial(&live), Err(DialError::Denied)),
            "a sandbox denial must stay distinguishable from an absent socket"
        );
    }

    #[test]
    fn dial_skips_a_dangling_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("discord-ipc-0");
        std::os::unix::fs::symlink(dir.path().join("absent"), &link).unwrap();

        assert!(dial(&link).is_err());
    }

    #[test]
    fn dial_follows_a_symlink_to_a_real_socket() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sock");
        let _listener = UnixListener::bind(&real).unwrap();
        let link = dir.path().join("discord-ipc-0");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(dial(&link).is_ok());
    }

    /// The regression, end to end. Upstream's `find_pipe` commits to index 0
    /// and gives up; this must fall through to the live Discord at index 1.
    #[test]
    fn connect_falls_through_a_stale_entry_to_a_live_discord() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("discord-ipc-0"), b"").unwrap();
        let live = dir.path().join("discord-ipc-1");
        spawn_fake_discord(UnixListener::bind(&live).unwrap());

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(client.connect().is_ok());
    }

    /// A dead socket inode — the reproducible Flatpak failure. `is_socket()`
    /// is true, so only the connect fallthrough can reject it.
    #[test]
    fn connect_falls_through_a_refusing_socket() {
        let dir = tempfile::tempdir().unwrap();
        let dead = dir.path().join("discord-ipc-0");
        drop(UnixListener::bind(&dead).unwrap()); // bound, then no listener
        let live = dir.path().join("discord-ipc-1");
        spawn_fake_discord(UnixListener::bind(&live).unwrap());

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(client.connect().is_ok());
    }

    /// The fallthrough must also happen at the *handshake* layer, not just at
    /// `dial`'s stat/connect filters: an impostor that connects and answers
    /// CLOSE at index 0 must not stop the search, and the real Discord at
    /// index 1 must still get used.
    #[test]
    fn connect_falls_through_a_failed_handshake_to_a_live_discord() {
        let dir = tempfile::tempdir().unwrap();
        let impostor = dir.path().join("discord-ipc-0");
        spawn_impostor(UnixListener::bind(&impostor).unwrap());
        let live = dir.path().join("discord-ipc-1");
        spawn_fake_discord(UnixListener::bind(&live).unwrap());

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(client.connect().is_ok());
    }

    /// A peer that accepts and never answers must not wedge the thread.
    /// Without the read timeout in `dial`, this test hangs forever.
    #[test]
    fn connect_gives_up_on_a_silent_peer() {
        let dir = tempfile::tempdir().unwrap();
        let silent = dir.path().join("discord-ipc-0");
        let listener = UnixListener::bind(&silent).unwrap();
        std::thread::spawn(move || {
            let _held = listener.accept();
            std::thread::sleep(std::time::Duration::from_secs(30));
        });

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(client.connect().is_err());
    }

    #[test]
    fn connect_reports_not_found_when_nothing_is_dialable() {
        let dir = tempfile::tempdir().unwrap();

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(matches!(client.connect(), Err(Error::IPCNotFound)));
    }

    /// Each silent peer costs a whole `HANDSHAKE_READ_TIMEOUT`, and a real
    /// environment offers hundreds of candidates. `CONNECT_DEADLINE` has to
    /// bound the entire scan, not one candidate within it.
    #[test]
    fn connect_stops_scanning_once_the_deadline_passes() {
        const SILENT_PEERS: u32 = 8;

        let dir = tempfile::tempdir().unwrap();
        // Bound but never accepted: the kernel backlog completes every connect,
        // so each of these burns a full read timeout and answers nothing.
        let _silent: Vec<UnixListener> = (0..SILENT_PEERS)
            .map(|i| UnixListener::bind(dir.path().join(format!("discord-ipc-{i}"))).unwrap())
            .collect();

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        let started = std::time::Instant::now();
        assert!(client.connect().is_err());
        let elapsed = started.elapsed();

        // Undeadlined this is SILENT_PEERS * HANDSHAKE_READ_TIMEOUT (16s).
        // Deadlined it is CONNECT_DEADLINE plus at most the one candidate that
        // was already in flight. The bound is loose on purpose: it has to fail
        // only when the deadline is genuinely absent, not when CI is busy.
        assert!(
            elapsed < CONNECT_DEADLINE + 2 * HANDSHAKE_READ_TIMEOUT,
            "connect() ran for {elapsed:?}; the deadline did not bound the scan"
        );
        assert!(
            elapsed < SILENT_PEERS * HANDSHAKE_READ_TIMEOUT,
            "connect() ran for {elapsed:?}, as long as an undeadlined full scan"
        );
    }

    /// A failed `connect()` must leave the client disconnected. Without the
    /// up-front clear, a scan that dials nothing never enters the loop body and
    /// silently keeps the previous stream behind an `Err` return.
    #[test]
    fn a_failed_connect_drops_the_previous_socket() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("discord-ipc-0");
        spawn_fake_discord(UnixListener::bind(&live).unwrap());

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(client.connect().is_ok());

        std::fs::remove_file(&live).unwrap();
        assert!(matches!(client.connect(), Err(Error::IPCNotFound)));

        // `close()` reports `NotConnected` only when no socket is held.
        assert!(matches!(client.close(), Err(Error::NotConnected)));
    }

    /// `reconnect()` must not fall back to the trait default, which dials the
    /// first connectable candidate without proving it speaks Discord. The
    /// impostor at index 0 would satisfy that path; only the validating
    /// `connect()` reaches the real peer at index 1.
    #[test]
    fn reconnect_routes_through_the_validating_connect() {
        let dir = tempfile::tempdir().unwrap();
        let impostor = dir.path().join("discord-ipc-0");
        spawn_impostor(UnixListener::bind(&impostor).unwrap());
        let live = dir.path().join("discord-ipc-1");
        let handshaken = spawn_fake_discord_reporting(UnixListener::bind(&live).unwrap());

        let mut client = SoneDiscordClient::with_bases("123", vec![dir.path().to_path_buf()]);
        assert!(client.connect().is_ok());
        assert!(handshaken.recv_timeout(Duration::from_secs(5)).is_ok());

        // The trait default would `close()` + `connect_ipc()` + a blind
        // `send_handshake()`, land on the impostor, and still report `Ok` — so
        // the real assertion is that the *live* peer saw a second handshake.
        assert!(client.reconnect().is_ok());
        assert!(
            handshaken.recv_timeout(Duration::from_secs(5)).is_ok(),
            "reconnect() stopped at the impostor instead of validating candidates"
        );
    }
}
