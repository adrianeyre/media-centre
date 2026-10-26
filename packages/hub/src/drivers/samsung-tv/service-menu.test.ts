import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APPLIANCES_PATH, applianceKeysPath, type Appliance, type HubError } from "@media-centre/shared";

import { openDatabase } from "../../database.ts";
import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { createHub } from "../../hub.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { controlSockets, type ControlSockets } from "./control-sockets.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";
import { serviceMenuGuard, ServiceMenuRefusal, SERVICE_MENU_SEQUENCES } from "./service-menu.ts";

const FACTORY_REFUSAL =
  "The Hub never sends the Factory key: it opens the TV's service menu, which can misconfigure or break the TV.";

/** Each known sequence, written out as a person would key it on the TV's remote. */
const SEQUENCES = [
  ["KEY_INFO", "KEY_MENU", "KEY_MUTE", "KEY_POWER"],
  ["KEY_MUTE", "KEY_1", "KEY_8", "KEY_2", "KEY_POWER"],
  ["KEY_INFO", "KEY_PMODE", "KEY_MUTE", "KEY_POWER"],
  ["KEY_SLEEP", "KEY_PMODE", "KEY_MUTE", "KEY_POWER"],
  ["KEY_MUTE", "KEY_1", "KEY_1", "KEY_9", "KEY_ENTER"],
] as const;

/** The guard's refusal of `code` after `before`, or undefined if it lets it through. */
const refusalOf = (before: readonly string[], code: string): string | undefined => {
  const guard = serviceMenuGuard();
  for (const sent of before) {
    guard.check(sent);
    guard.sent(sent);
  }
  try {
    guard.check(code);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceMenuRefusal);
    return (error as ServiceMenuRefusal).message;
  }
};

describe("the Samsung TV Driver's service-menu guard (FR-30)", () => {
  it("knows every sequence written out here, and no others", () => {
    expect(SERVICE_MENU_SEQUENCES.length).toBe(SEQUENCES.length);
  });

  it.each(["KEY_FACTORY", "key_factory", " KEY_FACTORY "])("refuses %j, whatever came before", (code) => {
    expect(refusalOf([], code)).toBe(FACTORY_REFUSAL);
    expect(refusalOf(["KEY_HOME", "KEY_INFO"], code)).toBe(FACTORY_REFUSAL);
  });

  it.each(SEQUENCES.map((sequence) => [sequence.join(", "), sequence] as const))(
    "refuses the last key of %s",
    (_name, sequence) => {
      expect(refusalOf(sequence.slice(0, -1), sequence.at(-1) ?? "")).toMatch(
        /^The Hub didn't send (Power|OK): after .+ it opens the TV's service menu, which can misconfigure or break the TV\. Press another key first\.$/,
      );
    },
  );

  it("names the keys of a refused sequence as the TV's remote does", () => {
    expect(refusalOf(["KEY_INFO", "KEY_MENU", "KEY_MUTE"], "KEY_POWER")).toBe(
      "The Hub didn't send Power: after Info, Menu and Mute it opens the TV's service menu, " +
        "which can misconfigure or break the TV. Press another key first.",
    );
    expect(refusalOf(["KEY_UP", "KEY_MUTE", "KEY_1", "KEY_1", "KEY_9"], "KEY_ENTER")).toBe(
      "The Hub didn't send OK: after Mute, 1, 1 and 9 it opens the TV's service menu, " +
        "which can misconfigure or break the TV. Press another key first.",
    );
  });

  it("refuses the power key after any of them that the sequence allows", () => {
    for (const power of ["KEY_POWER", "KEY_POWEROFF", "KEY_POWERON"]) {
      expect(refusalOf(["KEY_INFO", "KEY_MENU", "KEY_MUTE"], power)).toBeDefined();
    }
  });

  it("lets the same keys through in another order, or with another key between them", () => {
    expect(refusalOf(["KEY_MENU", "KEY_INFO", "KEY_MUTE"], "KEY_POWER")).toBeUndefined();
    expect(refusalOf(["KEY_INFO", "KEY_MENU", "KEY_UP", "KEY_MUTE"], "KEY_POWER")).toBeUndefined();
    expect(refusalOf(["KEY_MUTE", "KEY_1", "KEY_8", "KEY_2"], "KEY_ENTER")).toBeUndefined();
    expect(refusalOf(["KEY_INFO", "KEY_MENU", "KEY_MUTE"], "KEY_RETURN")).toBeUndefined();
    expect(refusalOf(["KEY_INFO", "KEY_MENU", "KEY_MUTE", "KEY_RETURN"], "KEY_POWER")).toBeUndefined();
  });

  it("looks back only on keys that were sent, not on one it refused", () => {
    const guard = serviceMenuGuard();
    for (const code of ["KEY_INFO", "KEY_MENU", "KEY_MUTE"]) guard.sent(code);

    expect(() => {
      guard.check("KEY_POWER");
    }).toThrow(ServiceMenuRefusal);
    expect(() => {
      guard.check("KEY_POWER");
    }).toThrow(ServiceMenuRefusal);
  });
});

describe("every key the Driver sends, against the fake Samsung TV", () => {
  let tv: FakeSamsungTv;
  let token: string;
  let sockets: ControlSockets;

  beforeEach(async () => {
    tv = await startFakeSamsungTv();
    token = await samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort }).pair(tv.host);
    sockets = controlSockets({ port: tv.controlPort, clientName: "media-centre", timeoutMs: 5_000 });
  });

  afterEach(async () => {
    sockets.close(tv.host);
    await tv.stop();
  });

  const press = (code: string) => sockets.pressKey(tv.host, token, code);

  it("passes the guard: the factory key never reaches the TV, not even on a socket already open", async () => {
    await press("KEY_HOME");

    await expect(press("KEY_FACTORY")).rejects.toThrow(new ServiceMenuRefusal(FACTORY_REFUSAL));
    await press("KEY_RETURN");

    await expect.poll(() => tv.keys.map(({ code }) => code)).toEqual(["KEY_HOME", "KEY_RETURN"]);
  });

  it.each(SEQUENCES.map((sequence) => [sequence.join(", "), sequence] as const))(
    "sends all of %s but its last key",
    async (_name, sequence) => {
      for (const code of sequence.slice(0, -1)) await press(code);

      await expect(press(sequence.at(-1) ?? "")).rejects.toThrow(ServiceMenuRefusal);
      await press("KEY_HOME");

      await expect.poll(() => tv.keys.map(({ code }) => code)).toEqual([...sequence.slice(0, -1), "KEY_HOME"]);
    },
  );

  it("holds the power key only when it passes the guard too, as switching a Frame TV off does", async () => {
    const [info, menu, mute, power] = SEQUENCES[0];
    for (const code of [info, menu, mute]) await press(code);

    await expect(sockets.holdKey(tv.host, token, power, 50)).rejects.toThrow(ServiceMenuRefusal);
    await press("KEY_HOME");
    await sockets.holdKey(tv.host, token, power, 50);

    await expect
      .poll(() => tv.keys.map(({ code, command }) => `${command} ${code}`))
      .toEqual([
        ...[info, menu, mute, "KEY_HOME"].map((code) => `Click ${code}`),
        `Press ${power}`,
        `Release ${power}`,
      ]);
  });

  it("refuses a sequence's last key even when every key is asked for at once", async () => {
    const [info, menu, mute, power] = SEQUENCES[0];

    const results = await Promise.allSettled([press(info), press(menu), press(mute), press(power)]);

    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected"]);
    await expect.poll(() => tv.keys.map(({ code }) => code)).toEqual([info, menu, mute]);
  });
});

describe("the factory key, sent straight to the Hub's API", () => {
  let dir: string;
  let database: DatabaseSync;
  let tv: FakeSamsungTv;
  let driver: Driver;
  let hub: Server;
  let base: string;
  let logged: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hub-service-menu-test-"));
    database = openDatabase(join(dir, "media-centre.sqlite"));
    tv = await startFakeSamsungTv();
    driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort });
    hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database, drivers: { tv: driver } });
    await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    driver.disconnect?.(tv.host);
    await new Promise((done) => hub.close(done));
    database.close();
    await tv.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it.each(["KEY_FACTORY", "factory", "Factory"])("is refused by the Driver when asked for as %j", async (key) => {
    const added = (await (
      await post(APPLIANCES_PATH, { kind: "tv", address: tv.host, name: "TV", roomId: null })
    ).json()) as Appliance;
    expect((await post(applianceKeysPath(added.id), { key: "home" })).status).toBe(204);

    const response = await post(applianceKeysPath(added.id), { key });

    expect(response.status).toBe(403);
    expect(((await response.json()) as HubError).error).toBe(FACTORY_REFUSAL);
    expect(logged).toContain(`Refused to send a key to TV: ${FACTORY_REFUSAL}`);
    expect((await post(applianceKeysPath(added.id), { key: "back" })).status).toBe(204);
    await expect.poll(() => tv.keys.map(({ code }) => code)).toEqual(["KEY_HOME", "KEY_RETURN"]);
  });

  it("is refused by the Driver itself, as what it is", async () => {
    const error = await (driver.pressKey?.(tv.host, "no token needed", "KEY_FACTORY") ?? Promise.resolve()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DriverFailure);
    expect(error).toMatchObject({ reason: "refused", message: FACTORY_REFUSAL });
    expect(tv.connections).toEqual([]);
  });
});
