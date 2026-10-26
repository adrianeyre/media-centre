import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MenuShortcut } from "@media-centre/shared";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { DriverFailure, type Driver, type ShortcutAnswer } from "../driver.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";

/**
 * The key each shortcut of FR-24 must reach a Samsung TV as, written out here rather than read from the Driver, so
 * that a wrong code in the Driver fails.
 */
const EXPECTED_CODES: Readonly<Record<MenuShortcut, string>> = {
  "picture-mode": "KEY_PMODE",
  "picture-size": "KEY_PICTURE_SIZE",
  "sleep-timer": "KEY_SLEEP",
  "energy-saving": "KEY_ESAVING",
  captions: "KEY_CAPTION",
  "audio-description": "KEY_AD",
  "audio-track": "KEY_MTS",
  "input-source": "KEY_SOURCE",
};

/** How long the Driver listens after a shortcut, here: long enough to tell from a key that waits for it. */
const LISTEN_MS = 600;

let tv: FakeSamsungTv;
let driver: Driver;
let token: string;

beforeEach(async () => {
  tv = await startFakeSamsungTv();
  driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort, shortcutListenMs: LISTEN_MS });
  token = await driver.pair(tv.host);
});

afterEach(async () => {
  driver.disconnect?.(tv.host);
  await tv.stop();
});

const pressShortcut = (shortcut: string, credentials = token): Promise<ShortcutAnswer> => {
  if (driver.pressShortcut === undefined) throw new Error("The Samsung TV Driver presses shortcuts");
  return driver.pressShortcut(tv.host, credentials, shortcut);
};

/** Whether the TV said it ignored the shortcut's key, once the Driver has listened. */
const ignored = async (answer: ShortcutAnswer): Promise<boolean> => {
  if (!answer.accepted) throw new Error("The TV refused the token");
  return answer.ignored;
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

/** The codes the TV has received, once it has received `count` of them. */
const receivedCodes = async (count: number): Promise<string[]> => {
  await expect.poll(() => tv.keys.length).toBe(count);
  return tv.keys.map(({ code }) => code);
};

describe("the Samsung TV Driver's TV Menu shortcuts (FR-24), against the fake Samsung TV", () => {
  it("presses each shortcut as the key it maps it to, tapped, on the control socket kept open for keys", async () => {
    const shortcuts = Object.keys(EXPECTED_CODES) as MenuShortcut[];

    for (const shortcut of shortcuts) {
      const answer = await pressShortcut(shortcut);
      expect(answer).toMatchObject({ accepted: true, credentials: token });
    }

    expect(await receivedCodes(shortcuts.length)).toEqual(shortcuts.map((shortcut) => EXPECTED_CODES[shortcut]));
    expect(tv.keys.every(({ command }) => command === "Click")).toBe(true);
    expect(tv.connections.map(({ outcome }) => outcome)).toEqual(["paired", "accepted"]);
  });

  it("says the TV ignored a shortcut when it answers the key with its error event", async () => {
    tv.ignoreKeys({ keys: ["KEY_ESAVING"], answer: "error" });

    expect(await ignored(await pressShortcut("energy-saving"))).toBe(true);
    expect(await ignored(await pressShortcut("picture-mode"))).toBe(false);
  });

  it("can't tell a key the TV ignores without a word, as those reported do, from one it took", async () => {
    tv.ignoreKeys({ keys: ["KEY_ESAVING"], answer: "silence" });

    expect(await ignored(await pressShortcut("energy-saving"))).toBe(false);
    expect(tv.keys.map(({ ignored: wasIgnored }) => wasIgnored)).toEqual([true]);
  });

  it("resolves once the key is sent, and listens after that without holding up the next key (FR-22)", async () => {
    tv.ignoreKeys({ keys: ["KEY_PMODE"], answer: "error" });
    const started = Date.now();

    const answer = await pressShortcut("picture-mode");
    const down = driver.pressKey?.(tv.host, token, "down");
    await down;
    const keysSent = Date.now() - started;

    expect(keysSent).toBeLessThan(LISTEN_MS / 2);
    expect(await receivedCodes(2)).toEqual(["KEY_PMODE", "KEY_DOWN"]);
    expect(await ignored(answer)).toBe(true);
  });

  it("says nothing was ignored when the TV closes the socket while the Driver listens", async () => {
    const answer = await pressShortcut("sleep-timer");
    await tv.dropConnections();

    expect(await ignored(answer)).toBe(false);
  });

  it("puts one answer from the TV down to one shortcut only, as the TV's error names no key", async () => {
    tv.ignoreKeys({ keys: ["KEY_AD"], answer: "error" });

    const [first, second] = await Promise.all([pressShortcut("audio-description"), pressShortcut("captions")]);

    // The error answers the first key, but may arrive once the second is sent, and is put down to that one.
    expect(await receivedCodes(2)).toEqual(["KEY_AD", "KEY_CAPTION"]);
    const both = await Promise.all([ignored(first), ignored(second)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a shortcut it doesn't have, including any of the TV's own codes or the Remote's keys, without sending it", async () => {
    for (const shortcut of ["KEY_PMODE", "ok", "factory", "", "toString", "__proto__"]) {
      const error = await failure(pressShortcut(shortcut));
      expect(error.reason).toBe("not-supported");
      expect(error.message).toBe("The TV has no such shortcut.");
    }
    expect(tv.keys).toEqual([]);
  });

  it("reports a token the TV refuses once access is revoked on it, and sends nothing", async () => {
    tv.revokeAccess();

    expect(await pressShortcut("picture-mode")).toEqual({ accepted: false });
    expect(tv.keys).toEqual([]);
  });
});
