import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  PLAYER_SOCKET_PATH,
  appliancePlaybackPath,
  appliancePlayerPath,
  type Appliance,
  type AppliancePlayback,
  type AppliancePlayer,
  type HubError,
  type PlaybackControl,
  type PlayerPlayback,
  type PlayerToHubMessage,
} from "@media-centre/shared";

import { applianceStore, type ApplianceStore } from "./appliances.ts";
import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";
import { acceptPlayers, type Players } from "./players.ts";
import { roomStore } from "./rooms.ts";

// Two TVs, each at its own loopback address, as two real TVs on the home
// network would be. A Player connects from the address of the TV it is on.
const LIVING_ROOM_TV = "127.0.0.2";
const BEDROOM_TV = "127.0.0.3";

let database: DatabaseSync;
let appliances: ApplianceStore;
let hub: Server;
let port: number;
let sockets: WebSocket[];
let logged: string[];

beforeEach(async () => {
  database = openDatabase(":memory:");
  appliances = applianceStore(database);
  hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  port = (hub.address() as AddressInfo).port;
  sockets = [];
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  for (const socket of sockets) {
    // One the Hub refused errors as it is terminated, before it ever opened.
    socket.on("error", () => undefined);
    socket.terminate();
  }
  await new Promise((done) => hub.close(done));
  database.close();
  vi.restoreAllMocks();
});

const addTv = (name: string, address: string, roomId: number | null = null): Appliance =>
  appliances.add(
    { kind: "tv", name, roomId, address, model: "QE55Q80TATXXU", macAddress: `02:00:00:00:00:${address.slice(-1)}` },
    "token",
  );

/**
 * Connects as a Player on the TV at `from`, and resolves once the Hub has it.
 * `host` is the Hub's address as the Player names it, when it names it other
 * than by `target`: so a test needn't ask DNS for another name, which, as
 * `localhost` may be IPv6, a connection from an IPv4 address can't reach.
 */
const connectPlayer = async (from: string, target = `127.0.0.1:${String(port)}`, host = target): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://${target}${PLAYER_SOCKET_PATH}`, { localAddress: from, headers: { host } });
  sockets.push(socket);
  await new Promise<void>((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  return socket;
};

const playerOn = async (tv: Appliance): Promise<AppliancePlayer> =>
  (await (await fetch(`http://127.0.0.1:${String(port)}${appliancePlayerPath(tv.id)}`)).json()) as AppliancePlayer;

describe("the Hub's Players", () => {
  it("knows which TV a Player is on by the address it connects from", async () => {
    const living = addTv("TV", LIVING_ROOM_TV, roomStore(database).add("Living room").id);
    const bedroom = addTv("Bedroom TV", BEDROOM_TV);
    expect(await playerOn(living)).toEqual({ connected: false });

    await connectPlayer(LIVING_ROOM_TV);

    await expect.poll(() => playerOn(living)).toEqual({ connected: true });
    expect(await playerOn(bedroom)).toEqual({ connected: false });
    expect(logged).toContain("A Player connected on Living room · TV");
  });

  it("forgets a Player once its socket closes", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    await expect.poll(() => playerOn(living)).toEqual({ connected: true });

    socket.close();

    await expect.poll(() => playerOn(living)).toEqual({ connected: false });
    await expect.poll(() => logged).toContain("The Player on TV disconnected");
  });

  it("counts a Player that connected before its TV was added, once it is", async () => {
    await connectPlayer(BEDROOM_TV);
    await expect.poll(() => logged).toContain(`A Player connected at ${BEDROOM_TV}, which is not a TV the Hub has`);

    const bedroom = addTv("TV", BEDROOM_TV);

    expect(await playerOn(bedroom)).toEqual({ connected: true });
  });

  it("still counts a Player on a TV while another of its sockets closes", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const old = await connectPlayer(LIVING_ROOM_TV);
    await connectPlayer(LIVING_ROOM_TV);

    old.close();
    await expect.poll(() => logged).toContain("The Player on TV disconnected");

    expect(await playerOn(living)).toEqual({ connected: true });
  });

  it("closes the Players' sockets as it stops, rather than wait for them", async () => {
    addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    const closed = new Promise((done) => socket.once("close", done));

    await new Promise((done) => hub.close(done));
    await closed;

    // Listening again, so that `afterEach` has a server to close.
    hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database });
    await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  });

  it("refuses a WebSocket anywhere but the Players' path", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/rooms`);
    sockets.push(socket);

    const status = await new Promise<number | undefined>((done) => {
      socket.once("unexpected-response", (_request, response) => {
        done(response.statusCode);
      });
    });

    expect(status).toBe(404);
  });

  it("answers 404 for an Appliance it hasn't got, and only GET and HEAD", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const base = `http://127.0.0.1:${String(port)}`;

    const missing = await fetch(`${base}${appliancePlayerPath(living.id + 1)}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as HubError).error).toBeTruthy();

    const post = await fetch(`${base}${appliancePlayerPath(living.id)}`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("the Players' heartbeat", () => {
  const HEARTBEAT_MS = 50;
  let server: Server;
  let players: Players;
  let address: string;

  beforeEach(async () => {
    server = createServer();
    players = acceptPlayers(server, appliances, { heartbeatMs: HEARTBEAT_MS });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    address = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    players.close();
    await new Promise((done) => server.close(done));
  });

  it("sends each Player a heartbeat, so that it can tell its connection is alive", async () => {
    const socket = await connectPlayer(LIVING_ROOM_TV, address);

    const message = await new Promise<string>((done) => {
      socket.once("message", (data: Buffer) => {
        done(data.toString("utf8"));
      });
    });

    expect(JSON.parse(message)).toEqual({ type: "heartbeat" });
  });

  it("drops a Player that doesn't answer its ping", async () => {
    const socket = new WebSocket(`ws://${address}${PLAYER_SOCKET_PATH}`, {
      localAddress: LIVING_ROOM_TV,
      autoPong: false,
    });
    sockets.push(socket);
    await new Promise((done) => socket.once("open", done));
    expect(players.connectedAt(LIVING_ROOM_TV)).toBe(true);

    await new Promise((done) => socket.once("close", done));

    await expect.poll(() => players.connectedAt(LIVING_ROOM_TV)).toBe(false);
  });

  it("keeps a Player that answers", async () => {
    await connectPlayer(LIVING_ROOM_TV, address);

    await new Promise((done) => setTimeout(done, HEARTBEAT_MS * 5));

    expect(players.connectedAt(LIVING_ROOM_TV)).toBe(true);
  });
});

describe("a Player saying a Media File played to its end (FR-48)", () => {
  let server: Server;
  let players: Players;
  let address: string;
  let ended: { readonly from: string; readonly url: string }[];

  beforeEach(async () => {
    server = createServer();
    ended = [];
    players = acceptPlayers(server, appliances, {
      onEnded: (player, url) => {
        ended.push({ from: player.address, url });
      },
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    address = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    players.close();
    await new Promise((done) => server.close(done));
  });

  it("is heard, with the URL it was sent the Media File at, from the TV it is on", async () => {
    const socket = await connectPlayer(LIVING_ROOM_TV, address);
    const message: PlayerToHubMessage = { type: "ended", url: "http://127.0.0.1:8080/api/media-sources/1/file/a.flac" };

    socket.send(JSON.stringify(message));

    await expect.poll(() => ended).toEqual([{ from: LIVING_ROOM_TV, url: message.url }]);
  });

  it("is not heard without a URL, as it can't say which Media File ended", async () => {
    const socket = await connectPlayer(LIVING_ROOM_TV, address);
    socket.send(JSON.stringify({ type: "ended" }));
    socket.send(JSON.stringify({ type: "ended", url: 5 }));
    socket.send(JSON.stringify({ type: "ended", url: "http://127.0.0.1:8080/b.flac" }));

    await expect.poll(() => ended).toEqual([{ from: LIVING_ROOM_TV, url: "http://127.0.0.1:8080/b.flac" }]);
  });
});

describe("waiting for a Player, and sending it a message (FR-35)", () => {
  let server: Server;
  let players: Players;
  /** The Hub's address, as a Player launched with it reaches it. */
  let hubAddress: string;

  beforeEach(async () => {
    server = createServer();
    players = acceptPlayers(server, appliances);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    hubAddress = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    players.close();
    await new Promise((done) => server.close(done));
  });

  /** Every message the socket is sent from now on, but the heartbeats. */
  const heard = (socket: WebSocket): unknown[] => {
    const messages: unknown[] = [];
    socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as { type: string };
      if (message.type !== "heartbeat") messages.push(message);
    });
    return messages;
  };

  it("resolves at once for a Player already connected from the TV, to the Hub at that address", async () => {
    await connectPlayer(LIVING_ROOM_TV, hubAddress);

    expect(await players.waitFor(LIVING_ROOM_TV, hubAddress, 1_000)).toBe(true);
  });

  it("resolves once a Player connects from the TV", async () => {
    const waiting = players.waitFor(LIVING_ROOM_TV, hubAddress, 5_000);

    await connectPlayer(BEDROOM_TV, hubAddress);
    await connectPlayer(LIVING_ROOM_TV, hubAddress);

    expect(await waiting).toBe(true);
  });

  it("doesn't count a Player connected to the Hub at another address, which it may have remembered", async () => {
    const { port } = server.address() as AddressInfo;
    await connectPlayer(LIVING_ROOM_TV, hubAddress, `localhost:${String(port)}`);

    expect(await players.waitFor(LIVING_ROOM_TV, hubAddress, 100)).toBe(false);
  });

  it("resolves false when no Player connects in time, or once the Hub stops", async () => {
    expect(await players.waitFor(LIVING_ROOM_TV, hubAddress, 50)).toBe(false);

    const waiting = players.waitFor(LIVING_ROOM_TV, hubAddress, 60_000);
    players.close();
    expect(await waiting).toBe(false);
  });

  it("sends a message to the Players on the TV connected to the Hub at that address only", async () => {
    const { port } = server.address() as AddressInfo;
    const living = heard(await connectPlayer(LIVING_ROOM_TV, hubAddress));
    const remembered = heard(await connectPlayer(LIVING_ROOM_TV, hubAddress, `localhost:${String(port)}`));
    const bedroom = heard(await connectPlayer(BEDROOM_TV, hubAddress));
    const play = {
      type: "play",
      url: `http://${hubAddress}/api/media-sources/1/file/Clip.mp4`,
      positionMs: 0,
    } as const;

    expect(await players.send(LIVING_ROOM_TV, hubAddress, play)).toBe(1);

    await expect.poll(() => living).toEqual([play]);
    expect(remembered).toEqual([]);
    expect(bedroom).toEqual([]);
    expect(await players.send("127.0.0.9", hubAddress, play)).toBe(0);
  });
});

describe("what a Player is playing, and the now-playing bar's controls (FR-36)", () => {
  const CONTROL_REPORT_TIMEOUT_MS = 200;
  const URL_OF = (file: string): string => `http://127.0.0.1:8080/api/media-sources/1/file/Films/${file}`;
  const playing = (more: Partial<PlayerPlayback> = {}): PlayerPlayback => ({
    state: "playing",
    url: URL_OF("Sci-Fi%20Classics/Arrival%20(2016).mkv"),
    positionMs: 12_000,
    durationMs: 6_960_000,
    audioTrack: 0,
    ...more,
  });

  beforeEach(async () => {
    // A Hub that waits less for a Player that never reports.
    await new Promise((done) => hub.close(done));
    hub = createHub({
      remoteDir: "/nonexistent",
      version: "9.9.9",
      hubId: "hub-1",
      database,
      playback: { controlReportTimeoutMs: CONTROL_REPORT_TIMEOUT_MS },
    });
    await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
    port = (hub.address() as AddressInfo).port;
  });

  const base = (): string => `http://127.0.0.1:${String(port)}`;
  const playbackOn = async (tv: Appliance): Promise<AppliancePlayback> =>
    (await (await fetch(`${base()}${appliancePlaybackPath(tv.id)}`)).json()) as AppliancePlayback;
  const control = (tv: Appliance, body: PlaybackControl | object): Promise<Response> =>
    fetch(`${base()}${appliancePlaybackPath(tv.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const report = (socket: WebSocket, playback: PlayerPlayback): void => {
    const message: PlayerToHubMessage = { type: "playback", playback };
    socket.send(JSON.stringify(message));
  };
  /** Every control the socket is sent from now on. */
  const controls = (socket: WebSocket): PlaybackControl[] => {
    const heard: PlaybackControl[] = [];
    socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as { type: string; control?: PlaybackControl };
      if (message.type === "control" && message.control !== undefined) heard.push(message.control);
    });
    return heard;
  };

  it("says nothing is playing on a TV with no Player, or one that plays nothing", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    expect(await playbackOn(living)).toEqual({ nowPlaying: null });

    const socket = await connectPlayer(LIVING_ROOM_TV);
    report(socket, { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null });
    await new Promise((done) => setTimeout(done, 50));

    expect(await playbackOn(living)).toEqual({ nowPlaying: null });
  });

  it("follows what the Player on the TV reports, naming the Media File by its file name", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const bedroom = addTv("Bedroom TV", BEDROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);

    report(socket, playing());

    await expect
      .poll(() => playbackOn(living))
      .toEqual({
        nowPlaying: {
          name: "Arrival (2016).mkv",
          // The Hub sent it no Media File, so knows neither its Route nor any of
          // its audio or subtitle tracks, and has no file to take a preview picture from.
          route: null,
          state: "playing",
          positionMs: 12_000,
          durationMs: 6_960_000,
          audioTracks: [],
          audioTrack: null,
          subtitleTracks: [],
          subtitleTrack: null,
          preview: null,
          music: null,
          queue: null,
        },
      });
    expect(await playbackOn(bedroom)).toEqual({ nowPlaying: null });

    report(socket, playing({ state: "paused", positionMs: 13_000 }));

    await expect
      .poll(async () => (await playbackOn(living)).nowPlaying)
      .toMatchObject({ state: "paused", positionMs: 13_000 });
  });

  it("forgets what a Player was playing once it disconnects", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    report(socket, playing());
    await expect.poll(async () => (await playbackOn(living)).nowPlaying).not.toBeNull();

    socket.close();

    await expect.poll(() => playbackOn(living)).toEqual({ nowPlaying: null });
  });

  it("of two Players on one TV, follows the one playing something", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const playingOne = await connectPlayer(LIVING_ROOM_TV);
    const idleOne = await connectPlayer(LIVING_ROOM_TV);

    report(playingOne, playing());
    await expect.poll(async () => (await playbackOn(living)).nowPlaying).not.toBeNull();
    report(idleOne, { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null });
    await new Promise((done) => setTimeout(done, 50));

    expect((await playbackOn(living)).nowPlaying?.name).toBe("Arrival (2016).mkv");
  });

  it.each([
    ["not JSON", "playing"],
    ["a message it doesn't know", JSON.stringify({ type: "volume", volume: 11 })],
    ["a state it doesn't know", JSON.stringify({ type: "playback", playback: { ...playing(), state: "seeking" } })],
    [
      "a position that isn't a number",
      JSON.stringify({ type: "playback", playback: { ...playing(), positionMs: "1" } }),
    ],
    ["a negative duration", JSON.stringify({ type: "playback", playback: { ...playing(), durationMs: -1 } })],
  ])("ignores a report it doesn't know: %s", async (_, data) => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);

    socket.send(data);
    await new Promise((done) => setTimeout(done, 50));

    expect(await playbackOn(living)).toEqual({ nowPlaying: null });
    expect(await playerOn(living)).toEqual({ connected: true });
  });

  it("follows a Player that doesn't say which audio or subtitle track it plays, as one older than the Hub doesn't", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    // Saying nothing of them, as JSON leaves out what is undefined.
    const older = { ...playing(), audioTrack: undefined, subtitleTrack: undefined };

    socket.send(JSON.stringify({ type: "playback", playback: older }));

    await expect
      .poll(async () => (await playbackOn(living)).nowPlaying)
      .toMatchObject({ name: "Arrival (2016).mkv", state: "playing", audioTrack: null, subtitleTrack: null });
  });

  it("sends the Player each control, and answers with what it reports once it has done it", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    const heard = controls(socket);
    report(socket, playing());
    await expect.poll(async () => (await playbackOn(living)).nowPlaying).not.toBeNull();
    socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as { type: string; control?: PlaybackControl };
      if (message.control?.action === "pause") report(socket, playing({ state: "paused" }));
    });

    const answer = await control(living, { action: "pause" });

    expect(answer.status).toBe(200);
    expect(((await answer.json()) as AppliancePlayback).nowPlaying?.state).toBe("paused");
    expect(heard).toEqual([{ action: "pause" }]);
  });

  it("passes on every kind of control as it was asked", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    const heard = controls(socket);
    report(socket, playing());
    await expect.poll(async () => (await playbackOn(living)).nowPlaying).not.toBeNull();
    const all: PlaybackControl[] = [
      { action: "play" },
      { action: "pause" },
      { action: "seek", positionMs: 60_000 },
      { action: "skip", byMs: -30_000 },
      { action: "skip", byMs: 10_000 },
      // Off, which any Media File has.
      { action: "subtitle-track", track: null },
      { action: "stop" },
    ];

    for (const each of all) expect((await control(living, each)).status).toBe(200);

    expect(heard).toEqual(all);
  });

  it("answers with what the Player last reported when it says nothing in time", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    report(socket, playing());
    await expect.poll(async () => (await playbackOn(living)).nowPlaying).not.toBeNull();
    const started = Date.now();

    const answer = await control(living, { action: "play" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(CONTROL_REPORT_TIMEOUT_MS - 10);
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as AppliancePlayback).nowPlaying?.state).toBe("playing");
  });

  it("refuses a control with 409 when nothing is playing on the TV", async () => {
    const living = addTv("TV", LIVING_ROOM_TV, roomStore(database).add("Living room").id);

    const answer = await control(living, { action: "pause" });

    expect(answer.status).toBe(409);
    expect(((await answer.json()) as HubError).error).toBe("Nothing is playing on Living room · TV.");
  });

  it.each([
    ["no action", {}],
    ["an action it doesn't know", { action: "rewind" }],
    ["a seek with no position", { action: "seek" }],
    ["a seek before the start", { action: "seek", positionMs: -1 }],
    ["a skip by something that isn't a number", { action: "skip", byMs: "10" }],
    ["an audio track by no number", { action: "audio-track" }],
    ["an audio track before the first", { action: "audio-track", track: -1 }],
    ["an audio track by something that isn't a whole number", { action: "audio-track", track: 1.5 }],
    // The Hub sent the Player no Media File, so knows of no audio tracks to choose from.
    ["an audio track the Media File hasn't got", { action: "audio-track", track: 0 }],
    ["a subtitle track by no number", { action: "subtitle-track" }],
    ["a subtitle track before the first", { action: "subtitle-track", track: -1 }],
    ["a subtitle track by something that isn't a whole number", { action: "subtitle-track", track: "1" }],
    // As for audio tracks, it knows of no subtitle tracks to choose from.
    ["a subtitle track the Media File hasn't got", { action: "subtitle-track", track: 0 }],
  ])("refuses a control it doesn't know with 400: %s", async (_, body) => {
    const living = addTv("TV", LIVING_ROOM_TV);
    const socket = await connectPlayer(LIVING_ROOM_TV);
    const heard = controls(socket);
    report(socket, playing());
    await expect.poll(async () => (await playbackOn(living)).nowPlaying).not.toBeNull();

    const answer = await control(living, body);

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as HubError).error).toBeTruthy();
    expect(heard).toEqual([]);
  });

  it("answers 404 for an Appliance it hasn't got, and only GET, HEAD and POST", async () => {
    const living = addTv("TV", LIVING_ROOM_TV);

    expect((await fetch(`${base()}${appliancePlaybackPath(living.id + 1)}`)).status).toBe(404);
    const put = await fetch(`${base()}${appliancePlaybackPath(living.id)}`, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, HEAD, POST");
  });
});
