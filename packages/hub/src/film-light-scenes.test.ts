import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLIANCES_PATH,
  LIGHT_SCENES_PATH,
  LIGHTS_PATH,
  MEDIA_SOURCES_PATH,
  ROOMS_PATH,
  appliancePath,
  appliancePlaybackPath,
  appliancePlayPath,
  applianceStatePath,
  lightScenePath,
  lightSceneRecallPath,
  roomPath,
  type Appliance,
  type HubError,
  type LightSceneSaved,
  type LightState,
  type MediaSource,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { leproDriverFromEnvironment } from "./drivers/lepro/lepro-driver.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import { startFakeLeproLight, type FakeLeproLight } from "./fakes/lepro-light/fake-lepro-light.ts";
import {
  FAKE_APPS,
  FAKE_PLAYER_APP,
  startFakeSamsungTv,
  type FakeSamsungTv,
} from "./fakes/samsung-tv/fake-samsung-tv.ts";
import { createHub } from "./hub.ts";
import type { NetworkInterfaces } from "./hub-address.ts";
import { makeTestMediaSource } from "./testing/media.ts";

// A TV's film Light Scene (FR-57), through a real Hub: the fake TV at its own
// loopback address, whose fake Player connects to the Hub from there and
// plays what it is sent, and fake Lepro Lights beside it, a colour bulb and
// a smart plug in the Living room, and a white bulb in the Office.
const TV_HOST = "127.0.0.2";
const BULB = "127.0.0.8";
const PLUG = "127.0.0.9";
const DESK = "127.0.0.10";

/** One test Media Source, generated once with ffmpeg and only read by the tests. */
let media: string;
let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let tv: FakeSamsungTv;
let bulb: FakeLeproLight;
let plug: FakeLeproLight;
let desk: FakeLeproLight;
let hub: Server | undefined;
let base: string;
let logged: string[];

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-film-light-scenes-media-"));
  await makeTestMediaSource(media);
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

/** The Hub's own address on its network, as it finds it: loopback here, where the fake TV is. */
const loopback: NetworkInterfaces = () => ({
  eth0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "02:00:00:00:00:01",
      internal: false,
      cidr: null,
    },
  ],
});

const startHub = async (): Promise<void> => {
  database = openDatabase(databaseFile);
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    drivers: {
      tv: samsungTvDriver({
        restPort: tv.restPort,
        controlPort: tv.controlPort,
        upnpPort: tv.upnpPort,
        wakePort: tv.wakePort,
        appsTimeoutMs: 1_000,
      }),
      light: leproDriverFromEnvironment({
        LEPRO_PORT: String(bulb.port),
        LEPRO_DISCOVERY_PORT: String(bulb.discoveryPort),
      }),
    },
    networkInterfaces: loopback,
    play: { wakeTimeoutMs: 1_000, powerPollMs: 50, playerTimeoutMs: 3_000 },
  });
  await new Promise<void>((done) => hub?.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
};

const stopHub = async (): Promise<void> => {
  if (hub !== undefined) await new Promise((done) => hub?.close(done));
  hub = undefined;
  database.close();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-film-light-scenes-"));
  databaseFile = join(dir, "media-centre.sqlite");
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  tv = await startFakeSamsungTv({
    host: TV_HOST,
    macAddress: "02:00:00:00:00:22",
    apps: [...FAKE_APPS, FAKE_PLAYER_APP],
  });
  bulb = await startFakeLeproLight({ host: BULB, kind: "colour" });
  const shared = { port: bulb.port, discoveryPort: bulb.discoveryPort, httpPort: bulb.httpPort };
  plug = await startFakeLeproLight({ host: PLUG, kind: "plug", ...shared });
  desk = await startFakeLeproLight({ host: DESK, kind: "white", ...shared });
  await startHub();
});

afterEach(async () => {
  await stopHub();
  await Promise.all([tv.stop(), bulb.stop(), plug.stop(), desk.stop()]);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const created = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await send("POST", path, body);
  expect(response.status).toBe(201);
  return (await response.json()) as T;
};

const errorOf = async (response: Response): Promise<string> => ((await response.json()) as HubError).error;

const addLight = (light: FakeLeproLight, name: string, roomId: number): Promise<Appliance> =>
  created(APPLIANCES_PATH, {
    kind: "light",
    address: light.host,
    name,
    roomId,
    light: { id: light.id, key: light.key },
  });

const BLUE = { hue: 240, saturation: 100 };

/** How the Living room's Lights are before any film. */
const EVENING: { readonly bulb: LightState; readonly plug: boolean } = {
  bulb: { on: true, brightness: 80, colourTemperature: 4_000, colour: null },
  plug: true,
};

/** What sets the bulb as it is of an evening, white at a colour temperature. */
const EVENING_CHANGE = { on: true, brightness: 80, colourTemperature: 4_000 } as const;

/**
 * Living room · TV, and the Living room's Lamp and Plug, saved dimmed to
 * blue and off as its Light Scene "Film", then set as they are of an
 * evening; the Office's Desk, with a Light Scene "Work"; and the test Media
 * Source.
 */
const home = async () => {
  const living = await created<Room>(ROOMS_PATH, { name: "Living room" });
  const office = await created<Room>(ROOMS_PATH, { name: "Office" });
  const lamp = await addLight(bulb, "Lamp", living.id);
  const socket = await addLight(plug, "Plug", living.id);
  const lamp2 = await addLight(desk, "Desk", office.id);
  bulb.setLight({ on: true, brightness: 10, colour: BLUE });
  plug.setLight({ on: false });
  const film = (await created<LightSceneSaved>(LIGHT_SCENES_PATH, { roomId: living.id, name: "Film" })).lightScene;
  const work = (await created<LightSceneSaved>(LIGHT_SCENES_PATH, { roomId: office.id, name: "Work" })).lightScene;
  bulb.setLight(EVENING_CHANGE);
  plug.setLight({ on: EVENING.plug });
  const telly = await created<Appliance>(APPLIANCES_PATH, {
    kind: "tv",
    address: TV_HOST,
    name: "TV",
    roomId: living.id,
  });
  const source = await created<MediaSource>(MEDIA_SOURCES_PATH, { name: "Media", path: media });
  return { living, office, lamp, socket, desk: lamp2, film, work, tv: telly, source };
};

const choose = async (tvId: number, filmLightSceneId: number | null): Promise<Appliance> => {
  const response = await send("PATCH", appliancePath(tvId), { filmLightSceneId });
  expect(response.status).toBe(200);
  return (await response.json()) as Appliance;
};

/** Plays the Media File on the TV, and resolves once the Hub has sent it, and the Player says it plays it. */
const play = async (tvId: number, sourceId: number, path: string): Promise<void> => {
  const response = await send("POST", appliancePlayPath(tvId), { mediaSourceId: sourceId, path });
  expect(response.status).toBe(200);
  const steps = await response.text();
  expect(steps).toContain('{"step":"sent"}');
  await expect.poll(() => tv.playerStatus().playback, PATIENTLY).toBe("playing");
};

const stop = async (tvId: number): Promise<void> => {
  expect((await send("POST", appliancePlaybackPath(tvId), { action: "stop" })).status).toBe(200);
  await expect.poll(() => tv.playerStatus().playback, PATIENTLY).toBe("idle");
};

/** The Living room as the Light Scene "Film" has it. */
const expectFilm = async (): Promise<void> => {
  await expect
    .poll(() => bulb.light(), PATIENTLY)
    .toEqual({ on: true, brightness: 10, colourTemperature: null, colour: BLUE });
  await expect.poll(() => plug.light().on, PATIENTLY).toBe(false);
};

/** The Living room as it was before the film. */
const expectEvening = async (): Promise<void> => {
  await expect.poll(() => bulb.light(), PATIENTLY).toEqual(EVENING.bulb);
  await expect.poll(() => plug.light().on, PATIENTLY).toBe(EVENING.plug);
};

/** The commands the fake was sent that set something on it. */
const controls = (light: FakeLeproLight) => light.commands.filter(({ command }) => command === "control");

/** Long enough for the Hub to reach every Light, the first time on a slow machine too. */
const PATIENTLY = { timeout: 5_000 };

/** Gives the Hub long enough to have changed a Light, had it been going to. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 750));

describe("a TV's film Light Scene (FR-57)", () => {
  it("is recalled as the Player starts a video on the TV, and the Room set back as it was once the video stops", async () => {
    const { tv: telly, film, source } = await home();
    expect(await choose(telly.id, film.id)).toMatchObject({ id: telly.id, filmLightSceneId: film.id });

    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    await expect
      .poll(() => logged, PATIENTLY)
      .toContain('Living room · TV started a video, so the Hub recalled its Light Scene "Film"');

    await stop(telly.id);
    await expectEvening();
    await expect
      .poll(() => logged)
      .toContain("Living room · TV stopped its video, so the Hub set its Room's Lights back as they were");
    // The Office's Desk isn't the Living room's.
    expect(controls(desk)).toEqual([]);
  });

  it("changes nothing for audio", async () => {
    const { tv: telly, film, source } = await home();
    await choose(telly.id, film.id);
    bulb.clear();
    plug.clear();

    await play(telly.id, source.id, "Music/Album/01 Tone.flac");
    await settle();
    await stop(telly.id);
    await settle();

    expect(bulb.light()).toEqual(EVENING.bulb);
    expect(plug.light().on).toBe(EVENING.plug);
    expect([...controls(bulb), ...controls(plug)]).toEqual([]);
  });

  it("leaves a Light a person changed during the video as they left it, and sets the others back", async () => {
    const { tv: telly, film, source, socket } = await home();
    await choose(telly.id, film.id);
    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();

    // From the Lights tab, as the person reaches for the plug.
    expect((await send("PATCH", applianceStatePath(socket.id), { on: true })).status).toBe(200);
    plug.setLight({ on: false });
    await stop(telly.id);

    await expect.poll(() => bulb.light(), PATIENTLY).toEqual(EVENING.bulb);
    await settle();
    expect(plug.light().on).toBe(false);
    await expect
      .poll(() => logged, PATIENTLY)
      .toContain(
        "Living room · TV stopped its video, so the Hub set its Room's Lights back as they were, but 1 changed by hand meanwhile",
      );
  });

  it("takes a Room-wide change, or a Light Scene recalled, during the video as each of its Lights changed by hand", async () => {
    const { living, tv: telly, film, source } = await home();
    await choose(telly.id, film.id);

    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    expect((await send("POST", LIGHTS_PATH, { roomId: living.id, change: { brightness: 50 } })).status).toBe(200);
    await stop(telly.id);
    await settle();
    expect(bulb.light()).toMatchObject({ on: true, brightness: 50 });

    bulb.setLight(EVENING_CHANGE);
    plug.setLight({ on: EVENING.plug });
    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    expect((await send("POST", lightSceneRecallPath(film.id))).status).toBe(200);
    await stop(telly.id);
    await settle();
    await expectFilm();
  });

  it("doesn't read the Lights again for a video following a video, so the Room goes back as it was before the first", async () => {
    const { tv: telly, film, source } = await home();
    await choose(telly.id, film.id);

    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    await play(telly.id, source.id, "Films/Trailer.mkv");
    await settle();
    await stop(telly.id);

    await expectEvening();
    expect(logged.filter((line) => line.includes("started a video"))).toHaveLength(1);
  });

  it("sets the Room back as the TV goes from a video to audio, and as the Player goes away", async () => {
    const { tv: telly, film, source } = await home();
    await choose(telly.id, film.id);

    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    await play(telly.id, source.id, "Music/Album/02 Tone.mp3");
    await expectEvening();

    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    // Switched off with its own remote, which closes the Player.
    tv.setPowerState("standby");
    await expectEvening();
  });

  it("changes nothing on a TV with no Light Scene chosen, or no Room", async () => {
    const { tv: telly, source } = await home();
    bulb.clear();
    plug.clear();

    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await settle();
    await stop(telly.id);

    expect((await send("PATCH", appliancePath(telly.id), { roomId: null })).status).toBe(200);
    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await settle();
    await stop(telly.id);
    await settle();

    expect([...controls(bulb), ...controls(plug)]).toEqual([]);
    expect(bulb.light()).toEqual(EVENING.bulb);
  });

  it("is kept through a Hub restart", async () => {
    const { tv: telly, film, source } = await home();
    await choose(telly.id, film.id);

    await stopHub();
    await startHub();

    const all = (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];
    expect(all.find(({ id }) => id === telly.id)).toMatchObject({ filmLightSceneId: film.id });
    await play(telly.id, source.id, "Films/Sci-Fi/Clip.mp4");
    await expectFilm();
    await stop(telly.id);
    await expectEvening();
  });
});

describe("choosing a TV's film Light Scene", () => {
  it("takes only one of the TV's own Room's, and only for a TV with a Room", async () => {
    const { tv: telly, lamp, work } = await home();

    const other = await send("PATCH", appliancePath(telly.id), { filmLightSceneId: work.id });
    expect(other.status).toBe(400);
    expect(await errorOf(other)).toBe("A TV recalls only a Light Scene of its own Room, Living room.");

    const light = await send("PATCH", appliancePath(lamp.id), { filmLightSceneId: work.id });
    expect(light.status).toBe(400);
    expect(await errorOf(light)).toBe("Only a TV recalls a Light Scene as a video starts, not a Light.");

    const roomless = await send("PATCH", appliancePath(telly.id), { roomId: null, filmLightSceneId: work.id });
    expect(roomless.status).toBe(400);
    expect(await errorOf(roomless)).toBe("A TV with no Room has no Light Scenes to recall. Give it a Room first.");

    const deleted = await send("PATCH", appliancePath(telly.id), { filmLightSceneId: 999 });
    expect(deleted.status).toBe(409);
    expect(await errorOf(deleted)).toBe("That Light Scene has been deleted.");

    const shape = await send("PATCH", appliancePath(telly.id), { filmLightSceneId: "Film" });
    expect(shape.status).toBe(400);
    expect(await errorOf(shape)).toBe("Give the Light Scene as its id, or null for none.");

    // Moving to the Office and choosing its Light Scene at once.
    const moved = await send("PATCH", appliancePath(telly.id), { roomId: work.roomId, filmLightSceneId: work.id });
    expect(await moved.json()).toMatchObject({ roomId: work.roomId, filmLightSceneId: work.id });
  });

  it("is none once set to none, once the TV moves to another Room, or once the Light Scene or its Room is deleted", async () => {
    const { living, office, tv: telly, film } = await home();
    const none = await choose(telly.id, film.id).then(() => choose(telly.id, null));
    expect(none).not.toHaveProperty("filmLightSceneId");

    await choose(telly.id, film.id);
    // Renamed, it keeps it.
    expect(await (await send("PATCH", appliancePath(telly.id), { name: "Telly" })).json()).toMatchObject({
      filmLightSceneId: film.id,
    });
    const moved = (await (await send("PATCH", appliancePath(telly.id), { roomId: office.id })).json()) as Appliance;
    expect(moved).not.toHaveProperty("filmLightSceneId");

    await send("PATCH", appliancePath(telly.id), { roomId: living.id });
    await choose(telly.id, film.id);
    expect((await send("DELETE", lightScenePath(film.id))).status).toBe(204);
    const afterScene = (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];
    expect(afterScene.find(({ id }) => id === telly.id)).not.toHaveProperty("filmLightSceneId");

    bulb.setLight({ on: false });
    const again = (await created<LightSceneSaved>(LIGHT_SCENES_PATH, { roomId: living.id, name: "Late" })).lightScene;
    await choose(telly.id, again.id);
    expect((await send("DELETE", roomPath(living.id))).status).toBe(204);
    const afterRoom = (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];
    expect(afterRoom.find(({ id }) => id === telly.id)).toMatchObject({ roomId: null });
    expect(afterRoom.find(({ id }) => id === telly.id)).not.toHaveProperty("filmLightSceneId");
  });
});
