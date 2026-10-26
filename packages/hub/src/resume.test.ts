import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  MEDIA_SOURCES_PATH,
  PLAYER_SOCKET_PATH,
  appliancePlaybackPath,
  mediaCoverArtPath,
  mediaFilePath,
  mediaResumePositionPath,
  type AppliancePlayback,
  type HubToPlayerMessage,
  type MediaResumePosition,
  type MediaSource,
  type PlayerPlayback,
  type PlayerToHubMessage,
} from "@media-centre/shared";

import { applianceStore } from "./appliances.ts";
import { openDatabase } from "./database.ts";
import { NO_TAGS, type MediaProbe, type ProbeMedia } from "./ffprobe.ts";
import { createHub } from "./hub.ts";

// The Hub records each Media File's Resume Position from what the Players
// report, offers the one recorded last to each Player that plays nothing, and
// resumes it when a Player asks (FR-39, FR-40). Here a WebSocket stands in for
// the Player on a TV at its own loopback address.
const TV = "127.0.0.2";
/** The fake playback's length for every Media File, as the Player would report it. */
const LENGTH_MS = 60_000;

let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let hub: Server;
let port: number;
let sockets: WebSocket[];
let logged: string[];

const startHub = async (probeMedia?: ProbeMedia): Promise<void> => {
  database = openDatabase(databaseFile);
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    ...(probeMedia === undefined ? {} : { probeMedia }),
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  port = (hub.address() as AddressInfo).port;
};

const stopHub = async (): Promise<void> => {
  for (const socket of sockets) {
    socket.on("error", () => undefined);
    socket.terminate();
  }
  sockets = [];
  await new Promise((done) => hub.close(done));
  database.close();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-resume-"));
  await mkdir(join(dir, "media", "Films"), { recursive: true });
  for (const file of ["Films/Arrival.mkv", "Films/Contact.mkv"]) await writeFile(join(dir, "media", file), "a film");
  databaseFile = join(dir, "media-centre.sqlite");
  sockets = [];
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  await startHub();
  applianceStore(database).add(
    { kind: "tv", name: "TV", roomId: null, address: TV, model: "QE55Q80TATXXU", macAddress: "02:00:00:00:00:02" },
    "token",
  );
});

afterEach(async () => {
  await stopHub();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${String(port)}`;

const addMedia = async (): Promise<MediaSource> => {
  const response = await fetch(`${base()}${MEDIA_SOURCES_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Media", path: join(dir, "media") }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as MediaSource;
};

const resumePosition = async (source: MediaSource, path: string): Promise<number | null> => {
  const response = await fetch(`${base()}${mediaResumePositionPath(source.id, path)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as MediaResumePosition).positionMs;
};

/** A Player connected from the TV, with every message the Hub has sent it but the heartbeats. */
interface TestPlayer {
  readonly heard: HubToPlayerMessage[];
  readonly send: (message: PlayerToHubMessage) => void;
  readonly report: (playback: PlayerPlayback) => void;
}

const connectPlayer = async (): Promise<TestPlayer> => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${PLAYER_SOCKET_PATH}`, { localAddress: TV });
  sockets.push(socket);
  const heard: HubToPlayerMessage[] = [];
  socket.on("message", (data: Buffer) => {
    const message = JSON.parse(data.toString("utf8")) as HubToPlayerMessage;
    if (message.type !== "heartbeat") heard.push(message);
  });
  await new Promise<void>((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  const send = (message: PlayerToHubMessage): void => {
    socket.send(JSON.stringify(message));
  };
  return {
    heard,
    send,
    report: (playback) => {
      send({ type: "playback", playback });
    },
  };
};

const urlOf = (source: MediaSource, path: string): string =>
  `http://127.0.0.1:${String(port)}${mediaFilePath(source.id, path)}`;
const IDLE: PlayerPlayback = { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null };
const at = (url: string, positionMs: number, state: PlayerPlayback["state"] = "playing"): PlayerPlayback => ({
  state,
  url,
  positionMs,
  durationMs: LENGTH_MS,
  audioTrack: state === "loading" ? null : 0,
});

describe("recording Resume Positions from what the Players report (FR-40)", () => {
  it("records how far a Media File has played, from each report, and keeps it once the Player stops", async () => {
    const source = await addMedia();
    const player = await connectPlayer();
    const arrival = urlOf(source, "Films/Arrival.mkv");
    expect(await resumePosition(source, "Films/Arrival.mkv")).toBeNull();

    player.report(at(arrival, 0, "paused"));
    player.report(at(arrival, 29_000));
    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBe(29_000);
    player.report(at(arrival, 30_000, "paused"));
    player.report(IDLE);

    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBe(30_000);
    expect(await resumePosition(source, "Films/Contact.mkv")).toBeNull();
  });

  it("clears it once the Media File plays past 95%, and says so", async () => {
    const source = await addMedia();
    const player = await connectPlayer();
    const arrival = urlOf(source, "Films/Arrival.mkv");
    player.report(at(arrival, 30_000));
    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBe(30_000);

    player.report(at(arrival, 57_500));

    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBeNull();
    expect(logged).toContain('"Arrival.mkv" has played to within its last 5%, so its Resume Position is cleared');
  });

  it("records nothing while the Player doesn't yet say how long the Media File is", async () => {
    const source = await addMedia();
    const player = await connectPlayer();
    const arrival = urlOf(source, "Films/Arrival.mkv");

    player.report({ ...at(arrival, 30_000, "loading"), durationMs: null });
    player.report(at(urlOf(source, "Films/Contact.mkv"), 10_000));

    await expect.poll(() => resumePosition(source, "Films/Contact.mkv")).toBe(10_000);
    expect(await resumePosition(source, "Films/Arrival.mkv")).toBeNull();
  });

  it("keeps them through a Hub restart (NFR-4)", async () => {
    const source = await addMedia();
    const player = await connectPlayer();
    player.report(at(urlOf(source, "Films/Arrival.mkv"), 30_000, "paused"));
    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBe(30_000);

    await stopHub();
    await startHub();

    expect(await resumePosition(source, "Films/Arrival.mkv")).toBe(30_000);
  });

  it("answers a Media File's Resume Position only for a Media Source it has, and only to GET", async () => {
    const source = await addMedia();

    expect((await fetch(`${base()}${mediaResumePositionPath(source.id + 1, "Films/Arrival.mkv")}`)).status).toBe(404);
    const post = await fetch(`${base()}${mediaResumePositionPath(source.id, "Films/Arrival.mkv")}`, {
      method: "POST",
    });
    expect(post.status).toBe(405);
  });
});

describe("the Player's Resume button (FR-39)", () => {
  it("offers a Player that plays nothing the Media File whose Resume Position was recorded last", async () => {
    const source = await addMedia();
    const player = await connectPlayer();

    player.report(IDLE);
    await expect.poll(() => player.heard).toEqual([{ type: "resumable", resumable: null }]);

    player.report(at(urlOf(source, "Films/Contact.mkv"), 10_000));
    await expect.poll(() => resumePosition(source, "Films/Contact.mkv")).toBe(10_000);
    await new Promise((done) => setTimeout(done, 5));
    player.report(at(urlOf(source, "Films/Arrival.mkv"), 30_000, "paused"));
    player.report(IDLE);

    await expect
      .poll(() => player.heard.at(-1))
      .toEqual({
        type: "resumable",
        resumable: { mediaSourceId: source.id, path: "Films/Arrival.mkv", name: "Arrival.mkv", positionMs: 30_000 },
      });
  });

  it("offers it on whichever TV it last played on, as Resume Positions are per Media File", async () => {
    const source = await addMedia();
    const living = await connectPlayer();
    living.report(at(urlOf(source, "Films/Arrival.mkv"), 30_000, "paused"));
    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBe(30_000);

    const other = new WebSocket(`ws://127.0.0.1:${String(port)}${PLAYER_SOCKET_PATH}`, { localAddress: "127.0.0.3" });
    sockets.push(other);
    const heard: HubToPlayerMessage[] = [];
    other.on("message", (data: Buffer) => heard.push(JSON.parse(data.toString("utf8")) as HubToPlayerMessage));
    await new Promise((done) => other.once("open", done));
    other.send(JSON.stringify({ type: "playback", playback: IDLE }));

    await expect
      .poll(() => heard)
      .toContainEqual({
        type: "resumable",
        resumable: { mediaSourceId: source.id, path: "Films/Arrival.mkv", name: "Arrival.mkv", positionMs: 30_000 },
      });
  });

  it("sends a Player that asks to resume a Media File its URL, from its Resume Position", async () => {
    const source = await addMedia();
    const player = await connectPlayer();
    player.report(at(urlOf(source, "Films/Arrival.mkv"), 30_000, "paused"));
    await expect.poll(() => resumePosition(source, "Films/Arrival.mkv")).toBe(30_000);

    player.send({ type: "resume", mediaSourceId: source.id, path: "Films/Arrival.mkv" });

    await expect
      .poll(() => player.heard.at(-1))
      .toEqual({ type: "play", url: urlOf(source, "Films/Arrival.mkv"), positionMs: 30_000, subtitles: [] });
    expect(logged).toContain('Resumed "Arrival.mkv" from 0:30 on the Player on TV, by Direct Play');
  });

  it("lists the audio tracks of the Media File it resumes for the now-playing bar (FR-36)", async () => {
    await stopHub();
    const probe: MediaProbe = {
      container: "mp4",
      duration: 60,
      startTime: 0,
      tags: NO_TAGS,
      streams: [
        { index: 0, type: "video", codec: "h264", attachedPicture: false, language: null, title: null, channels: null },
        { index: 1, type: "audio", codec: "aac", attachedPicture: false, language: "eng", title: null, channels: 2 },
        { index: 2, type: "audio", codec: "ac3", attachedPicture: false, language: "ger", title: null, channels: 6 },
      ],
    };
    await startHub(() => Promise.resolve(probe));
    const tv = applianceStore(database).list()[0];
    const source = await addMedia();
    const player = await connectPlayer();

    player.send({ type: "resume", mediaSourceId: source.id, path: "Films/Arrival.mkv" });
    await expect.poll(() => player.heard.at(-1)?.type).toBe("play");
    player.report(at(urlOf(source, "Films/Arrival.mkv"), 1_000));

    await expect
      .poll(async () => {
        const answer = await fetch(`${base()}${appliancePlaybackPath(tv?.id ?? 0)}`);
        return ((await answer.json()) as AppliancePlayback).nowPlaying;
      })
      .toMatchObject({
        name: "Arrival.mkv",
        audioTracks: [
          { language: "eng", title: null, codec: "aac", channels: 2 },
          { language: "ger", title: null, codec: "ac3", channels: 6 },
        ],
        audioTrack: 0,
      });
  });

  it("sends an audio Media File it resumes with what the Player's now-playing screen shows (FR-47)", async () => {
    await stopHub();
    const probe: MediaProbe = {
      container: "flac",
      duration: 180,
      startTime: 0,
      tags: { title: "Tone in A", artist: "The Sine Waves", album: "Test Tones" },
      streams: [
        { index: 0, type: "audio", codec: "flac", attachedPicture: false, language: null, title: null, channels: 2 },
        { index: 1, type: "video", codec: "png", attachedPicture: true, language: null, title: null, channels: null },
      ],
    };
    await startHub(() => Promise.resolve(probe));
    await mkdir(join(dir, "media", "Music"));
    await writeFile(join(dir, "media", "Music", "Tone.flac"), "a tone");
    const source = await addMedia();
    const player = await connectPlayer();

    player.send({ type: "resume", mediaSourceId: source.id, path: "Music/Tone.flac" });

    await expect
      .poll(() => player.heard.at(-1))
      .toEqual({
        type: "play",
        url: urlOf(source, "Music/Tone.flac"),
        positionMs: 0,
        subtitles: [],
        music: {
          title: "Tone in A",
          artist: "The Sine Waves",
          album: "Test Tones",
          coverArt: `http://127.0.0.1:${String(port)}${mediaCoverArtPath(source.id, "Music/Tone.flac")}`,
        },
      });
  });

  it("sends it from the start when the Media File has no Resume Position by then", async () => {
    const source = await addMedia();
    const player = await connectPlayer();

    player.send({ type: "resume", mediaSourceId: source.id, path: "Films/Contact.mkv" });

    await expect
      .poll(() => player.heard.at(-1))
      .toEqual({ type: "play", url: urlOf(source, "Films/Contact.mkv"), positionMs: 0, subtitles: [] });
  });

  it.each([
    ["a Media Source it hasn't got", 99, "Films/Arrival.mkv"],
    ["a Media File that isn't there", 0, "Films/Gone.mkv"],
    ["a path outside the Media Source", 0, "../media-centre.sqlite"],
  ])("sends no URL for %s, but what it offers now", async (_, sourceOffset, path) => {
    const source = await addMedia();
    const player = await connectPlayer();

    player.send({ type: "resume", mediaSourceId: source.id + sourceOffset, path });

    await expect.poll(() => player.heard).toEqual([{ type: "resumable", resumable: null }]);
  });

  it("ignores a request to resume that isn't one", async () => {
    await addMedia();
    const player = await connectPlayer();
    const socket = sockets.at(-1);

    socket?.send(JSON.stringify({ type: "resume", mediaSourceId: "1", path: "Films/Arrival.mkv" }));
    socket?.send(JSON.stringify({ type: "resume", mediaSourceId: 1, path: "" }));
    player.report(IDLE);

    await expect.poll(() => player.heard).toEqual([{ type: "resumable", resumable: null }]);
  });
});
