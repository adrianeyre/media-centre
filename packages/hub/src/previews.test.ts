import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PREVIEW_REFRESH_MS, type PlaybackState, type PlayerPlayback } from "@media-centre/shared";

import { ffmpegFrame, previewPictures, type ExtractFrame } from "./previews.ts";
import type { SentMedia, SentTracks } from "./sent-tracks.ts";
import { brightnessOfPicture, makeBrighteningVideo } from "./testing/media.ts";

const TV = "127.0.0.2";
const URL = "http://127.0.0.1:8080/api/media-sources/1/files/Films/Film.mkv";
const FILE = "/media/Films/Film.mkv";

/** The Hub's record of what it sent the TV's Player: a video, or not, at {@link URL}. */
const sentTracks = (video = true): Pick<SentTracks, "at"> => ({
  at: (address, url) =>
    address === TV && url === URL ? ({ file: FILE, video } as Partial<SentMedia> as SentMedia) : null,
});

const playback = (state: PlaybackState, positionMs: number, url: string | null = URL): PlayerPlayback => ({
  state,
  url,
  positionMs,
  durationMs: 60_000,
  audioTrack: 0,
});

/**
 * Previews of what the Player on {@link TV} plays, on a clock the test moves,
 * and every frame extracted, which is a picture of where it was taken.
 */
const previews = (video = true) => {
  let time = 1_000_000;
  const extracted: { readonly file: string; readonly positionMs: number }[] = [];
  const extractFrame: ExtractFrame = (file, positionMs) => {
    extracted.push({ file, positionMs });
    return Promise.resolve(new TextEncoder().encode(`frame at ${String(positionMs)}`));
  };
  const made = previewPictures(sentTracks(video), { extractFrame, now: () => time });
  return {
    ...made,
    extracted,
    /** The Player's reports, a second apart, as it plays from `fromMs`, `seconds` of them, as the clock moves on. */
    plays: (fromMs: number, seconds: number): void => {
      for (let second = 0; second < seconds; second += 1) {
        made.heard(TV, playback("playing", fromMs + second * 1_000));
        time += 1_000;
      }
    },
    /** Moves the clock on, as the Player reports it is `state` at `positionMs`. */
    reports: (state: PlaybackState, positionMs: number, afterMs = 1_000): void => {
      time += afterMs;
      made.heard(TV, playback(state, positionMs));
    },
    /** What the picture asked for now is of. */
    pictured: async (): Promise<string | null> => {
      const picture = await made.picture(TV);
      return picture === null ? null : new TextDecoder().decode(picture);
    },
  };
};

describe("the preview picture of what a TV's Player plays (FR-27)", () => {
  it("is at where the Player is once it plays a video, extracted from the file only once asked, and only once", async () => {
    const preview = previews();

    preview.heard(TV, playback("playing", 12_000));

    expect(preview.at(TV, URL)).toEqual({ positionMs: 12_000 });
    expect(preview.extracted).toEqual([]);
    expect(await preview.pictured()).toBe("frame at 12000");
    expect(await preview.pictured()).toBe("frame at 12000");
    expect(preview.extracted).toEqual([{ file: FILE, positionMs: 12_000 }]);
  });

  it(`moves to where the Player is every ${String(PREVIEW_REFRESH_MS / 1_000)} seconds while it plays, and not between`, async () => {
    const preview = previews();
    const at: (number | undefined)[] = [];

    for (let second = 0; second < 16; second += 1) {
      preview.plays(second * 1_000, 1);
      at.push(preview.at(TV, URL)?.positionMs);
      await preview.pictured();
    }

    expect(at).toEqual([
      ...Array<number>(5).fill(0),
      ...Array<number>(5).fill(5_000),
      ...Array<number>(5).fill(10_000),
      15_000,
    ]);
    expect(preview.extracted.map(({ positionMs }) => positionMs)).toEqual([0, 5_000, 10_000, 15_000]);
  });

  it("holds still while the Player is paused, however long, extracting no further frame however often asked", async () => {
    const preview = previews();
    preview.plays(0, 7);
    // Paused a moment after its last report, as at 7 seconds.
    preview.reports("paused", 7_200, 200);
    const extracted = preview.extracted.length;

    for (let second = 0; second < 30; second += 1) {
      preview.reports("paused", 7_200);
      expect(await preview.pictured()).toBe("frame at 5000");
    }

    expect(preview.at(TV, URL)).toEqual({ positionMs: 5_000 });
    expect(preview.extracted).toHaveLength(extracted + 1);
  });

  it("goes on moving every 5 seconds once the Player plays again", () => {
    const preview = previews();
    preview.plays(0, 3);
    for (let second = 0; second < 20; second += 1) preview.reports("paused", 3_000);
    expect(preview.at(TV, URL)).toEqual({ positionMs: 0 });

    preview.reports("playing", 3_000);

    expect(preview.at(TV, URL)).toEqual({ positionMs: 3_000 });
  });

  it("follows a seek at once, whether the Player is playing or paused, and a skip as short as 10 seconds", async () => {
    const preview = previews();
    preview.plays(0, 2);

    preview.reports("playing", 45_000, 300);
    expect(preview.at(TV, URL)).toEqual({ positionMs: 45_000 });
    expect(await preview.pictured()).toBe("frame at 45000");

    preview.reports("paused", 45_400, 400);
    preview.reports("paused", 35_400, 300);
    expect(preview.at(TV, URL)).toEqual({ positionMs: 35_400 });
    expect(await preview.pictured()).toBe("frame at 35400");

    preview.reports("paused", 0, 300);
    expect(preview.at(TV, URL)).toEqual({ positionMs: 0 });
  });

  it("takes a Player's report a little late, or a little early, for playing on rather than a seek", () => {
    const preview = previews();
    preview.plays(0, 1);
    preview.reports("playing", 1_000, 1_900);
    preview.reports("playing", 3_400, 500);

    expect(preview.at(TV, URL)).toEqual({ positionMs: 0 });
  });

  it("starts again at where the Player is for each Media File the Hub sends it, and has none once it plays nothing", () => {
    const preview = previews();
    preview.plays(0, 3);
    expect(preview.at(TV, "http://127.0.0.1:8080/api/streams/other/playlist.m3u8")).toBeNull();

    preview.reports("idle", 0);

    expect(preview.at(TV, URL)).toBeNull();
    preview.reports("loading", 0);
    expect(preview.at(TV, URL)).toEqual({ positionMs: 0 });
  });

  it("has none of a Media File with no video, nor of one the Hub didn't send, and extracts nothing for them", async () => {
    for (const [preview, url] of [
      [previews(false), URL],
      [previews(), "http://127.0.0.1:8080/api/media-sources/1/files/Films/Other.mkv"],
    ] as const) {
      preview.heard(TV, playback("playing", 12_000, url));

      expect(preview.at(TV, url)).toBeNull();
      expect(await preview.pictured()).toBeNull();
      expect(preview.extracted).toEqual([]);
    }
  });

  it("is none, and says why in the Hub's log, when the frame can't be extracted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const preview = previewPictures(sentTracks(), { extractFrame: () => Promise.reject(new Error("No such file")) });
    preview.heard(TV, playback("playing", 0));

    expect(await preview.picture(TV)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('Couldn\'t extract a preview picture from "Film.mkv": No such file');
    vi.restoreAllMocks();
  });
});

describe("extracting a frame from a Media File with ffmpeg (FR-27)", () => {
  let dir: string;
  let video: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hub-previews-"));
    video = join(dir, "Brightening.mkv");
    await makeBrighteningVideo(video);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is a JPEG of the frame at the position, from the file itself", async () => {
    for (const seconds of [0, 10, 30, 59.5]) {
      const picture = await ffmpegFrame(video, seconds * 1_000);

      expect(picture?.subarray(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
      expect(await brightnessOfPicture(picture ?? new Uint8Array())).toBeCloseTo(seconds * 4, -0.5);
    }
  });

  it("is none past the Media File's end", async () => {
    expect(await ffmpegFrame(video, 70_000)).toBeNull();
  });

  it("rejects for a file ffmpeg can't read", async () => {
    await expect(ffmpegFrame(join(dir, "Missing.mkv"), 0)).rejects.toThrow(/No such file/);
  });
});
