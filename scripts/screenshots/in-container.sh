#!/usr/bin/env bash
# Runs inside the screenshots image (see run-in-docker.sh): copies the
# read-only source at /src to a folder of its own, installs and builds it for
# Linux, takes the screenshots, and puts them in /out.
set -euo pipefail

work="$HOME/media-centre"
rm -rf "$work"
mkdir -p "$work"
rsync -a --exclude node_modules --exclude dist --exclude .git --exclude test-results \
  --exclude playwright-report --exclude /data --exclude /.sandcastle /src/ "$work/"
cd "$work"

export CI=1
pnpm install --frozen-lockfile --store-dir /pnpm-store
pnpm build

# Taken here first, so that a run that fails leaves the last ones as they were.
shots="$work/screenshots"
mkdir -p "$shots/docs" "$shots/manifest"
SCREENSHOTS_DOCS_DIR="$shots/docs" SCREENSHOTS_MANIFEST_DIR="$shots/manifest"   pnpm exec playwright test --config playwright.screenshots.config.ts

rm -f /out/docs/*.png /out/manifest/*.png
cp "$shots"/docs/*.png /out/docs/
cp "$shots"/manifest/*.png /out/manifest/
echo "Took $(ls "$shots"/docs | wc -l) screenshots for the docs and $(ls "$shots"/manifest | wc -l) for the manifest."
