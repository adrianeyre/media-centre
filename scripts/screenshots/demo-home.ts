import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";

import { FAKE_APPS, FAKE_PLAYER_APP } from "../../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import type { FakeLeproLight } from "../../packages/hub/src/fakes/lepro-light/fake-lepro-light.ts";
import { FAKE_AIRCONS, FAKE_CLOUD_LOGIN } from "../../e2e/fake-air-conditioners.ts";
import { signInToFakeHive } from "../../e2e/fake-hive.ts";
import { startFakeLight, type FakeLightName } from "../../e2e/fake-lights.ts";
import { FAKE_TVS, fakeTvUrl } from "../../e2e/fake-tvs.ts";

/**
 * A believable home for the screenshots, put together through the Hub's API
 * from the fakes `playwright.screenshots.config.ts` starts: Rooms named on
 * the built-in floor plan, the two TVs, the two Air Conditioners, four
 * Lights, Hive's Heating, the fake Amazon's Echos and the fake Ring's
 * devices, each in a Room, the network and Bluetooth scanned, and a Media
 * Source of films, shows and music, one film playing, paused, on the
 * living room's TV.
 */

/** Each Room, in the Hub's order, and the place on the built-in floor plan it is. */
export const DEMO_ROOMS = [
  ["Living Room", "downstairs-4"],
  ["Kitchen", "downstairs-3"],
  ["Hall", "downstairs-6"],
  ["Garage", "downstairs-5"],
  ["Utility", "downstairs-1"],
  ["WC", "downstairs-2"],
  ["Main Bedroom", "upstairs-3"],
  ["En-suite", "upstairs-4"],
  ["Guest Room", "upstairs-1"],
  ["Office", "upstairs-5"],
  ["Spare Room", "upstairs-6"],
  ["Bathroom", "upstairs-2"],
  ["Landing", "upstairs-7"],
] as const;

export type DemoRoom = (typeof DEMO_ROOMS)[number][0];

/** The fake Lights, what each is called, the Room it is in, and how it is left. */
const DEMO_LIGHTS: readonly {
  readonly fake: FakeLightName;
  readonly name: string;
  readonly room: DemoRoom;
  readonly state: Readonly<Record<string, unknown>>;
}[] = [
  {
    fake: "lamp",
    name: "Floor Lamp",
    room: "Living Room",
    state: { on: true, brightness: 70, colour: { hue: 32, saturation: 80 } },
  },
  { fake: "plug", name: "Coffee Machine", room: "Kitchen", state: { on: true } },
  { fake: "desk", name: "Desk Lamp", room: "Office", state: { on: true, brightness: 85 } },
  { fake: "hidden", name: "Bedside Lamp", room: "Main Bedroom", state: { on: false } },
];

/** Hive's Appliances, by the name the fake Hive gives each, and the Room each goes in. */
const HIVE_ROOMS: Readonly<Record<string, DemoRoom>> = {
  Downstairs: "Hall",
  Upstairs: "Landing",
  Bedroom: "Main Bedroom",
  Study: "Office",
  "Living Room": "Living Room",
  "Hot Water": "Utility",
};

const ECHO_ROOMS: Readonly<Record<string, DemoRoom>> = {
  G0911W0000000001: "Kitchen",
  G0911W0000000002: "Living Room",
};

const RING_ROOMS: Readonly<Record<string, DemoRoom>> = {
  "100001": "Hall",
  "100002": "Garage",
  "100003": "Landing",
};

/** The fake Bluetooth devices, by address, named and put in a Room. */
const BLUETOOTH_DEVICES: Readonly<Record<string, { readonly name: string; readonly room: DemoRoom }>> = {
  "a4:c1:38:0a:1b:2c": { name: "Bathroom Bulb", room: "Bathroom" },
  "6a:1f:2e:3d:4c:5b": { name: "Phone", room: "Main Bedroom" },
  "f8:2a:53:79:ae:c7": { name: "Dehumidifier", room: "Office" },
};

/** The devices on the network that are no Appliance, by address, named and put in a Room. */
const NETWORK_DEVICES: Readonly<Record<string, { readonly name: string; readonly room: DemoRoom }>> = {
  "127.0.0.1": { name: "Home Server", room: "Office" },
};

/** The Media Source's files, each a minute of a test picture and a tone, which ffmpeg makes in a moment. */
const MEDIA_FILES = [
  "Films/Big Buck Bunny (2008).mp4",
  "Films/Cosmos Laundromat (2015).mp4",
  "Films/Elephants Dream (2006).mp4",
  "Films/Sintel (2010).mp4",
  "Films/Spring (2019).mp4",
  "Films/Tears of Steel (2012).mp4",
  "Shows/Nature Walks/Season 1/Nature Walks - S01E01 - The Forest.mp4",
  "Shows/Nature Walks/Season 1/Nature Walks - S01E02 - The Coast.mp4",
  "Shows/Nature Walks/Season 1/Nature Walks - S01E03 - The Mountains.mp4",
  "Music/Morning Light/01 Sunrise.mp3",
  "Music/Morning Light/02 Open Road.mp3",
] as const;

/** The film left playing, paused this far into it, on the living room's TV. */
const PLAYING = { path: "Films/Big Buck Bunny (2008).mp4", positionMs: 23_000 } as const;

const run = promisify(execFile);

/** Makes the Media Source's files in `dir`, H.264 and AAC in MP4, which a TV plays as they are, or MP3. */
const makeMedia = async (dir: string): Promise<void> => {
  for (const [index, file] of MEDIA_FILES.entries()) {
    const path = join(dir, file);
    await mkdir(dirname(path), { recursive: true });
    const tone = ["-f", "lavfi", "-i", `sine=frequency=${String(220 + index * 40)}:duration=60`];
    const picture = ["-f", "lavfi", "-i", "testsrc=duration=60:size=160x90:rate=10"];
    const video = ["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"];
    await run("ffmpeg", [
      ...["-v", "error", "-y"],
      ...(file.endsWith(".mp3") ? [...tone, "-c:a", "libmp3lame"] : [...picture, ...tone, ...video]),
      path,
    ]);
  }
};

/** The Hub's answer, or why it refused. */
const ok = async (response: Promise<APIResponse>): Promise<APIResponse> => {
  const answered = await response;
  if (!answered.ok()) {
    throw new Error(`${answered.url()} answered ${String(answered.status())}: ${await answered.text()}`);
  }
  return answered;
};

const json = async <T>(response: Promise<APIResponse>): Promise<T> => (await (await ok(response)).json()) as T;

/** Takes the Hub back to how the run started it: no Rooms, no Appliances, signed out of everything. */
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  await request.delete("/api/amazon/sign-in");
  await request.delete("/api/ring/sign-in");
  await request.delete("/api/hive");
  await request.put("/api/hub/address", { data: { override: null } });
  for (const kind of ["appliances", "rooms", "media-sources"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) await ok(request.delete(`/api/${kind}/${String(id)}`));
  }
  await request.delete("/api/rooms/floor-plan-drawing");
};

/** The fake Lights this process started, stopped once the screenshots are taken. */
const lights: FakeLeproLight[] = [];

/** The Media Source's folder, made for the run. */
let media: string | undefined;

/** Stops the fake Lights and deletes the Media Source's files. */
export const tearDownDemoHome = async (): Promise<void> => {
  await Promise.all(lights.splice(0).map((light) => light.stop()));
  if (media !== undefined) await rm(media, { recursive: true, force: true });
  media = undefined;
};

/** Builds the demo home on the run's Hub, from nothing. */
export const buildDemoHome = async (request: APIRequestContext): Promise<void> => {
  await tearDownDemoHome();
  await forgetEverything(request);

  const rooms = new Map<DemoRoom, number>();
  for (const [name, place] of DEMO_ROOMS) {
    const { id } = await json<{ id: number }>(request.post("/api/rooms", { data: { name } }));
    rooms.set(name, id);
    await ok(request.put(`/api/rooms/floor-plan/${place}`, { data: { roomId: id } }));
  }
  const roomId = (name: DemoRoom): number => {
    const id = rooms.get(name);
    if (id === undefined) throw new Error(`No Room called ${name}`);
    return id;
  };

  // The TVs, on, the living room's with the Player installed, as the TV tab is shown with one.
  for (const { host } of Object.values(FAKE_TVS)) {
    for (const power of ["standby", "on"]) {
      await ok(request.post(fakeTvUrl(host, "/_fake/power"), { data: { power } }));
    }
    const apps = host === FAKE_TVS.living.host ? [...FAKE_APPS, FAKE_PLAYER_APP] : FAKE_APPS;
    await ok(request.put(fakeTvUrl(host, "/_fake/apps"), { data: apps }));
  }
  const livingTv = await json<{ id: number }>(
    request.post("/api/appliances", {
      data: { kind: "tv", address: FAKE_TVS.living.host, name: "TV", roomId: roomId("Living Room") },
    }),
  );
  await ok(
    request.post("/api/appliances", {
      data: { kind: "tv", address: FAKE_TVS.bedroom.host, name: "TV", roomId: roomId("Main Bedroom") },
    }),
  );

  // The Air Conditioners: the living room's cooling, the bedroom's heating.
  const livingAircon = await json<{ id: number }>(
    request.post("/api/appliances", {
      data: {
        kind: "air-conditioner",
        address: FAKE_AIRCONS.living.host,
        name: "Aircon",
        roomId: roomId("Living Room"),
      },
    }),
  );
  const bedroomAircon = await json<{ id: number }>(
    request.post("/api/appliances", {
      data: {
        kind: "air-conditioner",
        address: FAKE_AIRCONS.bedroom.host,
        name: "Aircon",
        roomId: roomId("Main Bedroom"),
        login: FAKE_CLOUD_LOGIN,
      },
    }),
  );
  await ok(
    request.patch(`/api/appliances/${String(livingAircon.id)}/state`, {
      data: { power: true, mode: "cool", targetTemperature: 21, fanSpeed: "auto" },
    }),
  );
  await ok(
    request.patch(`/api/appliances/${String(bedroomAircon.id)}/state`, {
      data: { power: true, mode: "heat", targetTemperature: 23, fanSpeed: "auto" },
    }),
  );

  // The Lights, each started here, as the end-to-end tests start them.
  for (const { fake, name, room, state } of DEMO_LIGHTS) {
    const light = await startFakeLight(fake);
    lights.push(light);
    const { id } = await json<{ id: number }>(
      request.post("/api/appliances", {
        data: {
          kind: "light",
          address: light.host,
          name,
          roomId: roomId(room),
          light: { id: light.id, key: light.key },
        },
      }),
    );
    await ok(request.patch(`/api/appliances/${String(id)}/state`, { data: state }));
  }

  // Hive's Heating, Radiator Valves and Hot Water, each in its Room.
  await signInToFakeHive(request);
  const appliances = await json<{ id: number; kind: string; name: string }[]>(request.get("/api/appliances"));
  for (const [name, room] of Object.entries(HIVE_ROOMS)) {
    const hive = appliances.find(
      (each) => each.name === name && !["tv", "air-conditioner", "light"].includes(each.kind),
    );
    if (hive === undefined) throw new Error(`Hive has no ${name}`);
    await ok(request.patch(`/api/appliances/${String(hive.id)}`, { data: { roomId: roomId(room) } }));
  }

  // The fake Amazon's Echos and the fake Ring's devices.
  await ok(request.post("/api/amazon/sign-in", { data: { domain: "amazon.co.uk" } }));
  await expect
    .poll(async () => (await json<{ status: { state: string } }>(request.get("/api/amazon"))).status.state, {
      timeout: 30_000,
    })
    .toBe("signed-in");
  for (const [serial, room] of Object.entries(ECHO_ROOMS)) {
    await ok(request.put(`/api/amazon/devices/${serial}/room`, { data: { roomId: roomId(room) } }));
  }
  await ok(request.post("/api/ring/sign-in", { data: { email: "owner@example.com", password: "fake-password" } }));
  await ok(request.post("/api/ring/code", { data: { code: "123456" } }));
  for (const [id, room] of Object.entries(RING_ROOMS)) {
    await ok(request.put(`/api/ring/devices/${id}/room`, { data: { roomId: roomId(room) } }));
  }

  // The network and Bluetooth, scanned, as the Network tab shows them.
  await ok(request.post("/api/network/scan"));
  await expect
    .poll(async () => (await json<{ scanning: boolean }>(request.get("/api/network"))).scanning, { timeout: 60_000 })
    .toBe(false);
  await ok(request.post("/api/network/bluetooth/scan"));
  await expect
    .poll(async () => (await json<{ scanning: boolean }>(request.get("/api/network/bluetooth"))).scanning, {
      timeout: 30_000,
    })
    .toBe(false);
  for (const [address, { name, room }] of Object.entries(NETWORK_DEVICES)) {
    const path = `/api/network/devices/${encodeURIComponent(address)}`;
    await ok(request.put(`${path}/name`, { data: { name } }));
    await ok(request.put(`${path}/room`, { data: { roomId: roomId(room) } }));
  }
  for (const [address, { name, room }] of Object.entries(BLUETOOTH_DEVICES)) {
    const path = `/api/network/bluetooth/devices/${encodeURIComponent(address)}`;
    await ok(request.put(`${path}/name`, { data: { name } }));
    await ok(request.put(`${path}/room`, { data: { roomId: roomId(room) } }));
  }

  // The Media Source, and a film on the living room's TV, paused part way in.
  // The fake Player, on the fake TV, reaches the Hub at its loopback address.
  media = await mkdtemp(join(tmpdir(), "media-centre-screenshots-media-"));
  await makeMedia(media);
  const source = await json<{ id: number }>(request.post("/api/media-sources", { data: { name: "NAS", path: media } }));
  await ok(request.put("/api/hub/address", { data: { override: "127.0.0.1" } }));
  const played = await ok(
    request.post(`/api/appliances/${String(livingTv.id)}/play`, {
      data: { mediaSourceId: source.id, path: PLAYING.path },
      timeout: 60_000,
    }),
  );
  const progress = await played.text();
  if (!progress.includes('"sent"')) throw new Error(`The film didn't play: ${progress}`);
  const playback = `/api/appliances/${String(livingTv.id)}/playback`;
  await expect
    .poll(async () => (await json<{ nowPlaying: unknown }>(request.get(playback))).nowPlaying, { timeout: 30_000 })
    .not.toBeNull();
  await ok(request.post(playback, { data: { action: "seek", positionMs: PLAYING.positionMs } }));
  await ok(request.post(playback, { data: { action: "pause" } }));
};
