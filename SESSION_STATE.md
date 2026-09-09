# Session State

Updated: 2026-08-23

## Goal

Make Sone download TIDAL tracks as FLAC lossless when the download quality is
`max`, instead of silently producing AAC 320 kbps.

## Diagnosis

- Test album: `https://tidal.com/album/18813060`.
- Sone produced a real AAC `.m4a` file at 320 kbps.
- `/opt/tiddl/.venv/bin/tiddl --track-quality max` produced FLAC 16-bit/44.1 kHz
  for the same album and TIDAL account.
- Both clients use user `37584902`.
- `max` already maps to `HI_RES_LOSSLESS`.
- FLAC extraction, DASH parsing, and filename/container handling were not the
  cause.
- TIDAL can return a successful `HIGH`/AAC response when the client asks for
  `HI_RES_LOSSLESS`; the downloader previously accepted that downgrade without
  retrying.

## Changes Made

### `third_party/tiddl/tiddl/cli/commands/download/downloader.py`

- Added `Downloader.get_track_stream()`.
- When `track_quality` is `HI_RES_LOSSLESS` and the response is `HIGH`, it
  retries with `LOSSLESS`.
- It uses the retry only when the retry response is `LOSSLESS` or
  `HI_RES_LOSSLESS`; otherwise it keeps the original response.
- Download code now uses this method.

### `third_party/tiddl/tests/cli/commands/download/test_downloader.py`

- Added a test verifying `HI_RES_LOSSLESS -> LOSSLESS` fallback behavior.

### Existing changes from earlier work

- Added AAC/FLAC extraction tests in
  `third_party/tiddl/tests/core/utils/test_ffmpeg.py`.
- Updated `build-scripts/build/pacman.sh` to remove stale packages, require
  exactly one package, and verify the packaged helper contains `extract_flac`.

## Verification

- Tiddl test suite: `129 passed`.
- `git diff --check`: passed.
- Nuitka helper build was attempted twice with
  `./build-scripts/tiddl/build.sh /tmp/sone-tiddl-verify`.
- Both builds timed out during Nuitka C compilation; no new helper or package
  was produced.
- The full Tauri/package build was previously cancelled during Rust compilation.

## Current Worktree Changes

- `build-scripts/build/pacman.sh`
- `third_party/tiddl/tests/cli/commands/download/test_downloader.py`
- `third_party/tiddl/tests/core/utils/test_ffmpeg.py`
- `third_party/tiddl/tiddl/cli/commands/download/downloader.py`
- `SESSION_STATE.md`

## Next Session

1. Rebuild the standalone helper, allowing enough time for Nuitka C compilation:
   `./build-scripts/tiddl/build.sh /tmp/sone-tiddl-verify`
2. Package or launch Sone with the newly built helper.
3. Download album `18813060` using `max`.
4. Verify with `ffprobe` that the result is FLAC and no longer AAC 320 kbps.
5. If it still returns AAC, inspect the two `get_track_stream` responses and
   compare the TIDAL client credentials/auth flow used by Sone and the original
   `/opt/tiddl` installation.

Do not commit generated packages, Nuitka work directories, or build artifacts.
