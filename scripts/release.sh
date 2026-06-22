#!/bin/bash
# Build macOS artifacts and upload them to a DRAFT GitHub release for the
# current package.json version. Windows is built from the release tag by the
# GitHub Actions Windows runner after the draft is published.
#
# Usage:  ./scripts/release.sh           # build + upload to draft
# Then review the draft notes on GitHub and publish:
#   gh release edit vX.Y.Z --draft=false --latest
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
DIRTY_INPUTS=$(git status --porcelain --untracked-files=all -- src assets package.json package-lock.json scripts .github)
if [[ -n "$DIRTY_INPUTS" ]]; then
  echo "Refusing to release with uncommitted packaging inputs:" >&2
  echo "$DIRTY_INPUTS" >&2
  exit 1
fi

echo "==> Checking project assets..."
npm run lint

echo "==> Building $TAG (macOS arm64)..."
npx electron-builder --mac --publish never

MAC_ASAR=$(find dist -path '*/PRTS.app/Contents/Resources/app.asar' -print -quit)
if [[ -z "$MAC_ASAR" ]]; then
  echo "Could not find the packaged macOS app.asar." >&2
  exit 1
fi
node scripts/check-packaged-assets.js "$MAC_ASAR"

cd dist

if ! gh release view "$TAG" > /dev/null 2>&1; then
  echo "==> Creating draft release $TAG..."
  gh release create "$TAG" --draft --title "$TAG" --notes "Draft for $TAG -- notes TBD."
fi

echo "==> Uploading assets to $TAG..."
gh release upload "$TAG" --clobber \
  "PRTS-$VERSION-arm64.dmg" \
  "PRTS-$VERSION-arm64.dmg.blockmap" \
  "PRTS-$VERSION-arm64-mac.zip" \
  "PRTS-$VERSION-arm64-mac.zip.blockmap" \
  "latest-mac.yml"

echo
echo "Done. Assets are on the draft release. Review/edit the notes, then publish:"
echo "  gh release edit $TAG --draft=false --latest"
