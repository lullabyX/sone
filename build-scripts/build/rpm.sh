#!/usr/bin/env bash
# Usage: ./build-scripts/build/rpm.sh [--fedora|--opensuse] [--no-cache]
#   No flag  → builds both Fedora and openSUSE RPMs
#   --fedora → Fedora only  → dist/rpm/
#   --opensuse → openSUSE only → dist/rpm-opensuse/
#   --no-cache → passed to docker build
set -euo pipefail

cd "$(dirname "$0")/../.."

export DOCKER_BUILDKIT=1
DOCKER_ARGS=()
BUILD_FEDORA=false
BUILD_OPENSUSE=false

for arg in "$@"; do
    case "$arg" in
        --fedora)   BUILD_FEDORA=true ;;
        --opensuse) BUILD_OPENSUSE=true ;;
        --no-cache) DOCKER_ARGS+=(--no-cache) ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

# Default: build both
if ! $BUILD_FEDORA && ! $BUILD_OPENSUSE; then
    BUILD_FEDORA=true
    BUILD_OPENSUSE=true
fi

build_rpm() {
    local label="$1"
    local dockerfile="$2"
    local image="$3"
    local outdir="$4"

    mkdir -p "$outdir"

    echo "=== Building .rpm in Docker ($label) ==="
    echo ""

    echo "Building Docker image..."
    docker build ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} -f "$dockerfile" -t "$image" .

    echo ""
    echo "Extracting .rpm..."
    CONTAINER=$(docker create "$image")
    docker cp "$CONTAINER:/output/." "$outdir/"
    docker rm "$CONTAINER" > /dev/null

    # Post-build check
    echo ""
    RPM=$(ls "$outdir"/SONE-*.rpm 2>/dev/null | head -1)
    if [[ -z "$RPM" ]]; then
        echo "ERROR: No .rpm found in $outdir after build."
        exit 1
    fi

    echo "Package requires:"
    docker run --rm -v "$PWD/$RPM:/tmp/pkg.rpm:ro" "$image" rpm -qpR /tmp/pkg.rpm | head -20

    docker run --rm -v "$PWD/$RPM:/tmp/pkg.rpm:ro" "$image" sh -ceu '
        rpm -qpR /tmp/pkg.rpm | grep -Fx ffmpeg
        rpm -qpl /tmp/pkg.rpm | grep -Fx /usr/lib/sone/sone-tiddl/sone-tiddl
    '

    echo ""
    echo "=== $label build complete ==="
    ls -lh "$RPM"
    echo ""
}

if $BUILD_FEDORA; then
    build_rpm "Fedora" "build-scripts/build/Dockerfile.rpm" "sone-rpm-builder" "dist/rpm"
fi

if $BUILD_OPENSUSE; then
    build_rpm "openSUSE" "build-scripts/build/Dockerfile.rpm-opensuse" "sone-rpm-opensuse-builder" "dist/rpm-opensuse"
fi
