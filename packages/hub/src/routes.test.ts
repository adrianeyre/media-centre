import { describe, expect, it } from "vitest";

import type { Route } from "@media-centre/shared";

import type { PlayableFormats } from "./drivers/driver.ts";
import { SAMSUNG_TV_PLAYABLE_FORMATS } from "./drivers/samsung-tv/playable-formats.ts";
import { NO_TAGS, type MediaProbe, type ProbedStream } from "./ffprobe.ts";
import { audioToConvert, audioTracksOf, chooseRoute } from "./routes.ts";

/** A probe result as a row of the table has it: the container, then each stream's codec, by kind. */
interface Row {
  readonly container: string;
  readonly video?: readonly string[];
  readonly audio?: readonly string[];
  readonly subtitles?: readonly string[];
  /** Video streams that are attached pictures, e.g. an album's cover art. */
  readonly pictures?: readonly string[];
}

const probeOf = ({ container, video = [], audio = [], subtitles = [], pictures = [] }: Row): MediaProbe => {
  const streams: ProbedStream[] = [];
  const add = (type: ProbedStream["type"], codecs: readonly string[], attachedPicture = false): void => {
    for (const codec of codecs) {
      streams.push({
        index: streams.length,
        type,
        codec,
        attachedPicture,
        language: null,
        title: null,
        channels: null,
      });
    }
  };
  add("video", pictures, true);
  add("video", video);
  add("audio", audio);
  add("subtitle", subtitles);
  return { container, duration: 60, startTime: 0, streams, tags: NO_TAGS };
};

/** The index of the subtitle stream with this codec in the probe of `row`. */
const subtitleIn = (row: Row, codec: string): number => {
  const index = probeOf(row).streams.findIndex((stream) => stream.type === "subtitle" && stream.codec === codec);
  expect(index).not.toBe(-1);
  return index;
};

describe("choosing a Media File's Route to a Samsung TV (FR-41, ADR 0006)", () => {
  const table: readonly (readonly [string, Row, Route])[] = [
    // Direct Play: a container the TV plays, holding codecs it plays from it.
    ["an MP4 of H.264 and AAC", { container: "mp4", video: ["h264"], audio: ["aac"] }, "direct-play"],
    ["an MP4 of HEVC and Dolby Digital Plus", { container: "mp4", video: ["hevc"], audio: ["eac3"] }, "direct-play"],
    ["an MKV of H.264 and Dolby Digital", { container: "matroska", video: ["h264"], audio: ["ac3"] }, "direct-play"],
    [
      "an MKV of HEVC with two audio tracks it plays",
      { container: "matroska", video: ["hevc"], audio: ["eac3", "aac"] },
      "direct-play",
    ],
    [
      "an MPEG-TS recording with MP2 audio",
      { container: "mpegts", video: ["mpeg2video"], audio: ["mp2"] },
      "direct-play",
    ],
    ["a WebM of VP9 and Opus", { container: "webm", video: ["vp9"], audio: ["opus"] }, "direct-play"],
    ["a video with no audio", { container: "mp4", video: ["h264"] }, "direct-play"],
    ["an MP3", { container: "mp3", audio: ["mp3"] }, "direct-play"],
    ["a FLAC", { container: "flac", audio: ["flac"] }, "direct-play"],
    ["an MP3 with its cover art", { container: "mp3", audio: ["mp3"], pictures: ["mjpeg"] }, "direct-play"],
    ["an M4A of AAC with its cover art", { container: "mp4", audio: ["aac"], pictures: ["png"] }, "direct-play"],
    [
      "an MKV with text subtitles it can't show itself",
      { container: "matroska", video: ["h264"], audio: ["aac"], subtitles: ["ass"] },
      "direct-play",
    ],
    [
      "an MKV with image subtitles, none of them shown",
      { container: "matroska", video: ["h264"], audio: ["aac"], subtitles: ["hdmv_pgs_subtitle"] },
      "direct-play",
    ],

    // Remux: codecs the TV plays from HLS, in a container, or a mix, it doesn't play them from.
    [
      "an MKV recorded from broadcast TV, with MP2 audio",
      { container: "matroska", video: ["h264"], audio: ["mp2"] },
      "remux",
    ],
    ["an AVI of H.264 and MP3", { container: "avi", video: ["h264"], audio: ["mp3"] }, "remux"],
    ["an FLV of H.264 and AAC", { container: "flv", video: ["h264"], audio: ["aac"] }, "remux"],
    ["an MPEG program stream from a DVD", { container: "mpeg", video: ["mpeg2video"], audio: ["ac3"] }, "remux"],
    ["an MP4 with MPEG-2 video", { container: "mp4", video: ["mpeg2video"], audio: ["aac"] }, "remux"],
    ["an MKA of MP2", { container: "matroska", audio: ["mp2"] }, "remux"],
    [
      "an MKV with a broadcast MP2 track beside one it plays",
      { container: "matroska", video: ["hevc"], audio: ["ac3", "mp2"] },
      "remux",
    ],

    // Audio Conversion: video the TV plays from HLS, with audio it doesn't play at all.
    ["an MKV with DTS", { container: "matroska", video: ["h264"], audio: ["dts"] }, "audio-conversion"],
    ["an MKV with TrueHD", { container: "matroska", video: ["hevc"], audio: ["truehd"] }, "audio-conversion"],
    [
      "an MKV with a DTS track beside one it plays",
      { container: "matroska", video: ["h264"], audio: ["ac3", "dts"] },
      "audio-conversion",
    ],
    ["an MKV with FLAC audio", { container: "matroska", video: ["h264"], audio: ["flac"] }, "audio-conversion"],
    ["an M4A of ALAC", { container: "mp4", audio: ["alac"] }, "audio-conversion"],
    ["a WMA", { container: "asf", audio: ["wmav2"] }, "audio-conversion"],
    [
      "an MKV with DTS and text subtitles",
      { container: "matroska", video: ["h264"], audio: ["dts"], subtitles: ["subrip"] },
      "audio-conversion",
    ],

    // Full Conversion: video the TV doesn't play, even from HLS.
    ["a DivX/Xvid AVI", { container: "avi", video: ["mpeg4"], audio: ["mp3"] }, "full-conversion"],
    ["an MP4 of MPEG-4 Part 2", { container: "mp4", video: ["mpeg4"], audio: ["aac"] }, "full-conversion"],
    ["a WMV", { container: "asf", video: ["wmv3"], audio: ["wmav2"] }, "full-conversion"],
    ["an MKV of VP9", { container: "matroska", video: ["vp9"], audio: ["opus"] }, "full-conversion"],
    ["a WebM of VP9 with DTS", { container: "webm", video: ["vp9"], audio: ["dts"] }, "full-conversion"],
    ["a RealMedia file", { container: "rm", video: ["rv40"], audio: ["cook"] }, "full-conversion"],
    ["an MKV of a codec ffprobe has no name for", { container: "matroska", video: ["unknown"] }, "full-conversion"],
  ];

  it.each(table.map(([name, row, route]) => [name, route, row] as const))("%s takes %s", (_, route, row) => {
    expect(chooseRoute(probeOf(row), SAMSUNG_TV_PLAYABLE_FORMATS)).toBe(route);
  });

  it("says each of the four Routes for some row of the table", () => {
    expect(new Set(table.map(([, , route]) => route))).toEqual(
      new Set(["direct-play", "remux", "audio-conversion", "full-conversion"]),
    );
  });

  describe("with a subtitle stream chosen to be shown", () => {
    const subtitled: Row = {
      container: "matroska",
      video: ["h264"],
      audio: ["aac"],
      subtitles: ["subrip", "ass", "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"],
    };

    it.each(["subrip", "ass"])("keeps the Route for text subtitles, %s, which are converted if need be", (codec) => {
      expect(
        chooseRoute(probeOf(subtitled), SAMSUNG_TV_PLAYABLE_FORMATS, { subtitle: subtitleIn(subtitled, codec) }),
      ).toBe("direct-play");
    });

    it.each(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"])(
      "takes Full Conversion for image subtitles, %s, the TV can't show, to burn them in",
      (codec) => {
        expect(
          chooseRoute(probeOf(subtitled), SAMSUNG_TV_PLAYABLE_FORMATS, { subtitle: subtitleIn(subtitled, codec) }),
        ).toBe("full-conversion");
      },
    );

    it("keeps the Route for image subtitles a TV shows itself", () => {
      const showsPgs: PlayableFormats = {
        ...SAMSUNG_TV_PLAYABLE_FORMATS,
        subtitles: [...SAMSUNG_TV_PLAYABLE_FORMATS.subtitles, "hdmv_pgs_subtitle"],
      };
      const subtitle = subtitleIn(subtitled, "hdmv_pgs_subtitle");

      expect(chooseRoute(probeOf(subtitled), showsPgs, { subtitle })).toBe("direct-play");
    });

    it("ignores a chosen index that isn't a subtitle stream", () => {
      expect(chooseRoute(probeOf(subtitled), SAMSUNG_TV_PLAYABLE_FORMATS, { subtitle: 0 })).toBe("direct-play");
    });
  });

  it("goes by what the TV plays, which another TV's Driver says differently", () => {
    const playsEverythingInMkv: PlayableFormats = {
      direct: { matroska: { video: ["mpeg4", "h264"], audio: ["dts", "mp2"] } },
      streamed: { video: ["h264"], audio: ["aac"] },
      subtitles: [],
    };

    expect(
      chooseRoute(probeOf({ container: "matroska", video: ["mpeg4"], audio: ["dts"] }), playsEverythingInMkv),
    ).toBe("direct-play");
    expect(chooseRoute(probeOf({ container: "avi", video: ["h264"], audio: ["dts"] }), playsEverythingInMkv)).toBe(
      "audio-conversion",
    );
  });

  it("has no Route for a file with neither video nor audio to play", () => {
    expect(
      chooseRoute(probeOf({ container: "matroska", subtitles: ["subrip"] }), SAMSUNG_TV_PLAYABLE_FORMATS),
    ).toBeNull();
    expect(chooseRoute(probeOf({ container: "mp3", pictures: ["mjpeg"] }), SAMSUNG_TV_PLAYABLE_FORMATS)).toBeNull();
  });
});

describe("the audio of a Media File (FR-36, FR-41)", () => {
  const film: MediaProbe = {
    container: "matroska",
    duration: 60,
    startTime: 0,
    tags: NO_TAGS,
    streams: [
      { index: 0, type: "video", codec: "h264", attachedPicture: false, language: null, title: null, channels: null },
      {
        index: 1,
        type: "audio",
        codec: "dts",
        attachedPicture: false,
        language: "eng",
        title: "Surround",
        channels: 6,
      },
      {
        index: 2,
        type: "subtitle",
        codec: "subrip",
        attachedPicture: false,
        language: "eng",
        title: null,
        channels: null,
      },
      { index: 3, type: "audio", codec: "ac3", attachedPicture: false, language: "fre", title: null, channels: 2 },
      { index: 4, type: "audio", codec: "truehd", attachedPicture: false, language: null, title: null, channels: 8 },
    ],
  };

  it("lists every audio track, in the file's order, with its language where the file says", () => {
    expect(audioTracksOf(film)).toEqual([
      { language: "eng", title: "Surround", codec: "dts", channels: 6 },
      { language: "fre", title: null, codec: "ac3", channels: 2 },
      { language: null, title: null, codec: "truehd", channels: 8 },
    ]);
  });

  it("converts only the audio streams the TV doesn't play from HLS, by their indexes", () => {
    expect(chooseRoute(film, SAMSUNG_TV_PLAYABLE_FORMATS)).toBe("audio-conversion");
    expect(audioToConvert(film, SAMSUNG_TV_PLAYABLE_FORMATS)).toEqual([1, 4]);
  });
});
