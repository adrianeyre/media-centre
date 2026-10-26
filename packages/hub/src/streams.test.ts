import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { STREAMS_PATH, type PlayerPlayback } from "@media-centre/shared";

import { SAMSUNG_TV_PLAYABLE_FORMATS } from "./drivers/samsung-tv/playable-formats.ts";
import { ffprobeMedia, type MediaProbe } from "./ffprobe.ts";
import { audioToConvert } from "./routes.ts";
import { hlsStreams, type StreamedFile, type Streams, type StreamsOptions } from "./streams.ts";
import { makeTestMediaSource, operaBrightness } from "./testing/media.ts";
import { SOFTWARE_VIDEO_ENCODER, type VideoEncoder } from "./video-encoders.ts";

const run = promisify(execFile);

// The Remux Route's HLS (FR-42, ADR 0006), with real ffmpeg, on the sample
// recorded from broadcast TV: a minute of H.264 and MP2 in an MKV, with a
// keyframe every 2 seconds.
const TV = "127.0.0.2";
const RECORDING = "Films/Recording.mkv";
/** Twelve seconds of H.264 with DTS 5.1, then Dolby Digital and AAC, which takes the Audio Conversion Route. */
const ARRIVAL = "Films/Sci-Fi/Arrival.mkv";
/** A minute of Xvid and MP3 in an AVI, with a keyframe every 5 seconds, which takes the Full Conversion Route. */
const HOME_VIDEO = "Films/Home Video.avi";
/**
 * A minute of H.264 and AAC, its picture black, with a SubRip, then PGS and
 * VobSub showing a white box, at indexes 3 and 4, which Full Conversion burns in.
 */
const OPERA = "Films/Opera.mkv";
/** Short segments, so that each takes ffmpeg reading as the file plays only a moment. */
const SEGMENT_SECONDS = 2;

let media: string;
let recording: StreamedFile;
let arrival: StreamedFile;
let homeVideo: StreamedFile;
let opera: StreamedFile;
let streams: Streams;
let server: Server;
let base: string;

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-streams-"));
  await makeTestMediaSource(media);
  const probe = await ffprobeMedia(join(media, RECORDING));
  if (probe?.duration === null || probe === null) throw new Error("ffprobe couldn't read the recording");
  recording = {
    mediaSourceId: 1,
    path: RECORDING,
    file: join(media, RECORDING),
    name: "Recording.mkv",
    probe: { ...probe, duration: probe.duration },
    convertAudio: [],
    convertVideo: false,
    burnSubtitle: null,
  };
  const film = await ffprobeMedia(join(media, ARRIVAL));
  if (film?.duration === null || film === null) throw new Error("ffprobe couldn't read the film");
  arrival = {
    mediaSourceId: 1,
    path: ARRIVAL,
    file: join(media, ARRIVAL),
    name: "Arrival.mkv",
    probe: { ...film, duration: film.duration },
    convertAudio: audioToConvert(film, SAMSUNG_TV_PLAYABLE_FORMATS),
    convertVideo: false,
    burnSubtitle: null,
  };
  const avi = await ffprobeMedia(join(media, HOME_VIDEO));
  if (avi?.duration === null || avi === null) throw new Error("ffprobe couldn't read the home video");
  homeVideo = {
    mediaSourceId: 1,
    path: HOME_VIDEO,
    file: join(media, HOME_VIDEO),
    name: "Home Video.avi",
    probe: { ...avi, duration: avi.duration },
    convertAudio: audioToConvert(avi, SAMSUNG_TV_PLAYABLE_FORMATS),
    convertVideo: true,
    burnSubtitle: null,
  };
  const subtitled = await ffprobeMedia(join(media, OPERA));
  if (subtitled?.duration === null || subtitled === null) throw new Error("ffprobe couldn't read the opera");
  opera = {
    mediaSourceId: 1,
    path: OPERA,
    file: join(media, OPERA),
    name: "Opera.mkv",
    probe: { ...subtitled, duration: subtitled.duration },
    convertAudio: [],
    convertVideo: true,
    burnSubtitle: null,
  };
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

/** Serves `streams` alone, as the Hub serves them. */
const serve = async (options: StreamsOptions = {}): Promise<void> => {
  streams = hlsStreams({ segmentSeconds: SEGMENT_SECONDS, ...options });
  server = createServer((request, response) => {
    void streams.handle(request, response, new URL(request.url ?? "/", "http://hub").pathname).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await streams.close();
  await new Promise((done) => server.close(done));
  vi.restoreAllMocks();
});

/** Whether the process is still running. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Resolves once `check` holds, or fails after 8 seconds. */
const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Never ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
};

/** Resolves once none of these ffmpegs is running any more, nor any other of `streams`. */
const allStopped = async (pids: readonly number[]): Promise<void> => {
  await until(() => streams.running().length === 0 && !pids.some(isRunning), "stopped every ffmpeg");
};

/** What ffprobe says of a segment the Hub served. */
const probeSegment = async (bytes: Uint8Array): Promise<MediaProbe | null> => {
  const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
  try {
    await writeFile(join(dir, "segment.ts"), bytes);
    return await ffprobeMedia(join(dir, "segment.ts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * When a segment's first picture is, in seconds into the Media File, as its
 * timestamps say; or, given another stream, e.g. "a:0", when that starts.
 */
const firstPictureIn = async (bytes: Uint8Array, stream = "v:0"): Promise<number> => {
  const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
  try {
    await writeFile(join(dir, "segment.ts"), bytes);
    const { stdout } = await run("ffprobe", [
      "-v",
      "quiet",
      "-select_streams",
      stream,
      "-show_entries",
      "stream=start_time",
      "-of",
      "csv=p=0",
      join(dir, "segment.ts"),
    ]);
    // Said once for the stream and again for its program. MPEG-TS starts its
    // timestamps 1.4 seconds in, which players take as the start.
    return Number(stdout.trim().split("\n")[0]) - 1.4;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The MD5 of each picture of the file's first video stream, decoded, in order: the same for a stream copied, not for one re-encoded. */
const decodedPictures = async (file: string): Promise<string[]> => {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim() ?? "");
};

const segment = async (path: string, number: number): Promise<Response> =>
  fetch(`${base}${path.replace(/index\.m3u8$/, `${String(number)}.ts`)}`);

const playing = (path: string, state: PlayerPlayback["state"] = "playing"): PlayerPlayback => ({
  state,
  url: `http://hub:8080${path}`,
  positionMs: 1_000,
  durationMs: 60_000,
  audioTrack: 0,
});

describe("streaming a Media File by Remux, as HLS (FR-42)", () => {
  it("serves a playlist of the whole Media File, in segments, so the Player can seek anywhere in it", async () => {
    await serve();
    const path = streams.start(TV, recording);

    expect(path).toMatch(new RegExp(`^${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
    const answer = await fetch(`${base}${path}`);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    const lines = (await answer.text()).trim().split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:3",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
    ]);
    expect(lines.at(-1)).toBe("#EXT-X-ENDLIST");
    const segments = lines.filter((line) => line.endsWith(".ts"));
    expect(segments).toEqual(Array.from({ length: 30 }, (_, index) => `${String(index)}.ts`));
    const lengths = lines.filter((line) => line.startsWith("#EXTINF:")).map((line) => Number(line.slice(8, -1)));
    // The last takes the tenth of a second over the minute, and the few
    // milliseconds of the MP2 encoder's delay that ffmpeg before 6.0 adds.
    expect(lengths.slice(0, -1).every((length) => length === 2)).toBe(true);
    expect(lengths.at(-1)).toBeCloseTo(2.1, 1);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBeCloseTo(recording.probe.duration, 3);
    // ffmpeg starts only once the Player asks for a segment.
    expect(streams.running()).toEqual([]);
  });

  it("serves each segment as MPEG-TS, the streams copied, not converted, at its place in the Media File", async () => {
    await serve();
    const path = streams.start(TV, recording);

    const first = await segment(path, 0);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("video/mp2t");
    const bytes = new Uint8Array(await first.arrayBuffer());
    const probe = await probeSegment(bytes);

    expect(probe?.container).toBe("mpegts");
    expect(probe?.streams.map(({ type, codec }) => [type, codec])).toEqual([
      ["video", "h264"],
      ["audio", "mp2"],
    ]);
    expect(probe?.duration).toBeCloseTo(SEGMENT_SECONDS, 0);
    expect(await firstPictureIn(bytes)).toBeCloseTo(0, 0);
    const fifth = new Uint8Array(await (await segment(path, 5)).arrayBuffer());
    expect(await firstPictureIn(fifth)).toBeCloseTo(5 * SEGMENT_SECONDS, 0);
  });

  it("keeps the first segment's timestamps on the same timeline as the rest, its video having B-frames", async () => {
    await serve();
    const path = streams.start(TV, recording);

    const first = new Uint8Array(await (await segment(path, 0)).arrayBuffer());
    const second = new Uint8Array(await (await segment(path, 1)).arrayBuffer());

    expect(await firstPictureIn(first)).toBeCloseTo(0, 1);
    expect(await firstPictureIn(second)).toBeCloseTo(SEGMENT_SECONDS, 1);
  });

  it("restarts ffmpeg from a segment far beyond what it has produced, for a seek there, and serves it", async () => {
    // As the Media File plays, so that it hasn't produced the end by the time the Player seeks there.
    await serve({ readRate: 1 });
    const path = streams.start(TV, recording);
    expect((await segment(path, 0)).status).toBe(200);
    const [fromStart] = streams.running();
    expect(fromStart).toBeDefined();

    const seeking = Date.now();
    const answer = await segment(path, 25);

    expect(answer.status).toBe(200);
    const bytes = new Uint8Array(await answer.arrayBuffer());
    // From the keyframe before it, at most 2 seconds before, so that the TV can show it at once.
    const first = await firstPictureIn(bytes);
    expect(first).toBeLessThanOrEqual(25 * SEGMENT_SECONDS + 0.1);
    expect(first).toBeGreaterThanOrEqual(25 * SEGMENT_SECONDS - 2.1);
    // Far sooner than reading the 50 seconds before it as they play.
    expect(Date.now() - seeking).toBeLessThan(10_000);
    const [fromSeek] = streams.running();
    expect(fromSeek).toBeDefined();
    expect(fromSeek).not.toBe(fromStart);
    await until(() => !isRunning(fromStart ?? 0), "stopped the ffmpeg from the start");
    // What the first ffmpeg produced is still served.
    expect((await segment(path, 0)).status).toBe(200);
    expect(streams.running()).toEqual([fromSeek]);
  });

  it("waits for a segment just ahead of what ffmpeg has produced, rather than starting again", async () => {
    await serve({ readRate: 1 });
    const path = streams.start(TV, recording);
    expect((await segment(path, 0)).status).toBe(200);
    const before = streams.running();

    expect((await segment(path, 2)).status).toBe(200);

    expect(streams.running()).toEqual(before);
  }, 15_000);

  it("refuses a segment past the end, and a stream it hasn't got", async () => {
    await serve();
    const path = streams.start(TV, recording);

    expect((await segment(path, 30)).status).toBe(404);
    expect((await fetch(`${base}${STREAMS_PATH}/00000000-0000-0000-0000-000000000000/index.m3u8`)).status).toBe(404);
    expect((await fetch(`${base}${STREAMS_PATH}/nonsense/0.ts`)).status).toBe(404);
    expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(405);
  });

  it("says which Media File a stream's URL is of, as the Player reports it", async () => {
    await serve();
    const path = streams.start(TV, recording);

    expect(streams.mediaFileAt(`http://hub:8080${path}`)).toEqual({
      mediaSourceId: 1,
      path: RECORDING,
      name: "Recording.mkv",
    });
    expect(streams.mediaFileAt("http://hub:8080/api/media-sources/1/file/Films/Trailer.mkv")).toBeNull();
    expect(streams.mediaFileAt(null)).toBeNull();
  });
});

describe("stopping ffmpeg (FR-42)", () => {
  /** Starts a stream with ffmpeg reading as it plays, so that it is still running, and resolves with its path and process id. */
  const streaming = async (options: StreamsOptions = {}): Promise<{ path: string; pid: number }> => {
    await serve({ readRate: 1, ...options });
    const path = streams.start(TV, recording);
    streams.heard(TV, playing(path, "loading"));
    expect((await segment(path, 0)).status).toBe(200);
    const [pid] = streams.running();
    if (pid === undefined) throw new Error("ffmpeg isn't running");
    expect(isRunning(pid)).toBe(true);
    return { path, pid };
  };

  it("stops it, and ends the stream, once the Player stops playing it", async () => {
    const { path, pid } = await streaming();

    streams.heard(TV, { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null });

    await allStopped([pid]);
    expect((await segment(path, 0)).status).toBe(404);
    expect(streams.mediaFileAt(`http://hub${path}`)).toBeNull();
  });

  it("stops it once the Player plays something else", async () => {
    const { pid } = await streaming();

    streams.heard(TV, {
      state: "loading",
      url: "http://hub/api/media-sources/1/file/Films/Trailer.mkv",
      positionMs: 0,
      durationMs: null,
      audioTrack: null,
    });

    await allStopped([pid]);
  });

  it("goes on while the Player only says what it played before it was sent the stream", async () => {
    await serve({ readRate: 1 });
    const path = streams.start(TV, recording);

    streams.heard(TV, { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null });

    expect((await segment(path, 0)).status).toBe(200);
  });

  it("stops it at once when the Player disconnects, and ends the stream if it doesn't come back", async () => {
    const { path, pid } = await streaming({ abandonedMs: 5_000 });

    streams.playerGone(TV);

    await allStopped([pid]);
    // Until then, the TV may still be playing it, and asks for more.
    expect((await segment(path, 10)).status).toBe(200);
    const [again] = streams.running();
    expect(again).toBeDefined();
    await until(async () => (await fetch(`${base}${path}`)).status === 404, "ended the stream");
    await allStopped(again === undefined ? [] : [again]);
  }, 15_000);

  it("keeps the stream for a Player that connects again and says it plays it", async () => {
    const { path, pid } = await streaming({ abandonedMs: 300 });

    streams.playerGone(TV);
    await allStopped([pid]);
    streams.heard(TV, playing(path));
    await new Promise((done) => setTimeout(done, 500));

    expect((await fetch(`${base}${path}`)).status).toBe(200);
  });

  it("ends the TV's stream when another is started there", async () => {
    const { path, pid } = await streaming();

    const next = streams.start(TV, recording);

    await allStopped([pid]);
    expect((await fetch(`${base}${path}`)).status).toBe(404);
    expect((await fetch(`${base}${next}`)).status).toBe(200);
  });

  it("stops every ffmpeg, and deletes every segment, as the Hub stops", async () => {
    // This process's own, as each test file runs in its own, streaming beside this one.
    const ours = async (): Promise<string[]> =>
      (await readdir(tmpdir())).filter((name) => name.startsWith(`media-centre-streams-${String(process.pid)}-`));
    const before = new Set(await ours());
    const { path, pid } = await streaming();
    const other = streams.start("127.0.0.3", recording);
    expect((await segment(other, 0)).status).toBe(200);
    const pids = streams.running();
    expect(pids).toHaveLength(2);
    expect(path).not.toBe(other);

    const made = (await ours()).filter((name) => !before.has(name));
    expect(made).toHaveLength(1);
    expect(await readdir(join(tmpdir(), made[0] ?? ""))).toHaveLength(2);

    await streams.close();

    await allStopped([pid, ...pids]);
    expect((await ours()).filter((name) => made.includes(name))).toEqual([]);
  });
});

describe("segments left behind (FR-42)", () => {
  it("are deleted before the first stream, when the Hub that made them is no longer running, and only then", async () => {
    // A Hub that was killed, and another that is still running.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    const running = spawn("sleep", ["30"]);
    const left = join(tmpdir(), `media-centre-streams-${String(gone)}-left-behind`);
    const kept = join(tmpdir(), `media-centre-streams-${String(running.pid)}-still-running`);
    try {
      for (const dir of [left, kept]) {
        await mkdir(join(dir, "stream"), { recursive: true });
        await writeFile(join(dir, "stream", "run1-0.ts"), "a segment");
      }
      await serve();

      const path = streams.start(TV, recording);
      expect((await segment(path, 0)).status).toBe(200);

      await expect(stat(left)).rejects.toThrow();
      expect((await stat(kept)).isDirectory()).toBe(true);
    } finally {
      running.kill();
      await rm(kept, { recursive: true, force: true });
      await rm(left, { recursive: true, force: true });
    }
  });
});

describe("streaming a Media File by Audio Conversion, as HLS (FR-41, FR-42, ADR 0006)", () => {
  it("re-encodes only the audio the TV can't play, DTS, to Dolby Digital, copying every other stream", async () => {
    expect(arrival.convertAudio).toEqual([1]);
    await serve();
    const path = streams.start(TV, arrival);

    const first = await segment(path, 0);
    expect(first.status).toBe(200);
    const probe = await probeSegment(new Uint8Array(await first.arrayBuffer()));

    expect(probe?.container).toBe("mpegts");
    // Every audio track, in the file's order, each with its language, so that the Player can switch between them.
    expect(probe?.streams.map(({ type, codec, channels, language }) => [type, codec, channels, language])).toEqual([
      ["video", "h264", null, null],
      ["audio", "ac3", 6, "eng"],
      ["audio", "ac3", 2, "fre"],
      ["audio", "aac", 2, null],
    ]);
    expect(probe?.duration).toBeCloseTo(SEGMENT_SECONDS, 0);
  });

  it("copies the video, not re-encoding it: its pictures decode to exactly the Media File's", async () => {
    await serve();
    const path = streams.start(TV, arrival);
    const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
    try {
      const segments: string[] = [];
      for (let number = 0; number < 3; number += 1) {
        const answer = await segment(path, number);
        expect(answer.status).toBe(200);
        segments.push(join(dir, `${String(number)}.ts`));
        await writeFile(segments.at(-1) ?? "", new Uint8Array(await answer.arrayBuffer()));
      }
      const streamed = (await Promise.all(segments.map(decodedPictures))).flat();
      const original = await decodedPictures(arrival.file);

      // Ten pictures a second, for the three segments' six seconds.
      expect(streamed).toHaveLength(60);
      expect(streamed).toEqual(original.slice(0, streamed.length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts the converted audio where each segment starts, from the start and from a seek", async () => {
    await serve();
    const path = streams.start(TV, arrival);

    for (const number of [0, 4]) {
      const bytes = new Uint8Array(await (await segment(path, number)).arrayBuffer());
      expect(await firstPictureIn(bytes, "a:0")).toBeCloseTo(number * SEGMENT_SECONDS, 0);
    }
  });

  it("says why in the Hub's log when ffmpeg can't convert the audio", async () => {
    const error = vi.mocked(console.error);
    await serve({ segmentTimeoutMs: 2_000 });
    const path = streams.start(TV, { ...arrival, file: join(media, "Damaged.mp4") });

    expect((await segment(path, 0)).status).toBe(500);
    expect(error.mock.calls.flat().join("\n")).toContain('ffmpeg couldn\'t convert the audio of "Arrival.mkv"');
  });
});

describe("streaming a Media File by Full Conversion, as HLS (FR-41, FR-42, ADR 0006)", () => {
  /** The first picture of a segment's video, as ffprobe says: when it is, as {@link firstPictureIn} says, and whether it is a keyframe. */
  const firstFrameIn = async (bytes: Uint8Array): Promise<{ at: number; keyframe: boolean }> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
    try {
      await writeFile(join(dir, "segment.ts"), bytes);
      const { stdout } = await run("ffprobe", [
        ...["-v", "quiet", "-select_streams", "v:0", "-read_intervals", "%+#1"],
        ...["-show_entries", "frame=pts_time,key_frame", "-of", "csv=p=0"],
        join(dir, "segment.ts"),
      ]);
      const [keyframe, at] = (stdout.trim().split("\n")[0] ?? "").split(",");
      return { at: Number(at) - 1.4, keyframe: keyframe === "1" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** What ffprobe says of a segment's video: its codec, profile and pixel format. */
  const videoIn = async (bytes: Uint8Array): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
    try {
      await writeFile(join(dir, "segment.ts"), bytes);
      const { stdout } = await run("ffprobe", [
        ...["-v", "quiet", "-select_streams", "v:0"],
        ...["-show_entries", "stream=codec_name,profile,pix_fmt", "-of", "csv=p=0"],
        join(dir, "segment.ts"),
      ]);
      return stdout.trim().split("\n")[0] ?? "";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const bytesOf = async (path: string, number: number): Promise<Uint8Array> => {
    const answer = await segment(path, number);
    expect(answer.status).toBe(200);
    return new Uint8Array(await answer.arrayBuffer());
  };

  it("re-encodes the video the TV can't play, Xvid, to H.264, copying the audio it plays", async () => {
    expect(homeVideo.convertAudio).toEqual([]);
    await serve();
    const path = streams.start(TV, homeVideo);

    const bytes = await bytesOf(path, 0);
    const probe = await probeSegment(bytes);

    expect(probe?.container).toBe("mpegts");
    expect(probe?.streams.map(({ type, codec }) => [type, codec])).toEqual([
      ["video", "h264"],
      ["audio", "mp3"],
    ]);
    expect(await videoIn(bytes)).toBe("h264,High,yuv420p");
    expect(SAMSUNG_TV_PLAYABLE_FORMATS.streamed.video).toContain(SOFTWARE_VIDEO_ENCODER.codec);
    expect(probe?.duration).toBeCloseTo(SEGMENT_SECONDS, 0);
  });

  it("starts every segment with a keyframe at exactly its time, though the Media File has one only every 5 seconds", async () => {
    await serve();
    const path = streams.start(TV, homeVideo);

    for (const number of [0, 1, 2, 3, 4]) {
      const first = await firstFrameIn(await bytesOf(path, number));
      expect(first.keyframe).toBe(true);
      expect(first.at).toBeCloseTo(number * SEGMENT_SECONDS, 2);
    }
  });

  it("restarts ffmpeg from a segment far beyond what it has converted, for a seek there, its video and audio both starting there", async () => {
    // As the Media File plays, so that it hasn't converted the end by the time the Player seeks there.
    await serve({ readRate: 1 });
    const path = streams.start(TV, homeVideo);
    await bytesOf(path, 0);
    const [fromStart] = streams.running();
    expect(fromStart).toBeDefined();

    const seeking = Date.now();
    // 46 seconds in, a second after the Media File's keyframe at 45.
    const bytes = await bytesOf(path, 23);

    expect(Date.now() - seeking).toBeLessThan(10_000);
    const first = await firstFrameIn(bytes);
    expect(first.keyframe).toBe(true);
    expect(first.at).toBeCloseTo(23 * SEGMENT_SECONDS, 2);
    // Not the audio the AVI holds from before the seek, which ffmpeg would copy too.
    expect(await firstPictureIn(bytes, "a:0")).toBeCloseTo(23 * SEGMENT_SECONDS, 1);
    const [fromSeek] = streams.running();
    expect(fromSeek).toBeDefined();
    expect(fromSeek).not.toBe(fromStart);
    await until(() => !isRunning(fromStart ?? 0), "stopped the ffmpeg from the start");
    // The segment after follows on, from the same ffmpeg.
    const next = await firstFrameIn(await bytesOf(path, 24));
    expect(next.keyframe).toBe(true);
    expect(next.at).toBeCloseTo(24 * SEGMENT_SECONDS, 2);
    expect(streams.running()).toEqual([fromSeek]);
  }, 15_000);

  it("encodes with the encoder chosen in one place, chosen once, and only for Full Conversion", async () => {
    const mpeg2: VideoEncoder = {
      name: "a test encoder (MPEG-2)",
      codec: "mpeg2video",
      inputArguments: [],
      filter: "",
      outputArguments: ["-c:v", "mpeg2video"],
    };
    const choose = vi.fn(() => Promise.resolve(mpeg2));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await serve({ chooseVideoEncoder: choose });

    // Remux and Audio Conversion copy the video, so needn't choose.
    await bytesOf(streams.start(TV, recording), 0);
    await bytesOf(streams.start(TV, arrival), 0);
    expect(choose).not.toHaveBeenCalled();
    const first = await probeSegment(await bytesOf(streams.start(TV, homeVideo), 0));
    const second = await probeSegment(await bytesOf(streams.start("127.0.0.3", homeVideo), 3));

    for (const probe of [first, second])
      expect(probe?.streams.find(({ type }) => type === "video")?.codec).toBe("mpeg2video");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Full Conversion re-encodes video in a test encoder (MPEG-2)");
  });

  it("says why in the Hub's log when ffmpeg can't convert the Media File", async () => {
    const error = vi.mocked(console.error);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await serve({ segmentTimeoutMs: 2_000 });
    const path = streams.start(TV, { ...homeVideo, file: join(media, "Damaged.mp4") });

    expect((await segment(path, 0)).status).toBe(500);
    expect(error.mock.calls.flat().join("\n")).toContain('ffmpeg couldn\'t convert "Home Video.avi"');
  });
});

describe("burning image subtitles into a stream by Full Conversion (FR-45, ADR 0006)", () => {
  const bytesOf = async (path: string, number: number): Promise<Uint8Array> => {
    const answer = await segment(path, number);
    expect(answer.status).toBe(200);
    return new Uint8Array(await answer.arrayBuffer());
  };

  it.each([
    ["PGS", 3],
    ["VobSub", 4],
  ])(
    "burns %s into the video it re-encodes, at its place, leaving the rest of the picture as it was",
    async (_, index) => {
      expect(opera.probe.streams.find((stream) => stream.index === index)?.type).toBe("subtitle");
      await serve();
      const path = streams.start(TV, { ...opera, burnSubtitle: index });

      const bytes = await bytesOf(path, 0);

      // Half a second in, a picture of black with the white box on it.
      expect(await operaBrightness(bytes, 5, "box")).toBeGreaterThan(200);
      expect(await operaBrightness(bytes, 5, "outside")).toBeLessThan(40);
      // Burned into the picture, so not a stream of its own.
      expect((await probeSegment(bytes))?.streams.map(({ type, codec }) => [type, codec])).toEqual([
        ["video", "h264"],
        ["audio", "aac"],
      ]);
    },
  );

  it("burns in none it isn't asked to, re-encoding the picture as it is", async () => {
    await serve();
    const path = streams.start(TV, opera);

    expect(await operaBrightness(await bytesOf(path, 0), 5, "box")).toBeLessThan(40);
  });

  it("burns them in from a seek too, from the next subtitle on, every segment at exactly its time", async () => {
    await serve({ readRate: 1 });
    const path = streams.start(TV, { ...opera, burnSubtitle: 3 });
    await bytesOf(path, 0);

    // 46 seconds in, and on to the subtitle shown afresh at 50.
    await bytesOf(path, 23);
    await bytesOf(path, 24);
    const bytes = await bytesOf(path, 25);

    expect(await firstPictureIn(bytes)).toBeCloseTo(25 * SEGMENT_SECONDS, 2);
    expect(await operaBrightness(bytes, 5, "box")).toBeGreaterThan(200);
  }, 15_000);
});
