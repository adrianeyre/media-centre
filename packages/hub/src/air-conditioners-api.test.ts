import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
  ROOMS_PATH,
  applianceCapabilitiesPath,
  applianceConnectionPath,
  applianceKeysPath,
  appliancePairingPath,
  appliancePath,
  applianceStatePath,
  roomPath,
  type AirConditionerCapabilitiesReading,
  type AirConditionerReading,
  type Appliance,
  type FoundAirConditioner,
  type HubError,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { mideaDriver } from "./drivers/midea/midea-driver.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import {
  FAKE_AIRCON_KEYS_PATH,
  startFakeMideaAircon,
  type FakeMideaAircon,
} from "./fakes/midea-aircon/fake-midea-aircon.ts";
import { startFakeMideaCloud, type FakeMideaCloud } from "./fakes/midea-cloud/fake-midea-cloud.ts";
import { createHub } from "./hub.ts";

// Two fake Air Conditioners, each at its own address on the same ports, as
// two real units on the home network would be: one on protocol v2, one on v3.
const UNIT_ON_V2 = "127.0.0.5";
const UNIT_ON_V3 = "127.0.0.6";

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };

let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let hub: Server;
let base: string;
let v2: FakeMideaAircon;
let v3: FakeMideaAircon;
let cloud: FakeMideaCloud;
/** Midea Air's cloud, which knows nobody here, so that no test reaches the real one. */
let mideaAir: FakeMideaCloud;
/** Every body the Hub sent, to prove no token, key or login is ever among them. */
let answers: string[];
/** Every line the Hub logged, likewise. */
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-air-conditioners-test-"));
  databaseFile = join(dir, "media-centre.sqlite");
  database = openDatabase(databaseFile);
  v2 = await startFakeMideaAircon({
    host: UNIT_ON_V2,
    version: 2,
    id: 0x0000_0000_1001,
    serialNumber: "000000P0000000Q1F0C9A1B2C3D50000",
  });
  v3 = await startFakeMideaAircon({
    host: UNIT_ON_V3,
    port: v2.port,
    discoveryPort: v2.discoveryPort,
    httpPort: v2.httpPort,
    version: 3,
    id: 0x0000_0000_1002,
    serialNumber: "000000P0000000Q1F0C9A1B2C3D60000",
  });
  cloud = await startFakeMideaCloud({ ...LOGIN, units: [{ id: v3.id, token: v3.token ?? "", key: v3.key ?? "" }] });
  mideaAir = await startFakeMideaCloud({ app: "Midea Air", account: "someone-else@example.com", password: "theirs" });

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
    // Logging to the console, as the Hub runs it.
    "air-conditioner": mideaDriver({
      port: v2.port,
      discoveryPorts: [v2.discoveryPort],
      // Each fake's own address, where a broadcast would reach them all.
      searchTargets: [UNIT_ON_V2, UNIT_ON_V3].map((host) => ({ host, port: v2.discoveryPort })),
      searchWindowMs: 200,
      connectTimeoutMs: 1_000,
      answerTimeoutMs: 1_000,
      cloudUrl: cloud.url,
      mideaAirCloudUrl: mideaAir.url,
      cloudTimeoutMs: 1_000,
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
  await Promise.all([v2.stop(), v3.stop(), cloud.stop(), mideaAir.stop()]);
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

const listAppliances = async (): Promise<Appliance[]> =>
  (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];

const addRoom = async (name: string): Promise<Room> =>
  (await (await send("POST", ROOMS_PATH, { name })).json()) as Room;

const add = (address: string, fields: Record<string, unknown> = {}): Promise<Response> =>
  send("POST", APPLIANCES_PATH, { kind: "air-conditioner", address, roomId: null, ...fields });

const added = async (address: string, fields: Record<string, unknown> = {}): Promise<Appliance> => {
  const response = await add(address, fields);
  expect(response.status).toBe(201);
  return (await response.json()) as Appliance;
};

const readState = async (id: number): Promise<AirConditionerReading> =>
  (await (await send("GET", applianceStatePath(id))).json()) as AirConditionerReading;

const readCapabilities = async (id: number): Promise<AirConditionerCapabilitiesReading> =>
  (await (await send("GET", applianceCapabilitiesPath(id))).json()) as AirConditionerCapabilitiesReading;

/** Gives the v3 fake a new token and key, and the cloud too, as a factory reset and pairing again in Midea's app would. */
const factoryReset = async (): Promise<{ token: string; key: string }> => {
  const keys = { token: randomBytes(64).toString("hex"), key: randomBytes(32).toString("hex") };
  const reset = await fetch(`http://${UNIT_ON_V3}:${String(v3.httpPort)}${FAKE_AIRCON_KEYS_PATH}`, {
    method: "POST",
    body: JSON.stringify(keys),
  });
  expect(reset.status).toBe(204);
  cloud.setUnits([{ id: v3.id, ...keys }]);
  return keys;
};

/** Every form a token or key could be written in: hex either case, base64 and base64url, and in part. */
const formsOf = (hex: string): string[] => {
  const bytes = Buffer.from(hex, "hex");
  const forms = [hex.toLowerCase(), hex.toUpperCase(), bytes.toString("base64"), bytes.toString("base64url")];
  return [...forms, ...forms.map((form) => form.slice(0, Math.ceil(form.length / 3)))];
};

describe("Find Air Conditioners", () => {
  it("lists every Midea unit that answers on the Hub's subnet, saying which needs the login", async () => {
    const response = await send("POST", APPLIANCE_SEARCH_PATH, { kind: "air-conditioner" });

    expect(response.status).toBe(200);
    const found = (await response.json()) as FoundAirConditioner[];
    expect(found.sort((a, b) => a.address.localeCompare(b.address))).toEqual([
      {
        kind: "air-conditioner",
        address: UNIT_ON_V2,
        name: v2.name,
        serialNumber: v2.serialNumber,
        needsLogin: false,
      },
      {
        kind: "air-conditioner",
        address: UNIT_ON_V3,
        name: v3.name,
        serialNumber: v3.serialNumber,
        needsLogin: true,
      },
    ]);
    expect(logged).toContain("Searched the network for Air Conditioners, and found 2");
  });
});

describe("Adding an Air Conditioner", () => {
  it("adds a v2 unit by IP, named and in a Room as a TV is, and refuses it twice, or a name taken in its Room", async () => {
    const bedroom = await addRoom("Bedroom");
    const office = await addRoom("Office");

    const aircon = await added(UNIT_ON_V2, { name: "Aircon", roomId: bedroom.id });

    expect(aircon).toEqual({
      id: aircon.id,
      kind: "air-conditioner",
      name: "Aircon",
      roomId: bedroom.id,
      address: UNIT_ON_V2,
      model: "Midea, protocol v2",
      macAddress: "",
      serialNumber: v2.serialNumber,
      pairing: "paired",
    });
    expect(await listAppliances()).toEqual([aircon]);
    expect(logged).toContain(`Added Bedroom · Aircon, an Air Conditioner at ${UNIT_ON_V2} (Midea, protocol v2)`);

    // The name, ignoring case, is refused in the same Room before the unit or the cloud is asked anything.
    v3.clear();
    const taken = await add(UNIT_ON_V3, { name: "aircon", roomId: bedroom.id, login: LOGIN });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as HubError).error).toBe(
      'There is already an Air Conditioner called "Aircon" in Bedroom.',
    );
    expect(v3.connections).toEqual([]);
    expect(cloud.requests).toEqual([]);

    const again = await add(UNIT_ON_V2, { name: "Study aircon", roomId: office.id });
    expect(again.status).toBe(409);
    expect(((await again.json()) as HubError).error).toBe(
      "That Air Conditioner is already added, as Bedroom · Aircon.",
    );

    const long = await add(UNIT_ON_V3, { name: "x".repeat(41), login: LOGIN });
    expect(((await long.json()) as HubError).error).toBe(
      "An Air Conditioner's name can be at most 40 characters; that one has 41.",
    );

    // Renamed, moved, and to "No room" when its Room goes, as any Appliance is (FR-8, FR-11).
    const moved = await send("PATCH", appliancePath(aircon.id), { name: "Study", roomId: office.id });
    expect(((await moved.json()) as Appliance).name).toBe("Study");
    expect((await send("DELETE", roomPath(office.id))).status).toBe(204);
    expect(await listAppliances()).toEqual([{ ...aircon, name: "Study", roomId: null }]);
  });

  it("names a unit added with no name by its own", async () => {
    expect((await added(UNIT_ON_V2)).name).toBe(v2.name);
  });

  it("refuses a unit that doesn't answer, and an address that isn't one", async () => {
    await v2.stop();
    const gone = await add(UNIT_ON_V2);
    expect(gone.status).toBe(502);
    expect(((await gone.json()) as HubError).error).toBe(
      `No Air Conditioner answered at ${UNIT_ON_V2}. Check that it is switched on and on the same network as the Hub.`,
    );

    const nowhere = await add("the bedroom");
    expect(nowhere.status).toBe(400);
    expect(((await nowhere.json()) as HubError).error).toBe(
      "Give the Air Conditioner's IP address, e.g. 192.168.1.20.",
    );
    expect(await listAppliances()).toEqual([]);
  });

  it("asks for the login for a v3 unit, fetches its token and key with it once, and controls it with the cloud stopped", async () => {
    const without = await add(UNIT_ON_V3, { name: "Aircon" });
    expect(without.status).toBe(401);
    expect(await without.json()).toEqual({
      error:
        "This Air Conditioner answers only once the Hub has its token and key. Sign in once, so that the Hub can fetch them from its maker's cloud.",
      needs: "login",
    });
    expect(cloud.requests).toEqual([]);

    const wrong = await add(UNIT_ON_V3, { name: "Aircon", login: { ...LOGIN, password: "Tr0ub4dor&3" } });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as HubError).error).toBe(
      "Neither MSmartHome nor Midea Air accepted that email and password. Check them, as you sign in to the app the Air Conditioner is set up in, then try again.",
    );
    expect(await listAppliances()).toEqual([]);

    const aircon = await added(UNIT_ON_V3, { name: "Aircon", login: LOGIN });
    expect(aircon).toMatchObject({ kind: "air-conditioner", model: "Midea, protocol v3", pairing: "paired" });
    expect(v3.connections.at(-1)).toEqual({ version: 3, handshake: "accepted" });

    // The internet goes down: the Hub never asks the cloud again for it.
    await cloud.stop();
    const asked = cloud.requests.length;
    const reading = await readState(aircon.id);
    expect(reading).toMatchObject({ known: true, state: { power: false, mode: "cool" } });

    const changed = await send("PATCH", applianceStatePath(aircon.id), {
      power: true,
      mode: "heat",
      targetTemperature: 22.5,
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      known: true,
      state: { power: true, mode: "heat", targetTemperature: 22.5 },
    });
    expect(v3.state()).toMatchObject({ power: true, mode: "heat", targetTemperature: 22.5 });
    expect(cloud.requests).toHaveLength(asked);
  });

  it("refuses an empty login, quoting none of it back", async () => {
    const response = await add(UNIT_ON_V3, { login: { account: "", password: LOGIN.password } });

    expect(response.status).toBe(400);
    const { error } = (await response.json()) as HubError;
    expect(error).toBe("Give the email address and password you sign in with, each at most 256 characters.");
    expect(cloud.requests).toEqual([]);
  });
});

describe("An Air Conditioner's token, key and login", () => {
  it("keeps only the token and key, never the login, in the SQLite file, and forgets them as it is removed", async () => {
    const aircon = await added(UNIT_ON_V3, { login: LOGIN });
    await factoryReset();
    expect((await readState(aircon.id)).known).toBe(false);
    expect((await send("POST", appliancePairingPath(aircon.id), { login: LOGIN })).status).toBe(200);

    const kept = database.prepare("SELECT credentials FROM appliance_credentials").all() as { credentials: string }[];
    expect(kept).toHaveLength(1);
    expect(Object.keys(JSON.parse(kept[0]?.credentials ?? "{}") as object).sort()).toEqual([
      "id",
      "key",
      "token",
      "version",
    ]);

    const bytes = await readFile(databaseFile);
    expect(existsSync(`${databaseFile}-journal`)).toBe(false);
    for (const text of [LOGIN.account, LOGIN.password]) {
      expect(bytes.includes(Buffer.from(text, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(text, "utf16le"))).toBe(false);
    }
    expect(bytes.includes(Buffer.from(v3.token ?? "", "utf8"))).toBe(true);

    expect((await send("DELETE", appliancePath(aircon.id))).status).toBe(204);
    expect(database.prepare("SELECT credentials FROM appliance_credentials").all()).toEqual([]);
    expect((await readFile(databaseFile)).includes(Buffer.from(v3.token ?? "", "utf8"))).toBe(false);
  });

  it("never sends the token, the key or the login in an answer, nor logs them", async () => {
    const first = { token: v3.token ?? "", key: v3.key ?? "" };
    await send("POST", APPLIANCE_SEARCH_PATH, { kind: "air-conditioner" });
    await add(UNIT_ON_V3, { login: { ...LOGIN, password: "wrong" } });
    const aircon = await added(UNIT_ON_V3, { login: LOGIN });
    await readState(aircon.id);
    await send("PATCH", applianceStatePath(aircon.id), { power: true, fanSpeed: "low" });
    await send("POST", applianceConnectionPath(aircon.id));
    const second = await factoryReset();
    await readState(aircon.id);
    await send("PATCH", applianceStatePath(aircon.id), { power: false });
    await send("POST", appliancePairingPath(aircon.id), { login: { ...LOGIN, password: "wrong" } });
    await send("POST", appliancePairingPath(aircon.id), { login: LOGIN });
    await readState(aircon.id);
    await listAppliances();
    await send("DELETE", appliancePath(aircon.id));

    expect(answers.length).toBeGreaterThan(10);
    expect(logged.length).toBeGreaterThan(3);
    const secrets = [
      ...[first.token, first.key, second.token, second.key].flatMap(formsOf),
      LOGIN.account,
      LOGIN.password,
    ];
    for (const secret of secrets) {
      for (const answer of answers) expect(answer).not.toContain(secret);
      for (const line of logged) expect(line).not.toContain(secret);
    }
  });
});

describe("Fetch again", () => {
  it("follows a unit that starts refusing its token and key, and fetches them again with the login, which restores control", async () => {
    const bedroom = await addRoom("Bedroom");
    const aircon = await added(UNIT_ON_V3, { name: "Aircon", roomId: bedroom.id, login: LOGIN });
    const first = { token: v3.token, key: v3.key };
    await factoryReset();

    expect(await readState(aircon.id)).toEqual({ known: false, why: "fetch-again" });
    expect(await listAppliances()).toEqual([{ ...aircon, pairing: "pair-again" }]);
    expect(logged).toContain("Bedroom · Aircon refused the Hub's token and key, so they need fetching again");
    // The Hub says so once, however often the Remote asks.
    await readState(aircon.id);
    expect(logged.filter((line) => line.startsWith("Bedroom · Aircon refused"))).toHaveLength(1);

    const change = await send("PATCH", applianceStatePath(aircon.id), { power: true });
    expect(change.status).toBe(409);
    expect(((await change.json()) as HubError).error).toBe(
      "Bedroom · Aircon no longer accepts the Hub's token and key. Fetch them again in Settings.",
    );
    expect(v3.state().power).toBe(false);

    const checked = await send("POST", applianceConnectionPath(aircon.id));
    expect(((await checked.json()) as Appliance).pairing).toBe("pair-again");

    const noLogin = await send("POST", appliancePairingPath(aircon.id), {});
    expect(noLogin.status).toBe(401);
    expect(((await noLogin.json()) as HubError).needs).toBe("login");

    const wrong = await send("POST", appliancePairingPath(aircon.id), { login: { ...LOGIN, password: "wrong" } });
    expect(wrong.status).toBe(403);

    const fetched = await send("POST", appliancePairingPath(aircon.id), { login: LOGIN });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ ...aircon, pairing: "paired" });
    expect(logged).toContain("Fetched the token and key of Bedroom · Aircon again");
    expect(v3.token).not.toBe(first.token);

    await cloud.stop();
    const changed = await send("PATCH", applianceStatePath(aircon.id), { power: true });
    expect(await changed.json()).toMatchObject({ known: true, state: { power: true } });
    expect(v3.state().power).toBe(true);
  });

  it("checks a unit's token and key as Settings opens, leaving one that can't be reached as it was", async () => {
    const aircon = await added(UNIT_ON_V3, { login: LOGIN });

    const accepted = await send("POST", applianceConnectionPath(aircon.id));
    expect(((await accepted.json()) as Appliance).pairing).toBe("paired");

    await v3.stop();
    expect((await send("POST", applianceConnectionPath(aircon.id))).status).toBe(502);
    expect((await listAppliances())[0]?.pairing).toBe("paired");
  });
});

describe("An Air Conditioner's capabilities", () => {
  it("are the controls the unit reports it has, read through its Driver (FR-50)", async () => {
    const aircon = await added(UNIT_ON_V2);

    expect(await readCapabilities(aircon.id)).toEqual({
      known: true,
      capabilities: {
        power: true,
        modes: [
          { mode: "cool", temperature: { min: 16, max: 30, step: 0.5 } },
          { mode: "heat", temperature: { min: 16, max: 30, step: 0.5 } },
          { mode: "dry", temperature: { min: 16, max: 30, step: 0.5 } },
          { mode: "fan", temperature: null },
          { mode: "auto", temperature: { min: 16, max: 30, step: 0.5 } },
        ],
        fan: { speeds: ["silent", "low", "medium", "high", "full"], auto: true },
        swing: { vertical: true, horizontal: true },
        presets: ["eco", "turbo", "sleep"],
        display: true,
        temperatures: { room: true, outdoor: true },
        functions: expect.arrayContaining([
          { id: "self-clean", name: "Self-clean", kind: "on-off" },
          expect.objectContaining({ id: "breeze", kind: "choice" }),
        ]) as unknown,
      },
    });
  });

  it("are only those of a unit with fewer, in its own ranges and steps", async () => {
    const small = await startFakeMideaAircon({
      host: "127.0.0.7",
      port: v2.port,
      discoveryPort: v2.discoveryPort,
      httpPort: v2.httpPort,
      version: 2,
      id: 0x0000_0000_1003,
      serialNumber: "000000P0000000Q1F0C9A1B2C3D70000",
      features: ["cool", "heat", "fan-auto"],
      temperatureRanges: { cool: [17, 30], auto: [17, 30], heat: [16, 28] },
    });
    try {
      const aircon = await added(small.host);
      expect(await readCapabilities(aircon.id)).toEqual({
        known: true,
        capabilities: {
          power: true,
          modes: [
            { mode: "cool", temperature: { min: 17, max: 30, step: 1 } },
            { mode: "heat", temperature: { min: 16, max: 28, step: 1 } },
            { mode: "fan", temperature: null },
          ],
          fan: { speeds: ["low", "high"], auto: true },
          swing: { vertical: false, horizontal: false },
          presets: ["sleep"],
          display: false,
          temperatures: { room: true, outdoor: false },
          functions: [],
        },
      });
    } finally {
      await small.stop();
    }
  });

  it("say when the unit can't be reached (FR-51a), or refuses its token and key, marking it to fetch them again", async () => {
    const aircon = await added(UNIT_ON_V2);
    const keyed = await added(UNIT_ON_V3, { login: LOGIN });
    await v2.stop();
    await factoryReset();

    expect(await readCapabilities(aircon.id)).toEqual({ known: false, why: "unreachable" });
    expect(await readCapabilities(keyed.id)).toEqual({ known: false, why: "fetch-again" });
    const after = await listAppliances();
    expect(after.find(({ id }) => id === aircon.id)?.pairing).toBe("paired");
    expect(after.find(({ id }) => id === keyed.id)?.pairing).toBe("pair-again");
  });

  it("are only read", async () => {
    const aircon = await added(UNIT_ON_V2);

    const response = await send("PATCH", applianceCapabilitiesPath(aircon.id), { power: true });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("An Air Conditioner's state", () => {
  it("says when the unit can't be reached (FR-51a), and refuses a change to it", async () => {
    const aircon = await added(UNIT_ON_V2);
    await v2.stop();

    expect(await readState(aircon.id)).toEqual({ known: false, why: "unreachable" });
    const change = await send("PATCH", applianceStatePath(aircon.id), { power: true });
    expect(change.status).toBe(502);
    expect((await listAppliances())[0]?.pairing).toBe("paired");
  });

  it("refuses a change the unit hasn't the capability for, and one that isn't a change", async () => {
    const aircon = await added(UNIT_ON_V2);

    const hot = await send("PATCH", applianceStatePath(aircon.id), { mode: "heat", targetTemperature: 45 });
    expect(hot.status).toBe(400);
    expect(((await hot.json()) as HubError).error).toBe(
      "This Air Conditioner takes 16° to 30° in heat mode, in half degrees.",
    );
    for (const [body, message] of [
      [{}, "Say what to change."],
      [{ colour: "red" }, "An Air Conditioner has nothing called colour to change."],
      [{ power: "on" }, "Say whether to switch it on, as true or false."],
      [{ mode: "warm" }, "Give the mode as one of cool, heat, dry, fan, auto."],
      [{ swing: { diagonal: true } }, "Say which ways it swings, as vertical and horizontal, each true or false."],
    ] as const) {
      const refused = await send("PATCH", applianceStatePath(aircon.id), body);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as HubError).error).toBe(message);
    }
    expect(v2.commands.filter(({ command }) => command === "set-state")).toEqual([]);
  });

  it("is refused for what only a TV has", async () => {
    const aircon = await added(UNIT_ON_V2, { name: "Aircon" });

    const key = await send("POST", applianceKeysPath(aircon.id), { key: "power" });
    expect(key.status).toBe(400);
    expect(((await key.json()) as HubError).error).toBe("Aircon isn't a TV.");
  });

  it("is refused by a Hub run without an Air Conditioner Driver", async () => {
    const plain = createHub({
      remoteDir: "/nonexistent",
      version: "9.9.9",
      hubId: "hub-2",
      database: openDatabase(":memory:"),
      drivers: { tv: samsungTvDriver() },
    });
    await new Promise<void>((done) => plain.listen(0, "127.0.0.1", done));
    const at = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${at}${APPLIANCES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "air-conditioner", address: UNIT_ON_V2, roomId: null }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as HubError).error).toBe("The Hub can't add that kind of Appliance.");
    } finally {
      await new Promise((done) => plain.close(done));
    }
  });
});
