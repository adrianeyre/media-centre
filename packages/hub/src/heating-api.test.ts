import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLIANCES_PATH,
  HEATING_PATH,
  HIVE_PATH,
  HIVE_SIGN_IN_PATH,
  ROOMS_PATH,
  WHOLE_HOME_PATH,
  appliancePath,
  heatingPath,
  roomTargetPath,
  type Appliance,
  type HeatingHome,
  type HeatingOutcome,
  type HubError,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { hiveDriver } from "./drivers/hive/hive-driver.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import { startFakeHiveCloud, type FakeHiveCloud, type FakeHiveProduct } from "./fakes/hive-cloud/fake-hive-cloud.ts";
import { createHub } from "./hub.ts";

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };

/** The Boosts Hive's app offers, in minutes: every quarter of an hour to an hour, then every half hour to six. */
const BOOST_MINUTES = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];

let dir: string;
let database: DatabaseSync;
let hub: Server;
let base: string;
let cloud: FakeHiveCloud;
/** Every body the Hub sent, to prove no token or key is ever among them. */
let answers: string[];

const start = async (products?: readonly FakeHiveProduct[]): Promise<void> => {
  cloud = await startFakeHiveCloud({ ...LOGIN, ...(products === undefined ? {} : { products }) });
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    drivers: {
      tv: samsungTvDriver(),
      heating: hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, timeoutMs: 1_000, log: () => undefined }),
    },
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-heating-test-"));
  database = openDatabase(join(dir, "media-centre.sqlite"));
  answers = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((done) => hub.close(done));
  database.close();
  await cloud.stop();
  await rm(dir, { recursive: true, force: true });
});

const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  answers.push(text);
  return new Response(response.status === 204 ? null : text, { status: response.status, headers: response.headers });
};

const signIn = async (): Promise<void> => {
  expect((await send("POST", HIVE_SIGN_IN_PATH, LOGIN)).status).toBe(200);
  cloud.clear();
};

const home = async (): Promise<HeatingHome> => {
  const response = await send("GET", HEATING_PATH);
  expect(response.status).toBe(200);
  return (await response.json()) as HeatingHome;
};

const appliances = async (): Promise<Appliance[]> => (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];

/** The Hub's Appliance that is the fake's product of this name. */
const applianceNamed = async (name: string): Promise<Appliance> => {
  const found = (await appliances()).find((each) => each.name === name);
  if (found === undefined) throw new Error(`No Appliance is called ${name}`);
  return found;
};

const idOf = (name: string): string => {
  const product = cloud.products().find((each) => each.name === name);
  if (product === undefined) throw new Error(`No product is called ${name}`);
  return product.id;
};

const productNamed = (name: string) => cloud.products().find((each) => each.name === name);

const change = async (path: string, body: unknown): Promise<HeatingOutcome> => {
  const response = await send("POST", path, body);
  expect(response.status).toBe(200);
  return (await response.json()) as HeatingOutcome;
};

const refusal = async (response: Response): Promise<{ status: number; error: string }> => ({
  status: response.status,
  error: ((await response.json()) as HubError).error,
});

/** The changes the fake took, by the name of the product each was to. */
const changesTaken = (): { readonly name: string; readonly change: unknown }[] =>
  cloud.requests
    .filter(({ product, outcome }) => product !== undefined && outcome === "accepted")
    .map(({ product, change: taken }) => ({
      name: cloud.products().find(({ id }) => id === product)?.name ?? "",
      change: taken,
    }));

const addRoom = async (name: string): Promise<Room> =>
  (await (await send("POST", ROOMS_PATH, { name })).json()) as Room;

const moveTo = async (name: string, roomId: number): Promise<void> => {
  const { id } = await applianceNamed(name);
  expect((await send("PATCH", appliancePath(id), { roomId })).status).toBe(200);
};

describe("Reading the Heating tab", () => {
  it("reads nothing of Hive while the Hub isn't signed in", async () => {
    await start();
    expect(await home()).toEqual({ signedIn: false });
    expect(cloud.requests).toEqual([]);
  });

  it("answers every Heating, Radiator Valve and Hot Water with its controls and what Hive reports, in one request to Hive", async () => {
    await start();
    await signIn();
    cloud.setProduct(idOf("Downstairs"), { temperature: 18.5, working: true });

    const read = await home();

    // One read of everything, by whatever path Hive's API has, which only the Driver and the fake know.
    expect(cloud.requests.map(({ request, outcome }) => `${request.split(" ")[0] ?? ""} ${outcome}`)).toEqual([
      "GET accepted",
    ]);
    if (!read.signedIn || read.hive !== "reachable") throw new Error("Hive should be reachable");
    const all = await appliances();
    expect(read.appliances.map(({ appliance }) => appliance)).toEqual(all);
    expect(read.appliances.map(({ id, kind }) => ({ id, kind }))).toEqual(all.map(({ id, kind }) => ({ id, kind })));
    const target = { min: 5, max: 32, step: 0.5 };
    const [downstairs, upstairs, bedroom, study, , hotWater] = read.appliances;
    expect(downstairs).toMatchObject({
      kind: "heating",
      capabilities: { modes: ["schedule", "manual", "off"], target, boostMinutes: BOOST_MINUTES },
      state: { mode: "schedule", target: 20, temperature: 18.5, callingForHeat: true, boost: null, online: true },
    });
    expect(upstairs?.state).toMatchObject({ target: 19, callingForHeat: false });
    expect(bedroom).toMatchObject({
      kind: "radiator-valve",
      capabilities: { target },
      state: { target: 18, lowBattery: false, zone: { id: idOf("Upstairs"), name: "Upstairs" } },
    });
    expect(study?.state).toMatchObject({ lowBattery: true });
    expect(hotWater).toMatchObject({
      kind: "hot-water",
      capabilities: { modes: ["schedule", "on", "off"], boostMinutes: BOOST_MINUTES },
      state: { mode: "schedule", boost: null, on: false, online: true },
    });
  });

  it("reads Hive again each time it is asked, keeping nothing between, and never on its own", async () => {
    await start();
    await signIn();
    await home();
    cloud.setProduct(idOf("Upstairs"), { target: 22.5 });
    const read = await home();
    if (!read.signedIn || read.hive !== "reachable") throw new Error("Hive should be reachable");
    expect(read.appliances.find(({ appliance }) => appliance.name === "Upstairs")?.state).toMatchObject({
      target: 22.5,
    });

    cloud.clear();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cloud.requests).toEqual([]);
  });

  it("says a Radiator Valve Hive reports offline as its state", async () => {
    await start();
    await signIn();
    cloud.setProduct(idOf("Bedroom"), { online: false });
    const read = await home();
    if (!read.signedIn || read.hive !== "reachable") throw new Error("Hive should be reachable");
    expect(read.appliances.filter(({ state }) => !state.online).map(({ appliance }) => appliance.name)).toEqual([
      "Bedroom",
    ]);
  });

  it('says "Can\'t reach Hive" while Hive drops every connection, and reads it again once it is back', async () => {
    await start();
    await signIn();
    cloud.setDown(true);
    expect(await home()).toEqual({ signedIn: true, hive: "unreachable" });
    const { id } = await applianceNamed("Downstairs");
    expect(await refusal(await send("POST", heatingPath(id), { target: 21 }))).toEqual({
      status: 502,
      error: "Can't reach Hive. Check that the Hub is connected to the internet.",
    });
    expect((await send("POST", WHOLE_HOME_PATH, { target: 21 })).status).toBe(502);

    cloud.setDown(false);
    expect(await home()).toMatchObject({ signedIn: true, hive: "reachable" });
  });

  it("says Hive no longer accepts the Hub's tokens, for Settings to sign in again", async () => {
    await start();
    await signIn();
    cloud.revoke();
    expect(await home()).toEqual({ signedIn: true, hive: "tokens-refused" });
    const { id } = await applianceNamed("Downstairs");
    expect(await refusal(await send("POST", heatingPath(id), { target: 21 }))).toEqual({
      status: 502,
      error: "Hive no longer accepts the Hub's sign-in. Sign in to Hive again in Settings.",
    });
  });

  it("never answers with a token or a key", async () => {
    await start();
    await signIn();
    await home();
    const { id } = await applianceNamed("Bedroom");
    await change(heatingPath(id), { boost: { target: 22, minutes: 60 } });
    const credentials = (database.prepare("SELECT credentials FROM hive_account").get() as { credentials: string })
      .credentials;
    const secrets = Object.values(JSON.parse(credentials) as Record<string, unknown>).flatMap((value): unknown[] =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
          ? Object.values(value as Record<string, unknown>)
          : [],
    );
    expect(secrets.length).toBeGreaterThan(3);
    for (const secret of secrets) for (const answer of answers) expect(answer).not.toContain(String(secret));
  });
});

describe("Changing a Heating, a Radiator Valve or the Hot Water", () => {
  it.each(["Downstairs", "Bedroom"])(
    "sets %s's target, mode and Boost, and cancels the Boost, answering with what Hive then reports",
    async (name) => {
      await start();
      await signIn();
      const { id } = await applianceNamed(name);

      expect(await change(heatingPath(id), { target: 21.5 })).toEqual({
        appliances: [
          { kind: expect.any(String) as unknown, id, state: expect.objectContaining({ target: 21.5 }) as unknown },
        ],
        refused: [],
      });
      expect((await change(heatingPath(id), { mode: "manual" })).appliances[0]?.state).toMatchObject({
        mode: "manual",
      });
      expect((await change(heatingPath(id), { boost: { target: 23, minutes: 90 } })).appliances[0]?.state).toEqual(
        expect.objectContaining({ target: 23, boost: { target: 23, minutesLeft: 90 } }),
      );
      expect(productNamed(name)).toMatchObject({ mode: "boost", boost: 90, target: 23 });
      expect((await change(heatingPath(id), { boost: null })).appliances[0]?.state).toMatchObject({
        mode: "manual",
        target: 21.5,
        boost: null,
      });
      expect((await change(heatingPath(id), { mode: "off" })).appliances[0]?.state).toMatchObject({ mode: "off" });
      expect(productNamed(name)).toMatchObject({ mode: "off", boost: null });
    },
  );

  it("boosts every Radiator Valve in a Heating's zone with it, and none outside it, and cancels their Boosts with it", async () => {
    await start();
    await signIn();
    const upstairs = await applianceNamed("Upstairs");
    const bedroom = await applianceNamed("Bedroom");
    const study = await applianceNamed("Study");

    const boosted = await change(heatingPath(upstairs.id), { boost: { target: 23, minutes: 90 } });

    expect(boosted.refused).toEqual([]);
    expect(boosted.appliances.map(({ id }) => id)).toEqual([upstairs.id, bedroom.id, study.id]);
    expect(cloud.products().map(({ name, mode }) => [name, mode])).toEqual([
      ["Downstairs", "schedule"],
      ["Upstairs", "boost"],
      ["Bedroom", "boost"],
      ["Study", "boost"],
      // In Downstairs' zone.
      ["Living Room", "schedule"],
      ["Hot Water", "schedule"],
    ]);
    expect(productNamed("Bedroom")).toMatchObject({ boost: 90, target: 23 });

    // A target or a mode is the zone's alone.
    await change(heatingPath(upstairs.id), { target: 18 });
    expect(productNamed("Study")).toMatchObject({ mode: "boost", target: 23 });

    await change(heatingPath(upstairs.id), { boost: null });
    expect(
      cloud
        .products()
        .map(({ name, mode }) => [name, mode])
        .slice(1, 4),
    ).toEqual([
      ["Upstairs", "schedule"],
      ["Bedroom", "schedule"],
      ["Study", "schedule"],
    ]);
  });

  it("names a Radiator Valve in the zone that didn't take its Boost, and boosts the rest", async () => {
    await start();
    await signIn();
    const upstairs = await applianceNamed("Upstairs");
    const study = await applianceNamed("Study");
    cloud.setProduct(idOf("Study"), { refusesChanges: true });

    const boosted = await change(heatingPath(upstairs.id), { boost: { target: 23, minutes: 90 } });

    expect(boosted.refused).toEqual([study.id]);
    expect(productNamed("Upstairs")).toMatchObject({ mode: "boost" });
    expect(productNamed("Bedroom")).toMatchObject({ mode: "boost" });
    expect(productNamed("Study")).toMatchObject({ mode: "schedule" });
  });

  it("sets the Hot Water's mode, and boosts it by duration, and cancels the Boost", async () => {
    await start();
    await signIn();
    const { id } = await applianceNamed("Hot Water");

    expect((await change(heatingPath(id), { mode: "on" })).appliances[0]?.state).toMatchObject({ mode: "on" });
    expect((await change(heatingPath(id), { boost: { minutes: 30 } })).appliances[0]?.state).toMatchObject({
      mode: "on",
      boost: { minutesLeft: 30 },
    });
    expect(productNamed("Hot Water")).toMatchObject({ mode: "boost", boost: 30 });
    expect((await change(heatingPath(id), { boost: null })).appliances[0]?.state).toMatchObject({ boost: null });
    expect(productNamed("Hot Water")).toMatchObject({ mode: "on", boost: null });
  });

  it("shows a change Hive refuses as refused, with what Hive reports of it (FR-68)", async () => {
    await start();
    await signIn();
    const { id } = await applianceNamed("Study");
    cloud.setProduct(idOf("Study"), { refusesChanges: true });

    const outcome = await change(heatingPath(id), { target: 25 });

    expect(outcome.refused).toEqual([id]);
    expect(outcome.appliances).toEqual([
      { kind: "radiator-valve", id, state: expect.objectContaining({ target: 20, online: true }) as unknown },
    ]);
    expect(productNamed("Study")).toMatchObject({ target: 20 });
  });

  it("refuses a change Hive can't take before anything is sent, and one to an Appliance that isn't Hive's", async () => {
    await start();
    await signIn();
    const { id: downstairs } = await applianceNamed("Downstairs");
    const { id: hotWater } = await applianceNamed("Hot Water");
    cloud.clear();

    expect(await refusal(await send("POST", heatingPath(downstairs), { target: 40 }))).toEqual({
      status: 400,
      error: "Downstairs's target is from 5° to 32°.",
    });
    expect((await send("POST", heatingPath(downstairs), { boost: { target: 22, minutes: 20 } })).status).toBe(400);
    expect((await send("POST", heatingPath(hotWater), { target: 50 })).status).toBe(400);
    expect((await send("POST", heatingPath(downstairs), [{ target: 21 }])).status).toBe(400);
    expect((await send("POST", heatingPath(downstairs), "warmer")).status).toBe(400);
    expect(cloud.requests.some(({ request }) => request.startsWith("POST"))).toBe(false);

    expect((await send("POST", heatingPath(999), { target: 21 })).status).toBe(404);
    expect((await send("GET", heatingPath(downstairs))).status).toBe(405);
    expect((await send("POST", `${HEATING_PATH}/somewhere`, {})).status).toBe(404);
  });

  it("refuses every change while the Hub isn't signed in", async () => {
    await start();
    await signIn();
    const { id } = await applianceNamed("Downstairs");
    expect((await send("DELETE", HIVE_PATH)).status).toBe(204);
    expect(await home()).toEqual({ signedIn: false });
    expect((await send("POST", WHOLE_HOME_PATH, { target: 21 })).status).toBe(409);
    expect((await send("POST", heatingPath(id), { target: 21 })).status).toBe(404);
  });
});

describe("The Whole home", () => {
  it("sets every Heating's target and mode, and no Radiator Valve's nor the Hot Water's", async () => {
    await start();
    await signIn();
    const downstairs = await applianceNamed("Downstairs");
    const upstairs = await applianceNamed("Upstairs");

    const outcome = await change(WHOLE_HOME_PATH, { target: 21 });

    expect(outcome.refused).toEqual([]);
    expect(
      outcome.appliances.map(({ id, state }) => ({ id, state: { target: (state as { target: number }).target } })),
    ).toEqual([
      { id: downstairs.id, state: { target: 21 } },
      { id: upstairs.id, state: { target: 21 } },
    ]);
    expect(changesTaken()).toEqual([
      { name: "Downstairs", change: { target: 21 } },
      { name: "Upstairs", change: { target: 21 } },
    ]);

    await change(WHOLE_HOME_PATH, { mode: "off" });
    expect(cloud.products().map(({ name, mode }) => [name, mode])).toEqual([
      ["Downstairs", "off"],
      ["Upstairs", "off"],
      ["Bedroom", "schedule"],
      ["Study", "schedule"],
      ["Living Room", "schedule"],
      ["Hot Water", "schedule"],
    ]);
  });

  it("boosts every Heating and every Radiator Valve, never the Hot Water, and cancels each one's Boost", async () => {
    await start();
    await signIn();

    const boosted = await change(WHOLE_HOME_PATH, { boost: { target: 22, minutes: 60 } });

    expect(boosted.refused).toEqual([]);
    expect(boosted.appliances).toHaveLength(5);
    expect(cloud.products().map(({ name, mode, boost, target }) => [name, mode, boost, target])).toEqual([
      ["Downstairs", "boost", 60, 22],
      ["Upstairs", "boost", 60, 22],
      ["Bedroom", "boost", 60, 22],
      ["Study", "boost", 60, 22],
      ["Living Room", "boost", 60, 22],
      ["Hot Water", "schedule", null, null],
    ]);

    await change(WHOLE_HOME_PATH, { boost: null });
    expect(cloud.products().map(({ name, mode, boost }) => [name, mode, boost])).toEqual([
      ["Downstairs", "schedule", null],
      ["Upstairs", "schedule", null],
      ["Bedroom", "schedule", null],
      ["Study", "schedule", null],
      ["Living Room", "schedule", null],
      ["Hot Water", "schedule", null],
    ]);
  });

  it("names a zone Hive refuses the change for, with what Hive reports of it, and makes it of the rest", async () => {
    await start();
    await signIn();
    const upstairs = await applianceNamed("Upstairs");
    cloud.setProduct(idOf("Upstairs"), { refusesChanges: true });

    const outcome = await change(WHOLE_HOME_PATH, { target: 23 });

    expect(outcome.refused).toEqual([upstairs.id]);
    expect(outcome.appliances.map(({ state }) => (state as { target: number }).target)).toEqual([23, 19]);
    expect(
      cloud
        .products()
        .slice(0, 2)
        .map(({ target }) => target),
    ).toEqual([23, 19]);
  });
});

describe("A Room-wide target", () => {
  it("sets every Radiator Valve in the Room, and none outside it", async () => {
    await start();
    await signIn();
    const upstairsRoom = await addRoom("Upstairs landing");
    const lounge = await addRoom("Lounge");
    await moveTo("Bedroom", upstairsRoom.id);
    await moveTo("Study", upstairsRoom.id);
    await moveTo("Living Room", lounge.id);

    const outcome = await change(roomTargetPath(upstairsRoom.id), { target: 22.5 });

    expect(outcome.refused).toEqual([]);
    expect(changesTaken()).toEqual([
      { name: "Bedroom", change: { target: 22.5 } },
      { name: "Study", change: { target: 22.5 } },
    ]);
    expect(cloud.products().map(({ name, target }) => [name, target])).toEqual([
      ["Downstairs", 20],
      ["Upstairs", 19],
      ["Bedroom", 22.5],
      ["Study", 22.5],
      ["Living Room", 21],
      ["Hot Water", null],
    ]);
  });

  it("names a Radiator Valve that didn't take it", async () => {
    await start();
    await signIn();
    const room = await addRoom("Upstairs landing");
    await moveTo("Bedroom", room.id);
    await moveTo("Study", room.id);
    const study = await applianceNamed("Study");
    cloud.setProduct(idOf("Study"), { refusesChanges: true });

    const outcome = await change(roomTargetPath(room.id), { target: 22 });

    expect(outcome.refused).toEqual([study.id]);
    expect(
      cloud
        .products()
        .map(({ target }) => target)
        .slice(2, 4),
    ).toEqual([22, 20]);
  });

  it("refuses a target that isn't one, and a Room that no longer exists", async () => {
    await start();
    await signIn();
    const room = await addRoom("Landing");
    expect((await send("POST", roomTargetPath(room.id), { target: "warm" })).status).toBe(400);
    expect((await send("DELETE", `${ROOMS_PATH}/${String(room.id)}`)).status).toBe(204);
    expect((await send("POST", roomTargetPath(room.id), { target: 21 })).status).toBe(409);
  });
});
