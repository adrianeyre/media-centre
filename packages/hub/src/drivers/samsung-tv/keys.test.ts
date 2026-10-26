import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RemoteKey } from "@media-centre/shared";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";

/**
 * The code each key of FR-18, and volume up and down (FR-19), must reach a Samsung TV as, written out here
 * rather than read from the Driver, so that a wrong code in the Driver fails.
 */
const EXPECTED_CODES: Readonly<Record<RemoteKey, string>> = {
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  ok: "KEY_ENTER",
  back: "KEY_RETURN",
  home: "KEY_HOME",
  menu: "KEY_MENU",
  tools: "KEY_TOOLS",
  info: "KEY_INFO",
  source: "KEY_SOURCE",
  "channel-up": "KEY_CHUP",
  "channel-down": "KEY_CHDOWN",
  "0": "KEY_0",
  "1": "KEY_1",
  "2": "KEY_2",
  "3": "KEY_3",
  "4": "KEY_4",
  "5": "KEY_5",
  "6": "KEY_6",
  "7": "KEY_7",
  "8": "KEY_8",
  "9": "KEY_9",
  red: "KEY_RED",
  green: "KEY_GREEN",
  yellow: "KEY_YELLOW",
  blue: "KEY_CYAN",
  play: "KEY_PLAY",
  pause: "KEY_PAUSE",
  stop: "KEY_STOP",
  rewind: "KEY_REWIND",
  "fast-forward": "KEY_FF",
  "volume-up": "KEY_VOLUP",
  "volume-down": "KEY_VOLDOWN",
};

let tv: FakeSamsungTv;
let driver: Driver;
let token: string;

beforeEach(async () => {
  tv = await startFakeSamsungTv();
  driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort });
  token = await driver.pair(tv.host);
});

afterEach(async () => {
  driver.disconnect?.(tv.host);
  await tv.stop();
});

const pressKey = (key: string, credentials = token) => {
  if (driver.pressKey === undefined) throw new Error("The Samsung TV Driver presses keys");
  return driver.pressKey(tv.host, credentials, key);
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

/** The codes the TV has received, once it has received `count` of them: a key is sent before the TV reads it. */
const receivedCodes = async (count: number): Promise<string[]> => {
  await expect.poll(() => tv.keys.length).toBe(count);
  return tv.keys.map(({ code }) => code);
};

/** The connections the TV let the Driver in on with its token, which keys are sent on. */
const keySockets = () => tv.connections.filter(({ outcome }) => outcome === "accepted");

describe("the Samsung TV Driver's keys, against the fake Samsung TV", () => {
  it("presses every key of FR-18 and FR-19 as the code the TV takes for it, tapped", async () => {
    const keys = Object.keys(EXPECTED_CODES) as RemoteKey[];

    for (const key of keys) expect(await pressKey(key)).toEqual({ accepted: true, credentials: token });

    expect(await receivedCodes(keys.length)).toEqual(keys.map((key) => EXPECTED_CODES[key]));
    expect(tv.keys.every(({ command }) => command === "Click")).toBe(true);
  });

  it("sends every key on one control socket, opened by the first and kept open (FR-22)", async () => {
    for (const key of ["up", "up", "left", "ok", "back"]) await pressKey(key);

    await receivedCodes(5);
    expect(tv.connections.map(({ outcome }) => outcome)).toEqual(["paired", "accepted"]);
    expect(keySockets()[0]).toMatchObject({ clientName: "media-centre", token });
    expect(new Set(tv.keys.map(({ connection }) => connection))).toEqual(new Set([1]));
    expect(keySockets()[0]?.messages).toHaveLength(5);
  });

  it("opens one socket for keys pressed together, and presses them in the order asked", async () => {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

    await Promise.all(keys.map((key) => pressKey(key)));

    expect(await receivedCodes(keys.length)).toEqual(keys.map((key) => `KEY_${key}`));
    expect(keySockets()).toHaveLength(1);
  });

  it("opens the socket again once the TV has closed it, and presses the key on it", async () => {
    await pressKey("up");
    await receivedCodes(1);

    await tv.dropConnections();
    await pressKey("down");
    await pressKey("ok");

    await receivedCodes(3);
    expect(keySockets()).toHaveLength(2);
    expect(tv.keys.map(({ code, connection }) => [code, connection])).toEqual([
      ["KEY_UP", 1],
      ["KEY_DOWN", 2],
      ["KEY_ENTER", 2],
    ]);
  });

  it("opens a socket with the new token once the TV is paired again, and closes the old one", async () => {
    await pressKey("up");
    const fresh = await driver.pair(tv.host);

    expect(await pressKey("down", fresh)).toEqual({ accepted: true, credentials: fresh });

    expect(keySockets().map((connection) => connection.token)).toEqual([token, fresh]);
  });

  it("reports a token the TV refuses once access is revoked on it, and sends nothing", async () => {
    await pressKey("up");

    tv.revokeAccess();
    // Which closes the socket, once the Driver has seen it closed.
    await tv.dropConnections();

    expect(await pressKey("down")).toEqual({ accepted: false });
    expect(await receivedCodes(1)).toEqual(["KEY_UP"]);
  });

  it("refuses a key it doesn't have, including any of the TV's own codes, without connecting", async () => {
    for (const key of ["volume", "KEY_UP", "KEY_POWER", "", "toString", "__proto__"]) {
      const error = await failure(pressKey(key));
      expect(error.reason).toBe("not-supported");
      expect(error.message).toBe("The TV has no such key.");
    }
    expect(tv.connections).toHaveLength(1);
    expect(tv.keys).toEqual([]);
  });

  it("says no TV answered when nothing is listening at the address", async () => {
    const nowhere = samsungTvDriver({ restPort: await freePort(), controlPort: await freePort() });

    const error = await failure(nowhere.pressKey?.("127.0.0.1", token, "ok") ?? Promise.resolve());

    expect(error.reason).toBe("unreachable");
    expect(error.message).not.toContain(token);
  });

  it("closes the socket when told to disconnect, and opens another for the next key", async () => {
    await pressKey("up");

    driver.disconnect?.(tv.host);
    await pressKey("down");

    expect(keySockets()).toHaveLength(2);
  });
});
