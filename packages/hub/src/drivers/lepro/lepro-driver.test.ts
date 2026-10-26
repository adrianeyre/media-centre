import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { LightState } from "@media-centre/shared";

import {
  startFakeLeproLight,
  type FakeLeproLight,
  type FakeLeproLightOptions,
  type FakeLightCommand,
} from "../../fakes/lepro-light/fake-lepro-light.ts";
import { freePort } from "../../testing/ports.ts";
import { CredentialsRefused, DriverFailure } from "../driver.ts";
import { LeproKeyRefused, leproCredentials, leproDriver, leproDriverFromEnvironment } from "./lepro-driver.ts";
import { tuyaTransport, type TuyaTransportOptions } from "./tuya.ts";

let fakes: FakeLeproLight[] = [];
let cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()));
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  fakes = [];
  cleanups = [];
});

const startFake = async (options: FakeLeproLightOptions = {}): Promise<FakeLeproLight> => {
  const fake = await startFakeLeproLight(options);
  fakes.push(fake);
  return fake;
};

const driverFor = (
  fake: FakeLeproLight,
  options: TuyaTransportOptions = {},
  log: (line: string) => void = () => undefined,
) =>
  leproDriver({
    transport: tuyaTransport({
      port: fake.port,
      discoveryPorts: [fake.discoveryPort],
      searchTargets: [{ host: fake.host, port: fake.discoveryPort }],
      searchWindowMs: 300,
      connectTimeoutMs: 1_000,
      answerTimeoutMs: 1_000,
      ...options,
    }),
    log,
  });

/** The credentials the Hub would keep for the fake, once it had its key. */
const credentialsFor = (fake: FakeLeproLight, overrides: { id?: string; key?: string } = {}): string =>
  leproCredentials({ id: overrides.id ?? fake.id, key: overrides.key ?? fake.key });

const controls = (fake: FakeLeproLight) =>
  fake.commands
    .filter((each): each is Extract<FakeLightCommand, { command: "control" }> => each.command === "control")
    .map(({ dps }) => dps);

describe("The Lepro Driver", () => {
  it("finds a Light by asking it, and identifies one by its address, without its key", async () => {
    const fake = await startFake();
    const other = await startFake({ host: "127.0.0.2", discoveryPort: fake.discoveryPort });
    const driver = driverFor(fake, {
      searchTargets: [
        { host: fake.host, port: fake.discoveryPort },
        { host: other.host, port: other.discoveryPort },
      ],
    });

    const found = await driver.discover();
    expect(found).toHaveLength(2);
    expect(found).toContainEqual({
      address: "127.0.0.1",
      name: "Lepro Light",
      model: "Lepro, protocol v3.3",
      credentials: leproCredentials({ id: fake.id }),
    });
    expect(found.map(({ address }) => address).sort()).toEqual(["127.0.0.1", "127.0.0.2"]);

    expect(await driver.identify("127.0.0.2")).toMatchObject({
      address: "127.0.0.2",
      credentials: leproCredentials({ id: other.id }),
    });
    await expect(driver.identify("127.0.0.3")).rejects.toMatchObject({ reason: "unreachable" });
    await expect(driver.identify("light.local")).rejects.toMatchObject({ reason: "not-supported" });
  });

  it("finds a Light by listening for it to announce itself, as a real one broadcasts, with no search sent", async () => {
    const listening = await freePort();
    const fake = await startFake({ announceTo: [{ host: "127.0.0.1", port: listening }], announceEveryMs: 100 });
    const driver = leproDriver({
      transport: tuyaTransport({ port: fake.port, discoveryPorts: [listening], searchWindowMs: 400 }),
      log: () => undefined,
    });

    expect(await driver.discover()).toEqual([
      {
        address: "127.0.0.1",
        name: "Lepro Light",
        model: "Lepro, protocol v3.3",
        credentials: leproCredentials({ id: fake.id }),
      },
    ]);
    // Identifying listens only until that one is heard.
    const started = Date.now();
    expect(await driver.identify("127.0.0.1")).toMatchObject({ address: "127.0.0.1" });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("takes a Light the person gives by its id, and keeps its key with what it was found or given with", async () => {
    const fake = await startFake();
    const driver = driverFor(fake);
    const given = driver.given("127.0.0.1", ` ${fake.id} `);
    expect(given).toEqual({
      address: "127.0.0.1",
      name: "Lepro Light",
      model: "Lepro, protocol v3.3",
      credentials: leproCredentials({ id: fake.id }),
    });
    // Nothing is sent to it, as it may not be there.
    expect(fake.commands).toEqual([]);

    const [found] = await driver.discover();
    const kept = driver.withKey(found?.credentials ?? "", fake.key);
    expect(kept).toBe(credentialsFor(fake));
    expect(driver.withKey(given.credentials, fake.key)).toBe(kept);
    expect(await driver.readCapabilities("127.0.0.1", kept)).toMatchObject({ onOff: true });

    // Neither quoted when refused.
    for (const [credentials, key] of [
      [given.credentials, "short"],
      [leproCredentials({ id: "not an id" }), fake.key],
      ["not the Driver's", fake.key],
    ] as const) {
      let refused: unknown;
      try {
        driver.withKey(credentials, key);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(DriverFailure);
      expect(refused).toMatchObject({ reason: "not-supported" });
      expect((refused as Error).message).not.toContain(fake.key);
      expect((refused as Error).message).not.toContain(fake.id);
    }
  });

  it("tells whether two of its credentials are for the same Light, with its key or without", () => {
    const driver = leproDriver({ log: () => undefined });
    const light = leproCredentials({ id: "bf0123456789abcdef01" });
    const keyed = leproCredentials({ id: "bf0123456789abcdef01", key: "0123456789abcdef" });
    expect(driver.isSameLight(light, keyed)).toBe(true);
    expect(driver.isSameLight(keyed, leproCredentials({ id: "bf0123456789abcdef02" }))).toBe(false);
    expect(driver.isSameLight("not the Driver's", "not the Driver's")).toBe(false);
  });

  it("reports a colour Light's capabilities: on/off, brightness, colour temperature with its range, and colour", async () => {
    const fake = await startFake({ kind: "colour" });
    expect(await driverFor(fake).readCapabilities(fake.host, credentialsFor(fake))).toEqual({
      onOff: true,
      brightness: true,
      colourTemperature: { min: 2_700, max: 6_500 },
      colour: true,
    });
  });

  it("reports a white Light's capabilities: no colour", async () => {
    const fake = await startFake({ kind: "white" });
    expect(await driverFor(fake).readCapabilities(fake.host, credentialsFor(fake))).toEqual({
      onOff: true,
      brightness: true,
      colourTemperature: { min: 2_700, max: 6_500 },
      colour: false,
    });
  });

  it("reports only on/off for a plug, and for a Light with on/off alone", async () => {
    const plug = await startFake({ kind: "plug" });
    const onOffOnly = { onOff: true, brightness: false, colourTemperature: null, colour: false };
    expect(await driverFor(plug).readCapabilities(plug.host, credentialsFor(plug))).toEqual(onOffOnly);
    expect(await driverFor(plug).readState(plug.host, credentialsFor(plug))).toEqual({
      on: true,
      brightness: null,
      colourTemperature: null,
      colour: null,
    });

    const switchOnly = await startFake({ host: "127.0.0.2", dataPoints: ["20"] });
    expect(await driverFor(switchOnly).readCapabilities(switchOnly.host, credentialsFor(switchOnly))).toEqual(
      onOffOnly,
    );
  });

  it("reads the state, white or colour, as LampUX left it", async () => {
    const fake = await startFake();
    const driver = driverFor(fake);

    expect(await driver.readState(fake.host, credentialsFor(fake))).toEqual({
      on: true,
      brightness: 100,
      colourTemperature: 4_600,
      colour: null,
    });

    fake.setState({ "20": false, "21": "colour", "24": "00f003e801f4" });
    expect(await driver.readState(fake.host, credentialsFor(fake))).toEqual({
      on: false,
      brightness: 50,
      colourTemperature: null,
      colour: { hue: 240, saturation: 100 },
    });

    // An effect set in LampUX is neither white nor a colour.
    fake.setState({ "21": "scene" });
    expect(await driver.readState(fake.host, credentialsFor(fake))).toMatchObject({
      colourTemperature: null,
      colour: null,
    });
    expect(fake.commands.map(({ command }) => command)).toEqual(["query", "query", "query"]);
  });

  it("sets on/off, brightness, colour temperature and colour, and the fake records each", async () => {
    const fake = await startFake();
    const driver = driverFor(fake);
    const credentials = credentialsFor(fake);
    const set = async (change: Parameters<typeof driver.setState>[2]): Promise<LightState> => {
      fake.clear();
      return driver.setState(fake.host, credentials, change);
    };

    expect(await set({ on: false })).toMatchObject({ on: false });
    expect(controls(fake)).toEqual([{ "20": false }]);
    expect(fake.state()["20"]).toBe(false);

    expect(await set({ on: true, brightness: 30 })).toEqual({
      on: true,
      brightness: 30,
      colourTemperature: 4_600,
      colour: null,
    });
    expect(controls(fake)).toEqual([{ "20": true, "22": 300 }]);

    expect(await set({ colourTemperature: 2_700 })).toEqual({
      on: true,
      brightness: 30,
      colourTemperature: 2_700,
      colour: null,
    });
    expect(controls(fake)).toEqual([{ "21": "white", "23": 0 }]);

    // A colour keeps the brightness, and brightness in colour is the colour's.
    expect(await set({ colour: { hue: 120, saturation: 50 } })).toEqual({
      on: true,
      brightness: 30,
      colourTemperature: null,
      colour: { hue: 120, saturation: 50 },
    });
    expect(controls(fake)).toEqual([{ "21": "colour", "24": "007801f4012c" }]);

    expect(await set({ brightness: 80 })).toMatchObject({ brightness: 80, colour: { hue: 120, saturation: 50 } });
    expect(controls(fake)).toEqual([{ "24": "007801f40320" }]);

    // Back to white, it takes the brightness it had in colour.
    expect(await set({ colourTemperature: 6_500 })).toEqual({
      on: true,
      brightness: 80,
      colourTemperature: 6_500,
      colour: null,
    });
    expect(controls(fake)).toEqual([{ "21": "white", "23": 1_000, "22": 800 }]);
    expect(fake.state()).toMatchObject({ "20": true, "21": "white", "22": 800, "23": 1_000 });

    // Each change is read first and after, on one connection.
    expect(fake.commands.map(({ command }) => command)).toEqual(["query", "control", "query"]);
    expect(new Set(fake.commands.map(({ connection }) => connection)).size).toBe(1);
  });

  it("switches a plug on and off, and refuses what it hasn't got, sending nothing", async () => {
    const fake = await startFake({ kind: "plug" });
    const driver = driverFor(fake);
    const credentials = credentialsFor(fake);

    expect(await driver.setState(fake.host, credentials, { on: false })).toEqual({
      on: false,
      brightness: null,
      colourTemperature: null,
      colour: null,
    });
    expect(controls(fake)).toEqual([{ "1": false }]);

    for (const change of [{ brightness: 50 }, { colourTemperature: 3_000 }, { colour: { hue: 0, saturation: 100 } }]) {
      await expect(driver.setState(fake.host, credentials, change)).rejects.toMatchObject({
        reason: "not-supported",
      });
    }
    expect(controls(fake)).toHaveLength(1);
  });

  it("refuses a change out of a Light's range, or white and a colour at once, sending nothing", async () => {
    const white = await startFake({ kind: "white" });
    const driver = driverFor(white);
    const credentials = credentialsFor(white);
    const refused = async (change: unknown): Promise<DriverFailure> => {
      const error: unknown = await driver
        .setState(white.host, credentials, change as Parameters<typeof driver.setState>[2])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DriverFailure);
      return error as DriverFailure;
    };

    expect((await refused({ colour: { hue: 10, saturation: 10 } })).message).toBe("This Light has no colours.");
    expect((await refused({ brightness: 0 })).reason).toBe("not-supported");
    expect((await refused({ brightness: 101 })).reason).toBe("not-supported");
    expect((await refused({ brightness: 50.5 })).reason).toBe("not-supported");
    expect((await refused({ colourTemperature: 2_000 })).message).toBe(
      "This Light's colour temperature goes from 2700 K to 6500 K.",
    );
    expect((await refused({ on: "yes" })).reason).toBe("not-supported");

    const colour = await startFake({ host: "127.0.0.2" });
    await expect(
      driverFor(colour).setState(colour.host, credentialsFor(colour), {
        colourTemperature: 3_000,
        colour: { hue: 0, saturation: 100 },
      }),
    ).rejects.toThrow("A Light shows white at a colour temperature or a colour, not both at once.");
    await expect(
      driverFor(colour).setState(colour.host, credentialsFor(colour), { colour: { hue: 360, saturation: 100 } }),
    ).rejects.toMatchObject({ reason: "not-supported" });

    expect([...controls(white), ...controls(colour)]).toEqual([]);
  });

  it("tells a refused key or id apart from a Light it can't reach, and logs neither", async () => {
    const fake = await startFake();
    const lines: string[] = [];
    const driver = driverFor(fake, {}, (line) => lines.push(line));

    const wrongKey = await driver
      .readState(fake.host, credentialsFor(fake, { key: "0000000000000000" }))
      .catch((error: unknown) => error);
    expect(wrongKey).toBeInstanceOf(LeproKeyRefused);
    expect(wrongKey).toBeInstanceOf(CredentialsRefused);
    expect(wrongKey).toMatchObject({ reason: "not-allowed" });

    await expect(
      driver.setState(fake.host, credentialsFor(fake, { id: "bf00000000000000000000" }), { on: false }),
    ).rejects.toBeInstanceOf(LeproKeyRefused);
    expect(fake.commands.map(({ command }) => command)).toEqual(["refused", "refused"]);
    expect(fake.state()["20"]).toBe(true);

    // As discovery finds it, before the Hub has its key.
    await expect(driver.readState(fake.host, leproCredentials({ id: fake.id }))).rejects.toThrow(
      "The Light at 127.0.0.1 answers only once the Hub has its key.",
    );
    await expect(driver.readState(fake.host, '{"id": "bf01", "key": "short"}')).rejects.toMatchObject({
      reason: "not-recognised",
    });
    await expect(driver.readState(fake.host, "not json")).rejects.toMatchObject({ reason: "not-recognised" });

    expect(lines).toEqual([
      "The Light at 127.0.0.1 refused the Hub's key, so it needs giving again",
      "The Light at 127.0.0.1 refused the Hub's key, so it needs giving again",
    ]);
  });

  it("says a Light switched off at the wall is unreachable, and one that says nothing has timed out", async () => {
    const fake = await startFake();
    const credentials = credentialsFor(fake);
    const driver = driverFor(fake);
    await fake.stop();
    await expect(driver.readState(fake.host, credentials)).rejects.toMatchObject({ reason: "unreachable" });
    await expect(driver.discover()).resolves.toEqual([]);

    // It reads what it is sent, so as to hear the Driver hang up, and answers nothing.
    const silent = createServer((socket: Socket) => socket.on("error", () => undefined).resume());
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) =>
          silent.close(() => {
            resolve();
          }),
        ),
    );
    const port = (silent.address() as { port: number }).port;
    const silentDriver = leproDriver({
      transport: tuyaTransport({ port, answerTimeoutMs: 200 }),
      log: () => undefined,
    });
    await expect(silentDriver.readState("127.0.0.1", credentials)).rejects.toMatchObject({ reason: "timed-out" });
  });

  it("says what answers with something other than Tuya's frames isn't a Light it can control", async () => {
    const credentials = leproCredentials({ id: "bf0123456789abcdef01", key: "0123456789abcdef" });
    const talker = createServer((socket: Socket) => {
      socket.on("error", () => undefined);
      socket.on("data", () => socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });
    await new Promise<void>((resolve) => talker.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) =>
          talker.close(() => {
            resolve();
          }),
        ),
    );
    const driver = leproDriver({
      transport: tuyaTransport({ port: (talker.address() as { port: number }).port, answerTimeoutMs: 500 }),
      log: () => undefined,
    });
    await expect(driver.readState("127.0.0.1", credentials)).rejects.toMatchObject({ reason: "not-recognised" });
  });

  it("talks to one Light on one connection at a time", async () => {
    const fake = await startFake();
    const driver = driverFor(fake);
    const credentials = credentialsFor(fake);

    await Promise.all([
      driver.setState(fake.host, credentials, { brightness: 10 }),
      driver.readState(fake.host, credentials),
      driver.setState(fake.host, credentials, { on: false }),
    ]);
    const byConnection = new Map<number, string[]>();
    for (const { connection, command } of fake.commands) {
      byConnection.set(connection, [...(byConnection.get(connection) ?? []), command]);
    }
    expect([...byConnection.values()]).toEqual([
      ["query", "control", "query"],
      ["query"],
      ["query", "control", "query"],
    ]);
    // Each connection's commands came before the next's.
    const order = fake.commands.map(({ connection }) => connection);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("ignores what isn't a Light's announcement while it searches", async () => {
    const listening = await freePort();
    const noise = createSocket("udp4");
    cleanups.push(
      () =>
        new Promise((resolve) =>
          noise.close(() => {
            resolve();
          }),
        ),
    );
    const lines: string[] = [];
    const driver = leproDriver({
      transport: tuyaTransport({ discoveryPorts: [listening], searchWindowMs: 300 }),
      log: (line) => lines.push(line),
    });
    const searching = driver.discover();
    await new Promise((resolve) => setTimeout(resolve, 50));
    noise.send(Buffer.from("not an announcement"), listening, "127.0.0.1");
    expect(await searching).toEqual([]);
    expect(lines).toEqual([
      "Find Lights: Listening for 0.3 s for Lights announcing themselves",
      `Find Lights: Listening on UDP port ${String(listening)}`,
      expect.stringMatching(
        new RegExp(
          String.raw`^Find Lights: Heard on UDP port ${String(listening)} from 127\.0\.0\.1:\d+: ignored 19 bytes that aren't a Tuya frame`,
        ),
      ),
      expect.stringMatching(/^Find Lights: Heard 1 datagram in 0\.\d s, from 0 Lights$/),
    ]);
  });

  it("logs what it heard of each Light it finds, never its id, and when it heard nothing at all", async () => {
    const listening = await freePort();
    const fake = await startFake({ announceTo: [{ host: "127.0.0.1", port: listening }], announceEveryMs: 100 });
    const lines: string[] = [];
    const driver = leproDriver({
      transport: tuyaTransport({ port: fake.port, discoveryPorts: [listening], searchWindowMs: 250 }),
      log: (line) => lines.push(line),
    });
    await driver.discover();
    expect(lines).toContainEqual(expect.stringMatching(/: the Light at 127\.0\.0\.1, Lepro, protocol v3\.3$/));
    expect(lines.join("\n")).not.toContain(fake.id.slice(0, 10));
    await fake.stop();
    fakes = fakes.filter((each) => each !== fake);

    lines.length = 0;
    await driver.discover();
    expect(lines.at(-1)).toMatch(/^Find Lights: Heard nothing at all in 0\.\d s: .*firewall/);
  });
});

describe("The Lepro Driver from the Hub's environment", () => {
  it("takes its ports and search targets from it", async () => {
    const fake = await startFake();
    const driver = leproDriverFromEnvironment({
      LEPRO_PORT: String(fake.port),
      LEPRO_DISCOVERY_PORT: String(fake.discoveryPort),
      LEPRO_SEARCH_TARGETS: `${fake.host}:${String(fake.discoveryPort)}`,
    });
    const [found] = await driver.discover();
    expect(found?.address).toBe(fake.host);
    expect(await driver.readCapabilities(fake.host, credentialsFor(fake))).toMatchObject({ colour: true });
    expect(await driver.identify(fake.host)).toMatchObject({ address: fake.host });
  });

  it("refuses ports and search targets that aren't", () => {
    expect(() => leproDriverFromEnvironment({ LEPRO_PORT: "70000" })).toThrow(
      'LEPRO_PORT must be a port number, not "70000"',
    );
    expect(() => leproDriverFromEnvironment({ LEPRO_DISCOVERY_PORT: "x" })).toThrow(
      'LEPRO_DISCOVERY_PORT must be a port number, not "x"',
    );
    expect(() => leproDriverFromEnvironment({ LEPRO_SEARCH_TARGETS: "light.local:6667" })).toThrow(
      'LEPRO_SEARCH_TARGETS must be IPv4 host:port pairs, separated by commas, not "light.local:6667"',
    );
  });
});
