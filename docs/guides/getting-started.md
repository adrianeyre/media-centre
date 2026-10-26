# Getting started

How to install and run the Hub, on a PC with `pnpm start` or in Docker on a NAS.

## What you need

You need Node 26 or later, pnpm 12, and ffmpeg with ffprobe on the `PATH`, built with libx264:

- the Hub reads each Media File's duration and streams with ffprobe and remuxes with ffmpeg;
- the tests make their sample Media Files with ffmpeg rather than committing them, DTS among them, with ffmpeg's own experimental encoder.

## Running it on a PC

```bash
pnpm install
pnpm start        # builds the Remote and starts the Hub on http://localhost:41080
```

| Variable       | What it is                                                                         |
| -------------- | ---------------------------------------------------------------------------------- |
| `HUB_PORT`     | The port the Hub listens on. 41080 by default                                      |
| `HUB_DATABASE` | The SQLite file holding all the Hub's state. `data/media-centre.sqlite` by default |

`HUB_LATEST_VERSION_URL` changes where the Hub looks for a newer version, or stops it looking (see [Versions and releases](versions-and-releases.md)). The variables for running the Hub against the fake Appliances are in [The fake Appliances](fakes.md).

## The network

The Hub gives each TV its own IP address on the home network as the TV's Developer IP, which it finds on its network interfaces. On a machine with more than one network, set the address in Settings, under Hub.

The Hub must be on the same subnet as the TVs it controls: "Find TVs" searches for them over SSDP multicast, and Power switches a TV on with a Wake-on-LAN broadcast, neither of which crosses routers. In Docker on a NAS, that means host networking.

## Running the Hub on a NAS

The Hub ships as one Docker image, with ffmpeg and ffprobe, the Player's build, and, on amd64, Samsung's `sdb` and `tizen` tools, which keeps all its state in a volume at `/data`:

```bash
docker build -t media-centre-hub .
docker run -d --name media-centre-hub --network host -v media-centre-data:/data --restart unless-stopped media-centre-hub
```

Mount each folder of films, shows or music into the container too, e.g. `-v /volume1/video:/media/video:ro`, and add it in Settings, under Media Sources, by its path inside the container (`/media/video`). On a PC with `pnpm start`, a Media Source is any folder the Hub can read.

[Running the Hub in Docker](../setup/running-the-hub-in-docker.md) says:

- why it needs host networking;
- how to keep its state in a folder on the NAS;
- how to mount Media Sources and network shares;
- how to use a NAS's container app;
- how to pass a GPU into the container for Full Conversion;
- how to upgrade the image without losing Rooms, TVs, pairing tokens or Media Sources.
