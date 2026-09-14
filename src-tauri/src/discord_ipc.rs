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
use std::time::Duration;

use discord_rich_presence::error::Error;
use discord_rich_presence::DiscordIpc;
use serde_json::json;

type IpcResult<T> = std::result::Result<T, Error>;

/// How long a candidate gets to complete the handshake before we move on.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);

/// Directory prefixes, relative to a runtime dir, where a Discord client may
/// publish its IPC socket.
///
/// These mirror the `--filesystem` grants in the Flathub manifest, which lives
/// in the separate `flathub/io.github.lullabyX.sone` repository and cannot be
/// checked from this working tree. Verify against a built package with
/// `flatpak info --show-permissions io.github.lullabyX.sone`.
pub(crate) const APP_SUBPATHS: [&str; 8] = [
    "",
    "app/com.discordapp.Discord/",
    "app/com.discordapp.DiscordCanary/",
    "app/dev.vencord.Vesktop/",
    ".flatpak/com.discordapp.Discord/xdg-run/",
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

/// Runtime directories to search, in priority order.
///
/// Under Snap, `XDG_RUNTIME_DIR` points at the app's private `.../snap.<name>`
/// subdir, so walk one level up to reach the real one. Deduped because
/// `XDG_RUNTIME_DIR` and `TMPDIR` can resolve to the same directory.
pub(crate) fn base_dirs() -> Vec<PathBuf> {
    const KEYS: [&str; 4] = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"];
    let under_snap = std::env::var("SNAP").is_ok();

    let mut out = Vec::new();
    for (idx, key) in KEYS.iter().enumerate() {
        let Ok(val) = std::env::var(key) else {
            continue;
        };
        let path = if under_snap && idx == 0 {
            match val.rsplit_once('/') {
                Some((parent, _)) if !parent.is_empty() => PathBuf::from(parent),
                _ => continue,
            }
        } else {
            PathBuf::from(val)
        };
        if path.is_dir() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
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
pub(crate) fn dial(path: &Path) -> Option<UnixStream> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.file_type().is_socket() {
        return None;
    }
    let stream = UnixStream::connect(path).ok()?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).ok()?;
    Some(stream)
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
    /// defaulted `reconnect()` reaches it, and `discord.rs` never calls that.
    fn connect_ipc(&mut self) -> IpcResult<()> {
        for path in candidate_paths(&self.bases) {
            if let Some(stream) = dial(&path) {
                self.socket = Some(stream);
                return Ok(());
            }
        }
        Err(Error::IPCNotFound)
    }

    /// Overrides the trait default so fallthrough happens at the *handshake*
    /// layer. A candidate that connects but fails the handshake is discarded
    /// and the search continues, rather than failing the whole attempt.
    fn connect(&mut self) -> IpcResult<()> {
        let mut dialled_any = false;

        for path in candidate_paths(&self.bases) {
            let Some(stream) = dial(&path) else {
                continue;
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

    use std::os::unix::net::UnixListener;

    /// Answer one handshake with the frame real Discord sends, then stop.
    fn spawn_fake_discord(listener: UnixListener) {
        std::thread::spawn(move || {
            let Ok((mut s, _)) = listener.accept() else {
                return;
            };
            let mut header = [0u8; 8];
            if s.read_exact(&mut header).is_err() {
                return;
            }
            let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let mut body = vec![0u8; len];
            if s.read_exact(&mut body).is_err() {
                return;
            }
            let ready = br#"{"cmd":"DISPATCH","data":{"v":1},"evt":"READY","nonce":null}"#;
            let _ = s.write_all(&1u32.to_le_bytes());
            let _ = s.write_all(&(ready.len() as u32).to_le_bytes());
            let _ = s.write_all(ready);
            std::thread::sleep(std::time::Duration::from_secs(5));
        });
    }

    /// Accept the connection, read the handshake, then answer CLOSE (opcode 2)
    /// instead of READY — a peer that is dialable but deliberately rejects the
    /// handshake, as opposed to one that never answers at all.
    fn spawn_impostor(listener: UnixListener) {
        std::thread::spawn(move || {
            let Ok((mut s, _)) = listener.accept() else {
                return;
            };
            let mut header = [0u8; 8];
            if s.read_exact(&mut header).is_err() {
                return;
            }
            let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let mut body = vec![0u8; len];
            if s.read_exact(&mut body).is_err() {
                return;
            }
            let close = br#"{"code":4000,"message":"impostor"}"#;
            let _ = s.write_all(&2u32.to_le_bytes());
            let _ = s.write_all(&(close.len() as u32).to_le_bytes());
            let _ = s.write_all(close);
        });
    }

    #[test]
    fn dial_skips_a_zero_byte_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("discord-ipc-0");
        std::fs::write(&stale, b"").unwrap();

        assert!(dial(&stale).is_none());
    }

    #[test]
    fn dial_connects_to_a_real_socket() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("discord-ipc-0");
        let _listener = UnixListener::bind(&live).unwrap();

        assert!(dial(&live).is_some());
    }

    #[test]
    fn dial_skips_a_dangling_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("discord-ipc-0");
        std::os::unix::fs::symlink(dir.path().join("absent"), &link).unwrap();

        assert!(dial(&link).is_none());
    }

    #[test]
    fn dial_follows_a_symlink_to_a_real_socket() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sock");
        let _listener = UnixListener::bind(&real).unwrap();
        let link = dir.path().join("discord-ipc-0");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(dial(&link).is_some());
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
}
