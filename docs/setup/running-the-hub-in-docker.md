# Running the Hub in Docker

The Hub ships as one Docker image. One container serves the Remote, the API
the Remote and the Player use, and the Media Files (PRD FR-1). It belongs on an
always-on machine on the home network, normally the NAS, not a PC that sleeps
([ADR 0001](../architectural-decision-record/0001-hub-mediates-between-remote-and-appliances.md)).

The image has Node 26 and the built Hub, Remote and Player, plus ffmpeg and
ffprobe, which the Hub uses to probe Media Files and convert what a TV cannot
play
([ADR 0006](../architectural-decision-record/0006-the-hub-converts-what-the-tv-cannot-play.md)),
and, on amd64, Intel's VA-API driver, for converting on an Intel GPU, and
Samsung's `sdb` and `tizen` command-line tools, from Tizen Studio, which install
the Player on a TV from its Developer section (FR-31). Samsung makes those tools
for amd64 only, so on an ARM NAS the Hub can't install the Player itself:
install it from a PC with Tizen Studio instead
([how](../processes/installing-the-player-with-tizen-studio.md)).

For development on a PC, `pnpm start` runs the same Hub without Docker (see the
[getting started guide](../guides/getting-started.md)).

---

## Before you start: the subnet rule

**The Hub must be on the same subnet as the Appliances it controls** (PRD FR-2,
[ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).
Three things the Hub does stay inside one subnet and never cross a router:

- **Wake-on-LAN.** Power switches a TV on with a broadcast magic packet.
- **SSDP.** "Find TVs" searches for TVs with a multicast message.
- **UPnP.** The volume slider reads and sets each TV's own volume and mute
  through the TV's UPnP service.

So put the NAS and the TVs on the same network. If the TVs are on a separate
VLAN or guest Wi-Fi, "Find TVs" finds nothing and Power can't switch a TV on,
even when the Remote can still reach the Hub.

---

## Host networking

**Run the container with host networking** (`--network host`, or
`network_mode: host` in Compose). Docker's default bridge network puts the
container on a private network of its own, behind the NAS, which is exactly the
router the subnet rule forbids. Broadcasts and multicast from the Hub would
never reach a TV.

With host networking the Hub uses the NAS's own network interfaces:

- It listens on the NAS's address, on `HUB_PORT` (41080 by default). There's
  nothing to publish with `-p`, and Docker ignores `-p` with host networking.
- The Hub gives each TV its own IP address on the home network as the TV's
  Developer IP. It finds that address on the NAS's interfaces, preferring a
  real one to Docker's own (`docker0`, `br-…`, `veth…`). If the NAS is on more
  than one network and the Hub picks the wrong one, set the address in the
  Remote's Settings, under Hub.

Host networking puts the Hub on the home network only on a **Linux** Docker
host, which a NAS is. Docker Desktop on a Mac or Windows PC runs containers in a
virtual machine, whose "host" is not on your home network. There, run the Hub
with `pnpm start` instead.

If the NAS has a firewall, allow in TCP on the Hub's port, so phones can open
the Remote, and UDP from the TVs, which answer "Find TVs" on a port the Hub
chooses each time.

---

## The volume

All the Hub's state is one SQLite file: Rooms, Appliances, their pairing tokens
and other credentials, Media Sources and, as later phases add them, Resume
Positions (FR-3). In the image it is `/data/media-centre.sqlite`.
**Mount a volume at `/data`**, or the Hub's state goes with the container when
you remove it (NFR-4).

Use either:

- **A named volume**, which Docker manages: `-v media-centre-data:/data`. This
  is the simplest, and it is what the commands below use.
- **A folder on the NAS** (a bind mount), which is easier to find and back up,
  e.g. `-v /volume1/docker/media-centre:/data`. The Hub runs as the image's
  unprivileged `node` user, user and group 1000, so that user needs to be able
  to write the folder. Either give it the folder:

  ```bash
  sudo chown 1000:1000 /volume1/docker/media-centre
  ```

  or run the container as the folder's owner instead, with
  `--user <uid>:<gid>` (`user: "<uid>:<gid>"` in Compose).

The file holds pairing tokens, and the signing certificate the Hub installs
the Player with, with its passwords, so keep it, and its backups, private to
you.

Don't set `HUB_DATABASE` in the container. The image already points it at
`/data`, and anywhere else is outside the volume.

To install the Player, the Hub writes the signing certificate to a folder of
its own in the container's `/tmp`, readable only by the Hub's user, and deletes
it once the Player is installed, or, should the Hub be stopped meanwhile,
before its next install.

The HLS segments the Hub streams a Media File in, when it can't serve it as it
is (FR-42), are not state: they go in the container's `/tmp`, and are deleted
as playback ends. While a Media File plays, its segments can take up as much
space as the file itself, so leave the container's disk that much room.

---

## Media Sources

A Media Source is a folder the Hub reads Media Files from (FR-32). Inside a
container the Hub sees only what is mounted into it, so **mount each folder of
films, shows or music into the container**, then add it in the Remote's
Settings, under Media Sources, by the path it has **inside** the container.
Read-only (`:ro`) is enough; the Hub never changes a Media File.

```bash
docker run -d --name media-centre-hub --network host \
  -v media-centre-data:/data \
  -v /volume1/video:/media/video:ro \
  -v /volume1/music:/media/music:ro \
  --restart unless-stopped media-centre-hub
```

Here Settings adds `/media/video` and `/media/music`, not `/volume1/…`. In
Compose, add the same lines under `volumes:`.

**A network share** on a PC or another NAS is mounted on the Docker host first,
e.g. with the NAS's own "mount remote folder" feature or `mount -t cifs`, then
mounted into the container in the same way. Mount it before the container
starts, or restart the container after mounting it: a share mounted later onto
a folder already given to the container isn't seen inside it. If the share
isn't mounted, browsing that Media Source shows an empty folder, or says the
Hub can't find it.

The Hub runs as user and group 1000 (see above), which needs permission to read
each folder; Settings refuses a folder the Hub can't read and says so. Settings
also refuses a path that doesn't exist in the container, which usually means
the folder wasn't mounted, or was mounted somewhere else.

The Hub serves nothing outside a Media Source's folder: a path that leads out
of it, through `..` or a symlink, is refused (FR-5). A symlink inside a Media
Source that points elsewhere in the same Media Source works; one that points
out of it is hidden.

---

## Build the image

The image is built from this repository. Build it on the NAS itself if you can,
so it matches the NAS's processor:

```bash
git clone https://github.com/adrianeyre/media-centre.git
cd media-centre
docker build -t media-centre-hub .
```

On amd64 the build downloads Tizen Studio's command-line installer from
Samsung, about 280 MB, checks it against the SHA-256 the Dockerfile has, and
installs `sdb` and the `tizen` CLI from it, with the Java runtime the CLI needs.

To build on a PC for a NAS with a different processor, e.g. an ARM NAS, say
which, and copy the image across:

```bash
docker buildx build --platform linux/arm64 -t media-centre-hub --load .
docker save media-centre-hub | ssh you@nas docker load
```

---

## Run it

```bash
docker run -d \
  --name media-centre-hub \
  --network host \
  -v media-centre-data:/data \
  --restart unless-stopped \
  media-centre-hub
```

Then open `http://<the NAS's IP address>:41080` on a phone on the home network.
`docker logs media-centre-hub` should say:

```
Hub state in /data/media-centre.sqlite
Hub listening on http://0.0.0.0:41080
```

If something on the NAS already uses port 41080, choose another port with
`-e HUB_PORT=41081`. With host networking,
that is the port the Remote is on.

To check ffmpeg and ffprobe are in the image:

```bash
docker run --rm media-centre-hub ffmpeg -version
docker run --rm media-centre-hub ffprobe -version
```

### With Compose, or a NAS's container app

Most NAS container apps accept a Compose file: Synology's Container Manager
calls it a Project, QNAP's Container Station an Application. Others, such as
Unraid's, ask the same questions in a form; choose the **host** network there,
and map a folder or volume to `/data`. This Compose file builds the image from
the checkout it sits in and runs it as above:

```yaml
services:
  hub:
    build: .
    image: media-centre-hub
    container_name: media-centre-hub
    network_mode: host
    volumes:
      - media-centre-data:/data
    # environment:
    #   HUB_PORT: "8090"
    restart: unless-stopped

volumes:
  media-centre-data:
```

`docker compose up -d --build` builds and starts it.

---

## Hardware acceleration for Full Conversion

Full Conversion re-encodes a Media File's video, for video the TV can't play
at all, such as a DivX/Xvid AVI, or to burn image subtitles into it (FR-41,
FR-45). In software that takes a lot of CPU, and a low-power NAS may not keep
up with 1080p or 4K. **Pass the NAS's GPU into the container** and the Hub
encodes on it instead (FR-42). It looks for one before its first Full
Conversion, in this order:

| GPU    | Encoder                | The device the container needs                       |
| ------ | ---------------------- | ---------------------------------------------------- |
| NVIDIA | NVENC                  | `/dev/nvidiactl`, from NVIDIA's Container Toolkit    |
| Intel  | Quick Sync, then VAAPI | a render node, `/dev/dri/renderD128` on most NASes   |
| AMD    | VAAPI                  | a render node, with Mesa's driver added to the image |

It tries each encoder it finds a device for with a second of test video, and
uses the first that encodes. If none does, or the container has no GPU, it
encodes in software, as before. A container sees only the devices it is
given, whatever the NAS has.

### An Intel GPU

Most NASes with a GPU have an Intel one, built into the processor, e.g. a
Celeron J4125 or N100. On the NAS, over SSH, check it has a render node, and
which group may open it:

```bash
ls -l /dev/dri                 # renderD128, owned by a group such as render or video
stat -c %g /dev/dri/renderD128 # that group's number
```

The Hub runs as the unprivileged `node` user, so give the container the
device, and that group, by its number, as `stat` printed it:

```bash
docker run -d --name media-centre-hub --network host \
  -v media-centre-data:/data \
  --device /dev/dri:/dev/dri \
  --group-add "$(stat -c %g /dev/dri/renderD128)" \
  --restart unless-stopped media-centre-hub
```

In Compose, under the service:

```yaml
devices:
  - /dev/dri:/dev/dri
group_add:
  - "937" # the number stat printed, not a name: the container has no such group
```

A NAS container app whose form has no field for devices needs the Compose
file instead. If `/dev/dri`
isn't there at all, the processor has no GPU, or the NAS's system doesn't
load its driver; the Hub then encodes in software.

The image's driver is Debian's non-free build of Intel's media driver, for
Broadwell (2015) and later. Quick Sync comes through it too, on Intel GPUs
Debian's Quick Sync runtime still supports; on newer ones, VAAPI takes over.

### An NVIDIA GPU

Install [NVIDIA's Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the Docker host, which brings the host's NVIDIA driver into the container.
Ask it for the GPU, and for its video encoder, which it leaves out by default:

```bash
docker run -d --name media-centre-hub --network host \
  -v media-centre-data:/data \
  --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
  --restart unless-stopped media-centre-hub
```

In Compose, under the service:

```yaml
environment:
  NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

### An AMD GPU

VAAPI encodes on an AMD GPU too, but the image doesn't have Mesa's driver for
it. Add `mesa-va-drivers` to the `apt-get install` line in the `Dockerfile`,
rebuild the image, and pass `/dev/dri` in as for Intel.

### Checking which it uses

The Hub chooses once, at the first Full Conversion after it starts, so play a
Media File that needs one, such as a DivX/Xvid AVI, then look at its log:

```bash
docker logs media-centre-hub
```

```
Full Conversion re-encodes video in Quick Sync (h264_qsv) on /dev/dri/renderD128
```

It says `software (libx264)` if it found no GPU that encodes, and before
that, for each encoder it tried, why it couldn't use it, in ffmpeg's words:

- **`Permission denied`**: the container hasn't the render node's group. Add
  `--group-add` as above, with the number `stat` prints.
- **`No VA display found`** or **`Failed to initialise VAAPI connection`**:
  the device isn't in the container, or no driver in the image knows the GPU,
  as for AMD without Mesa's.
- **`Cannot load libcuda.so.1`**: NVIDIA's Container Toolkit isn't
  installed, or the container wasn't started with `--gpus`.

Quick Sync failing, e.g. with `Error initializing an internal MFX session`,
where VAAPI then works, is expected on Intel GPUs too new for Debian's Quick
Sync runtime: VAAPI encodes on the same hardware.

The Remote still flags Full Conversion as using a lot of the Hub's CPU, as it
can't tell how the Hub encodes.

---

## Upgrading the image

Everything the Hub keeps is in the volume, so upgrading is: build the new
image, then replace the container, keeping the volume.

1. **Back up the database**, while the Hub is stopped, so the file is complete:

   ```bash
   docker stop media-centre-hub
   docker cp media-centre-hub:/data/media-centre.sqlite ./media-centre-backup.sqlite
   ```

2. **Build the new image** from the updated checkout:

   ```bash
   git pull
   docker build -t media-centre-hub .
   ```

3. **Replace the container**, with the same volume and the same options as
   before:

   ```bash
   docker rm media-centre-hub
   docker run -d --name media-centre-hub --network host \
     -v media-centre-data:/data --restart unless-stopped media-centre-hub
   ```

   With Compose, steps 2 and 3 are `git pull` and
   `docker compose up -d --build`.

On its first start, the new Hub brings the database's schema up to date by
itself. Rooms, TVs and their pairing tokens, and Media Sources, are kept, so no
TV needs pairing again. Mount the same media folders as before, at the same
paths, or the Media Sources won't find them.

An older Hub refuses to start on a database a newer one has upgraded, saying
that it was written by a newer Hub. To go back to an older image, stop the
container and restore the backup you made before upgrading. In a folder on the
NAS, copy the file back. In a named volume, copy it in as the Hub's own user, so
the Hub can still write it:

```bash
docker run --rm -v media-centre-data:/data -v "$PWD":/backup:ro \
  media-centre-hub cp /backup/media-centre-backup.sqlite /data/media-centre.sqlite
```

`docker image prune` removes the old image once the new one is working.
