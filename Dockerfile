# The Hub's image: one container that serves the Remote, the API the Remote and
# the Player use, and the Media Files (PRD FR-1). How to run it, on a NAS or
# anywhere else, is in docs/setup/running-the-hub-in-docker.md.
#
#   docker build -t media-centre-hub .
#   docker run -d --name media-centre-hub --network host \
#     -v media-centre-data:/data --restart unless-stopped media-centre-hub
#
# Node and pnpm are pinned to the versions the root package.json and the
# Sandcastle image use. If those move, move these with them.
ARG NODE_VERSION=26.10.0
ARG PNPM_VERSION=12.14.0
# Samsung's Tizen Studio command-line tools, which install the Player on TVs
# (FR-31): its installer, by version, and the SHA-256 of the one checked here.
# To move to another version, change both.
ARG TIZEN_STUDIO_VERSION=6.1
ARG TIZEN_STUDIO_SHA256=7f33fe09eda4eb5d50463cf997e8f676d455060720470070ae1932994413aaf4

FROM node:${NODE_VERSION}-bookworm-slim AS pnpm
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
# Every workspace package's manifest, even those not built here: the lockfile
# names all four, and a frozen install refuses a workspace that doesn't match.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/hub/package.json packages/hub/
COPY packages/player/package.json packages/player/
COPY packages/remote/package.json packages/remote/
COPY packages/shared/package.json packages/shared/

# Builds the Remote, which the Hub serves as static files.
FROM pnpm AS remote
RUN pnpm install --frozen-lockfile
# The Remote shows CHANGELOG.md from its footer's version.
COPY tsconfig.base.json CHANGELOG.md ./
COPY packages/shared/src packages/shared/src
COPY packages/remote packages/remote
RUN pnpm --filter @media-centre/remote build

# Builds the Player, which the Hub signs and installs on TVs (FR-31).
FROM pnpm AS player
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY packages/player packages/player
RUN pnpm --filter @media-centre/player build

# Samsung's sdb and tizen CLI, from Tizen Studio's command-line installer, with
# the Java runtime it brings for the CLI: the Hub installs, launches and
# uninstalls the Player with them (FR-31). Samsung builds them for amd64 only,
# so on another machine the Hub's image has none, and says so when asked to
# install the Player. The installer refuses root, and installs only under the
# home of whoever runs it, so it runs as the Hub's own user, at the paths the
# Hub's image keeps it at. Its emulator platforms and package manager, which
# the Hub never uses, are left out.
FROM node:${NODE_VERSION}-bookworm-slim AS tizen-studio
ARG TIZEN_STUDIO_VERSION
ARG TIZEN_STUDIO_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /home/node
RUN if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      installer="web-cli_Tizen_Studio_${TIZEN_STUDIO_VERSION}_ubuntu-64.bin"; \
      curl -fsSLo "$installer" "https://download.tizen.org/sdk/Installer/tizen-studio_${TIZEN_STUDIO_VERSION}/$installer" \
      && echo "${TIZEN_STUDIO_SHA256}  $installer" | sha256sum -c - \
      && chmod +x "$installer" \
      && "./$installer" --accept-license /home/node/tizen-studio \
      && test -x tizen-studio/tools/sdb && test -x tizen-studio/tools/ide/bin/tizen \
      && rm -rf "$installer" .package-manager tizen-studio/platforms tizen-studio/package-manager; \
    else \
      mkdir tizen-studio; \
    fi \
  && mkdir -p tizen-studio-data

# Only what the Hub needs at run time, and none of the workspace's dev tools.
FROM pnpm AS hub-dependencies
RUN pnpm install --frozen-lockfile --prod --filter @media-centre/hub...

FROM node:${NODE_VERSION}-bookworm-slim

# ffmpeg, which brings ffprobe: the Hub probes Media Files and converts what a
# TV cannot play (FR-43, ADR 0006). Debian bookworm's, as in the Sandcastle
# image the tests run in. On amd64, Intel's VA-API driver too, from Debian's
# non-free, for Full Conversion to encode on an Intel GPU passed into the
# container, through Quick Sync or VAAPI (FR-42); the Hub uses software without
# one. NVIDIA's NVENC needs nothing here: NVIDIA's Container Toolkit brings its
# driver in from the host. docs/setup/running-the-hub-in-docker.md says how.
RUN if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources; \
      gpu_driver=intel-media-va-driver-non-free; \
    fi \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg ${gpu_driver:-} \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=hub-dependencies /app ./
COPY packages/shared/src packages/shared/src
COPY packages/hub/src packages/hub/src
COPY --from=remote /app/packages/remote/dist packages/remote/dist
COPY --from=player /app/packages/player/dist packages/player/dist

# Samsung's tools, where the Hub finds them, on its PATH. The Player's signing
# certificate is never kept with them: the Hub writes it for each install to a
# folder of its own, deleted once the Player is installed (FR-4).
COPY --from=tizen-studio --chown=node:node /home/node/tizen-studio /home/node/tizen-studio
COPY --from=tizen-studio --chown=node:node /home/node/tizen-studio-data /home/node/tizen-studio-data
ENV PATH="/home/node/tizen-studio/tools:/home/node/tizen-studio/tools/ide/bin:${PATH}"

# All the Hub's state is this one SQLite file (FR-3). Mount a volume at /data,
# or Rooms, Appliances and pairing tokens go with the container (NFR-4).
ENV HUB_DATABASE=/data/media-centre.sqlite
RUN mkdir /data && chown node:node /data
VOLUME /data

# The base image's unprivileged user. Nothing the Hub does needs root: its port
# is above 1024, Wake-on-LAN and SSDP send from any free port, and sdb connects
# to a TV from any.
USER node

# Informational only: the Hub expects host networking, where Docker publishes
# nothing and the Hub listens on HUB_PORT (41080 by default) on the host itself.
EXPOSE 41080

# Node runs the Hub's TypeScript directly, as `pnpm start` does, and is PID 1
# so `docker stop` reaches the Hub's own SIGTERM handler.
CMD ["node", "packages/hub/src/main.ts"]
