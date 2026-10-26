# The Hub converts what the TV cannot play

Every Media File ffmpeg can decode must play, but Samsung TVs cannot decode everything natively. For example, 2018 and later models have no DTS, and older codecs such as DivX/Xvid are unsupported. So before each play the Hub probes the Media File with ffprobe, compares it with what the Selected TV can decode, and picks the cheapest route that works:

1. **Direct play.** The file is served unchanged over HTTP with range requests.
2. **Remux.** The container changes and the streams are copied.
3. **Audio conversion.** Only the audio is re-encoded, e.g. DTS or TrueHD to AC3.
4. **Full conversion.** Video is re-encoded too, using hardware acceleration when the Hub can see a GPU and software otherwise.

Routes 2 to 4 are streamed to the Player as HLS so seeking still works. ffmpeg ships inside the Hub's Docker image. This replaces an earlier "direct play only" decision.

## Consequences

- Full conversion of 1080p or 4K on a low-power NAS without hardware acceleration may not keep up in real time. The Remote tells the person when a Media File needs full conversion.
- The Player uses AVPlay ([ADR 0005](./0005-the-player-uses-samsung-avplay.md)) precisely so that most Media Files take routes 1 to 3.
- Out of scope: DRM-protected files and disc images (`.iso`, `VIDEO_TS`, `BDMV`). Image-based subtitles the TV cannot render are burned in, which forces route 4.
