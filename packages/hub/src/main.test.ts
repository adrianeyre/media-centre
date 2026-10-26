import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  APPLIANCE_SEARCH_PATH,
  APPLIANCES_PATH,
  HIVE_CODE_PATH,
  HIVE_PATH,
  HIVE_SIGN_IN_PATH,
  HUB_ADDRESS_PATH,
  HUB_INFO_PATH,
  LATEST_VERSION_PATH,
  LIGHT_SCENES_PATH,
  MEDIA_SOURCES_PATH,
  PLAYER_SOCKET_PATH,
  ROOM_ORDER_PATH,
  ROOMS_PATH,
  applianceConnectionPath,
  applianceKeysPath,
  appliancePairingPath,
  appliancePath,
  applianceStatePath,
  lightSceneRecallPath,
  lightScenePath,
  mediaFolderPath,
  mediaSourcePath,
  roomPath,
  type AirConditionerReading,
  type Appliance,
  type FoundLight,
  type HiveSignedIn,
  type HubAddress,
  type HubInfo,
  type LightReading,
  type LightScene,
  type LightSceneSaved,
  type LightsOutcome,
  type MediaFolder,
  type MediaSource,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { startFakeHiveCloud } from "./fakes/hive-cloud/fake-hive-cloud.ts";
import { startFakeLeproLight } from "./fakes/lepro-light/fake-lepro-light.ts";
import { startFakeMideaAircon } from "./fakes/midea-aircon/fake-midea-aircon.ts";
import { startFakeMideaCloud } from "./fakes/midea-cloud/fake-midea-cloud.ts";
import { startFakeSamsungTv, type FakeSamsungTv } from "./fakes/samsung-tv/fake-samsung-tv.ts";
import { startNodeProcess, type RunningProcess } from "./testing/process.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const LISTENING = /Hub listening on http:\/\/0\.0\.0\.0:(\d+)/;

let dir: string;
let running: RunningProcess[];
let tv: FakeSamsungTv | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-main-test-"));
  running = [];
});

afterEach(async () => {
  await Promise.all(running.map((hub) => hub.stop()));
  await tv?.stop();
  tv = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Starts the Hub as its own process, as `pnpm start` does, on a free port. */
const startHub = async (
  database: string,
  env: Readonly<Record<string, string>> = {},
): Promise<{ hub: RunningProcess; base: string }> => {
  const hub = await startNodeProcess(MAIN, { HUB_PORT: "0", HUB_DATABASE: database, ...env }, LISTENING);
  running.push(hub);
  return { hub, base: `http://127.0.0.1:${hub.match[1] ?? ""}` };
};

const hubInfo = async (base: string): Promise<HubInfo> =>
  (await (await fetch(`${base}${HUB_INFO_PATH}`)).json()) as HubInfo;

// Each test starts the Hub as its own process, once or twice, and
// `startNodeProcess` gives each start up to 10 seconds: Vitest's default 5
// isn't enough while the rest of the suite loads the machine.
describe("the Hub process", { timeout: 30_000 }, () => {
  it("creates its SQLite file where HUB_DATABASE says, on first start", async () => {
    const database = join(dir, "state", "media-centre.sqlite");
    expect(existsSync(database)).toBe(false);

    const { base } = await startHub(database);

    expect(existsSync(database)).toBe(true);
    expect((await hubInfo(base)).product).toBe("media-centre");
  });

  it("reads back after a restart what it wrote before it", async () => {
    const database = join(dir, "media-centre.sqlite");

    const first = await startHub(database);
    const before = await hubInfo(first.base);
    expect(await first.hub.stop()).toBe(0);

    const second = await startHub(database);
    const after = await hubInfo(second.base);

    expect(after.hubId).toMatch(/^[0-9a-f]{32}$/);
    expect(after.hubId).toBe(before.hubId);
  });

  it("keeps the Rooms, their names and their order across a restart", async () => {
    const database = join(dir, "media-centre.sqlite");
    const first = await startHub(database);
    const send = (method: string, path: string, body: unknown): Promise<Response> =>
      fetch(`${first.base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const added: Room[] = [];
    for (const name of ["Living room", "Bedroom", "Office"]) {
      added.push((await (await send("POST", ROOMS_PATH, { name })).json()) as Room);
    }
    const [living, bedroom, office] = added as [Room, Room, Room];
    await send("PUT", ROOM_ORDER_PATH, { roomIds: [office.id, living.id, bedroom.id] });
    await send("PATCH", roomPath(bedroom.id), { name: "Guest room" });
    const before = (await (await fetch(`${first.base}${ROOMS_PATH}`)).json()) as Room[];
    expect(await first.hub.stop()).toBe(0);

    const second = await startHub(database);
    const after = (await (await fetch(`${second.base}${ROOMS_PATH}`)).json()) as Room[];

    expect(after.map((room) => room.name)).toEqual(["Office", "Living room", "Guest room"]);
    expect(after).toEqual(before);
  });

  it("keeps the IP address set for the Hub in Settings across a restart", async () => {
    const database = join(dir, "media-centre.sqlite");
    const first = await startHub(database);
    const set = await fetch(`${first.base}${HUB_ADDRESS_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ override: "192.168.1.10" }),
    });
    expect(set.status).toBe(200);
    expect(await first.hub.stop()).toBe(0);

    const second = await startHub(database);
    const after = (await (await fetch(`${second.base}${HUB_ADDRESS_PATH}`)).json()) as HubAddress;

    expect(after).toMatchObject({ address: "192.168.1.10", override: "192.168.1.10" });
  });

  it("keeps the Media Sources, their names and their files' durations across a restart", async () => {
    const database = join(dir, "media-centre.sqlite");
    for (const folder of ["Films", "Music"]) await mkdir(join(dir, folder));
    await writeFile(join(dir, "Films", "Damaged.mkv"), "not really a video");
    const first = await startHub(database);
    const send = (method: string, path: string, body: unknown): Promise<Response> =>
      fetch(`${first.base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const films = (await (await send("POST", MEDIA_SOURCES_PATH, { path: join(dir, "Films") })).json()) as MediaSource;
    await send("POST", MEDIA_SOURCES_PATH, { path: join(dir, "Music"), name: "Albums" });
    await send("PATCH", mediaSourcePath(films.id), { name: "Cinema" });
    const before = (await (await fetch(`${first.base}${MEDIA_SOURCES_PATH}`)).json()) as MediaSource[];
    const folder = (await (await fetch(`${first.base}${mediaFolderPath(films.id, "")}`)).json()) as MediaFolder;
    expect(await first.hub.stop()).toBe(0);

    const second = await startHub(database);
    const after = (await (await fetch(`${second.base}${MEDIA_SOURCES_PATH}`)).json()) as MediaSource[];

    expect(after).toEqual([
      { id: expect.any(Number) as number, name: "Albums", path: join(dir, "Music") },
      { id: films.id, name: "Cinema", path: join(dir, "Films") },
    ]);
    expect(after).toEqual(before);
    expect(await (await fetch(`${second.base}${mediaFolderPath(films.id, "")}`)).json()).toEqual(folder);
    expect(first.hub.output).toContain(`Added the Media Source "Films", ${join(dir, "Films")}`);
  });

  it("keeps a TV and its token across a restart, and never shows the token to the Remote or in its output", async () => {
    tv = await startFakeSamsungTv();
    const database = join(dir, "media-centre.sqlite");
    const env = { SAMSUNG_TV_REST_PORT: String(tv.restPort), SAMSUNG_TV_CONTROL_PORT: String(tv.controlPort) };
    const answers: string[] = [];
    const send = async (base: string, method: string, path: string, body?: unknown): Promise<string> => {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      answers.push(text);
      return text;
    };

    const first = await startHub(database, env);
    const tvRequest = { kind: "tv", address: tv.host, roomId: null };
    const added = JSON.parse(
      await send(first.base, "POST", APPLIANCES_PATH, { ...tvRequest, name: "TV" }),
    ) as Appliance;
    await send(first.base, "POST", APPLIANCES_PATH, tvRequest);
    expect(await first.hub.stop()).toBe(0);
    const [token] = tv.issuedTokens();

    const second = await startHub(database, env);
    expect(JSON.parse(await send(second.base, "GET", APPLIANCES_PATH))).toEqual([added]);
    await send(second.base, "POST", applianceConnectionPath(added.id));
    expect(tv.connections.at(-1)).toMatchObject({ token, outcome: "accepted" });
    await send(second.base, "POST", applianceKeysPath(added.id), { key: "ok" });
    await expect.poll(() => tv?.keys.length).toBe(1);

    tv.revokeAccess();
    expect(JSON.parse(await send(second.base, "POST", applianceConnectionPath(added.id)))).toMatchObject({
      pairing: "pair-again",
    });
    await send(second.base, "POST", appliancePairingPath(added.id));
    await send(second.base, "DELETE", appliancePath(added.id));
    await second.hub.stop();

    const tokens = tv.issuedTokens();
    expect(tokens).toHaveLength(2);
    const output = [...first.hub.output, ...second.hub.output];
    expect(output.some((line) => line.includes("Paired TV again"))).toBe(true);
    for (const secret of tokens) {
      for (const line of output) expect(line).not.toContain(secret);
      for (const answer of answers) expect(answer).not.toContain(secret);
    }
  });

  it("keeps an Air Conditioner and its token and key across a restart, controlling it with the cloud gone, and never shows them or the login", async () => {
    const login = { account: "owner@example.com", password: "correct horse battery staple" };
    const aircon = await startFakeMideaAircon({ version: 3 });
    const cloud = await startFakeMideaCloud({
      ...login,
      units: [{ id: aircon.id, token: aircon.token ?? "", key: aircon.key ?? "" }],
    });
    const mideaAir = await startFakeMideaCloud({
      app: "Midea Air",
      account: "someone-else@example.com",
      password: "theirs",
    });
    try {
      const database = join(dir, "media-centre.sqlite");
      const env = {
        MIDEA_PORT: String(aircon.port),
        MIDEA_DISCOVERY_PORT: String(aircon.discoveryPort),
        MIDEA_CLOUD_URL: cloud.url,
        MIDEA_AIR_CLOUD_URL: mideaAir.url,
      };
      const answers: string[] = [];
      const send = async (base: string, method: string, path: string, body?: unknown): Promise<string> => {
        const response = await fetch(`${base}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        const text = await response.text();
        answers.push(text);
        return text;
      };

      const first = await startHub(database, env);
      const added = JSON.parse(
        await send(first.base, "POST", APPLIANCES_PATH, {
          kind: "air-conditioner",
          address: aircon.host,
          name: "Aircon",
          roomId: null,
          login,
        }),
      ) as Appliance;
      expect(added).toMatchObject({ kind: "air-conditioner", name: "Aircon", pairing: "paired" });
      expect(await first.hub.stop()).toBe(0);

      // The internet goes down, and the Hub restarts.
      await cloud.stop();
      const second = await startHub(database, env);
      expect(JSON.parse(await send(second.base, "GET", APPLIANCES_PATH))).toEqual([added]);
      const changed = JSON.parse(
        await send(second.base, "PATCH", applianceStatePath(added.id), { power: true, mode: "dry" }),
      ) as AirConditionerReading;
      expect(changed).toMatchObject({ known: true, state: { power: true, mode: "dry" } });
      expect(aircon.state()).toMatchObject({ power: true, mode: "dry" });
      await second.hub.stop();

      const output = [...first.hub.output, ...second.hub.output];
      expect(output).toContain(`Added Aircon, an Air Conditioner at ${aircon.host} (Midea, protocol v3)`);
      for (const secret of [aircon.token ?? "", aircon.key ?? "", login.account, login.password]) {
        for (const line of output) expect(line).not.toContain(secret);
        for (const answer of answers) expect(answer).not.toContain(secret);
      }
    } finally {
      await Promise.all([aircon.stop(), cloud.stop(), mideaAir.stop()]);
    }
  });

  it("keeps the sign-in to Hive and its Appliances, renamed and in a Room, across a restart, asking for no password or code, and never shows the tokens", async () => {
    const login = { account: "owner@example.com", password: "correct horse battery staple" };
    const code = "246810";
    const cloud = await startFakeHiveCloud({ ...login, code });
    try {
      const database = join(dir, "media-centre.sqlite");
      const env = { HIVE_URL: cloud.url, HIVE_AUTH_URL: cloud.url };
      const answers: string[] = [];
      const send = async (base: string, method: string, path: string, body?: unknown): Promise<string> => {
        const response = await fetch(`${base}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        const text = await response.text();
        answers.push(text);
        return text;
      };

      const first = await startHub(database, env);
      expect(JSON.parse(await send(first.base, "POST", HIVE_SIGN_IN_PATH, login))).toEqual({
        signedIn: false,
        needs: "code",
      });
      const { added } = JSON.parse(await send(first.base, "POST", HIVE_CODE_PATH, { code })) as HiveSignedIn;
      expect(added.map(({ name }) => name)).toEqual([
        "Downstairs",
        "Upstairs",
        "Bedroom",
        "Study",
        "Living Room",
        "Hot Water",
      ]);
      const room = JSON.parse(await send(first.base, "POST", ROOMS_PATH, { name: "Bedroom" })) as Room;
      await send(first.base, "PATCH", appliancePath(added[2]?.id ?? 0), { name: "Radiator", roomId: room.id });
      const before = JSON.parse(await send(first.base, "GET", APPLIANCES_PATH)) as Appliance[];
      expect(await first.hub.stop()).toBe(0);

      cloud.clear();
      const second = await startHub(database, env);
      expect(JSON.parse(await send(second.base, "GET", APPLIANCES_PATH))).toEqual(before);
      expect(before.find(({ name }) => name === "Radiator")?.roomId).toBe(room.id);
      expect(JSON.parse(await send(second.base, "GET", HIVE_PATH))).toEqual({ signedIn: true, tokens: "accepted" });
      // Read once with the tokens kept: never signed in again, with a password or a code.
      expect(cloud.requests.map(({ outcome }) => outcome)).toEqual(["accepted"]);

      // Hive's tokens expire, and the Hub renews them itself, still asking for neither.
      cloud.advance(61);
      expect(JSON.parse(await send(second.base, "GET", HIVE_PATH))).toEqual({ signedIn: true, tokens: "accepted" });
      // Hive refused the expired id token once, and took the rest, the renewal among them.
      expect(new Set(cloud.requests.map(({ outcome }) => outcome))).toEqual(new Set(["accepted", "not-signed-in"]));
      expect(cloud.requests.filter(({ outcome }) => outcome === "not-signed-in")).toHaveLength(1);
      await second.hub.stop();

      const output = [...first.hub.output, ...second.hub.output];
      expect(output).toContain(
        "Added 6 of Hive's Appliances: Downstairs, Upstairs, Bedroom, Study, Living Room, Hot Water",
      );
      // Every token and key the Hub kept, as the file has them once it has stopped.
      const kept = openDatabase(database);
      const { credentials } = kept.prepare("SELECT credentials FROM hive_account").get() as { credentials: string };
      kept.close();
      const { accessToken, idToken, refreshToken, device } = JSON.parse(credentials) as Record<string, unknown>;
      const tokens = [accessToken, idToken, refreshToken, ...Object.values(device as Record<string, unknown>)];
      expect(tokens).toHaveLength(6);
      expect(tokens.every((token) => typeof token === "string" && token.length >= 12)).toBe(true);
      for (const secret of [...tokens.map(String), login.account, login.password, code]) {
        for (const line of output) expect(line).not.toContain(secret);
        for (const answer of answers) expect(answer).not.toContain(secret);
      }
    } finally {
      await cloud.stop();
    }
  });

  it("keeps a Light, found and added with its key, across a restart, controlling it still, and never shows its id or key", async () => {
    const light = await startFakeLeproLight();
    try {
      const database = join(dir, "media-centre.sqlite");
      const env = {
        LEPRO_PORT: String(light.port),
        LEPRO_DISCOVERY_PORT: String(light.discoveryPort),
        LEPRO_SEARCH_TARGETS: `${light.host}:${String(light.discoveryPort)}`,
      };
      const answers: string[] = [];
      const send = async (base: string, method: string, path: string, body?: unknown): Promise<string> => {
        const response = await fetch(`${base}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        const text = await response.text();
        answers.push(text);
        return text;
      };

      const first = await startHub(database, env);
      const room = JSON.parse(await send(first.base, "POST", ROOMS_PATH, { name: "Living room" })) as Room;
      const [found] = JSON.parse(await send(first.base, "POST", APPLIANCE_SEARCH_PATH, { kind: "light" })) as [
        FoundLight,
      ];
      expect(found).toMatchObject({ address: light.host, applianceId: null });
      const added = JSON.parse(
        await send(first.base, "POST", APPLIANCES_PATH, {
          kind: "light",
          address: found.address,
          name: "Lamp",
          roomId: room.id,
          light: { key: light.key },
        }),
      ) as Appliance;
      expect(added).toMatchObject({ kind: "light", name: "Lamp", roomId: room.id, pairing: "paired" });
      expect(await first.hub.stop()).toBe(0);

      const second = await startHub(database, env);
      expect(JSON.parse(await send(second.base, "GET", APPLIANCES_PATH))).toEqual([added]);
      const [again] = JSON.parse(await send(second.base, "POST", APPLIANCE_SEARCH_PATH, { kind: "light" })) as [
        FoundLight,
      ];
      expect(again.applianceId).toBe(added.id);
      const changed = JSON.parse(
        await send(second.base, "PATCH", applianceStatePath(added.id), { on: true, brightness: 40 }),
      ) as LightReading;
      expect(changed).toMatchObject({ known: true, state: { on: true, brightness: 40 } });
      expect(light.light()).toMatchObject({ on: true, brightness: 40 });
      await second.hub.stop();

      const output = [...first.hub.output, ...second.hub.output];
      expect(output).toContain(`Added Living room · Lamp, a Light at ${light.host} (Lepro, protocol v3.3)`);
      for (const secret of [light.id, light.key]) {
        for (const line of output) expect(line).not.toContain(secret);
        for (const answer of answers) expect(answer).not.toContain(secret);
      }
    } finally {
      await light.stop();
    }
  });

  it("keeps a Room's Light Scenes, renamed, across a restart, recalling them still, and forgets one deleted", async () => {
    const light = await startFakeLeproLight();
    try {
      const database = join(dir, "media-centre.sqlite");
      const env = {
        LEPRO_PORT: String(light.port),
        LEPRO_DISCOVERY_PORT: String(light.discoveryPort),
        LEPRO_SEARCH_TARGETS: `${light.host}:${String(light.discoveryPort)}`,
      };
      const send = async (base: string, method: string, path: string, body?: unknown): Promise<Response> =>
        fetch(`${base}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });

      const first = await startHub(database, env);
      const room = (await (await send(first.base, "POST", ROOMS_PATH, { name: "Living room" })).json()) as Room;
      const lamp = (await (
        await send(first.base, "POST", APPLIANCES_PATH, {
          kind: "light",
          address: light.host,
          name: "Lamp",
          roomId: room.id,
          light: { key: light.key },
        })
      ).json()) as Appliance;
      light.setLight({ on: true, brightness: 25, colour: { hue: 240, saturation: 100 } });
      const saved = light.light();
      const film = (
        (await (
          await send(first.base, "POST", LIGHT_SCENES_PATH, { roomId: room.id, name: "Film" })
        ).json()) as LightSceneSaved
      ).lightScene;
      const bright = (
        (await (
          await send(first.base, "POST", LIGHT_SCENES_PATH, { roomId: room.id, name: "Bright" })
        ).json()) as LightSceneSaved
      ).lightScene;
      expect((await send(first.base, "PATCH", lightScenePath(film.id), { name: "Cinema" })).status).toBe(200);
      expect((await send(first.base, "DELETE", lightScenePath(bright.id))).status).toBe(204);
      expect(await first.hub.stop()).toBe(0);

      // The same database file, a new Hub.
      light.setLight({ on: false, brightness: 100, colourTemperature: 6_000 });
      const second = await startHub(database, env);
      const kept = (await (await send(second.base, "GET", LIGHT_SCENES_PATH)).json()) as LightScene[];
      expect(kept).toEqual([{ id: film.id, roomId: room.id, name: "Cinema", lights: [{ id: lamp.id, state: saved }] }]);
      const recalled = await send(second.base, "POST", lightSceneRecallPath(film.id));
      expect(recalled.status).toBe(200);
      expect(((await recalled.json()) as LightsOutcome).unreached).toEqual([]);
      expect(light.light()).toEqual(saved);
      await second.hub.stop();
    } finally {
      await light.stop();
    }
  });

  it("stops at once with a Player connected, closing its socket", async () => {
    const { hub, base } = await startHub(join(dir, "media-centre.sqlite"));
    const player = new WebSocket(`${base.replace(/^http/, "ws")}${PLAYER_SOCKET_PATH}`);
    await new Promise((done) => player.once("open", done));
    const closed = new Promise((done) => player.once("close", done));

    expect(await hub.stop()).toBe(0);
    await closed;
  });

  it("reads the latest version from the package.json at HUB_LATEST_VERSION_URL, or doesn't look when it is empty", async () => {
    const github = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end(JSON.stringify({ version: "42.0.0" }));
    });
    await new Promise<void>((done) => github.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${String((github.address() as AddressInfo).port)}/main/package.json`;
      const looking = await startHub(join(dir, "looking.sqlite"), { HUB_LATEST_VERSION_URL: url });
      expect(await (await fetch(`${looking.base}${LATEST_VERSION_PATH}`)).json()).toEqual({ version: "42.0.0" });

      const notLooking = await startHub(join(dir, "not-looking.sqlite"), { HUB_LATEST_VERSION_URL: "" });
      expect(await (await fetch(`${notLooking.base}${LATEST_VERSION_PATH}`)).json()).toEqual({ version: null });
    } finally {
      await new Promise((done) => github.close(done));
    }
  });

  it("refuses to start with a Driver's port that is not a number", async () => {
    await expect(startHub(join(dir, "x.sqlite"), { SAMSUNG_TV_REST_PORT: "telly" })).rejects.toThrow(
      'SAMSUNG_TV_REST_PORT must be a port number, not "telly"',
    );
  });

  it("refuses to start with Hive's API given without its sign-in service, so a test never reaches Hive", async () => {
    await expect(startHub(join(dir, "x.sqlite"), { HIVE_URL: "http://127.0.0.1:18092" })).rejects.toThrow(
      "HIVE_URL and HIVE_AUTH_URL are set together, or neither is",
    );
  });

  it("refuses to start on a port that is not a number", async () => {
    await expect(
      startNodeProcess(MAIN, { HUB_PORT: "telly", HUB_DATABASE: join(dir, "x.sqlite") }, LISTENING),
    ).rejects.toThrow('HUB_PORT must be a port number, not "telly"');
  });
});
