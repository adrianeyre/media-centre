import { readFile, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLIANCE_SEARCH_PATH,
  APPLIANCES_PATH,
  ROOMS_PATH,
  applianceAppIconPath,
  applianceAppPath,
  applianceAppsPath,
  applianceConnectionPath,
  applianceDeviceInfoPath,
  applianceKeyboardPath,
  applianceKeysPath,
  applianceNowShowingPath,
  appliancePairingPath,
  appliancePath,
  appliancePowerPath,
  applianceShortcutsPath,
  applianceVolumePath,
  roomPath,
  type Appliance,
  type ApplianceApps,
  type ApplianceDeviceInfo,
  type ApplianceKeyboard,
  type AppliancePower,
  type ApplianceVolume,
  type FoundAppliance,
  type HubError,
  type NowShowing,
  type PowerSwitch,
  type Room,
  type ShortcutOutcome,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import type { Drivers } from "./drivers/driver.ts";
import { hiveDriver } from "./drivers/hive/hive-driver.ts";
import { SAMSUNG_POWER_KEY, SAMSUNG_SHORTCUT_KEY_CODES } from "./drivers/samsung-tv/keys.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import { startFakeSamsungTv, type FakeSamsungTv } from "./fakes/samsung-tv/fake-samsung-tv.ts";
import { fakeAppIcon } from "./fakes/samsung-tv/icons.ts";
import { createHub } from "./hub.ts";

// Two fake TVs, each at its own address on the same ports, as two real TVs on
// the home network would be.
const LIVING_ROOM_TV = "127.0.0.2";
const BEDROOM_TV = "127.0.0.3";

/** How long the Hub listens, after a shortcut's key, for the TV to say it ignored it. */
const SHORTCUT_LISTEN_MS = 300;

let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let hub: Server;
let base: string;
let living: FakeSamsungTv;
let bedroom: FakeSamsungTv;
/** Every body the Hub sent, to prove no token is ever among them. */
let answers: string[];
/** Every line the Hub logged, likewise. */
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-appliances-test-"));
  databaseFile = join(dir, "media-centre.sqlite");
  database = openDatabase(databaseFile);
  living = await startFakeSamsungTv({ host: LIVING_ROOM_TV, macAddress: "02:00:00:00:00:0A" });
  bedroom = await startFakeSamsungTv({
    host: BEDROOM_TV,
    restPort: living.restPort,
    controlPort: living.controlPort,
    ssdpPort: living.ssdpPort,
    wakePort: living.wakePort,
    upnpPort: living.upnpPort,
    name: "[TV] Samsung S95C (65)",
    model: "QE65S95CATXXU",
    macAddress: "02:00:00:00:00:0B",
  });
  const drivers = {
    tv: samsungTvDriver({
      restPort: living.restPort,
      controlPort: living.controlPort,
      // Each fake TV's own address, where the multicast group would reach them all.
      searchTargets: [LIVING_ROOM_TV, BEDROOM_TV].map((host) => ({ host, port: living.ssdpPort })),
      searchWindowMs: 300,
      // Each fake TV's own address, where a broadcast would reach them all.
      wakePort: living.wakePort,
      powerHoldMs: 400,
      upnpPort: living.upnpPort,
      shortcutListenMs: SHORTCUT_LISTEN_MS,
    }),
  };
  hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database, drivers });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;

  answers = [];
  logged = [];
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
  await Promise.all([living.stop(), bedroom.stop()]);
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

const addTv = async (address: string, roomId: number | null, name?: string): Promise<Appliance> => {
  const response = await send("POST", APPLIANCES_PATH, {
    kind: "tv",
    address,
    roomId,
    ...(name === undefined ? {} : { name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Appliance;
};

/** Expects the Hub to refuse, and returns the message it gave the person. */
const refusal = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as HubError).error;
};

const storedCredentials = (): { appliance_id: number; credentials: string }[] =>
  database.prepare("SELECT appliance_id, credentials FROM appliance_credentials ORDER BY appliance_id").all() as {
    appliance_id: number;
    credentials: string;
  }[];

/** Every token either fake TV has issued. */
const issuedTokens = (): string[] => [...living.issuedTokens(), ...bedroom.issuedTokens()];

describe("the Hub's Appliances", () => {
  it("start empty", async () => {
    expect(await listAppliances()).toEqual([]);
  });

  describe("adding a TV by IP", () => {
    it("reads its device info, pairs with it, and keeps its IP, MAC, model and own name", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null);

      expect(tv).toEqual({
        id: expect.any(Number) as number,
        kind: "tv",
        name: "[TV] Samsung Q60 Series (55)",
        roomId: null,
        address: LIVING_ROOM_TV,
        model: "QE55Q60TAUXXU",
        macAddress: "02:00:00:00:00:0a",
        pairing: "paired",
      });
      expect(await listAppliances()).toEqual([tv]);
      expect(living.requests.map(({ method }) => method)).toEqual(["GET"]);
      expect(living.connections).toEqual([expect.objectContaining({ clientName: "media-centre", outcome: "paired" })]);
    });

    it("stores the token the TV issued, and presents it on the next connection", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null);
      const [token] = living.issuedTokens();

      expect(storedCredentials()).toEqual([{ appliance_id: tv.id, credentials: token }]);

      const response = await send("POST", applianceConnectionPath(tv.id));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(tv);
      expect(living.connections[1]).toMatchObject({ token, outcome: "accepted" });
    });

    it("takes the name and Room it is given", async () => {
      const room = await addRoom("Living room");

      const tv = await addTv(LIVING_ROOM_TV, room.id, "  TV ");

      expect(tv).toMatchObject({ name: "TV", roomId: room.id });
    });

    it("cuts a long name of the TV's own to the 40 characters a name may have", async () => {
      await living.stop();
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
        name: `[TV] ${"x".repeat(50)}`,
      });

      expect((await addTv(LIVING_ROOM_TV, null)).name).toBe(`[TV] ${"x".repeat(35)}`);
    });

    it("refuses the same TV twice, saying what it is called", async () => {
      const room = await addRoom("Living room");
      await addTv(LIVING_ROOM_TV, room.id, "TV");

      const message = await refusal(
        await send("POST", APPLIANCES_PATH, { kind: "tv", address: LIVING_ROOM_TV, roomId: null }),
        409,
      );

      expect(message).toBe("That TV is already added, as Living room · TV.");
      expect(living.issuedTokens()).toHaveLength(1);
    });

    it("keeps nothing when the person chooses Deny on the TV", async () => {
      living.answerPairing("deny");

      const message = await refusal(
        await send("POST", APPLIANCES_PATH, { kind: "tv", address: LIVING_ROOM_TV, roomId: null }),
        502,
      );

      expect(message).toBe(`The TV at ${LIVING_ROOM_TV} didn't allow the Hub. Try again, and choose Allow on the TV.`);
      expect(await listAppliances()).toEqual([]);
      expect(storedCredentials()).toEqual([]);
    });

    it("says so when no TV answers at the address", async () => {
      const message = await refusal(
        await send("POST", APPLIANCES_PATH, { kind: "tv", address: "127.0.0.9", roomId: null }),
        502,
      );

      expect(message).toBe(
        "No TV answered at 127.0.0.9. Check that it is switched on and on the same network as the Hub.",
      );
    });

    const tv = { kind: "tv", address: LIVING_ROOM_TV, roomId: null };
    it.each([
      ["no IP address", { kind: "tv", roomId: null }, 400, "Give the TV's IP address, e.g. 192.168.1.20."],
      [
        "a name, not an IP address",
        { ...tv, address: "tv.local" },
        400,
        "Give the TV's IP address, e.g. 192.168.1.20.",
      ],
      ["a kind the Hub has no Driver for", { ...tv, kind: "kettle" }, 400, "The Hub can't add that kind of Appliance."],
      ["a Room that isn't one", { ...tv, roomId: "Hall" }, 400, 'Give the Room as its id, or null for "No room".'],
      ["a Room that no longer exists", { ...tv, roomId: 99, name: "TV" }, 409, "That Room no longer exists."],
      [
        "a name over 40 characters",
        { ...tv, name: "x".repeat(41) },
        400,
        "A TV's name can be at most 40 characters; that one has 41.",
      ],
    ])("refuses %s before asking the TV anything", async (_, body, status, expected) => {
      expect(await refusal(await send("POST", APPLIANCES_PATH, body), status)).toBe(expected);
      expect(living.connections).toEqual([]);
    });
  });

  describe("finding TVs", () => {
    const find = async (): Promise<FoundAppliance[]> => {
      const response = await send("POST", APPLIANCE_SEARCH_PATH, { kind: "tv" });
      expect(response.status).toBe(200);
      return (await response.json()) as FoundAppliance[];
    };

    /** Searches through a Hub of its own, with these Drivers. */
    const searchWith = async (drivers: Drivers): Promise<Response> => {
      const other = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-2", database, drivers });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        return await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}${APPLIANCE_SEARCH_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "tv" }),
        });
      } finally {
        await new Promise((done) => other.close(done));
      }
    };

    it("lists each TV on the network by its own name, IP, model and MAC, without pairing with any", async () => {
      expect(await find()).toEqual([
        {
          kind: "tv",
          address: LIVING_ROOM_TV,
          name: "[TV] Samsung Q60 Series (55)",
          model: "QE55Q60TAUXXU",
          macAddress: "02:00:00:00:00:0a",
        },
        {
          kind: "tv",
          address: BEDROOM_TV,
          name: "[TV] Samsung S95C (65)",
          model: "QE65S95CATXXU",
          macAddress: "02:00:00:00:00:0b",
        },
      ]);
      expect([...living.connections, ...bedroom.connections]).toEqual([]);
      expect(await listAppliances()).toEqual([]);
      expect(logged).toContain("Searched the network for TVs, and found 2");
    });

    it("still lists a TV already added, by the MAC address that tells the Remote it is", async () => {
      const added = await addTv(LIVING_ROOM_TV, null, "TV");

      const found = await find();

      expect(found.map(({ address, macAddress }) => ({ address, macAddress }))).toEqual([
        { address: LIVING_ROOM_TV, macAddress: added.macAddress },
        { address: BEDROOM_TV, macAddress: "02:00:00:00:00:0b" },
      ]);
    });

    it("finds none when no TV answers", async () => {
      const response = await searchWith({ tv: { ...samsungTvDriver(), discover: () => Promise.resolve([]) } });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    it("says so when the Driver couldn't search", async () => {
      // Broadcast without asking for it is refused, as a search with no network would be.
      const tv = samsungTvDriver({ searchTargets: [{ host: "255.255.255.255", port: 1900 }] });

      const message = await refusal(await searchWith({ tv }), 502);

      expect(message).toBe("The Hub couldn't search its network for TVs. Add the TV by its IP address instead.");
    });

    it("refuses a kind whose Driver can't search", async () => {
      const { identify, pair, connect, readPowerState } = samsungTvDriver();

      const message = await refusal(
        await searchWith({ tv: { kind: "tv", identify, pair, connect, readPowerState } }),
        400,
      );

      expect(message).toBe("The Hub can't search for TVs. Add one by its IP address instead.");
    });

    it.each([
      ["no kind", {}],
      ["a kind the Hub has no Driver for", { kind: "kettle" }],
    ])("refuses a search for %s", async (_, body) => {
      expect(await refusal(await send("POST", APPLIANCE_SEARCH_PATH, body), 400)).toBe(
        "The Hub can't search for that kind of Appliance.",
      );
    });

    it.each(["heating", "radiator-valve", "hot-water", "hive"])(
      "refuses to search for, or add by address, %s, whose Driver signs in to its maker's cloud instead",
      async (kind) => {
        // Nothing listens at port 9, so a Driver that tried would fail otherwise.
        const nowhere = "http://127.0.0.1:9";
        const heating = hiveDriver({ apiUrl: nowhere, authUrl: nowhere, timeoutMs: 500, log: () => undefined });
        const other = createHub({
          remoteDir: "/nonexistent",
          version: "9.9.9",
          hubId: "hub-2",
          database,
          drivers: { tv: samsungTvDriver(), heating },
        });
        await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
        const at = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}`;
        const post = (path: string, body: unknown): Promise<Response> =>
          fetch(`${at}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        try {
          expect(await refusal(await post(APPLIANCE_SEARCH_PATH, { kind }), 400)).toBe(
            "The Hub can't search for that kind of Appliance.",
          );
          expect(await refusal(await post(APPLIANCES_PATH, { kind, address: "127.0.0.1" }), 400)).toBe(
            "The Hub can't add that kind of Appliance.",
          );
        } finally {
          await new Promise((done) => other.close(done));
        }
      },
    );
  });

  describe("names and Rooms", () => {
    it('lets two TVs be called "TV" in different Rooms, and refuses a second "tv" in the same Room', async () => {
      const livingRoom = await addRoom("Living room");
      const bedroomRoom = await addRoom("Bedroom");
      await addTv(LIVING_ROOM_TV, livingRoom.id, "TV");

      const clash = await send("POST", APPLIANCES_PATH, {
        kind: "tv",
        address: BEDROOM_TV,
        roomId: livingRoom.id,
        name: "tv",
      });

      expect(await refusal(clash, 409)).toBe('There is already a TV called "TV" in Living room.');
      expect(bedroom.connections).toEqual([]);

      await addTv(BEDROOM_TV, bedroomRoom.id, "TV");
      expect((await listAppliances()).map(({ name, roomId }) => ({ name, roomId }))).toEqual([
        { name: "TV", roomId: livingRoom.id },
        { name: "TV", roomId: bedroomRoom.id },
      ]);
    });

    it("refuses a TV's own name when a TV with no Room already has it, ignoring case", async () => {
      await addTv(LIVING_ROOM_TV, null, "[tv] samsung s95c (65)");

      const message = await refusal(
        await send("POST", APPLIANCES_PATH, { kind: "tv", address: BEDROOM_TV, roomId: null }),
        409,
      );

      expect(message).toBe('There is already a TV called "[tv] samsung s95c (65)" with no Room.');
      expect(bedroom.connections).toEqual([]);
    });

    it("renames a TV and moves it between Rooms, by the same rules", async () => {
      const livingRoom = await addRoom("Living room");
      const bedroomRoom = await addRoom("Bedroom");
      const first = await addTv(LIVING_ROOM_TV, livingRoom.id, "TV");
      const second = await addTv(BEDROOM_TV, bedroomRoom.id, "TV");

      expect(await refusal(await send("PATCH", appliancePath(second.id), { roomId: livingRoom.id }), 409)).toBe(
        'There is already a TV called "TV" in Living room.',
      );

      const renamed = await send("PATCH", appliancePath(second.id), { name: "Big TV", roomId: livingRoom.id });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: second.id, name: "Big TV", roomId: livingRoom.id });

      const moved = await send("PATCH", appliancePath(first.id), { roomId: null });
      expect(await moved.json()).toMatchObject({ name: "TV", roomId: null });
      expect(await refusal(await send("PATCH", appliancePath(first.id), { name: "" }), 400)).toBe(
        "Give the TV a name.",
      );
      expect(await refusal(await send("PATCH", appliancePath(first.id), { roomId: 99 }), 409)).toBe(
        "That Room no longer exists.",
      );
    });

    it('moves a deleted Room\'s TVs to "No room", and deletes no Appliance', async () => {
      const livingRoom = await addRoom("Living room");
      const bedroomRoom = await addRoom("Bedroom");
      const first = await addTv(LIVING_ROOM_TV, livingRoom.id, "TV");
      const second = await addTv(BEDROOM_TV, bedroomRoom.id, "TV");

      expect((await send("DELETE", roomPath(livingRoom.id))).status).toBe(204);

      expect(await listAppliances()).toEqual([{ ...first, roomId: null }, second]);
      expect(storedCredentials()).toHaveLength(2);
    });

    it('keeps both TVs when deleting a Room leaves two called "TV" with no Room', async () => {
      const livingRoom = await addRoom("Living room");
      const bedroomRoom = await addRoom("Bedroom");
      await addTv(LIVING_ROOM_TV, livingRoom.id, "TV");
      await addTv(BEDROOM_TV, bedroomRoom.id, "TV");

      await send("DELETE", roomPath(livingRoom.id));
      await send("DELETE", roomPath(bedroomRoom.id));

      expect((await listAppliances()).map(({ name, roomId }) => ({ name, roomId }))).toEqual([
        { name: "TV", roomId: null },
        { name: "TV", roomId: null },
      ]);
    });
  });

  describe("pairing", () => {
    it('marks a TV "pair-again" when it refuses the token, and pairing again stores a new one', async () => {
      const tv = await addTv(LIVING_ROOM_TV, null);
      const [old] = living.issuedTokens();
      living.revokeAccess();

      const refused = await send("POST", applianceConnectionPath(tv.id));

      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({ ...tv, pairing: "pair-again" });
      expect(await listAppliances()).toEqual([{ ...tv, pairing: "pair-again" }]);

      const paired = await send("POST", appliancePairingPath(tv.id));

      expect(paired.status).toBe(200);
      expect(await paired.json()).toEqual(tv);
      const [, fresh] = living.issuedTokens();
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(old);
      expect(storedCredentials()).toEqual([{ appliance_id: tv.id, credentials: fresh }]);

      await send("POST", applianceConnectionPath(tv.id));
      expect(living.connections.at(-1)).toMatchObject({ token: fresh, outcome: "accepted" });
    });

    it("leaves a TV as it was when it can't be reached", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null);
      await living.stop();

      const message = await refusal(await send("POST", applianceConnectionPath(tv.id)), 502);

      expect(message).toContain(`No TV answered at ${LIVING_ROOM_TV}.`);
      expect(await listAppliances()).toEqual([tv]);
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });
  });

  describe("power state", () => {
    const power = async (id: number): Promise<AppliancePower> => {
      const response = await send("GET", appliancePowerPath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as AppliancePower;
    };

    it("follows each TV through on, standby and unreachable, read from its device info (FR-16)", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null, "Other TV");
      living.clearRequests();

      expect(await power(tv.id)).toEqual({ power: "on" });
      // One question to the TV, which its Driver's own tests say is its device info.
      expect(living.requests).toHaveLength(1);

      living.setPowerState("standby");
      expect(await power(tv.id)).toEqual({ power: "standby" });
      expect(await power(other.id)).toEqual({ power: "on" });

      living.setPowerState("on");
      expect(await power(tv.id)).toEqual({ power: "on" });

      await living.stop();
      expect(await power(tv.id)).toEqual({ power: "unreachable" });
      expect(await power(other.id)).toEqual({ power: "on" });
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });

    it("doesn't pair, connect or log to read it", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const connections = living.connections.length;
      const lines = logged.length;

      await power(tv.id);

      expect(living.connections).toHaveLength(connections);
      expect(logged).toHaveLength(lines);
    });

    it("refuses to read it for a TV that has been removed", async () => {
      expect(await refusal(await send("GET", appliancePowerPath(99)), 404)).toBe("That Appliance has been removed.");
    });
  });

  describe("the Power button (FR-17)", () => {
    const switchPower = async (id: number): Promise<PowerSwitch> => {
      const response = await send("POST", appliancePowerPath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as PowerSwitch;
    };

    const powerOf = async (id: number): Promise<AppliancePower["power"]> =>
      ((await (await send("GET", appliancePowerPath(id))).json()) as AppliancePower).power;

    /** The same fake TV, started again on the same ports, e.g. with other firmware. */
    const restartLiving = async (options: Parameters<typeof startFakeSamsungTv>[0] = {}): Promise<void> => {
      await living.stop();
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
        wakePort: bedroom.wakePort,
        macAddress: "02:00:00:00:00:0A",
        ...options,
      });
    };

    it("wakes a TV in standby with a magic packet for its MAC address, and it comes on", async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      await addTv(BEDROOM_TV, null);
      living.setPowerState("standby");

      expect(await switchPower(tv.id)).toEqual({ switching: "on" });

      await expect.poll(() => living.wakes.length).toBe(1);
      expect(living.wakes[0]?.macAddress).toBe("02:00:00:00:00:0a");
      expect(bedroom.wakes).toEqual([]);
      expect(living.keys).toEqual([]);
      expect(await powerOf(tv.id)).toBe("on");
      expect(logged).toContain("Sent Wake-on-LAN to Living room · TV, which was in standby");
    });

    it("wakes a TV that doesn't answer, as one whose firmware is silent in standby", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await restartLiving({ answersInStandby: false });
      living.setPowerState("standby");
      expect(await powerOf(tv.id)).toBe("unreachable");

      expect(await switchPower(tv.id)).toEqual({ switching: "on" });

      await expect.poll(() => living.wakes.map(({ macAddress }) => macAddress)).toEqual(["02:00:00:00:00:0a"]);
      expect(await powerOf(tv.id)).toBe("on");
      expect(logged).toContain("Sent Wake-on-LAN to TV, which didn't answer");
    });

    it("wakes a TV that must be paired again, which Wake-on-LAN needs no credentials for", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.revokeAccess();
      await send("POST", applianceConnectionPath(tv.id));
      living.setPowerState("standby");

      expect(await switchPower(tv.id)).toEqual({ switching: "on" });
      await expect.poll(() => living.wakes.length).toBe(1);
    });

    it("switches a TV that is on off with one press of its power key", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await switchPower(tv.id)).toEqual({ switching: "off" });

      await expect.poll(() => living.keys.length).toBe(1);
      expect(living.keys.map(({ code, command }) => ({ code, command }))).toEqual([
        { code: SAMSUNG_POWER_KEY, command: "Click" },
      ]);
      expect(living.wakes).toEqual([]);
      expect(await powerOf(tv.id)).toBe("standby");
      expect(logged).toContain("Switching TV off");

      expect(await switchPower(tv.id)).toEqual({ switching: "on" });
      await expect.poll(() => living.wakes.length).toBe(1);
      expect(await powerOf(tv.id)).toBe("on");
      expect(living.keys).toHaveLength(1);
    });

    it("holds the power key of a Frame TV, rather than pressing it, and it switches off", async () => {
      await restartLiving({ frame: true, frameHoldMs: 300 });
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await switchPower(tv.id)).toEqual({ switching: "off" });

      expect(living.keys.map(({ code, command }) => ({ code, command }))).toEqual([
        { code: SAMSUNG_POWER_KEY, command: "Press" },
        { code: SAMSUNG_POWER_KEY, command: "Release" },
      ]);
      expect(await powerOf(tv.id)).toBe("standby");
    });

    it('marks a TV "pair-again" when it no longer lets the Hub in to switch it off', async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      living.revokeAccess();

      const message = await refusal(await send("POST", appliancePowerPath(tv.id)), 409);

      expect(message).toBe("Living room · TV no longer lets the Hub in. Pair it again in Settings.");
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");
      expect(living.keys).toEqual([]);
      expect(await powerOf(tv.id)).toBe("on");
    });

    it("refuses for a TV that has been removed, and for a Driver that can't switch its Appliances", async () => {
      expect(await refusal(await send("POST", appliancePowerPath(99)), 404)).toBe("That Appliance has been removed.");

      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const { identify, pair, connect, readPowerState } = samsungTvDriver();
      const other = createHub({
        remoteDir: "/nonexistent",
        version: "9.9.9",
        hubId: "hub-1",
        database,
        drivers: { tv: { kind: "tv", identify, pair, connect, readPowerState } },
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const response = await fetch(
          `http://127.0.0.1:${String((other.address() as AddressInfo).port)}${appliancePowerPath(tv.id)}`,
          {
            method: "POST",
          },
        );
        expect(await refusal(response, 400)).toBe("TV can't be switched on or off.");
      } finally {
        await new Promise((done) => other.close(done));
      }
    });
  });

  describe("keys", () => {
    /** Any text, as the Hub takes from outside; the Driver says which are keys. */
    const press = (id: number, key: string): Promise<Response> => send("POST", applianceKeysPath(id), { key });

    /** Resolves once the TV has received `count` keys: the Hub answers once a key is sent, before the TV reads it. */
    const received = async (tv: FakeSamsungTv, count: number): Promise<void> => {
      await expect.poll(() => tv.keys.length).toBe(count);
    };

    /** The connections the TV let the Hub in on with a token it had already issued, as keys are sent on. */
    const keptSockets = (tv: FakeSamsungTv) => tv.connections.filter(({ outcome }) => outcome === "accepted");

    it("presses each key on the TV, and answers once it is sent (FR-18)", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      for (const key of ["up", "ok", "back"] as const) expect((await press(tv.id, key)).status).toBe(204);

      await received(living, 3);
      expect(bedroom.keys).toEqual([]);
    });

    it("keeps the TV's control socket open between key presses, rather than connecting for each (FR-22)", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null);

      for (const key of ["up", "up", "right", "ok", "back", "home"] as const) await press(tv.id, key);
      await press(other.id, "ok");
      await press(tv.id, "menu");

      await received(living, 7);
      await received(bedroom, 1);
      expect(keptSockets(living)).toHaveLength(1);
      expect(living.keys.every(({ connection }) => living.connections[connection]?.outcome === "accepted")).toBe(true);
      expect(keptSockets(bedroom)).toHaveLength(1);
    });

    it("opens the control socket again once the TV has closed it, e.g. going into standby", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await press(tv.id, "up");
      await received(living, 1);

      await living.dropConnections();
      expect((await press(tv.id, "down")).status).toBe(204);

      await received(living, 2);
      expect(keptSockets(living)).toHaveLength(2);
    });

    it("refuses a key the TV doesn't have, and sends nothing", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await refusal(await press(tv.id, "self-destruct"), 400)).toBe("The TV has no such key.");
      expect(keptSockets(living)).toEqual([]);
      expect(living.keys).toEqual([]);
    });

    it.each([[{}], [{ key: "" }], [{ key: 7 }], [{ key: "x".repeat(41) }], [[]]])(
      "refuses %j, saying to name a key",
      async (body) => {
        const tv = await addTv(LIVING_ROOM_TV, null, "TV");

        expect(await refusal(await send("POST", applianceKeysPath(tv.id), body), 400)).toBe("Say which key to press.");
        expect(living.keys).toEqual([]);
      },
    );

    it('marks a TV "pair-again" when it no longer lets the Hub in, and its keys work once it is paired again', async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      await press(tv.id, "up");
      await received(living, 1);

      living.revokeAccess();
      await living.dropConnections();
      const message = await refusal(await press(tv.id, "down"), 409);

      expect(message).toBe("Living room · TV no longer lets the Hub in. Pair it again in Settings.");
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");
      expect(logged).toContain("Living room · TV refused the Hub's credentials, so it needs pairing again");
      expect(living.keys).toHaveLength(1);

      expect((await send("POST", appliancePairingPath(tv.id))).status).toBe(200);
      expect((await press(tv.id, "down")).status).toBe(204);
      await received(living, 2);
      expect((await listAppliances())[0]?.pairing).toBe("paired");
    });

    it("says so when the TV can't be reached, and leaves it as it was", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await press(tv.id, "up");
      await living.stop();

      const message = await refusal(await press(tv.id, "down"), 502);

      expect(message).toBe(
        "No TV answered at 127.0.0.2. Check that it is switched on and on the same network as the Hub.",
      );
      expect(await listAppliances()).toEqual([tv]);
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });

    it("closes the TV's control socket when it is removed", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await press(tv.id, "up");

      expect((await send("DELETE", appliancePath(tv.id))).status).toBe(204);
      const again = await addTv(LIVING_ROOM_TV, null, "TV");
      await press(again.id, "down");

      expect(keptSockets(living)).toHaveLength(2);
      expect(await refusal(await press(tv.id, "up"), 404)).toBe("That Appliance has been removed.");
    });
  });

  describe("TV Menu shortcuts (FR-24)", () => {
    /** Any text, as the Hub takes from outside; the Driver says which are shortcuts. */
    const press = (id: number, shortcut: string): Promise<Response> =>
      send("POST", applianceShortcutsPath(id), { shortcut });

    const outcome = async (response: Response): Promise<ShortcutOutcome> => {
      expect(response.status).toBe(200);
      return (await response.json()) as ShortcutOutcome;
    };

    it("presses the shortcut's key on the TV, and doesn't claim the TV took it, as the TV doesn't say", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await outcome(await press(tv.id, "picture-mode"))).toEqual({ outcome: "unconfirmed" });

      expect(living.keys.map(({ code }) => code)).toEqual([SAMSUNG_SHORTCUT_KEY_CODES["picture-mode"]]);
      expect(bedroom.keys).toEqual([]);
    });

    it("says the TV ignored the shortcut when the TV says so, and logs it", async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      living.ignoreKeys({ keys: [SAMSUNG_SHORTCUT_KEY_CODES["energy-saving"]], answer: "error" });

      expect(await outcome(await press(tv.id, "energy-saving"))).toEqual({ outcome: "ignored" });
      expect(await outcome(await press(tv.id, "sleep-timer"))).toEqual({ outcome: "unconfirmed" });

      expect(logged).toContain("Living room · TV said it ignored the energy-saving shortcut's key");
      expect(logged.filter((line) => line.includes("sleep-timer"))).toEqual([]);
    });

    it("answers with its headers once the key is sent, and with the outcome only once it has listened", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      const response = await fetch(`${base}${applianceShortcutsPath(tv.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shortcut: "captions" }),
      });
      const headersAt = Date.now();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = (await response.json()) as ShortcutOutcome;

      expect(Date.now() - headersAt).toBeGreaterThanOrEqual(SHORTCUT_LISTEN_MS - 100);
      expect(body).toEqual({ outcome: "unconfirmed" });
      expect(living.keys.map(({ code }) => code)).toEqual([SAMSUNG_SHORTCUT_KEY_CODES.captions]);
    });

    it("refuses a shortcut the TV doesn't have, including one of the Remote's keys, and sends nothing", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      for (const shortcut of ["picture", "ok", "factory"]) {
        expect(await refusal(await press(tv.id, shortcut), 400)).toBe("The TV has no such shortcut.");
      }
      expect(living.keys).toEqual([]);
    });

    it.each([[{}], [{ shortcut: "" }], [{ shortcut: 7 }], [{ shortcut: "x".repeat(41) }], [[]]])(
      "refuses %j, saying to name a shortcut",
      async (body) => {
        const tv = await addTv(LIVING_ROOM_TV, null, "TV");

        expect(await refusal(await send("POST", applianceShortcutsPath(tv.id), body), 400)).toBe(
          "Say which shortcut to press.",
        );
        expect(living.keys).toEqual([]);
      },
    );

    it("presses nothing but POST", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      const response = await send("GET", applianceShortcutsPath(tv.id));

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });

    it('marks a TV "pair-again" when it no longer lets the Hub in', async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      living.revokeAccess();

      const message = await refusal(await press(tv.id, "input-source"), 409);

      expect(message).toBe("Living room · TV no longer lets the Hub in. Pair it again in Settings.");
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");
      expect(living.keys).toEqual([]);
    });

    it("says so when the TV can't be reached", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await living.stop();

      const message = await refusal(await press(tv.id, "audio-track"), 502);

      expect(message).toBe(
        "No TV answered at 127.0.0.2. Check that it is switched on and on the same network as the Hub.",
      );
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });
  });

  describe("volume (FR-19)", () => {
    const volume = async (id: number): Promise<ApplianceVolume> => {
      const response = await send("GET", applianceVolumePath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as ApplianceVolume;
    };

    const change = (id: number, body: unknown): Promise<Response> => send("PATCH", applianceVolumePath(id), body);

    it("reads each TV's own volume and mute, as they are after its own remote changed them", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null, "Other TV");
      bedroom.setVolume({ volume: 40 });

      expect(await volume(tv.id)).toEqual({ known: true, volume: 11, muted: false });
      expect(await volume(other.id)).toEqual({ known: true, volume: 40, muted: false });

      living.setVolume({ volume: 31, muted: true });
      expect(await volume(tv.id)).toEqual({ known: true, volume: 31, muted: true });
    });

    it("sets the volume to 18, and answers with it as the TV says it is", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await addTv(BEDROOM_TV, null, "Other TV");

      const response = await change(tv.id, { volume: 18 });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ known: true, volume: 18, muted: false });
      expect(living.volume()).toEqual({ volume: 18, muted: false });
      expect(bedroom.volume()).toEqual({ volume: 11, muted: false });
    });

    it("mutes and unmutes the TV, and sets both at once", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await (await change(tv.id, { muted: true })).json()).toEqual({ known: true, volume: 11, muted: true });
      expect(living.volume()).toEqual({ volume: 11, muted: true });
      expect(await (await change(tv.id, { volume: 5, muted: false })).json()).toEqual({
        known: true,
        volume: 5,
        muted: false,
      });
      expect(living.volume()).toEqual({ volume: 5, muted: false });
    });

    it("says the volume is not known for a TV in standby, and refuses to set it, which volume up and down still do", async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      living.setPowerState("standby");

      expect(await volume(tv.id)).toEqual({ known: false });
      expect(await refusal(await change(tv.id, { volume: 18 }), 502)).toBe(
        "The TV at 127.0.0.2 isn't answering for its volume, as when it is in standby. Volume up and down still work.",
      );
      expect(living.volume()).toEqual({ volume: 11, muted: false });

      expect((await send("POST", applianceKeysPath(tv.id), { key: "volume-up" })).status).toBe(204);
      expect((await send("POST", applianceKeysPath(tv.id), { key: "volume-down" })).status).toBe(204);
      await expect.poll(() => living.keys.length).toBe(2);
    });

    it("doesn't pair, connect or log to read or set it", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const connections = living.connections.length;
      const lines = logged.length;

      await volume(tv.id);
      await change(tv.id, { volume: 18 });
      await change(tv.id, { muted: true });

      expect(living.connections).toHaveLength(connections);
      expect(logged).toHaveLength(lines);
    });

    it.each([
      [{ volume: 101 }, "Give the volume as a whole number from 0 to 100."],
      [{ volume: -1 }, "Give the volume as a whole number from 0 to 100."],
      [{ volume: 17.5 }, "Give the volume as a whole number from 0 to 100."],
      [{ volume: "18" }, "Give the volume as a whole number from 0 to 100."],
      [{ muted: "yes" }, "Say whether to mute, as true or false."],
      [{}, "Say what to change: the volume, the mute or both."],
      [[], "Say what to change: the volume, the mute or both."],
      [null, "Say what to change."],
    ])("refuses to set %j, and changes nothing", async (body, message) => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await refusal(await change(tv.id, body), 400)).toBe(message);
      expect(living.volume()).toEqual({ volume: 11, muted: false });
      expect(living.upnpRequests).toEqual([]);
    });

    it("refuses for a TV that has been removed", async () => {
      expect(await refusal(await send("GET", applianceVolumePath(99)), 404)).toBe("That Appliance has been removed.");
      expect(await refusal(await change(99, { volume: 18 }), 404)).toBe("That Appliance has been removed.");
    });

    it("says the volume is not known, and refuses to set it, for a Driver whose Appliances can't say it", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const { identify, pair, connect, readPowerState } = samsungTvDriver();
      const other = createHub({
        remoteDir: "/nonexistent",
        version: "9.9.9",
        hubId: "hub-1",
        database,
        drivers: { tv: { kind: "tv", identify, pair, connect, readPowerState } },
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const url = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}${applianceVolumePath(tv.id)}`;
        expect(await (await fetch(url)).json()).toEqual({ known: false });
        const response = await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ volume: 18 }),
        });
        expect(await refusal(response, 400)).toBe("TV's volume can't be set.");
      } finally {
        await new Promise((done) => other.close(done));
      }
    });
  });

  describe("the on-screen keyboard (FR-20)", () => {
    const keyboard = async (id: number): Promise<ApplianceKeyboard> => {
      const response = await send("GET", applianceKeyboardPath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as ApplianceKeyboard;
    };

    /** Whether the Hub says the keyboard is open, once it says `open`: the TV's word takes a moment to arrive. */
    const saysOpen = async (id: number, open: boolean): Promise<void> => {
      await expect.poll(async () => keyboard(id)).toEqual({ open });
    };

    const type = (id: number, body: unknown): Promise<Response> => send("POST", applianceKeyboardPath(id), body);

    it("says whether each TV's keyboard is open, following the TV as it opens and closes it", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null, "Other TV");
      expect(await keyboard(tv.id)).toEqual({ open: false });
      expect(await keyboard(other.id)).toEqual({ open: false });

      living.setKeyboard(true);
      await saysOpen(tv.id, true);
      expect(await keyboard(other.id)).toEqual({ open: false });

      living.setKeyboard(false);
      await saysOpen(tv.id, false);
    });

    it('types "cosmos documentary" into the TV\'s keyboard and submits it, exactly, which closes it', async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await addTv(BEDROOM_TV, null, "Other TV");
      await keyboard(tv.id);
      living.setKeyboard(true);
      await saysOpen(tv.id, true);

      expect((await type(tv.id, { text: "cosmos documentary" })).status).toBe(204);

      await saysOpen(tv.id, false);
      expect(living.texts.map(({ text, keyboardOpen }) => ({ text, keyboardOpen }))).toEqual([
        { text: "cosmos documentary", keyboardOpen: true },
      ]);
      expect(bedroom.texts).toEqual([]);
    });

    it.each(["café", "Ünïcödé ß", "日本語", "🎬 films"])("types %j intact", async (text) => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.setKeyboard(true);

      expect((await type(tv.id, { text })).status).toBe(204);

      await expect.poll(() => living.texts.map((each) => each.text)).toEqual([text]);
    });

    it("never logs the text, which may be a password", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.setKeyboard(true);
      const lines = logged.length;

      await type(tv.id, { text: "hunter2-secret" });
      await keyboard(tv.id);

      await expect.poll(() => living.texts.length).toBe(1);
      expect(logged).toHaveLength(lines);
      for (const line of logged) expect(line).not.toContain("hunter2-secret");
    });

    it.each([
      [{}, "Type something to send to the TV."],
      [{ text: "" }, "Type something to send to the TV."],
      [{ text: 7 }, "Type something to send to the TV."],
      [[], "Type something to send to the TV."],
      [null, "Type something to send to the TV."],
      [{ text: "x".repeat(1_001) }, "Send at most 1,000 characters at a time."],
      [{ text: "broken \ud83c" }, "That text has a broken character in it. Type it again."],
    ])("refuses to type %j, and sends nothing", async (body, message) => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.setKeyboard(true);

      expect(await refusal(await type(tv.id, body), 400)).toBe(message);
      expect(living.connections.filter(({ outcome }) => outcome === "accepted")).toEqual([]);
    });

    it("says the keyboard isn't open for a TV that can't be reached, and says so when text can't be typed", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await living.stop();

      expect(await keyboard(tv.id)).toEqual({ open: false });
      expect(await refusal(await type(tv.id, { text: "café" }), 502)).toBe(
        "No TV answered at 127.0.0.2. Check that it is switched on and on the same network as the Hub.",
      );
      expect(await listAppliances()).toEqual([tv]);
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });

    it('marks a TV "pair-again" when it no longer lets the Hub in, then stops asking it about its keyboard until it is paired again', async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      await keyboard(tv.id);
      living.setKeyboard(true);
      await saysOpen(tv.id, true);

      living.revokeAccess();
      await living.dropConnections();
      expect(await refusal(await type(tv.id, { text: "café" }), 409)).toBe(
        "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
      );
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");

      // A TV may ask the person to allow the Hub each time it is asked, so it isn't, every second.
      const connections = living.connections.length;
      expect(await keyboard(tv.id)).toEqual({ open: false });
      expect(living.connections).toHaveLength(connections);

      expect((await send("POST", appliancePairingPath(tv.id))).status).toBe(200);
      expect((await type(tv.id, { text: "café" })).status).toBe(204);
      await expect.poll(() => living.texts.map(({ text }) => text)).toEqual(["café"]);
      expect(living.texts).toHaveLength(1);
    });

    it("refuses for a TV that has been removed", async () => {
      expect(await refusal(await send("GET", applianceKeyboardPath(99)), 404)).toBe("That Appliance has been removed.");
      expect(await refusal(await type(99, { text: "café" }), 404)).toBe("That Appliance has been removed.");
    });

    it("says the keyboard isn't open, and refuses text, for a Driver whose Appliances have no keyboard", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const { identify, pair, connect, readPowerState } = samsungTvDriver();
      const other = createHub({
        remoteDir: "/nonexistent",
        version: "9.9.9",
        hubId: "hub-1",
        database,
        drivers: { tv: { kind: "tv", identify, pair, connect, readPowerState } },
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const url = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}${applianceKeyboardPath(tv.id)}`;
        expect(await (await fetch(url)).json()).toEqual({ open: false });
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "café" }),
        });
        expect(await refusal(response, 400)).toBe("TV has no keyboard to type on.");
      } finally {
        await new Promise((done) => other.close(done));
      }
    });
  });

  describe("apps (FR-21)", () => {
    const apps = async (id: number): Promise<ApplianceApps> => {
      const response = await send("GET", applianceAppsPath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as ApplianceApps;
    };

    const icon = async (id: number, appId: string): Promise<Response> => {
      const response = await fetch(`${base}${applianceAppIconPath(id, appId)}`);
      return response;
    };

    const runningOn = (fake: FakeSamsungTv) =>
      fake
        .apps()
        .filter(({ running }) => running)
        .map(({ name, visible }) => ({ name, visible }));

    it("lists each TV's installed apps, in name order, with whether it gives an icon for each", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null, "Other TV");
      bedroom.setApps([{ id: "a.plex", name: "Plex" }]);

      expect(await apps(tv.id)).toEqual({
        known: true,
        apps: [
          { id: "org.tizen.browser", name: "Internet", icon: false },
          { id: "3201907018807", name: "Netflix", icon: true },
          { id: "3201910019365", name: "Prime Video", icon: true },
          { id: "111299001912", name: "YouTube", icon: true },
        ],
      });
      expect(await apps(other.id)).toEqual({ known: true, apps: [{ id: "a.plex", name: "Plex", icon: true }] });
    });

    it("answers with an app's icon, as the TV gives it, which the browser may keep a while", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await apps(tv.id);

      const response = await icon(tv.id, "111299001912");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fakeAppIcon("111299001912"));
      const head = await fetch(`${base}${applianceAppIconPath(tv.id, "111299001912")}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    });

    it("answers 404 for the icon of an app the TV gives none for, or hasn't got", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await refusal(await icon(tv.id, "org.tizen.browser"), 404)).toBe("TV gives no icon for that app.");
      expect(await refusal(await icon(tv.id, "no.such.app"), 404)).toBe("TV gives no icon for that app.");
    });

    it("launches an app, which the TV then says is running and visible, and logs it", async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      await addTv(BEDROOM_TV, null, "Other TV");

      expect((await send("POST", applianceAppPath(tv.id, "111299001912"))).status).toBe(204);

      expect(runningOn(living)).toEqual([{ name: "YouTube", visible: true }]);
      expect(runningOn(bedroom)).toEqual([]);
      expect(logged).toContain("Launched app 111299001912 on Living room · TV");
    });

    it("closes an app, which the TV then says is no longer running", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await send("POST", applianceAppPath(tv.id, "111299001912"));
      await send("POST", applianceAppPath(tv.id, "org.tizen.browser"));

      expect((await send("DELETE", applianceAppPath(tv.id, "111299001912"))).status).toBe(204);

      expect(runningOn(living)).toEqual([{ name: "Internet", visible: true }]);
      expect(logged).toContain("Closed app 111299001912 on TV");
    });

    it("says a TV in standby is in standby, rather than that it has no apps, and launches nothing on it", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.setPowerState("standby");

      expect(await apps(tv.id)).toEqual({ known: false, why: "standby" });
      expect(await refusal(await send("POST", applianceAppPath(tv.id, "111299001912")), 502)).toBe(
        "The TV at 127.0.0.2 isn't answering for its apps, as when it is in standby.",
      );
      expect(runningOn(living)).toEqual([]);

      living.setPowerState("on");
      expect(await apps(tv.id)).toMatchObject({ known: true });
    });

    it("says a TV that can't be reached is unreachable, rather than that it has no apps", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await living.stop();

      expect(await apps(tv.id)).toEqual({ known: false, why: "unreachable" });
      expect(await refusal(await send("DELETE", applianceAppPath(tv.id, "111299001912")), 502)).toBe(
        "The TV at 127.0.0.2 isn't answering for its apps, as when it is in standby.",
      );
      expect(await listAppliances()).toEqual([tv]);
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });

    it('marks a TV "pair-again" when it no longer lets the Hub in, then stops asking it for its apps until it is paired again', async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      living.revokeAccess();

      expect(await refusal(await send("GET", applianceAppsPath(tv.id)), 409)).toBe(
        "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
      );
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");

      // A TV may ask the person to allow the Hub each time it is asked.
      const connections = living.connections.length;
      expect(await refusal(await send("GET", applianceAppsPath(tv.id)), 409)).toBe(
        "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
      );
      expect((await icon(tv.id, "111299001912")).status).toBe(409);
      expect(living.connections).toHaveLength(connections);

      expect((await send("POST", appliancePairingPath(tv.id))).status).toBe(200);
      expect(await apps(tv.id)).toMatchObject({ known: true });
    });

    it.each(["no.such.app", "a".repeat(100)])(
      "refuses to launch or close %j, which the TV hasn't got",
      async (appId) => {
        const tv = await addTv(LIVING_ROOM_TV, null, "TV");

        for (const method of ["POST", "DELETE"]) {
          expect(await refusal(await send(method, applianceAppPath(tv.id, appId)), 400)).toBe(
            "The TV has no such app.",
          );
        }
      },
    );

    it.each(["a".repeat(101), "a b", "a%2Fb", "...", "-_.", "%E0%A4%A", "caf%C3%A9"])(
      "refuses an app id that can't be one, %j, without asking the TV",
      async (appId) => {
        const tv = await addTv(LIVING_ROOM_TV, null, "TV");
        living.clearRequests();

        const response = await fetch(`${base}${applianceAppsPath(tv.id)}/${appId}`, { method: "POST" });

        expect(await refusal(response, 400)).toBe("The TV has no such app.");
        expect(living.requests).toEqual([]);
      },
    );

    it("refuses other methods", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect((await send("POST", applianceAppsPath(tv.id))).status).toBe(405);
      expect((await send("GET", applianceAppPath(tv.id, "111299001912"))).status).toBe(405);
      expect((await send("POST", applianceAppIconPath(tv.id, "111299001912"))).status).toBe(405);
    });

    it("refuses for a TV that has been removed", async () => {
      expect(await refusal(await send("GET", applianceAppsPath(99)), 404)).toBe("That Appliance has been removed.");
      expect(await refusal(await send("POST", applianceAppPath(99, "111299001912")), 404)).toBe(
        "That Appliance has been removed.",
      );
      expect(await refusal(await icon(99, "111299001912"), 404)).toBe("That Appliance has been removed.");
    });

    it("refuses for a Driver whose Appliances have no apps", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const { identify, pair, connect, readPowerState } = samsungTvDriver();
      const other = createHub({
        remoteDir: "/nonexistent",
        version: "9.9.9",
        hubId: "hub-1",
        database,
        drivers: { tv: { kind: "tv", identify, pair, connect, readPowerState } },
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const url = (path: string) => `http://127.0.0.1:${String((other.address() as AddressInfo).port)}${path}`;
        expect(await refusal(await fetch(url(applianceAppsPath(tv.id))), 400)).toBe("TV has no apps.");
        expect(await refusal(await fetch(url(applianceAppIconPath(tv.id, "a.b"))), 400)).toBe("TV has no apps.");
        expect(await refusal(await fetch(url(applianceAppPath(tv.id, "a.b")), { method: "POST" }), 400)).toBe(
          "TV has no apps.",
        );
      } finally {
        await new Promise((done) => other.close(done));
      }
    });

    it("never sends or logs the TV's token", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await apps(tv.id);
      await send("POST", applianceAppPath(tv.id, "111299001912"));
      await send("DELETE", applianceAppPath(tv.id, "111299001912"));

      for (const token of issuedTokens()) {
        for (const text of [...answers, ...logged]) expect(text).not.toContain(token);
      }
    });
  });

  describe("Now Showing (FR-26)", () => {
    const nowShowing = async (id: number): Promise<NowShowing> => {
      const response = await send("GET", applianceNowShowingPath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as NowShowing;
    };

    it("says which app is in front on each TV, as the TV says, with whether it gives an icon for it", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null, "Other TV");
      living.bringToFront("111299001912");
      bedroom.bringToFront("org.tizen.browser");

      expect(await nowShowing(tv.id)).toEqual({
        known: true,
        app: { id: "111299001912", name: "YouTube", icon: true },
      });
      expect(await nowShowing(other.id)).toEqual({
        known: true,
        app: { id: "org.tizen.browser", name: "Internet", icon: false },
      });

      // As launched with the TV's own remote, or with the Remote.
      living.bringToFront("3201907018807");
      expect(await nowShowing(tv.id)).toMatchObject({ app: { name: "Netflix" } });
      expect((await send("POST", applianceAppPath(tv.id, "3201910019365"))).status).toBe(204);
      expect(await nowShowing(tv.id)).toMatchObject({ app: { name: "Prime Video" } });
    });

    it("says it can't tell when no app says it is in front, rather than guessing", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await nowShowing(tv.id)).toEqual({ known: false, why: "cannot-tell" });

      // As live TV would, with apps still running behind it.
      living.bringToFront("111299001912");
      living.bringToFront(undefined);
      expect(await nowShowing(tv.id)).toEqual({ known: false, why: "cannot-tell" });
    });

    it("says a TV in standby is in standby, and one that can't be reached is unreachable", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.bringToFront("111299001912");

      living.setPowerState("standby");
      expect(await nowShowing(tv.id)).toEqual({ known: false, why: "standby" });

      await living.stop();
      expect(await nowShowing(tv.id)).toEqual({ known: false, why: "unreachable" });
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });

    it("changes nothing on the TV it asks, nor on any other, and logs nothing", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await addTv(BEDROOM_TV, null, "Other TV");
      living.bringToFront("111299001912");
      bedroom.bringToFront("3201907018807");
      const before = [living.apps(), bedroom.apps()];
      living.clearRequests();
      bedroom.clearRequests();
      const lines = logged.length;

      await nowShowing(tv.id);
      await nowShowing(tv.id);

      expect([living.apps(), bedroom.apps()]).toEqual(before);
      expect(living.requests.every(({ method }) => method === "GET")).toBe(true);
      expect(bedroom.requests).toEqual([]);
      expect([...living.keys, ...bedroom.keys]).toEqual([]);
      expect(living.wakes).toEqual([]);
      expect(living.upnpRequests).toEqual([]);
      expect(logged).toHaveLength(lines);
    });

    it('marks a TV "pair-again" when it no longer lets the Hub in, then stops asking it until it is paired again', async () => {
      const room = await addRoom("Living room");
      const tv = await addTv(LIVING_ROOM_TV, room.id, "TV");
      living.revokeAccess();

      expect(await refusal(await send("GET", applianceNowShowingPath(tv.id)), 409)).toBe(
        "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
      );
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");
      const connections = living.connections.length;
      expect((await send("GET", applianceNowShowingPath(tv.id))).status).toBe(409);
      expect(living.connections).toHaveLength(connections);

      expect((await send("POST", appliancePairingPath(tv.id))).status).toBe(200);
      expect(await nowShowing(tv.id)).toEqual({ known: false, why: "cannot-tell" });
    });

    it("refuses other methods, a TV that has been removed, and a Driver whose Appliances can't say", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      expect((await send("POST", applianceNowShowingPath(tv.id))).status).toBe(405);
      expect((await send("HEAD", applianceNowShowingPath(tv.id))).status).toBe(200);
      expect(await refusal(await send("GET", applianceNowShowingPath(99)), 404)).toBe(
        "That Appliance has been removed.",
      );

      const { identify, pair, connect, readPowerState } = samsungTvDriver();
      const other = createHub({
        remoteDir: "/nonexistent",
        version: "9.9.9",
        hubId: "hub-1",
        database,
        drivers: { tv: { kind: "tv", identify, pair, connect, readPowerState } },
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const url = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}${applianceNowShowingPath(tv.id)}`;
        expect(await refusal(await fetch(url), 400)).toBe("TV can't say what it is showing.");
      } finally {
        await new Promise((done) => other.close(done));
      }
    });

    it("never sends or logs the TV's token", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.bringToFront("111299001912");
      await nowShowing(tv.id);

      for (const token of issuedTokens()) {
        for (const text of [...answers, ...logged]) expect(text).not.toContain(token);
      }
    });
  });

  describe("device info (FR-28)", () => {
    const deviceInfo = async (id: number): Promise<ApplianceDeviceInfo> => {
      const response = await send("GET", applianceDeviceInfoPath(id));
      expect(response.status).toBe(200);
      return (await response.json()) as ApplianceDeviceInfo;
    };

    it("reads each TV's model, name, MAC address, network type, Frame support, Developer Mode and Developer IP", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      const other = await addTv(BEDROOM_TV, null, "Other TV");
      bedroom.setDeveloper({ mode: "on", ip: "192.168.1.10" });

      expect(await deviceInfo(tv.id)).toEqual({
        known: true,
        info: {
          name: "[TV] Samsung Q60 Series (55)",
          model: "QE55Q60TAUXXU",
          macAddress: "02:00:00:00:00:0a",
          networkType: "wireless",
          frame: false,
          developer: { mode: "off", ip: null },
        },
      });
      expect(await deviceInfo(other.id)).toEqual({
        known: true,
        info: {
          name: "[TV] Samsung S95C (65)",
          model: "QE65S95CATXXU",
          macAddress: "02:00:00:00:00:0b",
          networkType: "wireless",
          frame: false,
          developer: { mode: "on", ip: "192.168.1.10" },
        },
      });
    });

    it("follows the TV as Developer Mode is switched on at it, and says when it reports neither it nor the Developer IP", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      living.setDeveloper({ mode: "on", ip: "192.168.1.10" });
      expect(await deviceInfo(tv.id)).toMatchObject({ info: { developer: { mode: "on", ip: "192.168.1.10" } } });

      living.setDeveloper(null);
      expect(await deviceInfo(tv.id)).toMatchObject({ known: true, info: { developer: null } });
    });

    it("reads a Frame TV as one, on a cable, from its device info", async () => {
      await living.stop();
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
        frame: true,
        device: { networkType: "wired" },
      });
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      expect(await deviceInfo(tv.id)).toMatchObject({ info: { frame: true, networkType: "wired" } });
    });

    it("reads a TV in standby, and says one that can't be reached is unreachable", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");

      living.setPowerState("standby");
      expect(await deviceInfo(tv.id)).toMatchObject({ known: true, info: { model: "QE55Q60TAUXXU" } });

      await living.stop();
      expect(await deviceInfo(tv.id)).toEqual({ known: false, why: "unreachable" });
      living = await startFakeSamsungTv({
        host: LIVING_ROOM_TV,
        restPort: bedroom.restPort,
        controlPort: bedroom.controlPort,
      });
    });

    it("changes nothing on the TV it asks, nor on any other, connects to neither and logs nothing", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await addTv(BEDROOM_TV, null, "Other TV");
      living.clearRequests();
      bedroom.clearRequests();
      const connections = [living.connections.length, bedroom.connections.length];
      const lines = logged.length;

      await deviceInfo(tv.id);
      await deviceInfo(tv.id);

      // One read of the TV's device info for each.
      expect(living.requests).toHaveLength(2);
      expect(living.requests.every(({ method }) => method === "GET")).toBe(true);
      expect(bedroom.requests).toEqual([]);
      expect([living.connections.length, bedroom.connections.length]).toEqual(connections);
      expect([...living.keys, ...bedroom.keys]).toEqual([]);
      expect(living.wakes).toEqual([]);
      expect(living.upnpRequests).toEqual([]);
      expect(logged).toHaveLength(lines);
    });

    it('reads a TV marked "pair-again" too, as device info needs no pairing', async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      living.revokeAccess();
      expect((await send("POST", applianceConnectionPath(tv.id))).status).toBe(200);
      expect((await listAppliances())[0]?.pairing).toBe("pair-again");

      expect(await deviceInfo(tv.id)).toMatchObject({ known: true, info: { model: "QE55Q60TAUXXU" } });
    });

    it("refuses other methods, a TV that has been removed, and a Driver whose Appliances report none", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      expect((await send("POST", applianceDeviceInfoPath(tv.id))).status).toBe(405);
      expect((await send("HEAD", applianceDeviceInfoPath(tv.id))).status).toBe(200);
      expect(await refusal(await send("GET", applianceDeviceInfoPath(99)), 404)).toBe(
        "That Appliance has been removed.",
      );

      const { identify, pair, connect, readPowerState } = samsungTvDriver();
      const other = createHub({
        remoteDir: "/nonexistent",
        version: "9.9.9",
        hubId: "hub-1",
        database,
        drivers: { tv: { kind: "tv", identify, pair, connect, readPowerState } },
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const url = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}${applianceDeviceInfoPath(tv.id)}`;
        expect(await refusal(await fetch(url), 400)).toBe("TV reports no device info.");
      } finally {
        await new Promise((done) => other.close(done));
      }
    });

    it("never sends or logs the TV's token", async () => {
      const tv = await addTv(LIVING_ROOM_TV, null, "TV");
      await deviceInfo(tv.id);

      for (const token of issuedTokens()) {
        for (const text of [...answers, ...logged]) expect(text).not.toContain(token);
      }
    });
  });

  describe("removing", () => {
    it("deletes the TV and its stored token, even from the database file", async () => {
      const first = await addTv(LIVING_ROOM_TV, null, "TV");
      const second = await addTv(BEDROOM_TV, null, "Other TV");
      const [token] = living.issuedTokens();
      expect((await readFile(databaseFile)).includes(token ?? "")).toBe(true);

      expect((await send("DELETE", appliancePath(first.id))).status).toBe(204);

      expect(await listAppliances()).toEqual([second]);
      expect(storedCredentials().map((row) => row.appliance_id)).toEqual([second.id]);
      expect((await readFile(databaseFile)).includes(token ?? "")).toBe(false);
      expect((await send("POST", applianceConnectionPath(first.id))).status).toBe(404);
    });

    it("refuses to remove a TV that doesn't exist", async () => {
      expect(await refusal(await send("DELETE", appliancePath(99)), 404)).toBe("That Appliance has been removed.");
    });
  });

  it.each([
    ["DELETE", APPLIANCES_PATH, "GET, HEAD, POST"],
    ["GET", appliancePath(1), "PATCH, DELETE"],
    ["GET", applianceConnectionPath(1), "POST"],
    ["PUT", appliancePairingPath(1), "POST"],
    ["PUT", appliancePowerPath(1), "GET, HEAD, POST"],
    ["GET", applianceKeysPath(1), "POST"],
    ["POST", applianceVolumePath(1), "GET, HEAD, PATCH"],
    ["PATCH", applianceKeyboardPath(1), "GET, HEAD, POST"],
    ["GET", APPLIANCE_SEARCH_PATH, "POST"],
  ])("refuses %s on %s, saying what it allows", async (method, path, allow) => {
    const response = await send(method, path);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
  });

  it("never sends a token to the Remote, nor writes one in a log line (FR-4)", async () => {
    const livingRoom = await addRoom("Living room");
    const tv = await addTv(LIVING_ROOM_TV, livingRoom.id, "TV");
    const other = await addTv(BEDROOM_TV, null);
    await send("POST", applianceConnectionPath(tv.id));
    await send("POST", applianceKeysPath(tv.id), { key: "ok" });
    living.revokeAccess();
    await send("POST", applianceConnectionPath(tv.id));
    await send("POST", applianceKeysPath(tv.id), { key: "ok" });
    await send("POST", appliancePairingPath(tv.id));
    await send("POST", applianceKeysPath(tv.id), { key: "ok" });
    await send("POST", applianceConnectionPath(tv.id));
    await send("POST", appliancePowerPath(tv.id));
    await send("POST", appliancePowerPath(tv.id));
    await send("PATCH", appliancePath(tv.id), { name: "Big TV" });
    await send("GET", APPLIANCES_PATH);
    await send("POST", APPLIANCES_PATH, { kind: "tv", address: LIVING_ROOM_TV, roomId: null });
    const tokens = issuedTokens();
    await bedroom.stop();
    await send("POST", applianceConnectionPath(other.id));
    await send("POST", appliancePairingPath(other.id));
    await send("DELETE", appliancePath(tv.id));
    bedroom = await startFakeSamsungTv({
      host: BEDROOM_TV,
      restPort: living.restPort,
      controlPort: living.controlPort,
    });

    expect(tokens).toHaveLength(3);
    expect(logged.length).toBeGreaterThan(0);
    for (const token of tokens) {
      for (const answer of answers) expect(answer).not.toContain(token);
      for (const line of logged) expect(line).not.toContain(token);
    }
  });
});
