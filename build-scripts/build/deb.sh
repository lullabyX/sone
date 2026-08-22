#!/usr/bin/env bash
# Usage: ./build-scripts/build/deb.sh [--no-cache]
# Output: ./dist/deb/SONE_<version>_amd64.deb
set -euo pipefail

cd "$(dirname "$0")/../.."

export DOCKER_BUILDKIT=1
IMAGE="sone-deb-builder"
OUTDIR="dist/deb"
DOCKER_ARGS=()

if [[ "${1:-}" == "--no-cache" ]]; then
    DOCKER_ARGS+=(--no-cache)
fi

mkdir -p "$OUTDIR"

echo "=== Building .deb in Docker (Ubuntu 22.04) ==="
echo ""

echo "Building Docker image..."
docker build ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} -f build-scripts/build/Dockerfile.deb -t "$IMAGE" .

echo ""
echo "Extracting .deb..."
CONTAINER=$(docker create "$IMAGE")
docker cp "$CONTAINER:/output/." "$OUTDIR/"
docker rm "$CONTAINER" > /dev/null

# Post-build check: verify dependencies are declared
echo ""
DEB=$(ls "$OUTDIR"/SONE_*.deb 2>/dev/null | head -1)
if [[ -z "$DEB" ]]; then
    echo "ERROR: No .deb found in $OUTDIR after build."
    exit 1
fi

echo "Package info:"
docker run --rm -v "$PWD/$DEB:/tmp/sone.deb:ro" "$IMAGE" \
    dpkg-deb -I /tmp/sone.deb | grep -E '(Package|Version|Depends|Section|Priority)'

echo ""
echo "=== Build complete ==="
ls -lh "$DEB"
