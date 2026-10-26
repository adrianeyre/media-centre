import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLIANCES_PATH,
  MEDIA_SOURCES_PATH,
  PLAYER_APP_ID,
  applianceNowShowingPath,
  appliancePlaybackPath,
  appliancePlayPath,
  appliancePreviewPath,
  applianceQueuePath,
  mediaCoverArtPath,
  mediaFilePath,
  mediaResumePositionPath,
  STREAMS_PATH,
  type Appliance,
  type AppliancePlayback,
  type HubError,
  type MediaResumePosition,
  type MediaSource,
  type NowPlaying,
  type NowShowing,
  type PlayProgress,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import {
  FAKE_APPS,
  FAKE_PLAYER_APP,
  startFakeSamsungTv,
  type FakeSamsungTv,
  type FakeSamsungTvOptions,
} from "./fakes/samsung-tv/fake-samsung-tv.ts";
import { createHub } from "./hub.ts";
import type { NetworkInterfaces } from "./hub-address.ts";
import type { PlayOptions } from "./play-api.ts";
import { ffmpegFrame, type ExtractFrame, type PreviewsOptions } from "./previews.ts";
import type { QueuesOptions } from "./queues.ts";
import type { StreamsOptions } from "./streams.ts";
import {
  ALBUM_TAGS,
  ARRIVAL_AUDIO_TRACKS,
  COVER_ART_SIZE,
  brightnessOfPicture,
  makeBrighteningVideo,
  FILM_SUBTITLES,
  FILM_SUBTITLE_TRACKS,
  makeTestMediaSource,
  OPERA_SUBTITLE,
  OPERA_SUBTITLE_TRACKS,
  operaBrightness,
} from "./testing/media.ts";

// The fake TV at its own loopback address, as a TV on the home network would
// be: its fake Player connects to the Hub from there, which is how the Hub
// knows it is that TV's.
const TV_HOST = "127.0.0.2";
const TV_MAC = "02:00:00:00:00:22";

/** One test Media Source, generated once with ffmpeg and only read by the tests. */
let media: string;
let database: DatabaseSync;
let tv: FakeSamsungTv;
let hub: Server | undefined;
let base: string;
let hubAddress: string;
let logged: string[];

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-play-"));
  await makeTestMediaSource(media);
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

/** The Hub's own address on its network, as it finds it: loopback here, where the fake TVs are. */
const loopbackInterfaces =
  (address = "127.0.0.1"): NetworkInterfaces =>
  () => ({
    eth0: [{ address, netmask: "255.0.0.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: null }],
  });

const QUICK: PlayOptions = { wakeTimeoutMs: 1_000, powerPollMs: 50, playerTimeoutMs: 1_500 };

/** Starts the fake TV, and a Hub whose Samsung TV Driver controls it, which finds itself at `ownAddress`. */
const start = async (
  tvOptions: FakeSamsungTvOptions = {},
  {
    ownAddress,
    interfaces = loopbackInterfaces(ownAddress),
    streams,
    previews,
    queues,
  }: {
    ownAddress?: string;
    interfaces?: NetworkInterfaces;
    streams?: StreamsOptions;
    previews?: PreviewsOptions;
    queues?: QueuesOptions;
  } = {},
): Promise<void> => {
  tv = await startFakeSamsungTv({
    host: TV_HOST,
    macAddress: TV_MAC,
    apps: [...FAKE_APPS, FAKE_PLAYER_APP],
    ...tvOptions,
  });
  const driver = samsungTvDriver({
    restPort: tv.restPort,
    controlPort: tv.controlPort,
    upnpPort: tv.upnpPort,
    wakePort: tv.wakePort,
    appsTimeoutMs: 1_000,
  });
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    drivers: { tv: driver },
    networkInterfaces: interfaces,
    play: QUICK,
    ...(streams === undefined ? {} : { streams }),
    ...(previews === undefined ? {} : { previews }),
    ...(queues === undefined ? {} : { queues }),
  });
  await new Promise<void>((done) => hub?.listen(0, "127.0.0.1", done));
  const { port } = hub.address() as AddressInfo;
  base = `http://127.0.0.1:${String(port)}`;
  hubAddress = `${ownAddress ?? "127.0.0.1"}:${String(port)}`;
};

beforeEach(() => {
  database = openDatabase(":memory:");
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  await tv.stop();
  if (hub !== undefined) await new Promise((done) => hub?.close(done));
  hub = undefined;
  database.close();
  vi.restoreAllMocks();
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const addTv = async (): Promise<Appliance> => {
  const room = (await (await post("/api/rooms", { name: "Living room" })).json()) as { id: number };
  const response = await post(APPLIANCES_PATH, { kind: "tv", address: TV_HOST, name: "TV", roomId: room.id });
  expect(response.status).toBe(201);
  return (await response.json()) as Appliance;
};

const addMedia = async (): Promise<MediaSource> => {
  const response = await post(MEDIA_SOURCES_PATH, { name: "Media", path: media });
  expect(response.status).toBe(201);
  return (await response.json()) as MediaSource;
};

/** Each step the Hub sent, with when it arrived. */
interface Heard {
  readonly at: number;
  readonly progress: PlayProgress;
}

/** Plays the Media File, and resolves once the Hub has said how it went, with each step as it arrived. */
const play = async (tvId: number, mediaSourceId: number, path: string, resume?: boolean): Promise<Heard[]> => {
  const response = await post(appliancePlayPath(tvId), {
    mediaSourceId,
    path,
    ...(resume === undefined ? {} : { resume }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
  const heard: Heard[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  const reader = response.body?.getReader();
  for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
    pending += decoder.decode(read.value as Uint8Array, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) heard.push({ at: Date.now(), progress: JSON.parse(line) as PlayProgress });
  }
  expect(pending).toBe("");
  return heard;
};

const steps = (heard: readonly Heard[]): PlayProgress[] => heard.map(({ progress }) => progress);

const refusal = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as HubError).error;
};

describe("playing a Media File on a TV by Direct Play (FR-35)", () => {
  it("with the TV on, launches the Player, which connects and is sent the Media File's URL", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const heard = await play(living.id, source.id, "Films/Sci-Fi/Clip.mp4");

    expect(steps(heard)).toEqual([
      { step: "launching" },
      { step: "connecting" },
      { step: "sending" },
      { step: "sent" },
    ]);
    const url = `http://${hubAddress}${mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4")}`;
    await expect.poll(() => tv.playerStatus()).toMatchObject({ connected: true, received: [url], playback: "playing" });
    expect(tv.apps()).toContainEqual({ id: PLAYER_APP_ID, name: "Media Centre", running: true, visible: true });
    expect(tv.wakes).toEqual([]);
    expect(logged).toContain('Sent "Clip.mp4" to the Player on Living room · TV, to play by Direct Play');
  });

  it("sends a URL that serves the Media File itself, with range requests", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await play(living.id, source.id, "Music/Album/01 Tone.flac");
    await expect.poll(() => tv.playerStatus().received).toHaveLength(1);
    const [url = ""] = tv.playerStatus().received;
    const file = await readFile(join(media, "Music/Album/01 Tone.flac"));

    const whole = await fetch(url);
    const part = await fetch(url, { headers: { range: "bytes=4-11" } });

    expect(Buffer.from(await whole.arrayBuffer()).equals(file)).toBe(true);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${String(file.length)}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(file.subarray(4, 12))).toBe(true);
  });

  it("with the TV in standby, sends a magic packet first, and launches the Player only once it comes on", async () => {
    await start({ wakeDelayMs: 300 });
    const living = await addTv();
    const source = await addMedia();
    tv.setPowerState("standby");

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard)).toEqual([
      { step: "waking" },
      { step: "launching" },
      { step: "connecting" },
      { step: "sending" },
      { step: "sent" },
    ]);
    expect(tv.wakes.map(({ macAddress }) => macAddress)).toEqual([TV_MAC]);
    const launching = heard.find(({ progress }) => progress.step === "launching");
    expect(launching?.at).toBeGreaterThanOrEqual((tv.wakes[0]?.receivedAt ?? Infinity) + 250);
    await expect.poll(() => tv.playerStatus().received).toHaveLength(1);
    expect(logged).toContain("Sent Wake-on-LAN to Living room · TV, to play a Media File on it");
  });

  it("says so, and launches nothing, when the TV doesn't come on in time", async () => {
    await start({ wakeDelayMs: 10_000 });
    const living = await addTv();
    const source = await addMedia();
    tv.setPowerState("standby");

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard)).toEqual([
      { step: "waking" },
      {
        step: "failed",
        error:
          "Living room · TV didn't come on within 1 second. Check that it is plugged in and set to switch on over the network, then try again.",
      },
    ]);
    expect((heard.at(-1)?.at ?? 0) - (heard[0]?.at ?? 0)).toBeGreaterThanOrEqual(900);
    expect(tv.wakes).toHaveLength(1);
    expect(tv.playerStatus().running).toBe(false);
  });

  it("wakes a TV that doesn't answer at all in standby, as some firmware doesn't", async () => {
    await start({ wakeDelayMs: 200, answersInStandby: false });
    const living = await addTv();
    const source = await addMedia();
    tv.setPowerState("standby");

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard).map(({ step }) => step)).toEqual(["waking", "launching", "connecting", "sending", "sent"]);
  });

  it("plays on a Player already connected, launching it again to bring it to the front", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await play(living.id, source.id, "Films/Sci-Fi/Clip.mp4");
    const player = tv.player();
    tv.bringToFront("111299001912");

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    expect(tv.player()).toBe(player);
    await expect
      .poll(() => tv.playerStatus().received)
      .toEqual([
        `http://${hubAddress}${mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4")}`,
        `http://${hubAddress}${mediaFilePath(source.id, "Films/Trailer.mkv")}`,
      ]);
    expect(tv.apps().find(({ id }) => id === PLAYER_APP_ID)?.visible).toBe(true);
  });

  it("says when the Player isn't installed on the TV", async () => {
    await start({ apps: FAKE_APPS });
    const living = await addTv();
    const source = await addMedia();

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard)).toEqual([
      { step: "launching" },
      {
        step: "failed",
        error: "The Player isn't installed on the TV. Install it from the TV's Developer section first.",
      },
    ]);
  });

  it("says when the Player doesn't connect to the Hub in time, naming the address it was given", async () => {
    // An address the TV can't reach the Hub at, as when the Hub chose the wrong one of its networks.
    await start({}, { ownAddress: "127.0.0.9" });
    const living = await addTv();
    const source = await addMedia();

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard)).toEqual([
      { step: "launching" },
      { step: "connecting" },
      {
        step: "failed",
        error: `The Player on Living room · TV didn't connect to the Hub within 2 seconds. Check that the TV can reach the Hub at ${hubAddress}.`,
      },
    ]);
    expect(tv.playerStatus()).toMatchObject({ running: true, hubAddress, connected: false });
  });

  it("says the TV must be paired again when it refuses the Hub as it launches the Player", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    tv.revokeAccess();

    const heard = await play(living.id, source.id, "Films/Trailer.mkv");

    expect(steps(heard)).toEqual([
      { step: "launching" },
      { step: "failed", error: "Living room · TV no longer lets the Hub in. Pair it again in Settings." },
    ]);
    const tvs = (await (await fetch(`${base}${APPLIANCES_PATH}`)).json()) as Appliance[];
    expect(tvs[0]?.pairing).toBe("pair-again");
  });

  it("never logs the TV's token", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await play(living.id, source.id, "Films/Trailer.mkv");

    for (const token of tv.issuedTokens()) expect(logged.join("\n")).not.toContain(token);
  });

  describe("refusing before it starts", () => {
    it("refuses a TV that isn't there", async () => {
      await start();
      const source = await addMedia();

      expect(
        await refusal(await post(appliancePlayPath(99), { mediaSourceId: source.id, path: "Films/Trailer.mkv" }), 404),
      ).toBe("That Appliance has been removed.");
    });

    it.each([
      ["a Media File that isn't there", "Films/Gone.mp4", 404, "That Media File no longer exists."],
      ["a file that isn't a Media File", "readme.txt", 404, "That is not a Media File."],
      ["a hidden file", ".hidden.mp4", 404, "That is not a Media File."],
      ["a folder", "Films", 404, "That is not a Media File."],
      ["a path outside the Media Source", "../outside.mp4", 403, "That path is outside the Media Source."],
    ])("refuses %s", async (_, path, status, message) => {
      await start();
      const living = await addTv();
      const source = await addMedia();

      expect(await refusal(await post(appliancePlayPath(living.id), { mediaSourceId: source.id, path }), status)).toBe(
        message,
      );
      expect(tv.playerStatus().running).toBe(false);
    });

    it("refuses a Media Source that isn't there", async () => {
      await start();
      const living = await addTv();

      expect(
        await refusal(await post(appliancePlayPath(living.id), { mediaSourceId: 7, path: "Films/Trailer.mkv" }), 404),
      ).toBe("That Media Source no longer exists.");
    });

    it("refuses a TV already marked to be paired again, without asking it", async () => {
      await start();
      const living = await addTv();
      const source = await addMedia();
      tv.revokeAccess();
      await post(`${APPLIANCES_PATH}/${String(living.id)}/connection`, {});
      const connections = tv.connections.length;

      expect(
        await refusal(
          await post(appliancePlayPath(living.id), { mediaSourceId: source.id, path: "Films/Trailer.mkv" }),
          409,
        ),
      ).toBe("Living room · TV no longer lets the Hub in. Pair it again in Settings.");
      expect(tv.connections).toHaveLength(connections);
    });

    it("refuses while the Hub doesn't know its own address, which the TV needs", async () => {
      await start({}, { interfaces: () => ({}) });
      const living = await addTv();
      const source = await addMedia();

      expect(
        await refusal(
          await post(appliancePlayPath(living.id), { mediaSourceId: source.id, path: "Films/Trailer.mkv" }),
          409,
        ),
      ).toBe("The Hub doesn't know its own IP address, which the TV needs to reach it. Set it in Settings, under Hub.");
    });

    it.each([
      ["no Media Source", { path: "Films/Trailer.mkv" }],
      ["a Media Source that isn't an id", { mediaSourceId: "1", path: "Films/Trailer.mkv" }],
      ["no path", { mediaSourceId: 1 }],
      ["an empty path", { mediaSourceId: 1, path: " " }],
      ["no body to speak of", null],
      ["a resume that isn't true or false", { mediaSourceId: 1, path: "Films/Trailer.mkv", resume: "yes" }],
    ])("refuses a request with %s", async (_, body) => {
      await start();
      const living = await addTv();

      expect((await post(appliancePlayPath(living.id), body)).status).toBe(400);
    });

    it("refuses other methods", async () => {
      await start();
      const living = await addTv();

      const response = await fetch(`${base}${appliancePlayPath(living.id)}`);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });
  });
});

describe("resuming a Media File, or starting it over (FR-40)", () => {
  const CLIP = "Films/Sci-Fi/Clip.mp4";

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const resumePosition = async (source: MediaSource): Promise<number | null> =>
    ((await (await fetch(`${base}${mediaResumePositionPath(source.id, CLIP)}`)).json()) as MediaResumePosition)
      .positionMs;

  /** Plays the clip on the fake TV's fake Player, which plays it as a minute long, and stops it at `positionMs`. */
  const stopAt = async (tvId: number, source: MediaSource, positionMs: number): Promise<void> => {
    await play(tvId, source.id, CLIP);
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    expect((await control(tvId, { action: "pause" })).status).toBe(200);
    expect((await control(tvId, { action: "seek", positionMs })).status).toBe(200);
    expect((await control(tvId, { action: "stop" })).status).toBe(200);
    await expect.poll(() => tv.playerStatus().playback).toBe("idle");
  };

  it("records where the Player stopped, and plays from there when asked to resume", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await stopAt(living.id, source, 30_000);
    expect(await resumePosition(source)).toBe(30_000);

    const heard = await play(living.id, source.id, CLIP, true);

    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    expect(tv.playerStatus().positionMs).toBeGreaterThanOrEqual(30_000);
    expect(logged).toContain('Sent "Clip.mp4" to the Player on Living room · TV, to play by Direct Play from 0:30');
  });

  it("plays from the start when asked to start over, or not asked to resume", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await stopAt(living.id, source, 30_000);

    for (const resume of [false, undefined]) {
      await play(living.id, source.id, CLIP, resume);
      await expect.poll(() => tv.playerStatus().playback).toBe("playing");
      expect(tv.playerStatus().positionMs).toBeLessThan(30_000);
    }
  });

  it("plays from the start when asked to resume a Media File with no Resume Position", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await play(living.id, source.id, CLIP, true);

    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    expect(tv.playerStatus().positionMs).toBeLessThan(5_000);
    expect(logged).toContain('Sent "Clip.mp4" to the Player on Living room · TV, to play by Direct Play');
  });

  it("clears the Resume Position once the Player plays past 95%", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await stopAt(living.id, source, 30_000);
    await play(living.id, source.id, CLIP, true);
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");

    expect((await control(living.id, { action: "seek", positionMs: 58_000 })).status).toBe(200);

    await expect.poll(() => resumePosition(source)).toBeNull();
  });
});

describe("playing a Media File by Remux, as HLS (FR-41, FR-42)", () => {
  // Recorded from broadcast TV: H.264 the TV plays, and MP2 audio it plays
  // only from HLS, in an MKV, a minute long, with a keyframe every 2 seconds.
  const RECORDING = "Films/Recording.mkv";
  /** ffmpeg reads the recording as it plays, so a seek can go past what it has produced, in 2-second segments. */
  const AS_IT_PLAYS: StreamsOptions = { readRate: 1, segmentSeconds: 2 };

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const run = promisify(execFile);

  /** The ffmpegs running now that read this test's recording, by process id, as the system lists them. */
  const ffmpegsReading = async (): Promise<string[]> => {
    try {
      const { stdout } = await run("pgrep", ["-f", `ffmpeg .*${join(media, RECORDING)}`]);
      return stdout.trim().split("\n");
    } catch {
      // pgrep says none by failing.
      return [];
    }
  };

  /** Plays the recording, and resolves once the fake Player is playing the stream, having read a segment of it. */
  const playRecording = async (tvId: number, sourceId: number): Promise<string> => {
    const heard = await play(tvId, sourceId, RECORDING);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    // Once ffmpeg has produced it, which takes it as long as the segment plays, reading as it plays.
    await expect.poll(() => tv.playerStatus().segments.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const [url = ""] = tv.playerStatus().received;
    return url;
  };

  it("plays an MKV the TV decodes, in a container it can't play directly, through the Player as HLS", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const url = await playRecording(living.id, source.id);

    expect(url).toMatch(new RegExp(`^http://${hubAddress}${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
    const playlist = await (await fetch(url)).text();
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(tv.playerStatus().segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });
    expect(tv.playerStatus().segments[0]?.bytes).toBeGreaterThan(0);
    expect(logged).toContain('Sent "Recording.mkv" to the Player on Living room · TV, to play by Remux');
    // The now-playing bar names the Media File, not its stream.
    const playback = (await (await fetch(`${base}${appliancePlaybackPath(living.id)}`)).json()) as AppliancePlayback;
    expect(playback.nowPlaying?.name).toBe("Recording.mkv");
  });

  it("seeks to a position the Hub hasn't produced yet, and records the Resume Position there", async () => {
    await start({}, { streams: AS_IT_PLAYS });
    const living = await addTv();
    const source = await addMedia();
    const url = await playRecording(living.id, source.id);
    const produced = tv.playerStatus().segments.length;

    expect((await control(living.id, { action: "seek", positionMs: 50_000 })).status).toBe(200);

    // 50 seconds in is the 26th 2-second segment, which ffmpeg, reading as it plays, is far from.
    await expect
      .poll(() => tv.playerStatus().segments.slice(produced), { timeout: 10_000 })
      .toContainEqual(expect.objectContaining({ url: url.replace(/index\.m3u8$/, "25.ts"), status: 200 }));
    expect(tv.playerStatus().segments.every(({ status }) => status === 200)).toBe(true);
    expect(tv.playerStatus().playback).toBe("playing");
    expect(tv.playerStatus().positionMs).toBeGreaterThanOrEqual(50_000);
    await expect
      .poll(async () => {
        const answer = await fetch(`${base}${mediaResumePositionPath(source.id, RECORDING)}`);
        return ((await answer.json()) as MediaResumePosition).positionMs;
      })
      .toBeGreaterThanOrEqual(50_000);
  });

  it("leaves no ffmpeg running once playback stops", async () => {
    await start({}, { streams: AS_IT_PLAYS });
    const living = await addTv();
    const source = await addMedia();
    const url = await playRecording(living.id, source.id);
    expect(await ffmpegsReading()).toHaveLength(1);

    expect((await control(living.id, { action: "stop" })).status).toBe(200);

    await expect.poll(ffmpegsReading).toEqual([]);
    expect((await fetch(url)).status).toBe(404);
  });

  it("leaves no ffmpeg running once the Player disconnects", async () => {
    await start({}, { streams: AS_IT_PLAYS });
    const living = await addTv();
    const source = await addMedia();
    await playRecording(living.id, source.id);
    expect(await ffmpegsReading()).toHaveLength(1);

    tv.player()?.stop();

    await expect.poll(ffmpegsReading).toEqual([]);
    expect(logged).toContain("The Player on Living room · TV disconnected");
  });

  it("leaves no ffmpeg running, nor its segments, once the Hub has stopped", async () => {
    // This process's own, as each test file runs in its own, streaming beside this one.
    const folders = async (): Promise<string[]> =>
      (await readdir(tmpdir())).filter((name) => name.startsWith(`media-centre-streams-${String(process.pid)}-`));
    const before = new Set(await folders());
    await start({}, { streams: AS_IT_PLAYS });
    const living = await addTv();
    const source = await addMedia();
    await playRecording(living.id, source.id);
    expect(await ffmpegsReading()).toHaveLength(1);
    const made = (await folders()).filter((name) => !before.has(name));
    expect(made).toHaveLength(1);

    await new Promise((done) => hub?.close(done));
    hub = undefined;

    // At once, as the Hub's process exits as soon as it has stopped.
    expect(await ffmpegsReading()).toEqual([]);
    expect((await folders()).filter((name) => made.includes(name))).toEqual([]);
  });

  it("leaves no ffmpeg running once another Media File is played in its place", async () => {
    await start({}, { streams: AS_IT_PLAYS });
    const living = await addTv();
    const source = await addMedia();
    await playRecording(living.id, source.id);
    expect(await ffmpegsReading()).toHaveLength(1);

    await play(living.id, source.id, "Films/Trailer.mkv");

    await expect.poll(ffmpegsReading).toEqual([]);
  });
});

describe("playing a Media File by Full Conversion, as HLS (FR-41, FR-42)", () => {
  // Xvid and MP3 in an AVI, a minute long, with a keyframe every 5 seconds:
  // video no Samsung TV plays, so the Hub re-encodes it.
  const HOME_VIDEO = "Films/Home Video.avi";
  /** ffmpeg reads the Media File as it plays, so a seek can go past what it has produced, in 2-second segments. */
  const AS_IT_PLAYS: StreamsOptions = { readRate: 1, segmentSeconds: 2 };

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const run = promisify(execFile);

  /** Plays the home video, and resolves with its stream's URL once the fake Player has read a segment of it. */
  const playHomeVideo = async (tvId: number, sourceId: number): Promise<string> => {
    const heard = await play(tvId, sourceId, HOME_VIDEO);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    await expect.poll(() => tv.playerStatus().segments.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const [url = ""] = tv.playerStatus().received;
    return url;
  };

  /** Each stream's codec in a segment the Hub serves, as ffprobe says. */
  const codecsIn = async (url: string): Promise<string[]> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
    try {
      const file = join(dir, "segment.ts");
      await writeFile(file, new Uint8Array(await (await fetch(url)).arrayBuffer()));
      const { stdout } = await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "json",
        file,
      ]);
      return (JSON.parse(stdout) as { streams: { codec_name: string }[] }).streams.map(
        ({ codec_name: codec }) => codec,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("plays a DivX/Xvid AVI through the Player as HLS, its video re-encoded to H.264", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const url = await playHomeVideo(living.id, source.id);

    expect(url).toMatch(new RegExp(`^http://${hubAddress}${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
    expect(tv.playerStatus().segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });
    expect(tv.playerStatus().segments[0]?.bytes).toBeGreaterThan(0);
    // The MP3 the TV plays, as it is.
    expect(await codecsIn(url.replace(/index\.m3u8$/, "0.ts"))).toEqual(["h264", "mp3"]);
    expect(logged).toContain('Sent "Home Video.avi" to the Player on Living room · TV, to play by Full Conversion');
    expect(logged).toContain("Full Conversion re-encodes video in software (libx264)");
    const playback = (await (await fetch(`${base}${appliancePlaybackPath(living.id)}`)).json()) as AppliancePlayback;
    expect(playback.nowPlaying?.name).toBe("Home Video.avi");
  });

  it("seeks to a position the Hub hasn't converted yet, and plays on from there", async () => {
    await start({}, { streams: AS_IT_PLAYS });
    const living = await addTv();
    const source = await addMedia();
    const url = await playHomeVideo(living.id, source.id);
    const read = tv.playerStatus().segments.length;

    expect((await control(living.id, { action: "seek", positionMs: 46_000 })).status).toBe(200);

    // 46 seconds in is the 24th 2-second segment, which ffmpeg, reading as it plays, is far from.
    await expect
      .poll(() => tv.playerStatus().segments.slice(read), { timeout: 10_000 })
      .toContainEqual(expect.objectContaining({ url: url.replace(/index\.m3u8$/, "23.ts"), status: 200 }));
    expect(tv.playerStatus().segments.every(({ status, bytes }) => status === 200 && bytes > 0)).toBe(true);
    expect(tv.playerStatus().playback).toBe("playing");
    expect(tv.playerStatus().positionMs).toBeGreaterThanOrEqual(46_000);
    expect(await codecsIn(url.replace(/index\.m3u8$/, "23.ts"))).toEqual(["h264", "mp3"]);
  }, 15_000);
});

describe("playing a Media File by Audio Conversion, and switching its audio track (FR-36, FR-41, FR-42)", () => {
  // H.264 with DTS 5.1, which no Samsung TV from 2018 on decodes, then Dolby
  // Digital in French and AAC in no language the file says, in an MKV.
  const ARRIVAL = "Films/Sci-Fi/Arrival.mkv";
  // H.264 with two AAC tracks, in English and Spanish, which the TV plays as they are.
  const TRAILER = "Films/Trailer.mkv";

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const nowPlaying = async (tvId: number): Promise<AppliancePlayback["nowPlaying"]> =>
    ((await (await fetch(`${base}${appliancePlaybackPath(tvId)}`)).json()) as AppliancePlayback).nowPlaying;

  /** Plays the Media File, and resolves with its URL once the fake Player is playing it. */
  const playing = async (tvId: number, sourceId: number, path: string): Promise<string> => {
    const heard = await play(tvId, sourceId, path);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    const [url = ""] = tv.playerStatus().received;
    return url;
  };

  it("plays an MKV with DTS through the Player as HLS, its audio converted, and lists its audio tracks", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const url = await playing(living.id, source.id, ARRIVAL);

    expect(url).toMatch(new RegExp(`^http://${hubAddress}${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
    await expect.poll(() => tv.playerStatus().segments.length).toBeGreaterThan(0);
    expect(tv.playerStatus().segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });
    expect(logged).toContain('Sent "Arrival.mkv" to the Player on Living room · TV, to play by Audio Conversion');
    await expect
      .poll(() => nowPlaying(living.id))
      .toMatchObject({ name: "Arrival.mkv", audioTracks: ARRIVAL_AUDIO_TRACKS, audioTrack: 0 });
  });

  it("switches audio track on a converted Route, playing on from where it was", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, ARRIVAL);
    expect((await control(living.id, { action: "seek", positionMs: 8_000 })).status).toBe(200);
    const before = tv.playerStatus().positionMs;

    const answer = await control(living.id, { action: "audio-track", track: 1 });

    expect(answer.status).toBe(200);
    const after = ((await answer.json()) as AppliancePlayback).nowPlaying;
    expect(after).toMatchObject({ name: "Arrival.mkv", state: "playing", audioTrack: 1 });
    expect(Math.abs((after?.positionMs ?? 0) - before)).toBeLessThan(3_000);
    expect(tv.playerStatus()).toMatchObject({ playback: "playing", audioTrack: 1 });
    // Switched in the stream it plays, which has every audio track, not by playing it again.
    expect(tv.playerStatus().received).toHaveLength(1);
  });

  it("switches audio track on Direct Play, playing on from where it was", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    const url = await playing(living.id, source.id, TRAILER);
    expect(url).toBe(`http://${hubAddress}${mediaFilePath(source.id, TRAILER)}`);
    expect((await nowPlaying(living.id))?.audioTracks.map(({ language, codec }) => [language, codec])).toEqual([
      ["eng", "aac"],
      ["spa", "aac"],
    ]);
    expect((await control(living.id, { action: "seek", positionMs: 30_000 })).status).toBe(200);
    const before = tv.playerStatus().positionMs;

    const answer = await control(living.id, { action: "audio-track", track: 1 });

    expect(answer.status).toBe(200);
    const after = ((await answer.json()) as AppliancePlayback).nowPlaying;
    expect(after).toMatchObject({ state: "playing", audioTrack: 1 });
    expect(Math.abs((after?.positionMs ?? 0) - before)).toBeLessThan(3_000);
    expect(tv.playerStatus().received).toEqual([url]);
  });

  it("refuses an audio track the Media File hasn't got, sending the Player nothing", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, ARRIVAL);

    const error = await refusal(await control(living.id, { action: "audio-track", track: 3 }), 400);

    expect(error).toBe(`"Arrival.mkv" hasn't got an audio track 4. Choose one of its own.`);
    expect(tv.playerStatus().audioTrack).toBe(0);
  });
});

describe("playing a Media File with subtitles, and choosing one (FR-36, FR-44, FR-45)", () => {
  // H.264 and AAC, which the TV plays as they are, with a SubRip in English
  // and an ASS in German of its own, beside `Film.en.srt` and `Film.fr.ass`.
  const FILM = "Films/Film.mkv";

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const nowPlaying = async (tvId: number): Promise<AppliancePlayback["nowPlaying"]> =>
    ((await (await fetch(`${base}${appliancePlaybackPath(tvId)}`)).json()) as AppliancePlayback).nowPlaying;

  /** Plays the Media File, and resolves once the fake Player is playing it. */
  const playing = async (tvId: number, sourceId: number, path: string): Promise<void> => {
    const heard = await play(tvId, sourceId, path);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
  };

  it("lists its own text subtitle tracks, with their languages, then the sidecar files beside it, none shown", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playing(living.id, source.id, FILM);

    await expect
      .poll(() => nowPlaying(living.id))
      .toMatchObject({ name: "Film.mkv", subtitleTracks: FILM_SUBTITLE_TRACKS, subtitleTrack: null });
    expect(tv.playerStatus()).toMatchObject({ subtitleTrack: null, subtitle: null });
  });

  it("sends the Player each, which it shows as chosen, those it can't render converted to SubRip (FR-45)", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, FILM);
    expect((await control(living.id, { action: "seek", positionMs: 20_000 })).status).toBe(200);

    const shown: (string | null)[] = [];
    for (const track of FILM_SUBTITLE_TRACKS.keys()) {
      expect((await control(living.id, { action: "subtitle-track", track })).status).toBe(200);
      shown.push(tv.playerStatus().subtitle);
    }

    // The fake Player renders only SubRip and WebVTT, as the Player does, so
    // shows an ASS's text only once the Hub has converted it.
    expect(shown).toEqual(FILM_SUBTITLES);
    expect(tv.playerStatus().received).toEqual([`http://${hubAddress}${mediaFilePath(source.id, FILM)}`]);
  });

  it("shows a sidecar ASS file through the fake Player, converted, then hides it for Off", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, FILM);
    expect((await control(living.id, { action: "seek", positionMs: 20_000 })).status).toBe(200);

    const answer = await control(living.id, { action: "subtitle-track", track: 3 });

    expect(answer.status).toBe(200);
    expect(((await answer.json()) as AppliancePlayback).nowPlaying).toMatchObject({
      state: "playing",
      subtitleTrack: 3,
    });
    expect(tv.playerStatus()).toMatchObject({ subtitleTrack: 3, subtitle: FILM_SUBTITLES[3] });
    // Shown over what it plays, not by playing it again.
    expect(tv.playerStatus().received).toHaveLength(1);

    const off = await control(living.id, { action: "subtitle-track", track: null });

    expect(off.status).toBe(200);
    expect(((await off.json()) as AppliancePlayback).nowPlaying).toMatchObject({ subtitleTrack: null });
    expect(tv.playerStatus()).toMatchObject({ playback: "playing", subtitleTrack: null, subtitle: null });
  });

  it("offers a sidecar file beside a Media File streamed as HLS too", async () => {
    const streamed = await mkdtemp(join(tmpdir(), "hub-play-subtitles-"));
    try {
      await mkdir(join(streamed, "Films"));
      await copyFile(join(media, "Films/Recording.mkv"), join(streamed, "Films/Recording.mkv"));
      await copyFile(join(media, "Films/Film.fr.ass"), join(streamed, "Films/Recording.fr.ass"));
      await start();
      const living = await addTv();
      const response = await post(MEDIA_SOURCES_PATH, { name: "Recordings", path: streamed });
      const source = (await response.json()) as MediaSource;

      await playing(living.id, source.id, "Films/Recording.mkv");
      expect(tv.playerStatus().received[0]).toMatch(/index\.m3u8$/);
      expect((await control(living.id, { action: "subtitle-track", track: 0 })).status).toBe(200);

      expect(await nowPlaying(living.id)).toMatchObject({
        subtitleTracks: [{ language: "fr", title: null, codec: "ass", sidecar: "Recording.fr.ass" }],
        subtitleTrack: 0,
      });
      expect(tv.playerStatus().subtitle).toBe(FILM_SUBTITLES[3]);
    } finally {
      await rm(streamed, { recursive: true, force: true });
    }
  });

  it("refuses a subtitle track the Media File hasn't got, sending the Player nothing", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, FILM);

    const error = await refusal(await control(living.id, { action: "subtitle-track", track: 4 }), 400);

    expect(error).toBe(`"Film.mkv" hasn't got a subtitle track 5. Choose one of its own, or "Off".`);
    expect(tv.playerStatus().subtitleTrack).toBeNull();
  });

  it("lists none for a Media File with none", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playing(living.id, source.id, "Films/Trailer.mkv");

    await expect.poll(() => nowPlaying(living.id)).toMatchObject({ name: "Trailer.mkv", subtitleTracks: [] });
  });
});

describe("burning image subtitles into the picture by Full Conversion, and no longer (FR-45, ADR 0006)", () => {
  // H.264 and AAC, which the TV plays as they are, its picture black, with a
  // SubRip in English, then PGS in Italian and VobSub in French, which the
  // TV can't render, both a white box.
  const OPERA = "Films/Opera.mkv";

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const nowPlaying = async (tvId: number): Promise<AppliancePlayback["nowPlaying"]> =>
    ((await (await fetch(`${base}${appliancePlaybackPath(tvId)}`)).json()) as AppliancePlayback).nowPlaying;

  /** Plays the opera, seeks 20 seconds into it, and resolves once the fake Player is playing there. */
  const playingOpera = async (tvId: number, sourceId: number): Promise<void> => {
    const heard = await play(tvId, sourceId, OPERA);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    expect((await control(tvId, { action: "seek", positionMs: 20_000 })).status).toBe(200);
  };

  /** Resolves once the fake Player plays the URL it was sent last, the `count`th, and returns it. */
  const playingAgain = async (count: number): Promise<string> => {
    await expect.poll(() => tv.playerStatus().received).toHaveLength(count);
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    return tv.playerStatus().received.at(-1) ?? "";
  };

  /** The bytes of segment `number` of the stream whose playlist the Player was sent. */
  const segmentOf = async (playlist: string, number: number): Promise<Uint8Array> => {
    const answer = await fetch(playlist.replace(/index\.m3u8$/, `${String(number)}.ts`));
    expect(answer.status).toBe(200);
    return new Uint8Array(await answer.arrayBuffer());
  };

  it("lists the image subtitle tracks too, as burned in, playing by Direct Play with none", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playingOpera(living.id, source.id);

    expect(await nowPlaying(living.id)).toMatchObject({
      name: "Opera.mkv",
      route: "direct-play",
      subtitleTracks: OPERA_SUBTITLE_TRACKS,
      subtitleTrack: null,
    });
    expect(tv.playerStatus().received).toEqual([`http://${hubAddress}${mediaFilePath(source.id, OPERA)}`]);
  });

  it.each([
    ["PGS", 1],
    ["VobSub", 2],
  ])(
    "shows %s by sending the Player the Media File again from where it is, by Full Conversion, with it burned in",
    async (_, track) => {
      await start();
      const living = await addTv();
      const source = await addMedia();
      await playingOpera(living.id, source.id);

      const answer = await control(living.id, { action: "subtitle-track", track });

      expect(answer.status).toBe(200);
      const playlist = await playingAgain(2);
      expect(playlist).toMatch(new RegExp(`^http://${hubAddress}${STREAMS_PATH}/[0-9a-f-]+/index\\.m3u8$`));
      // From where it was, give or take the second between its reports.
      expect(Math.abs(tv.playerStatus().positionMs - 20_000)).toBeLessThan(3_000);
      await expect
        .poll(() => nowPlaying(living.id))
        .toMatchObject({ route: "full-conversion", state: "playing", subtitleTrack: track });
      // Burned into the picture, so the Player shows none itself.
      expect(tv.playerStatus()).toMatchObject({ subtitleTrack: null, subtitle: null });
      // Bright in the box, half a second into its first segment.
      expect(await operaBrightness(await segmentOf(playlist, 0), 5, "box")).toBeGreaterThan(200);
      expect(logged).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Sent "Opera\\.mkv" to the Player on Living room · TV again from 0:\\d\\d, by Full Conversion, ` +
              `to burn its subtitle track ${String(track + 1)} into the picture$`,
          ),
        ),
      );
    },
  );

  it("goes back to Direct Play from where it is for Off, ending the stream", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playingOpera(living.id, source.id);
    expect((await control(living.id, { action: "subtitle-track", track: 1 })).status).toBe(200);
    const playlist = await playingAgain(2);
    await expect.poll(() => tv.playerStatus().positionMs, { timeout: 5_000 }).toBeGreaterThan(21_000);
    const before = tv.playerStatus().positionMs;

    expect((await control(living.id, { action: "subtitle-track", track: null })).status).toBe(200);

    expect(await playingAgain(3)).toBe(`http://${hubAddress}${mediaFilePath(source.id, OPERA)}`);
    expect(Math.abs(tv.playerStatus().positionMs - before)).toBeLessThan(3_000);
    await expect
      .poll(() => nowPlaying(living.id))
      .toMatchObject({ route: "direct-play", state: "playing", subtitleTrack: null });
    expect(tv.playerStatus()).toMatchObject({ subtitleTrack: null, subtitle: null });
    await expect.poll(async () => (await fetch(playlist)).status).toBe(404);
    expect(logged).toContainEqual(
      expect.stringMatching(/again from 0:\d\d, by Direct Play, burning no subtitles into the picture$/),
    );
  });

  it("goes back to Direct Play for a text track, which the Player shows itself from where it is", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playingOpera(living.id, source.id);
    expect((await control(living.id, { action: "subtitle-track", track: 2 })).status).toBe(200);
    await playingAgain(2);

    expect((await control(living.id, { action: "subtitle-track", track: 0 })).status).toBe(200);

    expect(await playingAgain(3)).toBe(`http://${hubAddress}${mediaFilePath(source.id, OPERA)}`);
    await expect.poll(() => tv.playerStatus()).toMatchObject({ subtitleTrack: 0, subtitle: OPERA_SUBTITLE });
    await expect.poll(() => nowPlaying(living.id)).toMatchObject({ route: "direct-play", subtitleTrack: 0 });
  });

  it("switches from one burned in to another by Full Conversion again, and sends nothing for the one it has", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playingOpera(living.id, source.id);
    expect((await control(living.id, { action: "subtitle-track", track: 1 })).status).toBe(200);
    const first = await playingAgain(2);

    expect((await control(living.id, { action: "subtitle-track", track: 1 })).status).toBe(200);
    expect(tv.playerStatus().received).toHaveLength(2);

    expect((await control(living.id, { action: "subtitle-track", track: 2 })).status).toBe(200);
    const second = await playingAgain(3);
    expect(second).toMatch(/index\.m3u8$/);
    expect(second).not.toBe(first);
    await expect.poll(() => nowPlaying(living.id)).toMatchObject({ route: "full-conversion", subtitleTrack: 2 });
  });

  it("shows a text track over Direct Play itself, sending nothing again, as no subtitles were burned in", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playingOpera(living.id, source.id);

    expect((await control(living.id, { action: "subtitle-track", track: 0 })).status).toBe(200);

    expect(tv.playerStatus()).toMatchObject({ subtitleTrack: 0, subtitle: OPERA_SUBTITLE });
    expect(tv.playerStatus().received).toHaveLength(1);
  });

  it("refuses to burn one in once the Media File has gone, sending the Player nothing", async () => {
    const copied = await mkdtemp(join(tmpdir(), "hub-play-burn-"));
    try {
      await mkdir(join(copied, "Films"));
      await copyFile(join(media, OPERA), join(copied, OPERA));
      await start();
      const living = await addTv();
      const source = (await (await post(MEDIA_SOURCES_PATH, { name: "Copied", path: copied })).json()) as MediaSource;
      await playingOpera(living.id, source.id);
      await rm(join(copied, OPERA));

      const error = await refusal(await control(living.id, { action: "subtitle-track", track: 1 }), 404);

      expect(error).toBeTruthy();
      expect(tv.playerStatus().received).toHaveLength(1);
    } finally {
      await rm(copied, { recursive: true, force: true });
    }
  });
});

describe("Now Showing for the Player: its Media File, position, tracks and preview picture (FR-27)", () => {
  const FILM = "Films/Film.mkv";
  const YOUTUBE = "111299001912";

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const nowShowing = async (tvId: number): Promise<NowShowing> =>
    (await (await fetch(`${base}${applianceNowShowingPath(tvId)}`)).json()) as NowShowing;
  const nowPlaying = async (tvId: number): Promise<NowPlaying | null> =>
    ((await (await fetch(`${base}${appliancePlaybackPath(tvId)}`)).json()) as AppliancePlayback).nowPlaying;
  /** Where the preview picture is, as Now Showing says, or null for none. */
  const previewAt = async (tvId: number): Promise<number | null> => {
    const showing = await nowShowing(tvId);
    return showing.known ? (showing.nowPlaying?.preview?.positionMs ?? null) : null;
  };

  /** Plays the Media File, and resolves once the fake Player is playing it. */
  const playing = async (tvId: number, sourceId: number, path: string): Promise<void> => {
    const heard = await play(tvId, sourceId, path);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
  };

  it("names the Player in front, with the Media File it plays, its position, its duration and the tracks in use", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, FILM);
    expect((await control(living.id, { action: "subtitle-track", track: 2 })).status).toBe(200);

    const showing = await nowShowing(living.id);

    expect(showing).toMatchObject({
      known: true,
      app: { id: PLAYER_APP_ID, name: "Media Centre" },
      nowPlaying: {
        name: "Film.mkv",
        route: "direct-play",
        state: "playing",
        durationMs: 60_000,
        audioTracks: [{ codec: "aac" }],
        audioTrack: 0,
        subtitleTracks: FILM_SUBTITLE_TRACKS,
        subtitleTrack: 2,
        preview: { positionMs: expect.any(Number) as number },
      },
    });
    // The now-playing bar is told of the same preview picture.
    expect(await nowPlaying(living.id)).toMatchObject({
      name: "Film.mkv",
      preview: { positionMs: expect.any(Number) as number },
    });
    // It moves on as the Player tells the Hub it plays on, as the now-playing bar does.
    await expect
      .poll(
        async () => {
          const later = await nowShowing(living.id);
          return later.known ? (later.nowPlaying?.positionMs ?? 0) : 0;
        },
        { timeout: 3_000 },
      )
      .toBeGreaterThan(0);
  });

  it("says the Player plays nothing once it is stopped, and nothing of it once another app is in front", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, FILM);

    expect((await control(living.id, { action: "stop" })).status).toBe(200);
    expect(await nowShowing(living.id)).toMatchObject({ known: true, app: { id: PLAYER_APP_ID }, nowPlaying: null });
    expect((await fetch(`${base}${appliancePreviewPath(living.id)}`)).status).toBe(404);

    expect(tv.bringToFront(YOUTUBE)).toBe(true);
    const showing = await nowShowing(living.id);
    expect(showing).toMatchObject({ known: true, app: { id: YOUTUBE, name: "YouTube" } });
    expect(showing).not.toHaveProperty("nowPlaying");
  });

  it("has no preview picture of an audio Media File, which has no video", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playing(living.id, source.id, "Music/Album/01 Tone.flac");

    await expect
      .poll(() => nowShowing(living.id))
      .toMatchObject({ nowPlaying: { name: "01 Tone.flac", preview: null } });
    expect((await fetch(`${base}${appliancePreviewPath(living.id)}`)).status).toBe(404);
  });

  describe("its preview picture", () => {
    /** A Media Source of its own, of a minute of video as bright as 4 times its time in seconds. */
    let brightening: string;
    const VIDEO = "Films/Brightening.mkv";

    beforeAll(async () => {
      brightening = await mkdtemp(join(tmpdir(), "hub-play-preview-"));
      await makeBrighteningVideo(join(brightening, VIDEO));
    });

    afterAll(async () => {
      await rm(brightening, { recursive: true, force: true });
    });

    /** Quicker than the Hub's own, so that the test needn't wait 5 seconds for each. */
    const REFRESH_MS = 1_500;

    /** Every frame the Hub extracts, with ffmpeg as it does by default, by where it is. */
    let extracted: number[];
    const extractFrame: ExtractFrame = (file, positionMs) => {
      extracted.push(positionMs);
      return ffmpegFrame(file, positionMs);
    };

    /** Starts the Hub, and plays the brightening video on the fake TV's Player. */
    const startPlaying = async (): Promise<number> => {
      extracted = [];
      await start({}, { previews: { refreshMs: REFRESH_MS, extractFrame } });
      const living = await addTv();
      const source = (await (
        await post(MEDIA_SOURCES_PATH, { name: "Videos", path: brightening })
      ).json()) as MediaSource;
      await playing(living.id, source.id, VIDEO);
      return living.id;
    };

    /** The preview picture the Hub serves now, and how bright it is: 4 times the second it is from. */
    const brightness = async (tvId: number): Promise<number> => {
      const response = await fetch(`${base}${appliancePreviewPath(tvId)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      return brightnessOfPicture(new Uint8Array(await response.arrayBuffer()));
    };

    it("is the frame at its position, extracted from the Media File itself, moving on as it plays", async () => {
      const living = await startPlaying();
      const first = await previewAt(living);
      expect(first).not.toBeNull();
      expect(await brightness(living)).toBeCloseTo(((first ?? 0) / 1_000) * 4, -0.5);

      await expect.poll(() => previewAt(living), { timeout: REFRESH_MS * 3 }).not.toBe(first);

      const next = (await previewAt(living)) ?? 0;
      expect(next - (first ?? 0)).toBeGreaterThanOrEqual(REFRESH_MS - 500);
      expect(await brightness(living)).toBeCloseTo((next / 1_000) * 4, -0.5);
      expect(extracted).toEqual([first, next]);
    });

    it("holds still while the Player is paused, extracting no further frame, then follows a seek", async () => {
      const living = await startPlaying();
      expect((await control(living, { action: "pause" })).status).toBe(200);
      const paused = await previewAt(living);
      const pausedBrightness = await brightness(living);
      const extractedThen = extracted.length;

      await new Promise((resolve) => setTimeout(resolve, REFRESH_MS * 2.5));

      expect(await previewAt(living)).toBe(paused);
      expect(await brightness(living)).toBe(pausedBrightness);
      expect(extracted).toHaveLength(extractedThen);

      expect((await control(living, { action: "seek", positionMs: 45_000 })).status).toBe(200);

      expect(await previewAt(living)).toBe(45_000);
      expect(await brightness(living)).toBeCloseTo(180, -0.5);
      expect(extracted.at(-1)).toBe(45_000);
    });

    it("follows a seek while the Player plays, at once rather than at the next refresh", async () => {
      const living = await startPlaying();

      expect((await control(living, { action: "seek", positionMs: 30_000 })).status).toBe(200);

      const at = (await previewAt(living)) ?? 0;
      expect(at).toBeGreaterThanOrEqual(30_000);
      expect(at).toBeLessThan(30_000 + REFRESH_MS);
      expect(await brightness(living)).toBeCloseTo((at / 1_000) * 4, -0.5);
    });
  });
});

describe("playing an audio Media File, with what its now-playing screen shows and its cover art (FR-27, FR-46, FR-47)", () => {
  const FLAC = "Music/Album/01 Tone.flac";
  const MP3 = "Music/Album/02 Tone.mp3";
  const ALAC = "Music/Album/03 Tone.m4a";
  const run = promisify(execFile);

  const control = (tvId: number, body: unknown): Promise<Response> => post(appliancePlaybackPath(tvId), body);
  const nowShowing = async (tvId: number): Promise<NowShowing> =>
    (await (await fetch(`${base}${applianceNowShowingPath(tvId)}`)).json()) as NowShowing;
  const nowPlaying = async (tvId: number): Promise<NowPlaying | null> =>
    ((await (await fetch(`${base}${appliancePlaybackPath(tvId)}`)).json()) as AppliancePlayback).nowPlaying;

  /** Plays the Media File, and resolves with its URL once the fake Player is playing it. */
  const playing = async (tvId: number, sourceId: number, path: string): Promise<string> => {
    const heard = await play(tvId, sourceId, path);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    return tv.playerStatus().received.at(-1) ?? "";
  };

  it("sends a tagged FLAC by Direct Play with its title, artist and album, and its cover art, which the Player reads", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const url = await playing(living.id, source.id, FLAC);

    expect(url).toBe(`http://${hubAddress}${mediaFilePath(source.id, FLAC)}`);
    const coverArt = `http://${hubAddress}${mediaCoverArtPath(source.id, FLAC)}`;
    await expect
      .poll(() => tv.playerStatus().music)
      .toEqual({ ...ALBUM_TAGS[0], coverArt, coverArtRead: { status: 200, bytes: expect.any(Number) as number } });
    // The cover art the Player reads is a JPEG of the picture in the file.
    const picture = await fetch(coverArt);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    const dir = await mkdtemp(join(tmpdir(), "hub-cover-art-"));
    try {
      await writeFile(join(dir, "cover.jpg"), new Uint8Array(await picture.arrayBuffer()));
      const { stdout } = await run("ffprobe", [
        ...["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(dir, "cover.jpg")],
      ]);
      expect(stdout.trim()).toBe(`${String(COVER_ART_SIZE)},${String(COVER_ART_SIZE)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names an untagged MP3 by its file name, with no cover art", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playing(living.id, source.id, MP3);

    await expect
      .poll(() => tv.playerStatus().music)
      .toEqual({ title: "02 Tone.mp3", artist: null, album: null, coverArt: null, coverArtRead: null });
    expect((await fetch(`${base}${mediaCoverArtPath(source.id, MP3)}`)).status).toBe(404);
  });

  it("streams an ALAC M4A, which the TV can't decode, by Audio Conversion, as AC3 alone, with its tags", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const url = await playing(living.id, source.id, ALAC);

    expect(url).toMatch(new RegExp(`^http://${hubAddress}${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
    expect(logged).toContain('Sent "03 Tone.m4a" to the Player on Living room · TV, to play by Audio Conversion');
    await expect.poll(() => tv.playerStatus().segments.length).toBeGreaterThan(0);
    expect(tv.playerStatus().segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });
    const dir = await mkdtemp(join(tmpdir(), "hub-segment-"));
    try {
      const file = join(dir, "segment.ts");
      await writeFile(file, new Uint8Array(await (await fetch(url.replace(/index\.m3u8$/, "0.ts"))).arrayBuffer()));
      const { stdout } = await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "json",
        file,
      ]);
      const { streams } = JSON.parse(stdout) as { streams: { codec_name: string }[] };
      expect(streams.map(({ codec_name: codec }) => codec)).toEqual(["ac3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Its title and album as its tags say, and its album's artist for its own, with no cover art.
    expect(tv.playerStatus().music).toEqual({ ...ALBUM_TAGS[2], coverArt: null, coverArtRead: null });
    expect(await nowPlaying(living.id)).toMatchObject({ name: "03 Tone.m4a", route: "audio-conversion" });
  });

  it("sends a video with nothing of the kind", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playing(living.id, source.id, "Films/Sci-Fi/Clip.mp4");

    expect(tv.playerStatus().music).toBeNull();
    expect(await nowPlaying(living.id)).toMatchObject({ name: "Clip.mp4", music: null });
  });

  it("has Now Showing, and the now-playing bar, say what the Player shows, with the cover art at the Hub", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playing(living.id, source.id, FLAC);

    const showing = await nowShowing(living.id);

    const music = { ...ALBUM_TAGS[0], coverArt: mediaCoverArtPath(source.id, FLAC) };
    expect(showing).toMatchObject({
      known: true,
      app: { id: PLAYER_APP_ID },
      nowPlaying: { name: "01 Tone.flac", preview: null, music },
    });
    expect(await nowPlaying(living.id)).toMatchObject({ music });
    // A path at the Hub, as the Remote reaches it, which serves the same cover art.
    expect((await fetch(`${base}${music.coverArt}`)).headers.get("content-type")).toBe("image/jpeg");

    // One without cover art says so, for a placeholder to stand in for it.
    await playing(living.id, source.id, MP3);
    await expect
      .poll(async () => (await nowPlaying(living.id))?.music)
      .toEqual({ title: "02 Tone.mp3", artist: null, album: null, coverArt: null });

    expect((await control(living.id, { action: "stop" })).status).toBe(200);
    expect(await nowShowing(living.id)).toMatchObject({ known: true, nowPlaying: null });
  });
});

describe("playing a folder as a Queue, with next, previous, shuffle and repeat (FR-46, FR-48)", () => {
  const ALBUM = "Music/Album";
  const FLAC = `${ALBUM}/01 Tone.flac`;
  const MP3 = `${ALBUM}/02 Tone.mp3`;
  const NAMES = ["01 Tone.flac", "02 Tone.mp3", "03 Tone.m4a"];
  // Each of the fake Player's Media Files is a minute long, as it plays them.
  const NEAR_THE_END_MS = 59_500;

  const nowPlaying = async (tvId: number): Promise<NowPlaying | null> =>
    ((await (await fetch(`${base}${appliancePlaybackPath(tvId)}`)).json()) as AppliancePlayback).nowPlaying;
  const queueControl = (tvId: number, body: unknown): Promise<Response> => post(applianceQueuePath(tvId), body);

  /** Plays the folder, and resolves once the fake Player is playing its first Media File. */
  const playFolder = async (tvId: number, mediaSourceId: number, folder = ALBUM): Promise<void> => {
    const response = await post(appliancePlayPath(tvId), { mediaSourceId, folder });
    expect(response.status).toBe(200);
    expect((await response.text()).trim().split("\n").at(-1)).toBe(JSON.stringify({ step: "sent" }));
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
  };

  /** Has the fake Player play on from near the end of what it plays, so that it ends in a moment. */
  const nearTheEnd = async (tvId: number): Promise<void> => {
    expect((await post(appliancePlaybackPath(tvId), { action: "seek", positionMs: NEAR_THE_END_MS })).status).toBe(200);
  };

  const directPlay = (sourceId: number, path: string): string => `http://${hubAddress}${mediaFilePath(sourceId, path)}`;

  it("queues the folder's audio Media Files in file-name order, leaving out everything else, and starts the first", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    await playFolder(living.id, source.id);

    expect(tv.playerStatus().received).toEqual([directPlay(source.id, FLAC)]);
    expect(await nowPlaying(living.id)).toMatchObject({
      name: "01 Tone.flac",
      queue: { mediaSourceId: source.id, folder: ALBUM, mediaFiles: NAMES, current: 0, shuffle: false, repeat: "off" },
    });
    expect(logged).toContain(
      'Sent "01 Tone.flac", 1 of 3 in the Queue of "Music/Album", to the Player on Living room · TV, to play by Direct Play',
    );
  });

  it("plays each next Media File by itself at the end of the one before, by its own Route, then ends", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playFolder(living.id, source.id);

    await nearTheEnd(living.id);
    await expect.poll(async () => (await nowPlaying(living.id))?.queue?.current).toBe(1);
    expect(tv.playerStatus().received).toEqual([directPlay(source.id, FLAC), directPlay(source.id, MP3)]);
    expect(await nowPlaying(living.id)).toMatchObject({ name: "02 Tone.mp3", state: "playing" });

    await nearTheEnd(living.id);
    // The ALAC, which the TV can't decode, by Audio Conversion, as it would be on its own.
    await expect.poll(async () => (await nowPlaying(living.id))?.queue?.current).toBe(2);
    expect(await nowPlaying(living.id)).toMatchObject({ name: "03 Tone.m4a", route: "audio-conversion" });
    expect(tv.playerStatus().received.at(-1)).toMatch(new RegExp(`^http://${hubAddress}${STREAMS_PATH}/`));
    expect(logged).toContain(
      'Sent "03 Tone.m4a", 3 of 3 in the Queue, to the Player on Living room · TV, to play by Audio Conversion',
    );

    await nearTheEnd(living.id);
    await expect.poll(() => tv.playerStatus().playback).toBe("idle");
    expect(await nowPlaying(living.id)).toBeNull();
    expect(tv.playerStatus().received).toHaveLength(3);
    expect(logged).toContain("The Queue on Living room · TV has played to its end");
  });

  it("moves to the next and previous Media File as asked, each from its start, refusing past either end", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playFolder(living.id, source.id);

    const previous = await queueControl(living.id, { action: "previous" });
    expect(previous.status).toBe(409);
    expect(((await previous.json()) as HubError).error).toBe("That is the first Media File of the Queue.");

    const next = await queueControl(living.id, { action: "next" });
    expect(next.status).toBe(200);
    // Answered once the Player has it.
    expect(((await next.json()) as AppliancePlayback).nowPlaying).toMatchObject({
      name: "02 Tone.mp3",
      queue: { current: 1 },
    });
    expect(tv.playerStatus().received.at(-1)).toBe(directPlay(source.id, MP3));
    expect(tv.playerStatus().positionMs).toBeLessThan(5_000);

    expect((await queueControl(living.id, { action: "next" })).status).toBe(200);
    const last = await queueControl(living.id, { action: "next" });
    expect(last.status).toBe(409);
    expect(((await last.json()) as HubError).error).toBe("That is the last Media File of the Queue.");

    expect((await queueControl(living.id, { action: "previous" })).status).toBe(200);
    expect(await nowPlaying(living.id)).toMatchObject({ name: "02 Tone.mp3", queue: { current: 1 } });
    expect(tv.playerStatus().received.at(-1)).toBe(directPlay(source.id, MP3));
  });

  it("repeats all, from the first after the last and the last before the first", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playFolder(living.id, source.id);

    const repeat = await queueControl(living.id, { action: "repeat", repeat: "all" });
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as AppliancePlayback).nowPlaying?.queue).toMatchObject({ repeat: "all" });

    expect((await queueControl(living.id, { action: "previous" })).status).toBe(200);
    expect(await nowPlaying(living.id)).toMatchObject({ name: "03 Tone.m4a", queue: { current: 2 } });

    await nearTheEnd(living.id);
    await expect.poll(async () => (await nowPlaying(living.id))?.name).toBe("01 Tone.flac");
    expect(await nowPlaying(living.id)).toMatchObject({ queue: { current: 0, repeat: "all" } });
  });

  it("repeats one, playing it again at its end, until next moves on", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playFolder(living.id, source.id);
    expect((await queueControl(living.id, { action: "repeat", repeat: "one" })).status).toBe(200);

    await nearTheEnd(living.id);
    await expect.poll(() => tv.playerStatus().received).toHaveLength(2);
    expect(tv.playerStatus().received).toEqual([directPlay(source.id, FLAC), directPlay(source.id, FLAC)]);
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    expect(await nowPlaying(living.id)).toMatchObject({ name: "01 Tone.flac", queue: { current: 0, repeat: "one" } });

    expect((await queueControl(living.id, { action: "next" })).status).toBe(200);
    expect(await nowPlaying(living.id)).toMatchObject({ name: "02 Tone.mp3", queue: { current: 1, repeat: "one" } });
  });

  it("shuffles the rest of the Queue, the current one playing on, then puts it back in file-name order", async () => {
    // Shuffling with nothing but 0s reverses the rest.
    await start({}, { queues: { random: () => 0 } });
    const living = await addTv();
    const source = await addMedia();
    await playFolder(living.id, source.id);
    expect((await queueControl(living.id, { action: "next" })).status).toBe(200);
    const sent = tv.playerStatus().received.length;

    const shuffled = await queueControl(living.id, { action: "shuffle", shuffle: true });

    expect(shuffled.status).toBe(200);
    expect(((await shuffled.json()) as AppliancePlayback).nowPlaying?.queue).toMatchObject({
      mediaFiles: NAMES,
      current: 1,
      shuffle: true,
    });
    // Only the one after it, so nothing moves; with the first back, two are after it.
    expect((await queueControl(living.id, { action: "previous" })).status).toBe(200);
    expect((await queueControl(living.id, { action: "shuffle", shuffle: true })).status).toBe(200);
    expect((await nowPlaying(living.id))?.queue).toMatchObject({
      mediaFiles: ["01 Tone.flac", "03 Tone.m4a", "02 Tone.mp3"],
      current: 0,
    });
    expect(tv.playerStatus().received).toHaveLength(sent + 1);

    await nearTheEnd(living.id);
    await expect.poll(async () => (await nowPlaying(living.id))?.name).toBe("03 Tone.m4a");
    expect((await nowPlaying(living.id))?.queue).toMatchObject({ current: 1 });

    const unshuffled = await queueControl(living.id, { action: "shuffle", shuffle: false });
    expect(((await unshuffled.json()) as AppliancePlayback).nowPlaying).toMatchObject({
      name: "03 Tone.m4a",
      queue: { mediaFiles: NAMES, current: 2, shuffle: false },
    });
  });

  it("ends once a Media File is played on its own, or it is stopped, playing nothing more by itself", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();
    await playFolder(living.id, source.id);

    const heard = await play(living.id, source.id, MP3);
    expect(steps(heard).at(-1)).toEqual({ step: "sent" });
    await expect.poll(async () => (await nowPlaying(living.id))?.name).toBe("02 Tone.mp3");
    expect((await nowPlaying(living.id))?.queue).toBeNull();
    await nearTheEnd(living.id);
    await expect.poll(() => tv.playerStatus().playback).toBe("idle");
    expect(tv.playerStatus().received).toHaveLength(2);

    await playFolder(living.id, source.id);
    expect((await post(appliancePlaybackPath(living.id), { action: "stop" })).status).toBe(200);
    // Played again on its own, as the first was, it is no longer the Queue's.
    await play(living.id, source.id, FLAC);
    await expect.poll(() => tv.playerStatus().playback).toBe("playing");
    expect((await nowPlaying(living.id))?.queue).toBeNull();
    const refused = await queueControl(living.id, { action: "next" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as HubError).error).toBe("Living room · TV isn't playing a Queue.");
  });

  it("refuses a folder with no audio Media Files, or outside the Media Source, before it starts", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    const none = await post(appliancePlayPath(living.id), { mediaSourceId: source.id, folder: "Films/Sci-Fi" });
    expect(none.status).toBe(404);
    expect(((await none.json()) as HubError).error).toBe('There are no audio Media Files in "Sci-Fi" to play.');
    // Only those directly in it, not in its folders.
    expect((await post(appliancePlayPath(living.id), { mediaSourceId: source.id, folder: "Music" })).status).toBe(404);
    expect((await post(appliancePlayPath(living.id), { mediaSourceId: source.id, folder: "../.." })).status).toBe(403);
    expect((await post(appliancePlayPath(living.id), { mediaSourceId: source.id, folder: 3 })).status).toBe(400);
    expect(tv.playerStatus().received).toEqual([]);
  });

  it("refuses what isn't a Queue control, and any while the TV plays no Queue", async () => {
    await start();
    const living = await addTv();
    const source = await addMedia();

    expect((await queueControl(living.id, { action: "next" })).status).toBe(409);
    await playFolder(living.id, source.id);
    expect((await queueControl(living.id, { action: "skip" })).status).toBe(400);
    expect((await queueControl(living.id, { action: "repeat", repeat: "twice" })).status).toBe(400);
    expect((await queueControl(living.id, { action: "shuffle" })).status).toBe(400);
    expect((await fetch(`${base}${applianceQueuePath(living.id)}`)).status).toBe(405);
  });
});
