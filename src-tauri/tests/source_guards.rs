//! Invariants about where certain code may appear. Cheap, and they catch the
//! classes of regression that runtime tests structurally cannot: a test can
//! observe what a proxied client *does*, but not that a second, unproxied one
//! was built somewhere else in the tree.
//!
//! Known limits of these guards, so nobody mistakes them for more than they are:
//!
//! - The exemptions are keyed on **basename**, not path. A future
//!   `src/mcp/proxy_http.rs` or `src/commands/audio.rs` would inherit the
//!   exemption from anywhere in the tree, and this crate already has duplicate
//!   basenames (`mod.rs` several times over). Tighten to a full relative path
//!   the day a second file wants one of these names.
//! - Only `src/` is scanned. `src-tauri/tests/` and any build script are
//!   unguarded; a stray client built in a test helper would not be caught.
//! - This is substring matching over source text, not parsing. It raises the
//!   cost of a bypass; it does not make one impossible.
//! - Specific to `the_startup_proxy_scrub_stays_gated_on_the_launch_sidecar`,
//!   and accepted rather than chased: the guard matches the literal prefix
//!   `if should_scrub_proxy_env(` without inspecting the argument, so a
//!   hand-written `if should_scrub_proxy_env(Some((true, "http".into())))`
//!   passes while scrubbing unconditionally;
//!   `SCRUBBED_PROXY_ENV_VARS.iter().take(1)`
//!   passes; and renaming the loop's binding breaks the guard, though it fails
//!   red rather than green. Every one of those takes deliberate effort, and a
//!   substring guard is the wrong tool for stopping an author who is trying.
//!   These guards exist to catch the accidental deletion and the innocent
//!   refactor.
//! - Same test: it reads `without_comments(&body)`, so the commented-out decoy
//!   `remember_scrubbed_env(` inside the gate — which used to satisfy both
//!   capture assertions while the live call sat below the removal loop — no
//!   longer counts. What is still accepted is that those assertions locate a
//!   *first* occurrence rather than counting them, so a second live capture
//!   call would go unchecked.
//! - `the_mirrored_reqwest_major_version_is_still_what_we_pin` matches the
//!   literal `0.11`, so pinning the dependency exactly (`version = "0.11.27"`)
//!   fails it spuriously. Red rather than green, so it is safe — just noisy,
//!   and the fix is to widen the match when someone actually pins that way.
//! - The `audio.rs` pair (`audio_does_not_decide_proxy_policy_for_itself`,
//!   `the_proxy_hook_is_attached_once_per_pipeline`) reads only the half of the
//!   file above its `#[cfg(test)]`, so the boundary is load-bearing. Moving it
//!   up silently unguards everything below, which is why
//!   `audio_rs_production_source` asserts there is exactly one such attribute
//!   rather than trusting the `find`. Adding a second one fails loudly there.
//! - `the_proxy_hook_is_attached_once_per_pipeline` strips comments before
//!   counting, because the same commented-decoy hole documented above for
//!   `remember_scrubbed_env` was live here: a refactor note naming
//!   `watch_pipeline_sources(&pipe, route);` stood in for the deleted call and
//!   the suite stayed green. `without_comments` removes `//` to end of line and
//!   `/* … */` blocks entire — line-granular stripping left both the trailing
//!   `// …` and the block form working, each measured green with a clean
//!   `cargo check` while `build_appsink_pipeline` attached no hook at all.
//! - Its sibling `audio_does_not_decide_proxy_policy_for_itself` is **not**
//!   comment-stripped, and that is a choice rather than an oversight. It is the
//!   only guard covering where proxy policy is decided, so a decoy there would
//!   have nothing behind it; a production doc comment naming `ProxyType::Http`
//!   therefore fails it — red, and fixed by rewording the comment. Red-not-green
//!   was preferred to permitting a decoy in the one guard nothing else backs up.
//! - `the_proxy_hook_is_attached_once_per_pipeline` matches the literal binding
//!   `&pipe`, so a hook threaded through a differently-named variable stops
//!   being counted — but that moves the hooks count alone, so it fails red
//!   against an unchanged `pipelines`. The spelling that moves *both* counts is
//!   `gst::Pipeline::builder()`, and the `pipelines == 2` backstop is what
//!   catches it.
//! - `the_unproxied_http_source_selection_still_prefers_soup_over_curl` reads
//!   the host's plugin registry, not our source. It cannot observe SONE's audio
//!   path — no line of it runs in this binary — and is a statement about the
//!   default `promote_curl_source` restores to, nothing more.
//!
//! Still owed, and deliberately not guarded here: no `window.open` fallbacks in
//! the frontend. `src/components/Login.tsx` has five live ones, each a `catch`
//! after `openUrl` from `@tauri-apps/plugin-opener` fails, and a `window.open`
//! escapes the proxied transport entirely. Removing them is a frontend task;
//! adding the guard before that lands would only break a green suite. When they
//! are gone, guard it — the natural home is a frontend lint, since these tests
//! scan Rust only.

use std::fs;
use std::path::{Path, PathBuf};

fn rust_sources() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(dir).expect("read_dir").flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(Path::new("src"), &mut out);
    out
}

fn file_name(p: &Path) -> String {
    p.file_name().unwrap().to_string_lossy().to_string()
}

/// Does `body` mention `ident` as its own path segment?
///
/// Plain `body.contains("Client::new")` is useless here: `TidalClient::new` and
/// `DiscordIpcClient::new` both contain it, and `ScreenSaverProxy::new` (six
/// zbus proxies in `idle_inhibit/dbus.rs`) contains `Proxy::new`. Requiring the
/// preceding byte not to be an identifier character keeps `reqwest::Client::new`
/// and a bare `Client::new` while dropping `SomethingClient::new` — which is
/// the distinction the guards actually care about.
fn mentions_path_segment(body: &str, ident: &str) -> bool {
    body.match_indices(ident).any(|(at, _)| {
        at == 0
            || !body.as_bytes()[..at]
                .last()
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
    })
}

/// A guard whose glob matched nothing is worse than no guard, so prove the walk
/// reaches the files every other test in here reasons about — including nested
/// ones, since losing the `is_dir()` recursion would still leave the 21
/// top-level files and a green suite while `commands/`, `mcp/`, `scrobble/` and
/// `tidal_report/` went unscanned. That is exactly where a stray client lives.
#[test]
fn the_source_walk_recurses_and_sees_the_files_these_guards_are_about() {
    let sources = rust_sources();
    assert!(
        sources.len() > 40,
        "source walk found only {} files; src/ has 21 at the top level and 42 \
         below it, so this many means the recursion is gone or the walk is not \
         rooted at src-tauri/src",
        sources.len()
    );
    for expected in ["main.rs", "audio.rs", "proxy.rs", "proxy_http.rs", "lib.rs"] {
        assert!(
            sources.iter().any(|p| file_name(p) == expected),
            "source walk never reached {expected}; these guards are vacuous"
        );
    }
    // Nested, and one of them three levels deep, so a single-level walk fails.
    for expected in [
        "commands/overlay.rs",
        "scrobble/musicbrainz.rs",
        "tidal_report/event.rs",
        "mcp/tools/catalog.rs",
    ] {
        assert!(
            sources
                .iter()
                .any(|p| p.to_string_lossy().replace('\\', "/").ends_with(expected)),
            "source walk never reached {expected}; it is not recursing, so every \
             other guard here silently skips the subdirectories"
        );
    }
}

/// Every `reqwest::Client` in this process must come from `proxy_http.rs`,
/// because a client built anywhere else has no proxy attached and egresses
/// direct — the silent degradation this whole design exists to prevent.
///
/// The import is guarded as well as the call. `use reqwest::Client;` is what
/// makes a bare `Client::new()` compile, so refusing the import is the cheapest
/// place to stop it; the alternative is chasing every spelling
/// (`reqwest::blocking::Client::new`, `ClientBuilder::new`, an aliased import)
/// through substring matching forever.
#[test]
fn proxy_objects_and_http_clients_are_built_only_in_proxy_http() {
    for f in rust_sources() {
        if file_name(&f) == "proxy_http.rs" {
            continue;
        }
        let body = fs::read_to_string(&f).unwrap();

        for line in body.lines() {
            let t = line.trim_start();
            if t.starts_with("use reqwest::") && (t.contains("Client") || t.contains("Proxy")) {
                panic!(
                    "{}: `{}` — importing reqwest's Client or Proxy here is what \
                     makes an unproxied `Client::new()` possible. Spell the type \
                     `reqwest::Client` inline if a signature needs it; build it \
                     in proxy_http.rs.",
                    f.display(),
                    t.trim_end()
                );
            }
        }

        // `Client::default` is not padding: reqwest's Default impl is literally
        // `Self::new()` for both the async and blocking clients, so it builds a
        // fully functional unproxied client.
        for ident in [
            "Proxy::",
            "Client::builder",
            "Client::new",
            "Client::default",
            "ClientBuilder",
        ] {
            assert!(
                !mentions_path_segment(&body, ident),
                "{}: `{ident}` here bypasses the proxy plan and silently \
                 egresses direct; build it in proxy_http.rs",
                f.display()
            );
        }
    }
}

/// Every request the API client makes must go through `TidalClient::dispatch`.
///
/// `dispatch` is where a transport failure is recorded against the proxy that
/// carried it, so a `.send()` added anywhere else in that file is not a bug you
/// would see: the request works, the failure surfaces as it always did, and the
/// only thing lost is the observation — silently, for exactly the requests the
/// pre-login banner exists to explain.
///
/// Substring matching over source text, with the same limits as its siblings.
/// Comment lines are stripped, so the doc comment on `dispatch` (which names
/// `.send()` deliberately) does not count itself; a `.send()` hidden inside a
/// macro or spelled `send ()` would pass.
///
/// Falsified on both halves, because a guard that counts to one is vacuous if
/// its anchor has been renamed out from under it: the `dispatch` signature must
/// still be there, and the one surviving call must still be the one that hands
/// its outcome to `observe_at`.
#[test]
fn the_api_clients_requests_are_sent_in_exactly_one_place() {
    let f = rust_sources()
        .into_iter()
        .find(|p| file_name(p) == "tidal_api.rs")
        .expect("tidal_api.rs must be in the walk, or this guard is vacuous");
    let body = fs::read_to_string(&f).unwrap();

    assert!(
        body.contains("async fn dispatch("),
        "{}: `dispatch` is gone or renamed; this guard now proves nothing",
        f.display()
    );

    let sends: Vec<&str> = body
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .filter(|l| l.contains(".send()"))
        .collect();

    assert_eq!(
        sends.len(),
        1,
        "{}: {} `.send()` sites, expected exactly one (inside `dispatch`). \
         A request sent anywhere else loses the proxy observation: {:?}",
        f.display(),
        sends.len(),
        sends
    );
    assert!(
        sends[0].contains("observe_at("),
        "{}: the one `.send()` no longer reports to the cell: `{}`",
        f.display(),
        sends[0].trim()
    );
}

/// `Url::set_port` is a trap for proxy URIs: it drops the port from the
/// serialized string whenever it equals the scheme default, so an HTTP proxy on
/// port 80 turns into `http://host/` and the port is lost. URIs are built by
/// concatenation in `proxy.rs` instead.
///
/// `Url::parse` is the same trap one step earlier and is banned with it, which
/// is what the spec asked for: `Url::parse("http://h:80/")` normalises the port
/// away on its own, so reaching for it to "validate" a proxy URI reintroduces
/// the defect without ever calling the setter. The damage is invisible to a
/// string comparison — libcurl was measured dialling 1080 — so the lint is the
/// guard, not a test of the output.
///
/// The ban is global. `audio.rs` used to be exempt while its
/// `gstreamer_proxy_uri` helper *was* that defect; the helper is gone, so
/// there is no allowlist left to re-read.
#[test]
fn the_url_port_manglers_are_banned_outright() {
    let mut offenders = Vec::new();

    for f in rust_sources() {
        let body = fs::read_to_string(&f).unwrap();
        // `Url::parse` as a path segment, so `TidalUrl::parse` and the like do
        // not trip it; `.set_port(` needs no such care.
        if !body.contains(".set_port(") && !mentions_path_segment(&body, "Url::parse") {
            continue;
        }
        offenders.push(f.display().to_string());
    }

    assert!(
        offenders.is_empty(),
        "{offenders:?}: Url::set_port and Url::parse both drop a port equal \
         to the scheme default; build URIs by concatenation in proxy.rs."
    );
}

/// Mutating the environment is unsound once GTK/glib have threads, and glib
/// reads these back through `g_getenv` only after those threads exist. `main()`
/// runs single-threaded before `tauri_app_lib::run()`, so it is the only sound
/// place for it.
///
/// This checks location, not ordering: it cannot tell whether the call in
/// `main.rs` actually precedes `run()`. Reviewing that is still on you.
#[test]
fn environment_is_mutated_only_in_main() {
    for f in rust_sources() {
        if file_name(&f) == "main.rs" {
            continue;
        }
        let body = fs::read_to_string(&f).unwrap();
        for needle in ["env::set_var", "env::remove_var"] {
            assert!(
                !body.contains(needle),
                "{}: {needle} is unsound once GTK/glib threads exist; move it to main.rs",
                f.display()
            );
        }
    }
}

/// The scrub must stay *gated*. `environment_is_mutated_only_in_main` above
/// asserts where the mutation may live, never that it is conditional — so
/// inverting the `if`, deleting it, or pointing the loop at a different array
/// leaves that guard, and every runtime test, green. `should_scrub_proxy_env`
/// is pure and well covered, but nothing else ties it to the call site.
///
/// The failure this catches is the one the whole design exists to prevent:
/// scrubbing while the user's proxy toggle is off deletes the system proxy
/// configuration of someone behind a corporate proxy, and their traffic
/// silently goes direct.
///
/// Lexical containment is checked by counting braces from the gate's own
/// block, not by proximity, so a `remove_var` moved out of the `if` and left
/// sitting next to it still fails.
#[test]
fn the_startup_proxy_scrub_stays_gated_on_the_launch_sidecar() {
    // Comments stripped, so a plausible refactor note cannot stand in for a
    // deleted call — the hole that was live here for `remember_scrubbed_env(`,
    // and the same one `the_proxy_hook_is_attached_once_per_pipeline` was
    // defeated through. It also removes the only text `block_of` could have
    // miscounted braces in.
    let body = without_comments(&fs::read_to_string("src/main.rs").expect("src/main.rs"));
    let body = body.as_str();

    let removals = body.match_indices("env::remove_var").count();
    assert_eq!(
        removals, 1,
        "src/main.rs has {removals} `env::remove_var` calls; this guard reasons \
         about exactly one, so a second would be unchecked"
    );
    let removal = body.find("env::remove_var").unwrap();

    // A negated or renamed condition does not match, which is the point: the
    // inverted gate fails here rather than silently passing containment.
    //
    // Counted before it is located, because everything below reasons about the
    // *first* occurrence. `should_record_launch_bypass` spells its own use
    // `!should_scrub_proxy_env(`, which does not match — but anyone who later
    // rewrites that as an `if` above this point silently moves the anchor, and
    // the containment assertions start proving things about the wrong block
    // while staying green.
    let gates = body.match_indices("if should_scrub_proxy_env(").count();
    assert_eq!(
        gates, 1,
        "src/main.rs has {gates} `if should_scrub_proxy_env(` sites; everything \
         below anchors on the first, so a second one moves this guard onto a \
         block it was never written about"
    );
    let gate = body.find("if should_scrub_proxy_env(").unwrap_or_else(|| {
        panic!(
            "no `if should_scrub_proxy_env(` in src/main.rs: the startup scrub \
             is ungated, negated, or renamed. It must run only when the launch \
             sidecar says SONE is proxying — `Direct` means the system's own \
             configuration applies and must be left alone."
        )
    });

    let loop_at = body
        .find("for v in tauri_app_lib::proxy::SCRUBBED_PROXY_ENV_VARS")
        .unwrap_or_else(|| {
            panic!(
                "the scrub loop in src/main.rs does not iterate \
                 `tauri_app_lib::proxy::SCRUBBED_PROXY_ENV_VARS`: that array \
                 is the audited removal list, and a different one scrubs the \
                 wrong variables — `PROXY_ENV_VARS` in particular is the wider \
                 capture list, and removing all of it downgrades the surfaces \
                 no stage has taken over yet"
            )
        });

    assert!(
        block_of(&body, gate).contains(&removal),
        "src/main.rs: `env::remove_var` is not inside the \
         `if should_scrub_proxy_env(...)` block. Sitting beside the gate is not \
         being gated — it scrubs on every launch."
    );
    assert!(
        block_of(&body, loop_at).contains(&removal),
        "src/main.rs: `env::remove_var` is not inside the `for v in \
         SCRUBBED_PROXY_ENV_VARS` loop, so it is removing something other \
         than the audited list"
    );

    // The capture is the same shape of hole one level down: deleting it, or
    // moving it after the loop, leaves every runtime test green because the
    // `proxy_http` tests supply the captured values explicitly. Losing it means
    // a user who turns SONE's proxy off mid-session has their system proxy
    // configuration simply gone for the rest of the session.
    let capture = body
        .find("proxy::remember_scrubbed_env(")
        .unwrap_or_else(|| {
            panic!(
                "src/main.rs never calls `remember_scrubbed_env`: the values \
                 about to be removed are the user's own proxy configuration, \
                 and the `Direct` route hands them back. Without the capture \
                 turning SONE's proxy off mid-session sends their traffic \
                 direct instead of through their system's proxy."
            )
        });
    assert!(
        block_of(&body, gate).contains(&capture),
        "src/main.rs: `remember_scrubbed_env` is outside the \
         `if should_scrub_proxy_env(...)` block, so it records an environment \
         nothing is about to remove"
    );
    assert!(
        capture < removal,
        "src/main.rs: `remember_scrubbed_env` runs at byte {capture}, after the \
         `env::remove_var` at {removal}. Capturing after removal captures \
         nothing — it must read the variables while they are still set."
    );
}

/// The byte range of the `{ … }` block that opens after `from`, brace-counted.
///
/// Good enough for this file and no more: it does not know about braces inside
/// strings, comments or char literals. `main.rs` has none between these gates
/// and their bodies, and the guard is about raising the cost of an ungated
/// scrub, not about parsing Rust.
fn block_of(body: &str, from: usize) -> std::ops::Range<usize> {
    let bytes = body.as_bytes();
    let open = from
        + body[from..]
            .find('{')
            .expect("a gate with no block in src/main.rs");
    let mut depth = 0usize;
    for (i, b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return open..i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces from byte {from} in src/main.rs");
}

/// `remember_launch_bypass` is `pub`, and its one-caller rule lives only in a
/// doc comment. Nothing stops a second call, and a second call is not a merge
/// conflict — it is a `OnceLock` whose FIRST write wins for the whole process.
///
/// The damage lands in the test suite before it lands in the app. `proxy.rs`'s
/// tests and `audio.rs`'s tests run in one process, and `AudioProxy::new`
/// snapshots `launch_bypass_was_set()` at construction — so one call from
/// anywhere, a test helper included, turns roughly ten `AudioProxy` tests red
/// depending on the order the harness happened to run them in, which is the
/// worst possible failure to hand somebody.
///
/// Scanning `src/` only, like every guard here, so a call added under
/// `src-tauri/tests/` is still unguarded.
#[test]
fn the_launch_bypass_is_recorded_from_exactly_one_place() {
    const DEF: &str = "pub fn remember_launch_bypass(";
    const USE: &str = "remember_launch_bypass(";

    let mut defined = 0usize;
    let mut callers: Vec<String> = Vec::new();
    for f in rust_sources() {
        // Comments stripped, or `audio.rs`'s doc comment explaining this very
        // rule counts as a violation of it.
        let body = without_comments(&fs::read_to_string(&f).unwrap());
        let defs = body.matches(DEF).count();
        defined += defs;
        for _ in 0..(body.matches(USE).count() - defs) {
            callers.push(f.display().to_string().replace('\\', "/"));
        }
    }

    assert_eq!(
        defined, 1,
        "expected exactly one `remember_launch_bypass` definition under src/, \
         found {defined}; this guard subtracts the definition from its call \
         count and now has the wrong anchor"
    );
    assert_eq!(
        callers.len(),
        1,
        "`remember_launch_bypass` is called {} times under src/: {callers:?}. \
         It writes a `OnceLock` whose first write wins for the process, and \
         `AudioProxy::new` reads it at construction — a second caller silently \
         decides the answer for every `AudioProxy` built afterwards, tests \
         included.",
        callers.len()
    );
    assert!(
        callers[0].ends_with("src/main.rs"),
        "`remember_launch_bypass` is called from {}, not src/main.rs. It has to \
         run before any thread exists and while the environment it is reading \
         is still the one the user's shell set — `main()` before \
         `tauri_app_lib::run()` is the only place that is true.",
        callers[0]
    );
}

/// The proxy save must claim its position in the client cell's write order
/// beside the write to disk, not inside the closure that builds the client.
///
/// Both orderings type-check and both pass every runtime test, because the
/// difference only shows under two overlapping saves. Claiming inside
/// `spawn_blocking` makes the cell's order the order in which the blocking
/// pool happened to run the closures, so a save that persisted an enabled
/// proxy can be overwritten in the cell by an earlier save's `Direct` client —
/// the user reads "proxy on" and egresses from their real address.
///
/// Lexical containment again: a `claim()` moved back inside the closure is
/// what this catches, and proximity would not.
#[test]
fn the_proxy_save_claims_its_generation_beside_the_write_not_inside_the_build() {
    let body = fs::read_to_string("src/commands/utility.rs").expect("src/commands/utility.rs");

    let claims = body.match_indices(".claim()").count();
    assert_eq!(
        claims, 1,
        "src/commands/utility.rs has {claims} `.claim()` calls; this guard          reasons about exactly one, so a second would be unchecked"
    );
    let claim = body.find(".claim()").unwrap_or_else(|| {
        panic!(
            "no `.claim()` in src/commands/utility.rs: the proxy save is back              to letting `apply` claim for itself, which puts the cell's write              order back in the hands of the blocking pool"
        )
    });

    // The call, not the word: the comment above the claim explains the hazard
    // in terms of `spawn_blocking`, and matching that would find the prose.
    let spawn = body.find("tokio::task::spawn_blocking(").unwrap_or_else(|| {
        panic!(
            "no `tokio::task::spawn_blocking(` in src/commands/utility.rs: the              client build has moved, and this guard no longer knows where the              claim must sit relative to it"
        )
    });
    assert!(
        claim < spawn,
        "src/commands/utility.rs: `.claim()` is inside or after the          `spawn_blocking` call, so the cell is ordered by whichever build          reached the pool first rather than by which save reached disk first"
    );

    let persist = body.find("persist(settings)?").unwrap_or_else(|| {
        panic!(
            "no `persist(settings)?` in src/commands/utility.rs: the save no              longer runs before the reconfigure"
        )
    });
    assert!(
        persist < claim,
        "src/commands/utility.rs: the generation is claimed before the          settings are persisted, so the cell's order can still disagree with          the order the files were written in"
    );
}

/// `proxy::system_proxy_from_env` is a deliberate mirror of one reqwest
/// release. 0.11.27 applies `ALL_PROXY` last and lets it overwrite
/// `HTTP_PROXY`/`HTTPS_PROXY`; 0.12 reversed that. Our copy reproduces
/// 0.11.27 on purpose — restoring a scrubbed environment has to send the
/// user's traffic where their own configuration was already sending it, not
/// where a better rule would.
///
/// So a major bump is a behaviour change in that function, not a dependency
/// update, and must not land silently. This fails the suite when the pin moves,
/// which is the prompt to re-read `get_from_environment` in the new release and
/// update both the mirror and its doc comment.
#[test]
fn the_mirrored_reqwest_major_version_is_still_what_we_pin() {
    let toml = fs::read_to_string("Cargo.toml").expect("src-tauri/Cargo.toml");
    let line = toml
        .lines()
        .find(|l| l.trim_start().starts_with("reqwest"))
        .expect("no reqwest dependency in Cargo.toml");
    assert!(
        line.contains("version = \"0.11\"") || line.contains("reqwest = \"0.11\""),
        "reqwest is pinned as `{}`, but `proxy::system_proxy_from_env` mirrors \
         0.11.27's `get_from_environment` — including the `ALL_PROXY` \
         precedence 0.12 reversed. Re-read that function in the new release, \
         update the mirror and its doc comment, then update this guard.",
        line.trim()
    );
}

/// The production half of `audio.rs`: everything above `#[cfg(test)]`.
///
/// Split deliberately — the module's own tests construct `ProxyType::Http`
/// settings, which is exactly the needle its guard bans in production code.
///
/// The split is only as good as its anchor, so every caller asserts there is
/// exactly one `#[cfg(test)]` first. A second one added partway up the file
/// would move this boundary upwards and silently stop guarding everything
/// below it — a `#[cfg(test)] fn` helper at the top of the file, with live
/// production code under it, was demonstrated leaving both guards green.
fn audio_rs_production_source() -> String {
    let body = fs::read_to_string("src/audio.rs").expect("read audio.rs");
    assert_eq!(
        body.matches("#[cfg(test)]").count(),
        1,
        "audio.rs has more than one #[cfg(test)]; this split now silently \
         unguards everything below the first one — re-anchor before adding \
         another"
    );
    match body.find("#[cfg(test)]") {
        Some(i) => body[..i].to_string(),
        None => body,
    }
}

/// `body` with its comments removed — `//` to end of line, and `/* … */`
/// blocks entire.
///
/// Counting needles in raw source counts them in prose too, which is how a
/// guard gets defeated by a plausible refactor note rather than by a bypass.
/// Dropping whole `//` *lines* was not enough: the same decoy still worked as
/// a trailing `// …` after a live statement, or inside a `/* … */` block, and
/// both were measured green with a clean `cargo check` while
/// `build_appsink_pipeline` attached no proxy hook at all.
///
/// Still not a lexer, and deliberately not one: a `//` inside a string literal
/// (`"https://…"`) truncates that line here. That direction is safe — it can
/// only *remove* text, so a guard that counts needles can only fail red — and
/// `audio.rs`'s production half has no needle sharing a line with a URL.
fn without_comments(body: &str) -> String {
    let no_blocks = {
        let mut out = String::with_capacity(body.len());
        let mut rest = body;
        while let Some(open) = rest.find("/*") {
            out.push_str(&rest[..open]);
            match rest[open + 2..].find("*/") {
                // Keep the newlines, so line-oriented reading downstream is
                // not silently re-flowed by a multi-line comment.
                Some(close) => {
                    let block = &rest[open..open + 2 + close + 2];
                    out.extend(block.chars().filter(|c| *c == '\n'));
                    rest = &rest[open + 2 + close + 2..];
                }
                // Unterminated: everything after it is comment.
                None => return out,
            }
        }
        out.push_str(rest);
        out
    };
    no_blocks
        .lines()
        .map(|l| match l.find("//") {
            Some(at) => &l[..at],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Proxy policy is decided in `proxy.rs` and handed to the audio thread as a
/// `Route`. `audio.rs` reading the settings types back out means it is deciding
/// for itself, and the decision it reaches is not the one the rest of the app
/// is using.
///
/// `reqwest::Url` here is belt-and-braces — `the_url_port_manglers_are_banned_outright`
/// already bans `Url::parse` across all of `src/`, so the two `ProxyType::`
/// needles are this guard's only unique contribution.
#[test]
fn audio_does_not_decide_proxy_policy_for_itself() {
    let body = audio_rs_production_source();
    for needle in ["reqwest::Url", "ProxyType::Http", "ProxyType::Socks5"] {
        assert!(
            !body.contains(needle),
            "audio.rs contains `{needle}` outside its tests: proxy decisions belong in proxy.rs"
        );
    }
}

/// Every pipeline gets the proxy hook, or the sources inside the one that
/// missed it egress from the user's real address while the UI says the proxy
/// is on.
///
/// Comments are stripped before counting, and that is not tidiness: deleting
/// the hook from `build_appsink_pipeline` and leaving a refactor note that
/// mentions `watch_pipeline_sources(&pipe, route);` was measured passing this
/// guard, with `cargo check` clean, while the appsink/DirectAlsa pipeline
/// attached no hook at all. The same decoy written as a trailing `// …` on a
/// live line, or inside a `/* … */` block, was measured passing the
/// line-granular version of the stripper; `without_comments` removes both.
#[test]
fn the_proxy_hook_is_attached_once_per_pipeline() {
    let body = without_comments(&audio_rs_production_source());
    let pipelines = body.matches("gst::Pipeline::new()").count();
    let hooks = body.matches("watch_pipeline_sources(&pipe").count();
    assert_eq!(
        hooks, pipelines,
        "every pipeline needs the hook: a per-element hook was measured \
         leaving the gapless second branch unproxied"
    );
    assert_eq!(
        pipelines, 2,
        "audio.rs is expected to build exactly two pipelines"
    );
}

/// With no proxy, `souphttpsrc` must win HTTP source selection over
/// `curlhttpsrc`, which is true only while soup outranks curl in the registry.
///
/// This asserts the *relation*, not four absolute ranks. An earlier version
/// pinned the measured integers (soup 256, curl 128), which could only ever
/// fail on a distro that re-ranked its own plugins — a red that says nothing
/// about SONE and teaches people to ignore the suite. `promote_curl_source`
/// inverts this relation deliberately when an authenticated route needs curl,
/// and restores it afterwards; that restore is unit-tested in `audio.rs`.
/// What is left for here is the default the restore returns to.
#[test]
fn the_unproxied_http_source_selection_still_prefers_soup_over_curl() {
    use gstreamer::glib::translate::IntoGlib;
    use gstreamer::prelude::PluginFeatureExtManual;

    let _ = gstreamer::init();

    let soup = gstreamer::ElementFactory::find("souphttpsrc")
        .expect("souphttpsrc is the unproxied HTTP source; without it this guard is vacuous");
    let Some(curl) = gstreamer::ElementFactory::find("curlhttpsrc") else {
        // No curl means nothing can outrank soup, and the proxied path has
        // bigger problems that `HostCaps` reports at runtime.
        return;
    };

    let (soup_rank, curl_rank) = (soup.rank().into_glib(), curl.rank().into_glib());
    assert!(
        curl_rank < soup_rank,
        "curlhttpsrc ranks {curl_rank} and souphttpsrc {soup_rank}: with the \
         proxy off curl would win source selection, which is not the path this \
         work promised to leave untouched"
    );
}
