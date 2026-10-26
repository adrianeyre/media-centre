import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLIANCE_SEARCH_PATH,
  APPLIANCES_PATH,
  LIGHT_SCENES_PATH,
  LIGHTS_PATH,
  ROOMS_PATH,
  applianceCapabilitiesPath,
  applianceConnectionPath,
  appliancePath,
  applianceStatePath,
  lightScenePath,
  lightSceneRecallPath,
  roomPath,
  type Appliance,
  type FoundLight,
  type HubError,
  type LightCapabilitiesReading,
  type LightReading,
  type LightScene,
  type LightSceneSaved,
  type LightsOutcome,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { leproDriverFromEnvironment } from "./drivers/lepro/lepro-driver.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import {
  startFakeLeproLight,
  type FakeLeproLight,
  type FakeLeproLightOptions,
} from "./fakes/lepro-light/fake-lepro-light.ts";
import { createHub } from "./hub.ts";

// Fake Lepro Lights, each at its own address on the same ports, as Lights on
// the home network would be: a colour bulb and a smart plug the Hub finds,
// and a white bulb it can't, which is added by its id.
const BULB = "127.0.0.8";
const PLUG = "127.0.0.9";
const HIDDEN = "127.0.0.10";

let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let hub: Server;
let base: string;
let bulb: FakeLeproLight;
let plug: FakeLeproLight;
let hidden: FakeLeproLight | undefined;
/** Every body the Hub sent, to prove no Light's id or key is ever among them. */
let answers: string[];
/** Every line the Hub logged, likewise. */
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-lights-test-"));
  databaseFile = join(dir, "media-centre.sqlite");
  database = openDatabase(databaseFile);
  bulb = await startFakeLeproLight({ host: BULB, kind: "colour" });
  plug = await startFakeLeproLight({
    host: PLUG,
    port: bulb.port,
    discoveryPort: bulb.discoveryPort,
    httpPort: bulb.httpPort,
    kind: "plug",
  });

  answers = [];
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const text = (arg: unknown): string =>
        arg instanceof Error ? `${String(arg.stack)} ${String(arg.cause)}` : String(arg);
      logged.push(args.map(text).join(" "));
    });
  }

  const drivers = {
    tv: samsungTvDriver(),
    // From the environment, logging to the console, as the Hub runs it: the bulb's and the plug's own
    // addresses are where a broadcast would reach every Light.
    light: leproDriverFromEnvironment({
      LEPRO_PORT: String(bulb.port),
      LEPRO_DISCOVERY_PORT: String(bulb.discoveryPort),
      LEPRO_SEARCH_TARGETS: [BULB, PLUG].map((host) => `${host}:${String(bulb.discoveryPort)}`).join(","),
    }),
  };
  hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database, drivers });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((done) => hub.close(done));
  database.close();
  await Promise.all([bulb.stop(), plug.stop(), hidden?.stop()]);
  hidden = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A white bulb on the same port as the others, which answers no search the Hub sends. */
const startHidden = async (options: FakeLeproLightOptions = {}): Promise<FakeLeproLight> => {
  hidden = await startFakeLeproLight({ host: HIDDEN, port: bulb.port, kind: "white", ...options });
  return hidden;
};

const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  answers.push(text);
  return new Response(response.status === 204 ? null : text, { status: response.status, headers: response.headers });
};

const addRoom = async (name: string): Promise<Room> =>
  (await (await send("POST", ROOMS_PATH, { name })).json()) as Room;

const add = (address: string, fields: Record<string, unknown> = {}): Promise<Response> =>
  send("POST", APPLIANCES_PATH, { kind: "light", address, roomId: null, ...fields });

/** Adds the fake as one found is added: by its address and its key, the Hub hearing its id. */
const added = async (fake: FakeLeproLight, fields: Record<string, unknown> = {}): Promise<Appliance> => {
  const response = await add(fake.host, { light: { key: fake.key }, ...fields });
  expect(response.status).toBe(201);
  return (await response.json()) as Appliance;
};

const find = async (): Promise<FoundLight[]> =>
  (await (await send("POST", APPLIANCE_SEARCH_PATH, { kind: "light" })).json()) as FoundLight[];

const readState = async (id: number): Promise<LightReading> =>
  (await (await send("GET", applianceStatePath(id))).json()) as LightReading;

const readCapabilities = async (id: number): Promise<LightCapabilitiesReading> =>
  (await (await send("GET", applianceCapabilitiesPath(id))).json()) as LightCapabilitiesReading;

const changeLights = async (body: unknown): Promise<LightsOutcome> => {
  const response = await send("POST", LIGHTS_PATH, body);
  expect(response.status).toBe(200);
  return (await response.json()) as LightsOutcome;
};

const errorOf = async (response: Response): Promise<string> => ((await response.json()) as HubError).error;

describe("Find Lights", () => {
  it("lists every Light that answers on the Hub's subnet, saying which is already added, and as what", async () => {
    const found = await find();
    expect(found.toSorted((a, b) => a.address.localeCompare(b.address))).toEqual([
      { kind: "light", address: BULB, name: "Lepro Light", model: "Lepro, protocol v3.3", applianceId: null },
      { kind: "light", address: PLUG, name: "Lepro Light", model: "Lepro, protocol v3.3", applianceId: null },
    ]);

    const light = await added(bulb);
    const again = await find();
    expect(again.find(({ address }) => address === BULB)?.applianceId).toBe(light.id);
    expect(again.find(({ address }) => address === PLUG)?.applianceId).toBeNull();
    expect(logged).toContain("Searched the network for Lights, and found 2");
  });
});

describe("Adding a Light", () => {
  it("adds one found by its address and key, named and in a Room as any Appliance, and refuses it twice, or a name taken in its Room", async () => {
    const living = await addRoom("Living room");
    const light = await added(bulb, { name: "Lamp", roomId: living.id });
    expect(light).toEqual({
      id: light.id,
      kind: "light",
      name: "Lamp",
      roomId: living.id,
      address: BULB,
      model: "Lepro, protocol v3.3",
      macAddress: "",
      pairing: "paired",
    });
    expect(logged).toContain(`Added Living room · Lamp, a Light at ${BULB} (Lepro, protocol v3.3)`);

    const twice = await add(BULB, { light: { key: bulb.key } });
    expect(twice.status).toBe(409);
    expect(await errorOf(twice)).toBe("That Light is already added, as Living room · Lamp.");

    const taken = await add(PLUG, { name: "lamp", roomId: living.id, light: { key: plug.key } });
    expect(taken.status).toBe(409);
    expect(await errorOf(taken)).toBe('There is already a Light called "Lamp" in Living room.');

    // A plug is a Light too, beside it, and another Room's Lamp is another Light.
    const plugged = await added(plug, { name: "Plug", roomId: living.id });
    const office = await addRoom("Office");
    expect((await send("PATCH", appliancePath(plugged.id), { name: "Lamp", roomId: office.id })).status).toBe(200);
    const listed = (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];
    expect(listed.map(({ name, roomId }) => [name, roomId])).toEqual([
      ["Lamp", living.id],
      ["Lamp", office.id],
    ]);
  });

  it("names a Light added with no name as its Driver does, as it gives none of its own", async () => {
    expect(await added(bulb)).toMatchObject({ name: "Lepro Light" });
  });

  // A search for it listens as long as the Driver does, as on a real network.
  it(
    "adds one it can't find by its address, its id and its key, and refuses it by its address alone",
    { timeout: 15_000 },
    async () => {
      const white = await startHidden();
      const alone = await add(HIDDEN, { light: { key: white.key } });
      expect(alone.status).toBe(502);
      expect(await errorOf(alone)).toMatch(/^No Light answered at 127\.0\.0\.10\./);

      const light = await added(white, { light: { id: white.id, key: white.key }, name: "Hall" });
      expect(light).toMatchObject({ kind: "light", name: "Hall", address: HIDDEN, model: "Lepro, protocol v3.3" });
      expect(await readCapabilities(light.id)).toEqual({
        known: true,
        capabilities: { onOff: true, brightness: true, colourTemperature: { min: 2_700, max: 6_500 }, colour: false },
      });

      // Found or given, it is the same Light.
      const twice = await add(HIDDEN, { light: { id: white.id, key: white.key } });
      expect(twice.status).toBe(409);
    },
  );

  it("refuses a key the Light doesn't answer to, keeping nothing, and one with no key, or a key that can't be one", async () => {
    const wrong = await add(BULB, { light: { key: "0123456789abcdef" } });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe(
      "The Light didn't answer to that device id and local key. Check each, as they were read from the Light.",
    );
    const none = await add(BULB);
    expect(none.status).toBe(400);
    expect(await errorOf(none)).toBe("Give the Light's local key, which lets the Hub in to it.");
    const short = await add(BULB, { light: { key: "short" } });
    expect(short.status).toBe(400);
    expect(await errorOf(short)).toBe(
      "That isn't a Lepro Light's device id and local key. Check each, as they were read from the Light.",
    );
    const empty = await add(BULB, { light: { key: "" } });
    expect(empty.status).toBe(400);
    expect(database.prepare("SELECT * FROM appliance").all()).toEqual([]);
  });

  it("refuses an address with no Light at it, and an address that isn't one", async () => {
    const nobody = await add("127.0.0.12", { light: { id: "bf0123456789abcdef01", key: "0123456789abcdef" } });
    expect(nobody.status).toBe(502);
    expect(await errorOf(nobody)).toMatch(/^No Light answered at 127\.0\.0\.12\./);
    const notAnAddress = await add("lamp", { light: { key: bulb.key } });
    expect(notAnAddress.status).toBe(400);
    expect(await errorOf(notAnAddress)).toBe("Give the Light's IP address, e.g. 192.168.1.20.");
  });
});

describe("A Light's id and key", () => {
  it("are kept in the SQLite file, and forgotten as it is removed", async () => {
    const light = await added(bulb);
    const kept = database.prepare("SELECT credentials FROM appliance_credentials").all() as { credentials: string }[];
    expect(kept).toHaveLength(1);
    expect(Object.keys(JSON.parse(kept[0]?.credentials ?? "{}") as object).sort()).toEqual(["id", "key"]);
    expect((await readFile(databaseFile)).includes(Buffer.from(bulb.key, "utf8"))).toBe(true);

    expect((await send("DELETE", appliancePath(light.id))).status).toBe(204);
    expect(database.prepare("SELECT credentials FROM appliance_credentials").all()).toEqual([]);
    expect((await readFile(databaseFile)).includes(Buffer.from(bulb.key, "utf8"))).toBe(false);
  });

  it("are never sent in an answer, nor logged", async () => {
    const white = await startHidden();
    await find();
    await add(BULB, { light: { key: "0123456789abcdef" } });
    await add(HIDDEN, { light: { id: white.id, key: "0123456789abcdef" } });
    const light = await added(bulb);
    const other = await added(white, { name: "Hall", light: { id: white.id, key: white.key } });
    await find();
    await readCapabilities(light.id);
    await readState(light.id);
    await send("PATCH", applianceStatePath(light.id), { on: false });
    await send("POST", applianceConnectionPath(other.id));
    await changeLights({ change: { on: false } });
    await white.stop();
    await changeLights({ change: { brightness: 40 } });
    await send("GET", APPLIANCES_PATH);
    await send("DELETE", appliancePath(light.id));

    expect(answers.length).toBeGreaterThan(10);
    expect(logged.length).toBeGreaterThan(3);
    for (const secret of [bulb.id, bulb.key, white.id, white.key, plug.id, plug.key]) {
      for (const answer of answers) expect(answer).not.toContain(secret);
      for (const line of logged) expect(line).not.toContain(secret);
    }
  });
});

describe("A Light's capabilities", () => {
  it("are the controls it reports it has, read through its Driver, so that a plug has on/off alone (FR-52)", async () => {
    const colour = await added(bulb);
    const plugged = await added(plug, { name: "Plug" });
    expect(await readCapabilities(colour.id)).toEqual({
      known: true,
      capabilities: { onOff: true, brightness: true, colourTemperature: { min: 2_700, max: 6_500 }, colour: true },
    });
    expect(await readCapabilities(plugged.id)).toEqual({
      known: true,
      capabilities: { onOff: true, brightness: false, colourTemperature: null, colour: false },
    });
  });

  it("say when the Light can't be reached (FR-57b)", async () => {
    const light = await added(bulb);
    await bulb.stop();
    expect(await readCapabilities(light.id)).toEqual({ known: false, why: "unreachable" });
  });
});

describe("A Light's state", () => {
  it("is read, and each control reaches the Light (FR-52)", async () => {
    const light = await added(bulb);
    expect(await readState(light.id)).toEqual({
      known: true,
      state: { on: true, brightness: 100, colourTemperature: 4_600, colour: null },
    });

    const change = async (body: unknown): Promise<LightReading> => {
      const response = await send("PATCH", applianceStatePath(light.id), body);
      expect(response.status).toBe(200);
      return (await response.json()) as LightReading;
    };
    expect(await change({ on: false })).toMatchObject({ known: true, state: { on: false } });
    expect(bulb.light().on).toBe(false);
    expect(await change({ on: true, brightness: 30 })).toMatchObject({
      known: true,
      state: { on: true, brightness: 30 },
    });
    expect(bulb.light().brightness).toBe(30);
    expect(await change({ colourTemperature: 2_700 })).toMatchObject({ state: { colourTemperature: 2_700 } });
    expect(bulb.light().colourTemperature).toBe(2_700);
    expect(await change({ colour: { hue: 240, saturation: 100 } })).toMatchObject({
      state: { colour: { hue: 240, saturation: 100 }, colourTemperature: null },
    });
    expect(bulb.light()).toMatchObject({ colour: { hue: 240, saturation: 100 }, colourTemperature: null });
  });

  it("refuses a change the Light hasn't the capability for, and one that isn't a change", async () => {
    const plugged = await added(plug);
    const dim = await send("PATCH", applianceStatePath(plugged.id), { brightness: 30 });
    expect(dim.status).toBe(400);
    expect(await errorOf(dim)).toBe("This Light doesn't dim.");
    for (const [body, error] of [
      [{}, "Say what to change."],
      [{ on: "yes" }, "Say whether to switch it on, as true or false."],
      [{ brightness: 30.5 }, "Give the brightness in whole percent."],
      [{ colour: { hue: 10 } }, "Give the colour as a hue and a saturation, each a whole number."],
      [{ volume: 3 }, "A Light has nothing called volume to change."],
    ] as const) {
      const refused = await send("PATCH", applianceStatePath(plugged.id), body);
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toBe(error);
    }
    expect(plug.commands.filter(({ command }) => command === "control")).toEqual([]);
  });

  it("says when the Light can't be reached, and refuses a change to it (FR-57b)", async () => {
    const light = await added(bulb);
    await bulb.stop();
    expect(await readState(light.id)).toEqual({ known: false, why: "unreachable" });
    expect((await send("PATCH", applianceStatePath(light.id), { on: false })).status).toBe(502);
  });

  it("says when the Light no longer answers to its key, marking it, and follows it answering again", async () => {
    const white = await startHidden();
    const light = await added(white, { light: { id: white.id, key: white.key } });
    await white.stop();
    // Paired again in LampUX, which issues it a new key.
    await startHidden({ id: white.id, key: "fedcba9876543210" });
    expect(await readState(light.id)).toEqual({ known: false, why: "key-refused" });
    const [marked] = (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];
    expect(marked).toMatchObject({ id: light.id, pairing: "pair-again" });
    expect(await readCapabilities(light.id)).toEqual({ known: false, why: "key-refused" });
    expect(logged).toContain("Lepro Light refused the Hub's key, so it needs giving again");
  });

  it("is refused for what only a TV or an Air Conditioner has", async () => {
    const light = await added(bulb);
    expect((await send("POST", `${appliancePath(light.id)}/keys`, { key: "ok" })).status).toBe(400);
  });
});

describe("Room-wide control and All off (FR-53)", () => {
  /** The bulb and the plug in the Living room, and a white bulb in the Office. */
  const home = async () => {
    const white = await startHidden();
    const living = await addRoom("Living room");
    const office = await addRoom("Office");
    const lamp = await added(bulb, { name: "Lamp", roomId: living.id });
    const socket = await added(plug, { name: "Plug", roomId: living.id });
    const desk = await added(white, { name: "Desk", roomId: office.id, light: { id: white.id, key: white.key } });
    return { white, living, office, lamp, socket, desk };
  };

  it("switches every Light in the Room off and on, and none outside it, in one request", async () => {
    const { white, living, lamp, socket } = await home();
    const off = await changeLights({ roomId: living.id, change: { on: false } });
    expect(off.unreached).toEqual([]);
    expect(off.lights.map(({ id, reading }) => [id, reading.known && reading.state.on])).toEqual([
      [lamp.id, false],
      [socket.id, false],
    ]);
    expect(bulb.light().on).toBe(false);
    expect(plug.light().on).toBe(false);
    expect(white.light().on).toBe(true);

    await changeLights({ roomId: living.id, change: { on: true } });
    expect(bulb.light().on).toBe(true);
    expect(plug.light().on).toBe(true);
  });

  it("sets the brightness of every Light in the Room that dims, switching it on, and leaves a plug as it is", async () => {
    const { white, living, lamp } = await home();
    await changeLights({ roomId: living.id, change: { on: false } });
    const dimmed = await changeLights({ roomId: living.id, change: { brightness: 30 } });
    expect(dimmed).toMatchObject({
      lights: [{ id: lamp.id, reading: { known: true, state: { on: true, brightness: 30 } } }],
      unreached: [],
    });
    expect(dimmed.lights).toHaveLength(1);
    expect(bulb.light().brightness).toBe(30);
    expect(plug.light().on).toBe(false);
    expect(white.light().brightness).toBe(100);
  });

  it("All off switches every Light in the home off", async () => {
    const { white, lamp, socket, desk } = await home();
    const off = await changeLights({ change: { on: false } });
    expect(off.lights.map(({ id }) => id)).toEqual([lamp.id, socket.id, desk.id]);
    expect(off.unreached).toEqual([]);
    expect([bulb.light().on, plug.light().on, white.light().on]).toEqual([false, false, false]);
  });

  it("reaches every Light that answers, and says which didn't (FR-57b)", async () => {
    const { white, living, lamp, socket, desk } = await home();
    await plug.stop();
    const room = await changeLights({ roomId: living.id, change: { on: false } });
    expect(room.unreached).toEqual([socket.id]);
    expect(room.lights).toMatchObject([
      { id: lamp.id, reading: { known: true, state: { on: false } } },
      { id: socket.id, reading: { known: false, why: "unreachable" } },
    ]);
    expect(bulb.light().on).toBe(false);

    await changeLights({ change: { on: true } });
    const allOff = await changeLights({ change: { on: false } });
    expect(allOff.unreached).toEqual([socket.id]);
    expect(allOff.lights.filter(({ reading }) => reading.known).map(({ id }) => id)).toEqual([lamp.id, desk.id]);
    expect([bulb.light().on, white.light().on]).toEqual([false, false]);
  });

  it("refuses a Room that no longer exists, and what isn't a change", async () => {
    const { office } = await home();
    expect((await send("DELETE", roomPath(office.id))).status).toBe(204);
    const stale = await send("POST", LIGHTS_PATH, { roomId: office.id, change: { on: false } });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toBe("That Room no longer exists.");
    for (const [body, error] of [
      [{ change: {} }, "Say whether to switch the Lights on or off, or how bright to make them."],
      [
        { change: { colour: { hue: 1, saturation: 1 } } },
        "Say whether to switch the Lights on or off, or how bright to make them.",
      ],
      [{ change: { brightness: 0 } }, "Give the brightness in whole percent, from 1% to 100%."],
      [{ change: { on: 1 } }, "Say whether to switch them on, as true or false."],
      [{ roomId: "office", change: { on: true } }, "Give the Room as its id, or leave it out for every Light."],
    ] as const) {
      const refused = await send("POST", LIGHTS_PATH, body);
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toBe(error);
    }
    expect((await send("GET", LIGHTS_PATH)).status).toBe(405);
  });
});

describe("Light Scenes (FR-56)", () => {
  /** The bulb and the plug in the Living room, and a white bulb in the Office. */
  const home = async () => {
    const white = await startHidden();
    const living = await addRoom("Living room");
    const office = await addRoom("Office");
    const lamp = await added(bulb, { name: "Lamp", roomId: living.id });
    const socket = await added(plug, { name: "Plug", roomId: living.id });
    const desk = await added(white, { name: "Desk", roomId: office.id, light: { id: white.id, key: white.key } });
    return { white, living, office, lamp, socket, desk };
  };

  const save = async (roomId: number, name: string): Promise<LightSceneSaved> => {
    const response = await send("POST", LIGHT_SCENES_PATH, { roomId, name });
    expect(response.status).toBe(201);
    return (await response.json()) as LightSceneSaved;
  };

  const recall = async (id: number): Promise<LightsOutcome> => {
    const response = await send("POST", lightSceneRecallPath(id));
    expect(response.status).toBe(200);
    return (await response.json()) as LightsOutcome;
  };

  const list = async (): Promise<LightScene[]> => (await (await send("GET", LIGHT_SCENES_PATH)).json()) as LightScene[];

  const BLUE = { hue: 240, saturation: 100 };

  it("captures each Light in the Room as it is, and recalling sets each back to it, and no Light outside the Room", async () => {
    const { white, living, lamp, socket } = await home();
    bulb.setLight({ on: true, brightness: 30, colour: BLUE });
    plug.setLight({ on: false });

    const { lightScene, unreached } = await save(living.id, "Film");
    expect(unreached).toEqual([]);
    expect(lightScene).toEqual({
      id: expect.any(Number) as number,
      roomId: living.id,
      name: "Film",
      lights: [
        { id: lamp.id, state: { on: true, brightness: 30, colourTemperature: null, colour: BLUE } },
        { id: socket.id, state: { on: false, brightness: null, colourTemperature: null, colour: null } },
      ],
    });
    expect(await list()).toEqual([lightScene]);

    // Changed since, as LampUX or the Remote would.
    bulb.setLight({ on: false, brightness: 100, colourTemperature: 6_000 });
    plug.setLight({ on: true });
    white.setLight({ on: true, brightness: 70 });
    const desk = white.light();

    const recalled = await recall(lightScene.id);
    expect(recalled.unreached).toEqual([]);
    expect(recalled.lights).toEqual([
      {
        id: lamp.id,
        reading: { known: true, state: { on: true, brightness: 30, colourTemperature: null, colour: BLUE } },
      },
      {
        id: socket.id,
        reading: { known: true, state: { on: false, brightness: null, colourTemperature: null, colour: null } },
      },
    ]);
    expect(bulb.light()).toEqual({ on: true, brightness: 30, colourTemperature: null, colour: BLUE });
    expect(plug.light().on).toBe(false);
    expect(white.light()).toEqual(desk);
  });

  it("sets a white Light back to its colour temperature and brightness, and a Light saved off back off at them", async () => {
    const { white, office, desk } = await home();
    white.setLight({ on: false, brightness: 20, colourTemperature: 3_000 });
    const saved = white.light();
    const { lightScene } = await save(office.id, "Night");
    expect(lightScene.lights).toEqual([{ id: desk.id, state: saved }]);

    white.setLight({ on: true, brightness: 90, colourTemperature: 6_000 });
    await recall(lightScene.id);
    expect(white.light()).toEqual(saved);
    expect(white.light().on).toBe(false);
  });

  it("leaves a Light added to the Room after saving as it is, and skips one moved out of it or removed", async () => {
    const { white, living, office, lamp, socket, desk } = await home();
    bulb.setLight({ on: true, brightness: 40, colourTemperature: 3_000 });
    plug.setLight({ on: true });
    const { lightScene } = await save(living.id, "Evening");

    // The Desk joins the Living room, and the Plug leaves it for the Office.
    expect((await send("PATCH", appliancePath(desk.id), { roomId: living.id })).status).toBe(200);
    expect((await send("PATCH", appliancePath(socket.id), { roomId: office.id })).status).toBe(200);
    bulb.setLight({ on: false });
    plug.setLight({ on: false });
    white.setLight({ on: false, brightness: 10 });

    const recalled = await recall(lightScene.id);
    expect(recalled).toEqual({
      lights: [{ id: lamp.id, reading: { known: true, state: bulb.light() } }],
      unreached: [],
    });
    expect(bulb.light()).toMatchObject({ on: true, brightness: 40, colourTemperature: 3_000 });
    expect(plug.light().on).toBe(false);
    expect(white.light()).toMatchObject({ on: false, brightness: 10 });

    // Back in the Room, it is recalled again, as it is still in the Light Scene.
    expect((await send("PATCH", appliancePath(socket.id), { roomId: living.id })).status).toBe(200);
    await recall(lightScene.id);
    expect(plug.light().on).toBe(true);

    // Removed, it is no longer in it.
    expect((await send("DELETE", appliancePath(socket.id))).status).toBe(204);
    expect((await list())[0]?.lights.map(({ id }) => id)).toEqual([lamp.id]);
    plug.setLight({ on: false });
    expect((await recall(lightScene.id)).lights.map(({ id }) => id)).toEqual([lamp.id]);
    expect(plug.light().on).toBe(false);
  });

  it("saves the Lights that answer, naming those that didn't, and recalls those that answer, naming the rest (FR-57b)", async () => {
    const { living, lamp, socket } = await home();
    const { lightScene: both } = await save(living.id, "Both");
    await plug.stop();

    const { lightScene, unreached } = await save(living.id, "Lamp only");
    expect(unreached).toEqual([socket.id]);
    expect(lightScene.lights.map(({ id }) => id)).toEqual([lamp.id]);

    bulb.setLight({ on: false });
    const recalled = await recall(both.id);
    expect(recalled.unreached).toEqual([socket.id]);
    expect(recalled.lights).toMatchObject([
      { id: lamp.id, reading: { known: true, state: { on: true } } },
      { id: socket.id, reading: { known: false, why: "unreachable" } },
    ]);
    expect(bulb.light().on).toBe(true);

    await bulb.stop();
    const none = await send("POST", LIGHT_SCENES_PATH, { roomId: living.id, name: "Nothing" });
    expect(none.status).toBe(502);
    expect(await errorOf(none)).toBe(
      "None of the Room's Lights answered, so there is nothing to save. Check they are switched on, then try again.",
    );
    expect((await list()).map(({ name }) => name)).toEqual(["Both", "Lamp only"]);
  });

  it("are renamed and deleted, each name unique in its Room ignoring case, and listed by Room in Room order", async () => {
    const { living, office } = await home();
    const { lightScene: film } = await save(living.id, "Film");
    const { lightScene: work } = await save(office.id, "Work");
    const { lightScene: officeFilm } = await save(office.id, "  film  ");
    expect(officeFilm.name).toBe("film");
    expect((await list()).map(({ name }) => name)).toEqual(["Film", "Work", "film"]);
    expect((await send("PUT", `${ROOMS_PATH}/order`, { roomIds: [office.id, living.id] })).status).toBe(200);
    expect((await list()).map(({ name }) => name)).toEqual(["Work", "film", "Film"]);

    const taken = await send("POST", LIGHT_SCENES_PATH, { roomId: living.id, name: "FILM" });
    expect(taken.status).toBe(409);
    expect(await errorOf(taken)).toBe('There is already a Light Scene called "Film" in Living room.');

    const renamed = await send("PATCH", lightScenePath(film.id), { name: "Cinema" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ ...film, name: "Cinema" });
    // Its own name, in another case, is no clash.
    expect((await send("PATCH", lightScenePath(film.id), { name: "CINEMA" })).status).toBe(200);
    const clash = await send("PATCH", lightScenePath(work.id), { name: "Film" });
    expect(clash.status).toBe(409);
    expect(await errorOf(clash)).toBe('There is already a Light Scene called "film" in Office.');

    expect((await send("DELETE", lightScenePath(work.id))).status).toBe(204);
    expect((await list()).map(({ name }) => name)).toEqual(["film", "CINEMA"]);
    for (const [method, path] of [
      ["DELETE", lightScenePath(work.id)],
      ["PATCH", lightScenePath(work.id)],
      ["POST", lightSceneRecallPath(work.id)],
      ["POST", `${LIGHT_SCENES_PATH}/nothing`],
    ] as const) {
      const gone = await send(method, path, method === "PATCH" ? { name: "Again" } : undefined);
      expect(gone.status).toBe(404);
      expect(await errorOf(gone)).toBe("That Light Scene has been deleted.");
    }

    // A Room's Light Scenes go with it.
    expect((await send("DELETE", roomPath(office.id))).status).toBe(204);
    expect((await list()).map(({ name }) => name)).toEqual(["CINEMA"]);
  });

  it("refuses a name that isn't one, a Room that no longer exists or has no Lights, and what isn't a request", async () => {
    const { office } = await home();
    const empty = await addRoom("Hall");
    for (const [body, status, error] of [
      [{ roomId: office.id, name: "  " }, 400, "Give the Light Scene a name."],
      [
        { roomId: office.id, name: "x".repeat(41) },
        400,
        "A Light Scene's name can be at most 40 characters; that one has 41.",
      ],
      [{ roomId: office.id }, 400, "Give the Light Scene a name."],
      [{ name: "Film" }, 400, "Give the Room whose Lights to save, as its id."],
      [{ roomId: empty.id, name: "Film" }, 409, "There are no Lights in that Room to save."],
      [{ roomId: 999, name: "Film" }, 409, "That Room no longer exists."],
    ] as const) {
      const refused = await send("POST", LIGHT_SCENES_PATH, body);
      expect(refused.status).toBe(status);
      expect(await errorOf(refused)).toBe(error);
    }
    const { lightScene } = await save(office.id, "Work");
    const blank = await send("PATCH", lightScenePath(lightScene.id), { name: "" });
    expect(blank.status).toBe(400);
    expect(await errorOf(blank)).toBe("Give the Light Scene a name.");
    expect((await send("PUT", LIGHT_SCENES_PATH)).status).toBe(405);
    expect((await send("GET", lightSceneRecallPath(lightScene.id))).status).toBe(405);
    expect(await list()).toEqual([lightScene]);
  });

  it("are kept in the SQLite file, with no Light's id or key", async () => {
    const { living } = await home();
    await save(living.id, "Film");
    const file = await readFile(databaseFile);
    expect(file.includes("Film")).toBe(true);
    for (const answer of answers) {
      for (const secret of [bulb.id, bulb.key, plug.id, plug.key]) expect(answer).not.toContain(secret);
    }
  });
});
