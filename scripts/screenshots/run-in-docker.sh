#!/usr/bin/env bash
# `pnpm screenshots`: takes the Remote's screenshots in Docker, as the fakes
# the Hub runs against need Linux's loopback addresses, and puts them in
# docs/images/screenshots/ and packages/remote/public/screenshots/, replacing
# what is there. Runs from Git Bash on Windows as well as from Linux or macOS.
#
# The image is built on the Sandcastle image, `sandcastle:temp` unless
# SCREENSHOTS_BASE_IMAGE says otherwise.
set -euo pipefail

# Docker on Windows is given Windows paths, untouched by Git Bash.
export MSYS_NO_PATHCONV=1

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if pwd -W >/dev/null 2>&1; then root="$(cd "$root" && pwd -W)"; fi

image=media-centre-screenshots
base="${SCREENSHOTS_BASE_IMAGE:-sandcastle:temp}"

mkdir -p "$root/docs/images/screenshots" "$root/packages/remote/public/screenshots"

# The context's own builder, which sees local images such as the base, rather
# than whichever builder is selected, which may be one that pulls everything.
docker buildx build --builder "$(docker context show)" --load --quiet --build-arg "BASE_IMAGE=$base" -t "$image" "$root/scripts/screenshots"

started=$SECONDS
docker run --rm --init --shm-size=1g \
  -v "$root:/src:ro" \
  -v "$root/docs/images/screenshots:/out/docs" \
  -v "$root/packages/remote/public/screenshots:/out/manifest" \
  -v media-centre-screenshots-pnpm-store:/pnpm-store \
  --entrypoint bash "$image" /src/scripts/screenshots/in-container.sh
echo "Screenshots taken in $((SECONDS - started)) seconds."
