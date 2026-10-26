import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLIANCES_PATH,
  HIVE_CODE_PATH,
  HIVE_PATH,
  HIVE_SIGN_IN_PATH,
  ROOMS_PATH,
  appliancePath,
  type Appliance,
  type HiveAccount,
  type HiveSignedIn,
  type HiveSignInOutcome,
  type HubError,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import type { HeatingDriver } from "./drivers/driver.ts";
import { hiveDriver } from "./drivers/hive/hive-driver.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import { startFakeHiveCloud, type FakeHiveCloud, type FakeHiveProduct } from "./fakes/hive-cloud/fake-hive-cloud.ts";
import { createHub } from "./hub.ts";

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };
const CODE = "246810";
const WRONG_CODE = "135797";

let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let hub: Server;
let base: string;
let cloud: FakeHiveCloud;
/** Every body the Hub sent, to prove no token, key, session, login or code is ever among them. */
let answers: string[];
/** Every line the Hub logged, likewise. */
let logged: string[];
/** Every sign-in session the Driver handed the Hub, as secret as the tokens. */
let sessions: string[];

/** Starts the Hub with a Hive Driver for the fake Hive cloud, which asks for `code` if given. */
const start = async (options: { code?: string; products?: readonly FakeHiveProduct[] } = {}): Promise<void> => {
  cloud = await startFakeHiveCloud({ ...LOGIN, ...options });
  // Logging to the console, as the Hub runs it.
  const driver = hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, timeoutMs: 1_000 });
  const heating: HeatingDriver = {
    ...driver,
    signIn: async (login, kept) => {
      const answer = await driver.signIn(login, kept);
      if (!answer.signedIn) sessions.push(answer.pending);
      return answer;
    },
  };
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    drivers: { tv: samsungTvDriver(), heating },
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-hive-test-"));
  databaseFile = join(dir, "media-centre.sqlite");
  database = openDatabase(databaseFile);
  answers = [];
  logged = [];
  sessions = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const text = (arg: unknown): string =>
        arg instanceof Error ? `${String(arg.stack)} ${String(arg.cause)}` : String(arg);
      logged.push(args.map(text).join(" "));
    });
  }
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

const listAppliances = async (): Promise<Appliance[]> =>
  (await (await send("GET", APPLIANCES_PATH)).json()) as Appliance[];

const hiveAccount = async (): Promise<HiveAccount> => (await (await send("GET", HIVE_PATH)).json()) as HiveAccount;

const signIn = async (login: object = LOGIN): Promise<HiveSignInOutcome> => {
  const response = await send("POST", HIVE_SIGN_IN_PATH, login);
  expect(response.status).toBe(200);
  return (await response.json()) as HiveSignInOutcome;
};

const enterCode = async (code: string): Promise<HiveSignedIn> => {
  const response = await send("POST", HIVE_CODE_PATH, { code });
  expect(response.status).toBe(200);
  return (await response.json()) as HiveSignedIn;
};

const refusal = async (response: Response): Promise<{ status: number; error: string }> => ({
  status: response.status,
  error: ((await response.json()) as HubError).error,
});

const addRoom = async (name: string): Promise<Room> =>
  (await (await send("POST", ROOMS_PATH, { name })).json()) as Room;

/** Hive's Appliances as the Hub lists them: kind, name and Room, in the order Hive lists them. */
const named = (appliances: readonly Appliance[]) =>
  appliances.map(({ kind, name, roomId }) => ({ kind, name, roomId }));

/** The fake's household, as the Hub adds it: each with Hive's name, and no Room. */
const HOUSEHOLD = [
  { kind: "heating", name: "Downstairs", roomId: null },
  { kind: "heating", name: "Upstairs", roomId: null },
  { kind: "radiator-valve", name: "Bedroom", roomId: null },
  { kind: "radiator-valve", name: "Study", roomId: null },
  { kind: "radiator-valve", name: "Living Room", roomId: null },
  { kind: "hot-water", name: "Hot Water", roomId: null },
];

describe("Signing in to Hive", () => {
  it("asks for the code Hive texts, then adds every Heating, Radiator Valve and Hot Water by Hive's names, in no Room", async () => {
    await start({ code: CODE });
    expect(await hiveAccount()).toEqual({ signedIn: false });

    expect(await signIn()).toEqual({ signedIn: false, needs: "code" });
    expect(await listAppliances()).toEqual([]);

    expect(await refusal(await send("POST", HIVE_CODE_PATH, { code: WRONG_CODE }))).toEqual({
      status: 403,
      error: "That isn't the code Hive sent. Try it again.",
    });
    // A wrong code can be given again, right.
    const signedIn = await enterCode(CODE);
    expect(signedIn.signedIn).toBe(true);
    expect(named(signedIn.added)).toEqual(HOUSEHOLD);
    expect(
      signedIn.added.map(({ model, address, macAddress, pairing }) => ({ model, address, macAddress, pairing })),
    ).toEqual(
      HOUSEHOLD.map(({ kind }) => ({
        model: { heating: "Hive Heating", "radiator-valve": "Hive Radiator Valve", "hot-water": "Hive Hot Water" }[
          kind
        ],
        address: "",
        macAddress: "",
        pairing: "paired",
      })),
    );
    // Each is Hive's own, by its id.
    expect(signedIn.added.map(({ serialNumber }) => serialNumber)).toEqual(cloud.products().map(({ id }) => id));
    expect(await listAppliances()).toEqual(signedIn.added);
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "accepted" });
    expect(logged).toContain(
      "Added 6 of Hive's Appliances: Downstairs, Upstairs, Bedroom, Study, Living Room, Hot Water",
    );
  });

  it("signs in at once when Hive asks for no code", async () => {
    await start();
    const signedIn = await signIn();
    expect(signedIn.signedIn).toBe(true);
    expect(named((signedIn as HiveSignedIn).added)).toEqual(HOUSEHOLD);
  });

  it("refuses a login Hive refuses, an empty one, and a code with no sign-in waiting for it, quoting none back", async () => {
    await start({ code: CODE });
    expect(await refusal(await send("POST", HIVE_SIGN_IN_PATH, { ...LOGIN, password: "wrong" }))).toEqual({
      status: 403,
      error: "Hive refused the email or password. Use the Hive account owner's.",
    });
    expect((await send("POST", HIVE_SIGN_IN_PATH, { account: LOGIN.account, password: "" })).status).toBe(400);
    expect((await send("POST", HIVE_SIGN_IN_PATH, {})).status).toBe(400);
    expect(await refusal(await send("POST", HIVE_CODE_PATH, { code: CODE }))).toEqual({
      status: 409,
      error: "Hive's code has expired. Sign in again for a new one.",
    });
    await signIn();
    expect((await send("POST", HIVE_CODE_PATH, { code: "" })).status).toBe(400);
    expect((await send("POST", HIVE_CODE_PATH, {})).status).toBe(400);
    expect((await send("GET", HIVE_SIGN_IN_PATH)).status).toBe(405);
    expect(await listAppliances()).toEqual([]);
    expect(await hiveAccount()).toEqual({ signedIn: false });
  });

  it("numbers one of Hive's names that another of its kind has already", async () => {
    await start({
      products: [
        { kind: "heating", name: "Heating", id: "zone-1" },
        { kind: "radiator-valve", name: "Bedroom", zone: "Heating", id: "valve-1" },
        { kind: "radiator-valve", name: "bedroom", zone: "Heating", id: "valve-2" },
        { kind: "radiator-valve", name: "", zone: "Heating", id: "valve-3" },
      ],
    });
    const signedIn = (await signIn()) as HiveSignedIn;
    expect(signedIn.added.map(({ name }) => name)).toEqual(["Heating", "Bedroom", "bedroom 2", "Radiator Valve"]);
  });

  it("is refused by a Hub run without a Hive Driver", async () => {
    cloud = await startFakeHiveCloud(LOGIN);
    hub = createHub({
      remoteDir: "/nonexistent",
      version: "9.9.9",
      hubId: "hub-1",
      database,
      drivers: { tv: samsungTvDriver() },
    });
    await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    expect(await hiveAccount()).toEqual({ signedIn: false });
    expect(await refusal(await send("POST", HIVE_SIGN_IN_PATH, LOGIN))).toEqual({
      status: 400,
      error: "The Hub can't sign in to Hive.",
    });
  });
});

describe("Hive's Appliances", () => {
  it("are renamed and given a Room as a TV is, kept so as the Hub signs in again, and not removed one by one", async () => {
    await start({ code: CODE });
    await signIn();
    const [downstairs, , bedroom] = (await enterCode(CODE)).added;
    if (downstairs === undefined || bedroom === undefined) throw new Error("Hive listed too few");
    const room = await addRoom("Main Bedroom");

    const moved = await send("PATCH", appliancePath(bedroom.id), { name: "Radiator", roomId: room.id });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ ...bedroom, name: "Radiator", roomId: room.id });
    const renamed = await send("PATCH", appliancePath(downstairs.id), { name: "Ground floor" });
    expect(((await renamed.json()) as Appliance).name).toBe("Ground floor");
    // As for any Appliance, a name is unique among its kind in a Room.
    expect((await send("PATCH", appliancePath(downstairs.id), { name: "upstairs" })).status).toBe(409);

    const removing = await send("DELETE", appliancePath(bedroom.id));
    expect(await refusal(removing)).toEqual({
      status: 409,
      error: "Main Bedroom · Radiator is Hive's, and goes only as the Hub signs out of Hive, in Settings.",
    });

    // Signed in again, as the device Hive trusts: no code, and none added twice.
    expect(await signIn()).toEqual({ signedIn: true, added: [] });
    const all = await listAppliances();
    expect(named(all)).toEqual([
      { kind: "heating", name: "Ground floor", roomId: null },
      { kind: "heating", name: "Upstairs", roomId: null },
      { kind: "radiator-valve", name: "Radiator", roomId: room.id },
      { kind: "radiator-valve", name: "Study", roomId: null },
      { kind: "radiator-valve", name: "Living Room", roomId: null },
      { kind: "hot-water", name: "Hot Water", roomId: null },
    ]);
  });

  it("appear by themselves as Settings checks the sign-in, once Hive lists one more", async () => {
    await start();
    await signIn();
    cloud.setProducts([
      { kind: "heating", name: "Downstairs" },
      { kind: "heating", name: "Upstairs" },
      { kind: "radiator-valve", name: "Bedroom", zone: "Upstairs" },
      { kind: "radiator-valve", name: "Nursery", zone: "Upstairs" },
    ]);
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "accepted" });
    expect((await listAppliances()).map(({ name }) => name)).toContain("Nursery");
  });
});

describe("Sign in again", () => {
  it("is offered once Hive stops accepting the tokens, and restores control, keeping every Appliance as it was", async () => {
    await start({ code: CODE });
    await signIn();
    await enterCode(CODE);
    const before = await listAppliances();

    cloud.revoke();
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "refused" });
    expect(logged).toContain("Hive no longer accepts the Hub's tokens, so Settings offers to sign in again");
    // Still Hive's Appliances, for the Heating tab to say it can't reach Hive.
    expect(await listAppliances()).toEqual(before);

    // The Hub is still a device Hive trusts, so Hive asks no code.
    expect(await signIn()).toEqual({ signedIn: true, added: [] });
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "accepted" });
    expect(await listAppliances()).toEqual(before);
  });

  it("asks for the code again where Hive has forgotten the Hub as a device", async () => {
    await start({ code: CODE });
    await signIn();
    await enterCode(CODE);
    cloud.revoke(true);
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "refused" });
    expect(await signIn()).toEqual({ signedIn: false, needs: "code" });
    expect(await enterCode(CODE)).toEqual({ signedIn: true, added: [] });
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "accepted" });
  });

  it("is not what Hive's cloud out of reach says, which is \"Can't reach Hive\"", async () => {
    await start();
    await signIn();
    await cloud.stop();
    expect(await hiveAccount()).toEqual({ signedIn: true, tokens: "unreachable" });
    const refused = await refusal(await send("POST", HIVE_SIGN_IN_PATH, LOGIN));
    expect(refused).toEqual({
      status: 502,
      error: "Can't reach Hive. Check that the Hub is connected to the internet.",
    });
  });
});

describe("Sign out", () => {
  it("removes every Hive Appliance, their places in Rooms and the tokens, leaving every other Appliance and the Rooms", async () => {
    await start();
    const { added } = (await signIn()) as HiveSignedIn;
    const room = await addRoom("Study");
    await send("PATCH", appliancePath(added[3]?.id ?? 0), { roomId: room.id });
    database
      .prepare(
        "INSERT INTO appliance (kind, name, name_key, room_id, address, model, mac_address, pairing) " +
          "VALUES ('tv', 'TV', 'tv', ?, '127.0.0.2', 'Samsung', 'aa:bb:cc:dd:ee:ff', 'paired')",
      )
      .run(room.id);
    const tv = (await listAppliances()).find(({ kind }) => kind === "tv");

    expect((await send("DELETE", HIVE_PATH)).status).toBe(204);
    expect(await listAppliances()).toEqual([tv]);
    expect(await hiveAccount()).toEqual({ signedIn: false });
    expect(database.prepare("SELECT * FROM hive_account").all()).toEqual([]);
    expect((await (await send("GET", ROOMS_PATH)).json()) as Room[]).toEqual([room]);
    expect(logged).toContain("Signed out of Hive: the Hub forgot its tokens, and removed Hive's 6 Appliances");

    // Signed in once more, they come back as Hive names them.
    expect(named(((await signIn()) as HiveSignedIn).added)).toEqual(HOUSEHOLD);
  });
});

describe("Hive's password, code and tokens", () => {
  it("never keeps the password or the code anywhere in the SQLite file, and overwrites the tokens as the Hub signs out", async () => {
    await start({ code: CODE });
    await send("POST", HIVE_SIGN_IN_PATH, { ...LOGIN, password: "wrong" });
    await signIn();
    await send("POST", HIVE_CODE_PATH, { code: WRONG_CODE });
    await enterCode(CODE);
    cloud.revoke();
    await hiveAccount();
    await signIn();

    const kept = database.prepare("SELECT credentials FROM hive_account").all() as { credentials: string }[];
    expect(kept).toHaveLength(1);
    expect(Object.keys(JSON.parse(kept[0]?.credentials ?? "{}") as object).sort()).toEqual([
      "accessToken",
      "device",
      "expiresAt",
      "idToken",
      "refreshToken",
    ]);
    // Hive's Appliances have no credentials of their own.
    const ownCredentials = database.prepare("SELECT credentials FROM appliance_credentials").all() as {
      credentials: string;
    }[];
    expect(new Set(ownCredentials.map(({ credentials }) => credentials))).toEqual(new Set([""]));

    // Every text in every table, then every byte of the file.
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[];
    const texts = tables.flatMap(({ name }) =>
      (database.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).flatMap((row) =>
        Object.values(row).filter((value): value is string => typeof value === "string"),
      ),
    );
    expect(texts.length).toBeGreaterThan(10);
    const bytes = await readFile(databaseFile);
    for (const secret of [LOGIN.password, "wrong", CODE, WRONG_CODE]) {
      for (const text of texts) expect(text).not.toContain(secret);
      expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(secret, "utf16le"))).toBe(false);
    }
    // Nor the account's email, which the Driver doesn't need.
    expect(bytes.includes(Buffer.from(LOGIN.account, "utf8"))).toBe(false);

    const refreshToken = (JSON.parse(kept[0]?.credentials ?? "{}") as { refreshToken: string }).refreshToken;
    expect(bytes.includes(Buffer.from(refreshToken, "utf8"))).toBe(true);
    await send("DELETE", HIVE_PATH);
    expect((await readFile(databaseFile)).includes(Buffer.from(refreshToken, "utf8"))).toBe(false);
  });

  it("never sends the tokens, the device's keys, Hive's session, the password or the code in an answer, nor logs them", async () => {
    await start({ code: CODE });
    const credentials: string[] = [];
    const keep = (): void => {
      const row = database.prepare("SELECT credentials FROM hive_account").get() as { credentials: string } | undefined;
      if (row !== undefined) credentials.push(row.credentials);
    };
    await hiveAccount();
    await send("POST", HIVE_SIGN_IN_PATH, { ...LOGIN, password: "wrong" });
    await signIn();
    await send("POST", HIVE_CODE_PATH, { code: WRONG_CODE });
    await enterCode(CODE);
    keep();
    await hiveAccount();
    await listAppliances();
    cloud.advance(61);
    await hiveAccount();
    keep();
    cloud.revoke();
    await hiveAccount();
    await signIn();
    keep();
    cloud.revoke(true);
    await hiveAccount();
    await signIn();
    await enterCode(CODE);
    keep();
    await send("DELETE", HIVE_PATH);

    expect(answers.length).toBeGreaterThan(12);
    expect(logged.length).toBeGreaterThan(8);
    expect(sessions).toHaveLength(2);
    const strings = (kept: string): string[] => {
      const found: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === "string") found.push(value);
        else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
      };
      walk(JSON.parse(kept));
      return found;
    };
    // Four times three tokens and the device's key, group key and password, and twice the session and its user.
    const tokens = [...credentials, ...sessions].flatMap(strings);
    expect(tokens.length).toBeGreaterThanOrEqual(4 * 6 + 2 * 2);
    const secrets = [...new Set([...tokens, LOGIN.account, LOGIN.password, "wrong", CODE, WRONG_CODE])];
    for (const secret of secrets) {
      for (const answer of answers) expect(answer).not.toContain(secret);
      for (const line of logged) expect(line).not.toContain(secret);
    }
  });
});
