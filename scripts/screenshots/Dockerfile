# The image `pnpm screenshots` takes the Remote's screenshots in: the
# Sandcastle image the end-to-end tests run in (Node, pnpm, ffmpeg and
# Playwright's Chromium), with fonts for whatever the Remote's own typeface
# doesn't draw, such as emoji and the fake devices' names, which would
# otherwise fall back to DejaVu.
ARG BASE_IMAGE=sandcastle:temp
FROM ${BASE_IMAGE}

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-inter fonts-noto-core fonts-noto-color-emoji rsync \
  && rm -rf /var/lib/apt/lists/*
# Inter, where the page asks for system-ui or sans-serif.
COPY fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

# Where pnpm keeps the packages it downloads, a volume kept between runs.
RUN mkdir -p /pnpm-store && chown 1000:1000 /pnpm-store
USER 1000
