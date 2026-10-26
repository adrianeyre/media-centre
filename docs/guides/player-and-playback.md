# The Player and playback

The Player is the Tizen web app the Hub installs on each Samsung TV to play Media Files from your PC or NAS.

![The TV tab](../images/screenshots/desktop-tv.png)

## Building the Player

The Player is a Tizen web app for Samsung TVs from 2018 on, whose web engine is Chromium 56:

```bash
pnpm --filter @media-centre/player build   # writes the Player's files to packages/player/dist
```

The build is a classic script, written as ES2016, and `es-check` checks that it holds nothing newer than Chromium 56 has, in the build and in `pnpm test`.

## Installing it on a TV

The Hub installs it on a TV itself.

1. Settings, under Signing certificate, takes your Samsung signing certificate's two `.p12` files, the author and the distributor certificate, each with its password. The Hub keeps them in its database, and never sends them or their passwords back, nor logs them.
2. Once a TV says it is in Developer Mode with the Hub's IP as its Developer IP, its Developer section has:
   - **Install / update Player**, which signs the Hub's own build of the Player with the certificate and installs it, over any Player there;
   - **Launch Player** and **Uninstall Player**;

   each showing its steps as the Hub takes them, and why one failed.

The Hub does them with Samsung's `sdb` and `tizen` command-line tools, from Tizen Studio, which are in its Docker image on amd64; with `pnpm start`, put them on the `PATH`. The Samsung TV Driver runs them, in `packages/hub/src/drivers/samsung-tv/player-tools.ts`, and the tests run it against a fake of them, as no TV in Developer Mode is at hand.

[Installing the Player with Tizen Studio](../processes/installing-the-player-with-tizen-studio.md) says how to make the certificate with Tizen Studio, give it to the Hub, and install the Player by hand from a PC, as on an ARM NAS, whose image hasn't the tools.

## How the Player reaches the Hub

The Player takes the Hub's address from its launch parameters and remembers it, and keeps a WebSocket open to the Hub, which knows which TV each Player is on by the address it connects from. Opened in a desktop browser, as `packages/player/dist/index.html?hub=127.0.0.1:41080`, it connects to that Hub and plays through a fake in place of the TV's AVPlay.

## Playing a Media File

Choosing a Media File in Watch & Listen plays it on the Selected TV. The Hub:

1. switches the TV on with Wake-on-LAN if it isn't on, and waits up to 30 seconds for it;
2. launches the Player with the Hub's address, the IP address in Settings, under Hub, and the port the Remote reached it on;
3. waits for the Player to connect back;
4. and sends it the Media File's URL.

The Remote shows each step as it happens. The Hub serves only Media Files inside a Media Source.

## Routes

Before each play the Hub probes the Media File with ffprobe and compares its container and codecs with what the Selected TV plays, which the Samsung TV Driver knows, to choose its Route: Direct Play, Remux, Audio Conversion or Full Conversion, the cheapest that works. Watch & Listen shows each Media File's Route to the Selected TV, and flags Full Conversion as using a lot of the Hub's CPU.

- **Direct Play** serves the file unchanged, with range requests.
- **Remux** streams it to the Player as HLS: a playlist of the whole file, in 6-second MPEG-TS segments that ffmpeg copies the streams into as the Player asks for them, so that it can seek anywhere; a seek past what ffmpeg has produced starts it again from there.
- **Audio Conversion** streams it the same way, but re-encodes each audio track the TV can't play, such as DTS or TrueHD, to Dolby Digital (AC3), 7.1 mixed down to 5.1, copying the video and every other track as they are.
- **Full Conversion**, for video the TV can't play at all, such as a DivX/Xvid AVI, re-encodes the video too, to H.264, starting each segment with a keyframe at exactly its time, so that a seek starts exactly where it asks; the audio is as for Audio Conversion.

### Encoding for Full Conversion

Full Conversion encodes on a GPU where the Hub can see one, which in Docker is one passed into its container: with NVENC on an NVIDIA GPU, or Quick Sync, then VAAPI, on each render node in `/dev/dri`, trying each with a moment of video before the first Full Conversion and taking the first that encodes. Without one it encodes in software, with libx264, which uses a lot of the Hub's CPU, and on a low-power NAS may not keep up with 1080p or 4K.

The encoder is chosen in one place, `packages/hub/src/video-encoders.ts`; the Hub's log says which it uses, and why it couldn't use each GPU encoder it tried.

### Streams and segments

Every audio track is in the stream, in the file's order. The segments are kept in the system's temporary folder until the Player stops, plays something else, or has been disconnected for a minute, and ffmpeg stops as soon as the Player stops or disconnects.

## The now-playing bar

While it plays, every TV screen of the Remote, TV Menu mode included, shows a now-playing bar:

- play/pause, a seek bar, skips back and forward of 10 and 30 seconds, and stop;
- the Media File's audio tracks, each by its language where the file says, as ffprobe read them before the play;
- and its subtitles.

Choosing an audio track has the Player switch to it through AVPlay, from where it is, whatever the Route.

## Subtitles

The subtitles are, in order:

1. "Off";
2. the Media File's own text subtitle tracks, by language;
3. the sidecar files beside it: `.srt`, `.vtt` and `.ass` files named as it is, less its extension, with a language code after it giving theirs, so that `Film.en.srt` and `Film.fr.ass` beside `Film.mkv` are English and French;
4. then its own image subtitle tracks, such as PGS from a Blu-ray or VobSub from a DVD, which the TV can't render, each marked as needing Full Conversion.

### Image subtitles

Choosing one of those, the Remote first warns that the Hub burns them into the picture by Full Conversion, which uses a lot of its CPU. Once the person agrees, the Hub sends the Player the Media File again, from where it is, with the audio track it plays, by Full Conversion, with that track laid over the video, scaled to its size, before it is re-encoded. A subtitle already on screen as the Hub starts converting, after a switch or a seek, appears only from the next one. Choosing "Off" or a text track again sends it once more by the cheaper Route it takes without.

### How subtitles reach the Player

The Hub serves each subtitle track at a URL of its own, which it sends the Player with the Media File: SubRip and WebVTT files as they are, and anything else, an `.ass` or a track inside the Media File, converted to SubRip with ffmpeg. The Player reads the one chosen from the Hub and draws each line itself, over the picture, at AVPlay's position, whatever the Route, since AVPlay loads a sidecar subtitle file only from a path on the TV, never from a URL, and leaves drawing it to the app all the same.

## Now Showing

The Player tells the Hub its position, length, audio track, subtitle track and whether it is playing, and the Remote reads that from the Hub every second, so every Remote on that TV shows the same.

With the Player in front, the Selected TV's Now Showing card names the Media File it plays, its position and duration, and the audio and subtitle tracks in use, and, for video, shows a preview picture: the frame at its position, which the Hub extracts from the Media File itself with ffmpeg, never a capture of the screen, moving it to where the Player is every 5 seconds while it plays and at once when it seeks, and holding it still while it is paused. The Hub extracts each frame only when a Remote first asks for it, and only once.

## Music

Audio Media Files, MP3, FLAC, AAC, ALAC, Ogg Vorbis or Opus, WAV, or anything else ffmpeg decodes, are browsed and take a Route as videos do: those the TV can't decode, such as ALAC or WMA, by Audio Conversion.

While one plays, the Player shows a now-playing screen: the cover art embedded in the file, or a placeholder for one with none, its title, artist and album, from its tags as ffprobe reads them, its file name standing in for a title it hasn't got, and its progress. The Hub takes the cover art out of the file itself with ffmpeg, as a JPEG at most 720 pixels tall, as it is asked for, and Now Showing shows the same.

## Queues

A folder with audio Media Files in it has "Play folder" in Watch & Listen, which plays those directly in it, not in its folders, in file-name order, as a Queue on the Selected TV, each from its start by the Route it takes. The Hub holds each TV's Queue, as long as it runs, and when the Player tells it a Media File has played to its end, sends it the next.

While the TV plays a Queue, the now-playing bar shows it, in the order it plays, the current Media File marked, with:

- previous and next;
- shuffle, which puts the Media Files after the current one in a random order;
- and repeat: off, which ends after the last; one, which plays the current one again at its end; and all, which goes from the last to the first.

Every Remote on that TV sees the same Queue. Playing a Media File on its own, or stopping, ends it.

## The TV's own remote

The TV's own remote controls the Player too: play/pause, play, pause and stop, rewind and fast-forward skip 10 seconds, and Back stops, back to the waiting screen.

## Resume Positions

The Hub records a Resume Position for each Media File from what the Player tells it as it plays, one per Media File, whichever TV plays it, and keeps it in its database through restarts.

Choosing a Media File that has one offers "Resume from h:mm:ss" or "Start over", the Hub sending the Player where to start; one played to within its last 5% is finished, and its Resume Position is cleared.

The Player's waiting screen offers "Resume" with the Media File whose Resume Position was recorded last, which OK on the TV's own remote presses, and the Hub sends it that Media File from there.
