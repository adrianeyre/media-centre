import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { AirConditionerCapabilities } from "@media-centre/shared";

import {
  startFakeMideaAircon,
  type FakeAirconCommand,
  type FakeMideaAircon,
  type FakeMideaAirconOptions,
} from "../../fakes/midea-aircon/fake-midea-aircon.ts";
import { freePort } from "../../testing/ports.ts";
import { CredentialsRefused, DriverFailure } from "../driver.ts";
import {
  MideaAuthError,
  mideaCredentials,
  mideaDriver,
  mideaDriverFromEnvironment,
  type MideaDriverOptions,
} from "./midea-driver.ts";

let fakes: FakeMideaAircon[] = [];
let cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()));
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  fakes = [];
  cleanups = [];
});

const startFake = async (options: FakeMideaAirconOptions): Promise<FakeMideaAircon> => {
  const fake = await startFakeMideaAircon(options);
  fakes.push(fake);
  return fake;
};

const driverFor = (fake: FakeMideaAircon, options: MideaDriverOptions = {}) =>
  mideaDriver({
    port: fake.port,
    discoveryPorts: [fake.discoveryPort],
    searchTargets: [{ host: fake.host, port: fake.discoveryPort }],
    searchWindowMs: 300,
    connectTimeoutMs: 1_000,
    answerTimeoutMs: 1_000,
    log: () => undefined,
    ...options,
  });

/** The credentials the Hub would keep for the fake, once its keys were fetched. */
const credentialsFor = (fake: FakeMideaAircon, overrides: { token?: string; key?: string } = {}): string =>
  mideaCredentials({
    id: fake.id,
    version: fake.version,
    ...(fake.version === 3 ? { token: overrides.token ?? fake.token ?? "", key: overrides.key ?? fake.key ?? "" } : {}),
  });

const commandsOf = <Name extends FakeAirconCommand["command"]>(fake: FakeMideaAircon, command: Name) =>
  fake.commands.filter((each): each is Extract<FakeAirconCommand, { command: Name }> => each.command === command);

const FULL: AirConditionerCapabilities = {
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
  functions: [
    {
      id: "vertical-vane",
      name: "Up-and-down louvre",
      kind: "choice",
      options: [1, 2, 3, 4, 5].map((each) => ({ id: String(each), name: `Position ${String(each)}` })),
    },
    {
      id: "horizontal-vane",
      name: "Side-to-side louvre",
      kind: "choice",
      options: [1, 2, 3, 4, 5].map((each) => ({ id: String(each), name: `Position ${String(each)}` })),
    },
    {
      id: "breeze",
      name: "Breeze",
      kind: "choice",
      options: [
        { id: "off", name: "Off" },
        { id: "away", name: "Breeze away" },
        { id: "mild", name: "Breeze mild" },
        { id: "less", name: "Breezeless" },
      ],
    },
    {
      id: "power-limit",
      name: "Power limit",
      kind: "choice",
      options: [
        { id: "100", name: "100%" },
        { id: "75", name: "75%" },
        { id: "50", name: "50%" },
      ],
    },
    { id: "self-clean", name: "Self-clean", kind: "on-off" },
    { id: "frost-protection", name: "Frost protection", kind: "on-off" },
    { id: "electric-heater", name: "Electric heater", kind: "on-off" },
    { id: "ionizer", name: "Ionizer", kind: "on-off" },
    { id: "smart-eye", name: "Smart eye", kind: "on-off" },
    { id: "air-towards-me", name: "Air towards me", kind: "on-off" },
    { id: "air-away-from-me", name: "Air away from me", kind: "on-off" },
  ],
};

describe.each([2, 3] as const)("The Midea Driver, against a fake unit on v%i", (version) => {
  it("finds the unit by discovery, and by its address, with credentials to control it", async () => {
    const fake = await startFake({ version, host: "127.0.0.1" });
    const driver = driverFor(fake);

    const found = await driver.discover();

    expect(found).toEqual([
      {
        address: "127.0.0.1",
        name: fake.name,
        model: `Midea, protocol v${String(version)}`,
        serialNumber: fake.serialNumber,
        credentials: mideaCredentials({ id: fake.id, version }),
        needsKeys: version === 3,
      },
    ]);
    expect(await driver.identify("127.0.0.1")).toEqual(found[0]);
  });

  it("reads the unit's capabilities as the Appliance's, and its state", async () => {
    const fake = await startFake({ version });
    fake.setState({
      power: true,
      mode: "heat",
      targetTemperature: 22.5,
      roomTemperature: 19.3,
      outdoorTemperature: -2.4,
    });
    const driver = driverFor(fake);

    expect(await driver.readCapabilities(fake.host, credentialsFor(fake))).toEqual(FULL);
    expect(await driver.readState(fake.host, credentialsFor(fake))).toEqual({
      power: true,
      mode: "heat",
      targetTemperature: 22.5,
      fanSpeed: "auto",
      swing: { vertical: false, horizontal: false },
      preset: null,
      display: true,
      roomTemperature: 19.3,
      outdoorTemperature: -2.4,
      functions: {
        "vertical-vane": "3",
        "horizontal-vane": "3",
        breeze: "off",
        "power-limit": "100",
        "self-clean": false,
        "frost-protection": false,
        "electric-heater": false,
        ionizer: false,
        "smart-eye": false,
        "air-towards-me": false,
        "air-away-from-me": false,
      },
    });
    expect(commandsOf(fake, "query-capabilities")).toHaveLength(2);
    expect(commandsOf(fake, "query-state").length).toBeGreaterThanOrEqual(2);
  });

  it("sets each control, which the unit records and takes", async () => {
    const fake = await startFake({ version });
    const driver = driverFor(fake);
    const credentials = credentialsFor(fake);
    const set = (change: Parameters<typeof driver.setState>[2]) => driver.setState(fake.host, credentials, change);

    expect(await set({ power: true })).toMatchObject({ power: true });
    expect(fake.state().power).toBe(true);
    expect(commandsOf(fake, "set-state").at(-1)).toMatchObject({ power: true, mode: "cool", targetTemperature: 24 });

    expect(await set({ mode: "dry", targetTemperature: 21.5 })).toMatchObject({ mode: "dry", targetTemperature: 21.5 });
    expect(fake.state()).toMatchObject({ mode: "dry", targetTemperature: 21.5 });

    for (const fanSpeed of ["silent", "low", "medium", "high", "full", "auto"] as const) {
      expect(await set({ fanSpeed })).toMatchObject({ fanSpeed });
    }
    expect(
      commandsOf(fake, "set-state")
        .slice(-6)
        .map(({ fanSpeed }) => fanSpeed),
    ).toEqual([20, 40, 60, 80, 100, 102]);

    expect(await set({ swing: { vertical: true } })).toMatchObject({ swing: { vertical: true, horizontal: false } });
    expect(await set({ swing: { horizontal: true } })).toMatchObject({ swing: { vertical: true, horizontal: true } });
    expect(await set({ swing: { vertical: false } })).toMatchObject({ swing: { vertical: false, horizontal: true } });
    expect(fake.state().swing).toEqual({ vertical: false, horizontal: true });

    for (const preset of ["eco", "turbo", "sleep"] as const) {
      expect(await set({ preset })).toMatchObject({ preset });
      expect(fake.state()).toMatchObject({
        eco: preset === "eco",
        turbo: preset === "turbo",
        sleep: preset === "sleep",
      });
    }
    expect(await set({ preset: null })).toMatchObject({ preset: null });

    expect(await set({ display: false })).toMatchObject({ display: false });
    expect(fake.state().display).toBe(false);
    // The display only toggles, so it isn't toggled when it is already as asked.
    await set({ display: false });
    expect(commandsOf(fake, "toggle-display")).toHaveLength(1);
    expect(await set({ display: true })).toMatchObject({ display: true });

    const functions = {
      "vertical-vane": "5",
      "horizontal-vane": "1",
      breeze: "mild",
      "power-limit": "50",
      "self-clean": true,
      "frost-protection": true,
      "electric-heater": true,
      ionizer: true,
      "smart-eye": true,
      "air-towards-me": true,
      "air-away-from-me": true,
    };
    expect((await set({ functions })).functions).toEqual(functions);
    expect(commandsOf(fake, "set-functions").at(-1)).toMatchObject({
      functions: { "vertical-vane": 100, "horizontal-vane": 1, breeze: 3, "power-limit": 50, "self-clean": 1 },
    });
    expect(fake.state().functions).toMatchObject({ breeze: 3, ionizer: 1 });

    expect(await set({ power: false })).toMatchObject({ power: false });
    expect(fake.state().power).toBe(false);
  });

  it("takes whole degrees only from a unit that takes no half degrees, within each mode's range", async () => {
    const fake = await startFake({
      version,
      features: ["cool", "heat", "dry", "auto"],
      temperatureRanges: { cool: [17, 30], auto: [17, 28], heat: [16, 31] },
    });
    const driver = driverFor(fake);
    const credentials = credentialsFor(fake);

    expect((await driver.readCapabilities(fake.host, credentials)).modes).toEqual([
      { mode: "cool", temperature: { min: 17, max: 30, step: 1 } },
      { mode: "heat", temperature: { min: 16, max: 31, step: 1 } },
      { mode: "dry", temperature: { min: 17, max: 30, step: 1 } },
      { mode: "fan", temperature: null },
      { mode: "auto", temperature: { min: 17, max: 28, step: 1 } },
    ]);
    await expect(driver.setState(fake.host, credentials, { targetTemperature: 21.5 })).rejects.toThrow(
      "This Air Conditioner takes 17° to 30° in cool mode, in whole degrees.",
    );
    await expect(
      driver.setState(fake.host, credentials, { mode: "heat", targetTemperature: 31 }),
    ).resolves.toMatchObject({ mode: "heat", targetTemperature: 31 });
    // A mode whose range the target is outside of takes the nearest it has.
    await expect(driver.setState(fake.host, credentials, { mode: "auto" })).resolves.toMatchObject({
      mode: "auto",
      targetTemperature: 28,
    });
    await expect(driver.setState(fake.host, credentials, { mode: "fan", targetTemperature: 20 })).rejects.toThrow(
      "This Air Conditioner takes no target temperature in fan mode.",
    );
  });

  it("yields only the capabilities of a unit with fewer, and refuses a change it hasn't the capability for", async () => {
    const fake = await startFake({
      version,
      features: ["cool", "fan-auto", "swing-vertical", "display", "self-clean"],
    });
    const driver = driverFor(fake);
    const credentials = credentialsFor(fake);

    expect(await driver.readCapabilities(fake.host, credentials)).toEqual({
      power: true,
      modes: [
        { mode: "cool", temperature: { min: 16, max: 30, step: 1 } },
        { mode: "fan", temperature: null },
      ],
      fan: { speeds: ["low", "high"], auto: true },
      swing: { vertical: true, horizontal: false },
      presets: ["sleep"],
      display: true,
      temperatures: { room: true, outdoor: false },
      functions: [{ id: "self-clean", name: "Self-clean", kind: "on-off" }],
    });
    expect(await driver.readState(fake.host, credentials)).toMatchObject({
      outdoorTemperature: null,
      functions: { "self-clean": false },
    });

    fake.clear();
    for (const [change, message] of [
      [{ mode: "heat" }, "This Air Conditioner has no heat mode."],
      [{ fanSpeed: "medium" }, "This Air Conditioner has no medium fan."],
      [{ swing: { horizontal: true } }, "This Air Conditioner doesn't swing side to side."],
      [{ preset: "eco" }, "This Air Conditioner has no eco preset."],
      [{ functions: { breeze: "mild" } }, 'This Air Conditioner has no function "breeze".'],
      [{ functions: { "self-clean": "on" } }, "Self-clean is on or off."],
    ] as const) {
      const refused = driver.setState(fake.host, credentials, change);
      await expect(refused).rejects.toThrow(message);
      await expect(refused).rejects.toMatchObject({ reason: "not-supported" });
    }
    expect(commandsOf(fake, "set-state")).toEqual([]);
    expect(commandsOf(fake, "set-functions")).toEqual([]);
  });

  it("reads the state the unit's own remote, or the weather, changed", async () => {
    const fake = await startFake({ version });
    const driver = driverFor(fake);

    fake.setState({ power: true, mode: "auto", fanSpeed: 60, eco: true, display: false, roomTemperature: 26.1 });

    expect(await driver.readState(fake.host, credentialsFor(fake))).toMatchObject({
      power: true,
      mode: "auto",
      fanSpeed: "medium",
      preset: "eco",
      display: false,
      roomTemperature: 26.1,
    });
  });

  it("leaves out, and logs, functions the unit reports that it doesn't know", async () => {
    const fake = await startFake({ version, features: ["cool"], unknownCapabilities: [0x0099, 0x02aa] });
    const lines: string[] = [];
    const driver = driverFor(fake, { log: (line) => lines.push(line) });

    expect((await driver.readCapabilities(fake.host, credentialsFor(fake))).functions).toEqual([]);
    expect(lines).toEqual([
      "The Air Conditioner at 127.0.0.1 reports functions the Midea Driver doesn't know, which it leaves out: 0x0099, 0x02aa",
    ]);
  });

  it("can't be reached once the unit is switched off at the wall, which isn't a refusal of its credentials", async () => {
    const fake = await startFake({ version });
    const driver = driverFor(fake);
    await fake.stop();
    fakes = [];

    const failed = driver.readState(fake.host, credentialsFor(fake));

    await expect(failed).rejects.toBeInstanceOf(DriverFailure);
    await expect(failed).rejects.toMatchObject({ reason: "unreachable" });
    await expect(failed).rejects.not.toBeInstanceOf(CredentialsRefused);
    await expect(failed).rejects.toThrow(
      "No Air Conditioner answered at 127.0.0.1. Check that it is switched on and on the same network as the Hub.",
    );
  });
});

describe("The Midea Driver, against a fake unit on v3", () => {
  it("makes the handshake on each connection, and counts each message up from it", async () => {
    const fake = await startFake({ version: 3 });
    const driver = driverFor(fake);

    await driver.readState(fake.host, credentialsFor(fake));
    await driver.setState(fake.host, credentialsFor(fake), { power: true });

    expect(fake.connections).toEqual([
      { version: 3, handshake: "accepted" },
      { version: 3, handshake: "accepted" },
    ]);
    for (const connection of [0, 1]) {
      const counts = fake.commands.filter((each) => each.connection === connection).map(({ count }) => count);
      expect(counts.length).toBeGreaterThan(1);
      expect(counts).toEqual(counts.map((_, index) => index));
    }
  });

  it("is refused with a wrong token, as its own error, which isn't 'unreachable'", async () => {
    const fake = await startFake({ version: 3 });
    const lines: string[] = [];
    const driver = driverFor(fake, { log: (line) => lines.push(line) });

    const refused = driver.readState(fake.host, credentialsFor(fake, { token: randomBytes(64).toString("hex") }));

    await expect(refused).rejects.toBeInstanceOf(MideaAuthError);
    await expect(refused).rejects.toBeInstanceOf(CredentialsRefused);
    await expect(refused).rejects.toMatchObject({ reason: "not-allowed" });
    await expect(refused).rejects.toThrow(
      "The Air Conditioner at 127.0.0.1 refused the Hub's token and key. Fetch them again.",
    );
    expect(fake.connections).toEqual([{ version: 3, handshake: "refused" }]);
    expect(fake.commands).toEqual([]);
    expect(lines).toEqual([
      "The Air Conditioner at 127.0.0.1 refused the Hub's token and key, so they need fetching again (The unit refused the token)",
    ]);
  });

  it("asks for the unit's token and key, as its own error, with the credentials discovery gave", async () => {
    const fake = await startFake({ version: 3 });
    const driver = driverFor(fake);
    const [found] = await driver.discover();

    const refused = driver.readState(fake.host, found?.credentials ?? "");

    await expect(refused).rejects.toBeInstanceOf(MideaAuthError);
    await expect(refused).rejects.toThrow(
      "The Air Conditioner at 127.0.0.1 answers only once its token and key are fetched from Midea's cloud.",
    );
    expect(fake.connections).toEqual([]);
  });

  it("is refused with a wrong key, which the unit can't tell but its answer gives away", async () => {
    const fake = await startFake({ version: 3 });
    const driver = driverFor(fake);

    const refused = driver.setState(fake.host, credentialsFor(fake, { key: randomBytes(32).toString("hex") }), {
      power: true,
    });

    await expect(refused).rejects.toBeInstanceOf(MideaAuthError);
    await expect(refused).rejects.toMatchObject({ reason: "not-allowed" });
    expect(fake.connections).toEqual([{ version: 3, handshake: "accepted" }]);
    expect(fake.commands).toEqual([]);
    expect(fake.state().power).toBe(false);
  });

  it("says a unit that accepts the connection but never answers didn't answer", async () => {
    // It holds each connection open, saying nothing, until the test is done.
    const held = new Set<Socket>();
    const server = createServer((socket) => held.add(socket));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => {
            resolve();
          });
        }),
    );
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const driver = mideaDriver({ port, answerTimeoutMs: 200, log: () => undefined });
    const credentials = mideaCredentials({
      id: 1,
      version: 3,
      token: randomBytes(64).toString("hex"),
      key: randomBytes(32).toString("hex"),
    });

    const failed = driver.readState("127.0.0.1", credentials);

    await expect(failed).rejects.toMatchObject({ reason: "timed-out" });
    await expect(failed).rejects.not.toBeInstanceOf(CredentialsRefused);
  });

  it("refuses credentials that aren't its own, without quoting them", async () => {
    const driver = mideaDriver({ log: () => undefined });

    for (const credentials of ["token", '{"id": 1, "version": 3, "token": "ab", "key": "cd"}', '{"version": 2}']) {
      const refused = driver.readState("127.0.0.1", credentials);
      await expect(refused).rejects.toMatchObject({ reason: "not-recognised" });
      await expect(refused).rejects.toThrow(
        "The Hub's credentials for the Air Conditioner at 127.0.0.1 aren't the Midea Driver's.",
      );
    }
  });
});

describe("The Midea Driver from the Hub's environment", () => {
  it("searches the targets, and connects on the ports, it is given", async () => {
    const fake = await startFake({ version: 2 });
    const driver = mideaDriverFromEnvironment({
      MIDEA_PORT: String(fake.port),
      MIDEA_DISCOVERY_PORT: String(fake.discoveryPort),
      MIDEA_SEARCH_TARGETS: `${fake.host}:${String(fake.discoveryPort)}`,
    });

    const [found] = await driver.discover();
    expect(found?.address).toBe(fake.host);
    expect(await driver.identify(fake.host)).toEqual(found);
    expect(await driver.readState(fake.host, found?.credentials ?? "")).toMatchObject({ power: false });
    // A search listens for 3 seconds, and so does identifying it.
  }, 10_000);

  it("refuses ports and targets that aren't", () => {
    expect(() => mideaDriverFromEnvironment({ MIDEA_PORT: "lots" })).toThrow(
      'MIDEA_PORT must be a port number, not "lots"',
    );
    expect(() => mideaDriverFromEnvironment({ MIDEA_SEARCH_TARGETS: "127.0.0.2" })).toThrow(
      'MIDEA_SEARCH_TARGETS must be IPv4 host:port pairs, separated by commas, not "127.0.0.2"',
    );
  });
});
