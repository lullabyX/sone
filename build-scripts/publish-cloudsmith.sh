#!/usr/bin/env bash
# Publish the built .deb/.rpm packages to Cloudsmith.
#
# Prereqs:
#   pip install --upgrade cloudsmith-cli
#   export CLOUDSMITH_API_KEY=...        (or run: cloudsmith login)
#   export CLOUDSMITH_REPO=lullabyx/sone (owner/repo of your Cloudsmith repo)
#
# Build artifacts first:  ./build-scripts/build/deb.sh && ./build-scripts/build/rpm.sh
# Then:                   ./build-scripts/publish-cloudsmith.sh
#
# Layout:
#   .deb            -> any-distro/any-version  (one package serves all Debian/Ubuntu)
#   Fedora .rpm     -> fedora/any-version
#   openSUSE .rpm   -> opensuse/any-version
# (RPMs are split because Fedora and openSUSE use different dependency names.)
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${CLOUDSMITH_REPO:?set CLOUDSMITH_REPO=owner/repo}"

latest() { ls -t $1 2>/dev/null | head -1; }

DEB="$(latest 'dist/deb/SONE_*_amd64.deb')"
RPM_FEDORA="$(latest 'dist/rpm/SONE-*.x86_64.rpm')"
RPM_SUSE="$(latest 'dist/rpm-opensuse/SONE-*.x86_64.rpm')"

[ -n "$DEB" ]        && echo "deb:      $DEB"        || { echo "no .deb in dist/deb"; exit 1; }
[ -n "$RPM_FEDORA" ] && echo "fedora:   $RPM_FEDORA" || { echo "no .rpm in dist/rpm"; exit 1; }
[ -n "$RPM_SUSE" ]   && echo "opensuse: $RPM_SUSE"   || { echo "no .rpm in dist/rpm-opensuse"; exit 1; }
echo "repo:     $REPO"
echo ""

echo "==> push .deb (all Debian/Ubuntu)"
cloudsmith push deb "$REPO/any-distro/any-version" "$DEB"

echo "==> push Fedora .rpm"
cloudsmith push rpm "$REPO/fedora/any-version" "$RPM_FEDORA"

echo "==> push openSUSE .rpm"
cloudsmith push rpm "$REPO/opensuse/any-version" "$RPM_SUSE"

echo ""
echo "Done. Users install via the repo's setup script — see README."
