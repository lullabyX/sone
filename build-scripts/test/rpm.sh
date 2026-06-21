#!/usr/bin/env bash
# Usage: ./build-scripts/test/rpm.sh [path/to/SONE.rpm]
# Auto-finds in dist/rpm/ and dist/rpm-opensuse/
set -euo pipefail

cd "$(dirname "$0")/../.."
source build-scripts/test/common.sh

# ── Find Fedora .rpm ──────────────────────────────────────────────────────────
FEDORA_RPM="${1:-}"
if [[ -z "$FEDORA_RPM" ]]; then
    for dir in dist/rpm src-tauri/target/release/bundle/rpm; do
        candidate=$(ls "$dir"/SONE-*.rpm 2>/dev/null | head -1 || true)
        if [[ -n "$candidate" ]]; then
            FEDORA_RPM="$candidate"
            break
        fi
    done
fi

# ── Find openSUSE .rpm ───────────────────────────────────────────────────────
OPENSUSE_RPM=""
if [[ -z "${1:-}" ]]; then
    candidate=$(ls dist/rpm-opensuse/SONE-*.rpm 2>/dev/null | head -1 || true)
    if [[ -n "$candidate" ]]; then
        OPENSUSE_RPM="$candidate"
    fi
fi

if [[ -z "$FEDORA_RPM" && -z "$OPENSUSE_RPM" ]]; then
    echo "ERROR: No .rpm found. Build first or pass path as argument."
    exit 1
fi

[[ -n "$FEDORA_RPM" ]] && FEDORA_RPM=$(realpath "$FEDORA_RPM")
[[ -n "$OPENSUSE_RPM" ]] && OPENSUSE_RPM=$(realpath "$OPENSUSE_RPM")

echo "=== SONE .rpm Multi-Distro Test ==="
[[ -n "$FEDORA_RPM" ]] && echo "Fedora package:  $FEDORA_RPM"
[[ -n "$OPENSUSE_RPM" ]] && echo "openSUSE package: $OPENSUSE_RPM"
echo ""
echo "Running smoke tests across distros..."
echo "─────────────────────────────────────────────────"

# Write native-package test script with rpm registry check
TEST_SCRIPT=$(mktemp /tmp/sone-test-XXXXXX.sh)
trap 'rm -f "$TEST_SCRIPT"' EXIT
write_test_script "$TEST_SCRIPT" "/usr/bin/sone"

# Prepend package registry check
ORIG=$(cat "$TEST_SCRIPT")
cat > "$TEST_SCRIPT" << 'PREPEND'
#!/usr/bin/env bash
set -e

# Check: package installed in registry
if rpm -qi sone > /dev/null 2>&1; then
    echo "CHECK:pkg_installed:PASS:in_rpm_registry"
else
    echo "CHECK:pkg_installed:FAIL:not_in_registry"
fi

PREPEND
echo "$ORIG" | tail -n +3 >> "$TEST_SCRIPT"
chmod +x "$TEST_SCRIPT"

# ── Fedora tests ──────────────────────────────────────────────────────────────
if [[ -n "$FEDORA_RPM" ]]; then
    FEDORA_DISTROS=(
        "Fedora 42|fedora:42|dnf install -y /pkg/*.rpm xorg-x11-server-Xvfb dbus-x11 xdotool"
        "Fedora 43|fedora:43|dnf install -y /pkg/*.rpm xorg-x11-server-Xvfb dbus-x11 xdotool"
    )

    for distro in "${FEDORA_DISTROS[@]}"; do
        IFS='|' read -r label image install_cmd <<< "$distro"

        if ! docker pull "$image" > /dev/null 2>&1; then
            printf "%-26s %s\n" "$label" "SKIP"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi

        run_test "$label" "$image" "$install_cmd" "$TEST_SCRIPT" \
            -v "$FEDORA_RPM:/pkg/$(basename "$FEDORA_RPM"):ro"
    done
fi

# ── openSUSE tests ────────────────────────────────────────────────────────────
if [[ -n "$OPENSUSE_RPM" ]]; then
    OPENSUSE_DISTROS=(
        "openSUSE TW|opensuse/tumbleweed|zypper --non-interactive --no-gpg-checks install /pkg/*.rpm xorg-x11-server-Xvfb dbus-1-daemon dbus-1-tools xdotool"
    )

    for distro in "${OPENSUSE_DISTROS[@]}"; do
        IFS='|' read -r label image install_cmd <<< "$distro"

        if ! docker pull "$image" > /dev/null 2>&1; then
            printf "%-26s %s\n" "$label" "SKIP"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi

        run_test "$label" "$image" "$install_cmd" "$TEST_SCRIPT" \
            -v "$OPENSUSE_RPM:/pkg/$(basename "$OPENSUSE_RPM"):ro"
    done
fi

print_summary
