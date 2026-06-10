#!/bin/bash
# Build macOS (arm64) + Windows (x64) artifacts and upload them to a DRAFT
# GitHub release for the current package.json version.
#
# Why this script exists:
# - Windows must be built with --x64 explicitly (an arm64 Mac defaults to
#   arm64 Windows binaries otherwise).
# - latest.yml references the installer as "PRTS-Setup-X.exe" (dashes), but
#   the file on disk has spaces and GitHub's web drag-drop uploader rewrites
#   spaces to dots — which 404s the auto-updater's download URL. Uploading
#   via gh with the dashed name keeps auto-update working.
#
# Usage:  ./scripts/release.sh           # build + upload to draft
# Then review the draft notes on GitHub and publish:
#   gh release edit vX.Y.Z --draft=false --latest
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
echo "==> Building $TAG (macOS arm64 + Windows x64)…"
npx electron-builder --mac --publish never
npx electron-builder --win --x64 --publish never

cd dist
cp -f "PRTS Setup $VERSION.exe" "PRTS-Setup-$VERSION.exe"
cp -f "PRTS Setup $VERSION.exe.blockmap" "PRTS-Setup-$VERSION.exe.blockmap"

echo "==> Verifying latest.yml matches the renamed installer…"
grep -q "PRTS-Setup-$VERSION.exe" latest.yml

if ! gh release view "$TAG" > /dev/null 2>&1; then
  echo "==> Creating draft release $TAG…"
  gh release create "$TAG" --draft --title "$TAG" --notes "Draft for $TAG — notes TBD."
fi

echo "==> Uploading assets to $TAG…"
gh release upload "$TAG" --clobber \
  "PRTS-Setup-$VERSION.exe" \
  "PRTS-Setup-$VERSION.exe.blockmap" \
  "PRTS-$VERSION-win.zip" \
  "latest.yml" \
  "PRTS-$VERSION-arm64.dmg" \
  "PRTS-$VERSION-arm64.dmg.blockmap" \
  "PRTS-$VERSION-arm64-mac.zip" \
  "PRTS-$VERSION-arm64-mac.zip.blockmap" \
  "latest-mac.yml"

echo
echo "Done. Assets are on the draft release. Review/edit the notes, then publish:"
echo "  gh release edit $TAG --draft=false --latest"
