# sone-tiddl Plan

## Goal

Ship the local `tiddl-headless` fork as Sone's private download helper. The
installed helper is named `sone-tiddl`, is not a standalone user application,
and uses Sone's existing TIDAL authentication automatically.

This plan intentionally does not use the upstream `oskvr37/tiddl` project as
the shipped source. The starting source is `/opt/tiddl-headless/tiddl`, at
commit `ce236b7`, which contains the Sone-specific JSONL event protocol,
byte-level progress reporting, and cancellation-safe temporary-file handling.
Upstream remains a source for later merges only.

## Non-Goals

- Do not implement a Rust downloader in this work.
- Do not expose `sone-tiddl` in `PATH` or document it as a user-facing CLI.
- Do not support `sone-tiddl auth login`, a separate TIDAL account, or
  standalone configuration.
- Do not write Sone credentials to `~/.tiddl`, environment variables,
  command-line arguments, logs, JSONL events, or temporary files.
- Do not bundle `ffmpeg` or `ffprobe`; declare and validate them as package
  dependencies instead.

## Source Ownership

1. [x] Import the `tiddl-headless` fork into this repository using `git subtree`:

   ```text
   third_party/tiddl/
   ```

2. Import from the `mikelexp/tiddl` fork's `sone-integration` branch, pinned
   initially to `ce236b7`.

3. Keep the Python project structure intact inside the subtree, including its
   own tests and `pyproject.toml`. Do not place it under `src-tauri`.

4. [x] Add `third_party/tiddl/UPSTREAM.md` containing:

   - The fork URL, branch, and imported commit.
   - The upstream base, initially `oskvr37/tiddl` `v3.4.4`.
   - A summary of Sone-specific behavior: JSONL schema v1, progress byte
     totals, process-group cancellation, and temporary-file cleanup.
   - The exact subtree update procedure.

5. Update the fork in a temporary integration branch first. Merge upstream
   changes there, retain the Sone patches, run its tests, and only then import
   the verified result into Sone's subtree.

## Private Helper Contract

Sone owns the outer download job, UI events, settings, cancellation request,
and persistent authentication. `sone-tiddl` owns TIDAL resource expansion,
manifest handling, file transfer, conversion, tagging, and its own temporary
files.

The process boundary remains JSONL on stdout:

```text
sone-tiddl download --events jsonl [non-secret download options]
```

The existing JSONL schema v1 in `third_party/tiddl/docs/events.md` is the
compatibility contract. It must retain its event names, ordering, terminal
semantics, safe error codes, and rule that no credential, request header, or
signed media URL is emitted.

Sone continues to validate `schema_version == 1`, reject malformed or unknown
events, and relay the existing `download:*` Tauri events without changing the
React queue model.

## Authentication Boundary

`sone-tiddl` is launched only by Sone in an integrated mode.

1. Sone refreshes or validates its TIDAL token before spawning the helper.

2. Sone creates a bidirectional Unix socket pair or equivalent inherited file
   descriptor. It passes the child descriptor only to `sone-tiddl`.

3. The private channel transfers a credential snapshot containing the access
   token, refresh token, OAuth client ID, client secret when required, user ID,
   country code, and non-secret proxy configuration.

4. [x] `sone-tiddl` keeps this snapshot in memory. It must not initialize or read
   `~/.tiddl`, `auth.json`, `config.toml`, API cache directories, or the
   embedded tiddl OAuth credential path in integrated mode.

5. If the helper refreshes credentials, it sends the refreshed state over the
   same private channel. Sone persists it through its existing encrypted
   settings/keyring flow. JSONL remains credential-free.

6. Close the inherited credential descriptor before launching `ffmpeg` or any
   other subprocess so media tools cannot inherit it.

7. [x] Add an internal `SoneAuthProvider` in the Python subtree. Keep the existing
   file/device-code authentication implementation untouched initially but make
   it unreachable from Sone's packaged entrypoint. Remove dead standalone code
   only after the integrated path is stable and its upstream impact is known.

## Python Entrypoint and Scope Reduction

- [x] Create a dedicated internal entrypoint, `sone_tiddl.bridge`, that
only accepts Sone's private launch protocol and JSONL download mode.

The integrated entrypoint must not expose:

- Human Rich output.
- Interactive search or favorites commands.
- Device-code login, logout, or browser launch.
- User-owned config files, default download locations, or API cache settings.

Operational settings are passed by Sone: resource URLs, destination, output
template, quality, filters, skip policy, and proxy behavior. Preserve the
current tiddl-headless download engine and JSONL renderer until a later change
can remove unused CLI/config code without changing download behavior.

## Nuitka Build

1. [x] Add reproducible helper build scripts under:

   ```text
   build-scripts/tiddl/
   ```

2. [x] Build with Python 3.13, required by the imported fork, and pin Nuitka plus
   all Python dependencies used for the release build.

3. [x] Use Nuitka `standalone` mode, not `onefile`. A standalone directory avoids
   extraction into a temporary directory for every download invocation and is
   easier to inspect when a dependency is missing.

4. [x] Compile the private entrypoint as `sone-tiddl`. Include required Python
   extension modules and dependencies such as `aiohttp`, `aiofiles`,
   `pydantic`, `mutagen`, `m3u8`, and the libraries still used after the
   integrated-mode reduction.

5. Build the helper in the package build environment. Verify the resulting
   Debian artifact in the Debian container and the derived Arch artifact in the
   Arch container. Do not assume ABI compatibility without those tests.

6. [x] Install the standalone directory in the package payload at:

   ```text
   /usr/lib/sone/sone-tiddl/
   ```

   The executable is:

   ```text
   /usr/lib/sone/sone-tiddl/sone-tiddl
   ```

7. Add `ffmpeg` and `ffprobe` to Debian, Arch, and RPM package dependencies as
   appropriate. The helper must report a safe structured conversion failure if
   either binary is unavailable.

## Rust Integration

1. Refactor `src-tauri/src/commands/downloads.rs` so executable resolution
   prefers the installed absolute helper path.

2. Keep `SONE_TIDDL_EXECUTABLE` as a development/test override. It is not a
   user-facing compatibility guarantee.

3. Remove the normal dependency check that asks users to install and manually
   authenticate `tiddl-headless`. A missing bundled helper is a packaging error;
   missing Sone authentication is handled by Sone's normal login flow.

4. Preserve one active job, invocation grouping, stdout JSONL parsing, stderr
   redaction, process-group cancellation, and post-download album-cover logic.

5. Add the private credential socket to the spawned child. Never use argv,
   environment variables, standard output, standard error, or disk for secrets.

6. Ensure cleanup closes all parent/child descriptors on normal completion,
   malformed JSONL, spawn failure, cancellation, SIGINT, and SIGKILL fallback.

## Packaging

1. [x] Include the Nuitka output in the Tauri Debian bundle.

2. Verify that the existing Arch packaging flow, which repackages the Debian
   payload, includes the helper and declares its dependencies.

3. [x] Extend RPM packaging with the same helper directory and dependencies.

4. [x] Add Apache-2.0 attribution for the imported tiddl source to Sone's shipped
   notices while preserving Sone's GPL-3.0-only license for Sone code.

5. [x] Do not commit generated packages, Nuitka work directories, compiled helper
   output, or existing build artifacts.

## Tests

### Python

- Preserve and run the imported tiddl-headless test suite.
- Add tests for `SoneAuthProvider` receiving initial state, refreshing state,
  and never reading/writing `~/.tiddl` in integrated mode.
- Add tests proving no secret is written to JSONL, stderr, logs, or temporary
  files.
- Keep tests for JSONL event ordering, byte totals, malformed events, error
  codes, and temporary-file cleanup on interruption.
- Add fixture-based tests for BTS, DASH, and HLS manifest paths used by the
  download engine.

### Rust

- Test packaged-helper resolution and `SONE_TIDDL_EXECUTABLE` override.
- Test the private credential channel without printing its payload.
- Test token-refresh propagation back into Sone's encrypted persistence path.
- Test malformed JSONL, unexpected schema/event, child failure, cancellation,
  and descriptor cleanup.
- Preserve frontend tests for queue construction, event mapping, failures,
  cancellation, and download settings.

### Package Smoke Tests

- Verify the installed helper can execute its non-interactive capability check.
- Verify a Sone-authenticated fixture reaches JSONL startup without a
  `~/.tiddl/auth.json` file.
- Verify missing `ffmpeg` becomes a safe structured error.
- Verify SIGINT cancellation removes only the helper's `.tiddl-part-*` files.
- Verify Debian, Arch, and RPM artifact contents, permissions, and dynamic
  library dependencies.

## Documentation and UX

1. Update download settings and error messages to say that downloads use the
   bundled Sone helper and the active Sone account.

2. Remove instructions telling users to install `tiddl-headless` or run
   `tiddl auth login`.

3. Document that `ffmpeg` is required by the package and that Sone-tiddl is an
   internal implementation detail, not a separately supported CLI.

4. Retain clear notices about TIDAL terms, copyright, and personal-use
    responsibility.

## Remaining Work

### Rust Integration

- [x] Resolve `/usr/lib/sone/sone-tiddl/sone-tiddl` by default in
  `src-tauri/src/commands/downloads.rs`.
- [x] Retain `SONE_TIDDL_EXECUTABLE` only as a development and test override.
- [x] Remove external `tiddl-headless` discovery and instructions to run
  `tiddl auth login`; report a missing bundled helper as a packaging error.
- [x] Create the inherited private credential socket, send the Sone credential
  snapshot, receive refreshed state, and persist it through Sone's encrypted
  settings flow.
- [x] Close parent and child credential descriptors on every completion,
  malformed-event, spawn-failure, cancellation, SIGINT, and SIGKILL path.
- [x] Preserve JSONL schema validation, event relay, stderr redaction,
  process-group cancellation, invocation grouping, and cover handling.

### Tests

- [x] Run the complete imported `tiddl-headless` Python suite.
- [x] Add Python coverage that proves secrets never reach JSONL, stderr, logs,
  or temporary files.
- [x] Add Python fixture coverage for BTS, DASH, and HLS manifests, JSONL
  errors and ordering, byte totals, and interruption cleanup.
- [ ] Add Rust tests for helper resolution, the executable override, private
  credential transfer, refresh persistence, malformed JSONL, child failures,
  cancellation, and descriptor cleanup.
- [x] Preserve or add frontend tests for queue construction, event mapping,
  failures, cancellation, and download settings.
- [ ] Add installed-package smoke tests for capabilities, authenticated startup
  without `~/.tiddl/auth.json`, missing `ffmpeg`/`ffprobe`, and SIGINT cleanup
  of only `.tiddl-part-*` files.

### Package Verification

- [x] Build the helper and Debian artifact inside the Debian build container.
- [x] Build the derived Arch artifact inside the Arch container and verify it
  contains the helper and declares `ffmpeg`.
- [x] Build and inspect the Fedora RPM artifact.
- [x] Build and inspect the openSUSE RPM artifact.
- [ ] Verify Debian, Arch, and RPM artifact contents, permissions, and dynamic
  library dependencies.
- [ ] Verify missing `ffmpeg` or `ffprobe` is reported as a safe structured
  conversion error.

### Documentation and UX

- [x] Update download settings and errors to identify the bundled helper and
  the active Sone account.
- [x] Remove user documentation that asks users to install `tiddl-headless` or
  authenticate it separately.
- [x] Document `ffmpeg`/`ffprobe` as package requirements and `sone-tiddl` as
  an unsupported internal implementation detail.
- [x] Retain TIDAL terms, copyright, and personal-use notices.

### Verified

- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 132 passed.
- `third_party/tiddl/.venv/bin/python -m pytest`: 120 passed.
- `pnpm test`: 209 passed.
- `pnpm build`: passed.

## Commit Sequence

1. Import `tiddl-headless` subtree, upstream metadata, and license notices.
2. Add the internal Sone authentication provider and private entrypoint with
   Python tests.
3. Add reproducible Nuitka standalone build and package smoke tests.
4. Include the helper and `ffmpeg` dependencies in Debian, Arch, and RPM
   packaging.
5. Integrate packaged helper resolution and the private credential channel in
   Rust with tests.
6. Update frontend/backend messaging and documentation.

## Acceptance Criteria

- A normal official Sone package downloads without an external Python install,
  a `tiddl` PATH entry, or a second TIDAL login.
- The package executes only the bundled `sone-tiddl` helper by default.
- No Sone credential is persisted in plaintext or exposed through command-line
  arguments, environment variables, logs, JSONL, or child media processes.
- Download queue behavior, JSONL schema v1 validation, progress updates,
  cancellation, tagging, conversion, and cover handling retain their current
  behavior.
- The `tiddl-headless` source can be updated from its upstream lineage through
  a documented and tested subtree workflow.
