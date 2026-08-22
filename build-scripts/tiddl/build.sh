#!/usr/bin/env bash
# Build a standalone private helper for inclusion in Linux packages.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PYTHON=${PYTHON:-python3.13}
OUTPUT=${1:-"$ROOT/src-tauri/resources/sone-tiddl"}
BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/sone-tiddl-build.XXXXXX")
trap 'rm -rf "$BUILD_ROOT"' EXIT

"$PYTHON" -m venv "$BUILD_ROOT/venv"
PYTHON="$BUILD_ROOT/venv/bin/python"
"$PYTHON" -m pip install --disable-pip-version-check -r "$ROOT/build-scripts/tiddl/requirements-release.txt"
"$PYTHON" -m pip install --disable-pip-version-check --no-build-isolation --no-deps "$ROOT/third_party/tiddl"

"$PYTHON" -m nuitka \
    --mode=standalone \
    --output-dir="$BUILD_ROOT/output" \
    --output-filename=sone-tiddl \
    --include-package=tiddl \
    --include-package-data=tiddl \
    "$ROOT/build-scripts/tiddl/entrypoint.py"

rm -rf "$OUTPUT"
mkdir -p "$(dirname "$OUTPUT")"
cp -a "$BUILD_ROOT/output/entrypoint.dist" "$OUTPUT"
