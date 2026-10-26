import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";

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

const readKeyboard = (credentials = token) => {
  if (driver.readKeyboard === undefined) throw new Error("The Samsung TV Driver reads the keyboard");
  return driver.readKeyboard(tv.host, credentials);
};

const enterText = (text: string, credentials = token) => {
  if (driver.enterText === undefined) throw new Error("The Samsung TV Driver types text");
  return driver.enterText(tv.host, credentials, text);
};

/** Whether the Driver says the keyboard is open, once it says `open`: the TV's event takes a moment to arrive. */
const saysOpen = async (open: boolean): Promise<void> => {
  await expect.poll(async () => readKeyboard()).toEqual({ accepted: true, credentials: token, open });
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

/** The connections the TV let the Driver in on with its token, which keys and text are sent on. */
const keptSockets = () => tv.connections.filter(({ outcome }) => outcome === "accepted");

describe("the Samsung TV Driver's on-screen keyboard, against the fake Samsung TV (FR-20)", () => {
  it("says the keyboard is closed until the TV opens it, then open until the TV closes it", async () => {
    expect(await readKeyboard()).toEqual({ accepted: true, credentials: token, open: false });

    tv.setKeyboard(true);
    await saysOpen(true);
    tv.setKeyboard(false);
    await saysOpen(false);
  });

  it("hears the keyboard on the control socket that keys are sent on, kept open", async () => {
    await readKeyboard();
    tv.setKeyboard(true);
    await saysOpen(true);
    await driver.pressKey?.(tv.host, token, "ok");

    await expect.poll(() => tv.keys.length).toBe(1);
    expect(keptSockets()).toHaveLength(1);
    expect(tv.keys[0]?.connection).toBe(1);
  });

  it('types "cosmos documentary" and submits it, which the TV takes exactly, and closes its keyboard', async () => {
    await readKeyboard();
    tv.setKeyboard(true);
    await saysOpen(true);

    expect(await enterText("cosmos documentary")).toEqual({ accepted: true, credentials: token });

    await saysOpen(false);
    expect(tv.texts.map(({ text, keyboardOpen }) => ({ text, keyboardOpen }))).toEqual([
      { text: "cosmos documentary", keyboardOpen: true },
    ]);
    expect(keptSockets()).toHaveLength(1);
  });

  it.each(["café", "Ünïcödé ß", "日本語の検索", "🎬 films", "  spaced  out  ", "x".repeat(1_000)])(
    "types %j exactly as given",
    async (text) => {
      tv.setKeyboard(true);

      await enterText(text);

      await expect.poll(() => tv.texts.map((each) => each.text)).toEqual([text]);
    },
  );

  it("sends text in turn with keys, in the order asked", async () => {
    tv.setKeyboard(true);

    await Promise.all([
      driver.pressKey?.(tv.host, token, "up"),
      enterText("first"),
      driver.pressKey?.(tv.host, token, "down"),
    ]);

    await expect.poll(() => tv.keys.length).toBe(2);
    const messages = keptSockets()[0]?.messages.map((message) => (JSON.parse(message) as { params: object }).params);
    expect(messages).toEqual([
      expect.objectContaining({ DataOfCmd: "KEY_UP" }),
      expect.objectContaining({ TypeOfRemote: "SendInputString" }),
      expect.objectContaining({ TypeOfRemote: "SendInputEnd" }),
      expect.objectContaining({ DataOfCmd: "KEY_DOWN" }),
    ]);
  });

  it("says the keyboard is closed once the TV has closed the socket, and hears it again on one opened afresh", async () => {
    await readKeyboard();
    tv.setKeyboard(true);
    await saysOpen(true);

    await tv.dropConnections();
    expect(await readKeyboard()).toEqual({ accepted: true, credentials: token, open: false });
    expect(keptSockets()).toHaveLength(2);

    tv.setKeyboard(false);
    tv.setKeyboard(true);
    await saysOpen(true);
  });

  it("types the text on a socket opened afresh when the TV has closed the one kept open", async () => {
    await readKeyboard();
    tv.setKeyboard(true);

    await tv.dropConnections();
    await enterText("again");

    await expect.poll(() => tv.texts.map(({ text, connection }) => [text, connection])).toEqual([["again", 2]]);
  });

  it("reports a token the TV refuses once access is revoked on it, and types nothing", async () => {
    await readKeyboard();
    tv.revokeAccess();
    await tv.dropConnections();

    expect(await readKeyboard()).toEqual({ accepted: false });
    expect(await enterText("secret")).toEqual({ accepted: false });
    expect(tv.texts).toEqual([]);
  });

  it("says no TV answered when nothing is listening at the address, without quoting the token or the text", async () => {
    const nowhere = samsungTvDriver({ restPort: await freePort(), controlPort: await freePort() });

    for (const work of [
      nowhere.readKeyboard?.("127.0.0.1", token),
      nowhere.enterText?.("127.0.0.1", token, "my password"),
    ]) {
      const error = await failure(work ?? Promise.resolve());
      expect(error.reason).toBe("unreachable");
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain("my password");
    }
  });
});
