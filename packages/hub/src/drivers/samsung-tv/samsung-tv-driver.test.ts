import { createSocket } from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { samsungTvDriver, samsungTvDriverFromEnvironment } from "./samsung-tv-driver.ts";
import { parseSsdpMessage, SAMSUNG_TV_SEARCH_TARGET } from "./ssdp.ts";

let tv: FakeSamsungTv | undefined;

afterEach(async () => {
  await tv?.stop();
  tv = undefined;
});

const driverFor = (
  fake: FakeSamsungTv,
  timeouts: { pairingTimeoutMs?: number; connectTimeoutMs?: number } = {},
): Driver => samsungTvDriver({ restPort: fake.restPort, controlPort: fake.controlPort, ...timeouts });

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

describe("the Samsung TV Driver, against the fake Samsung TV", () => {
  it("identifies the TV by its own name, model and MAC address", async () => {
    tv = await startFakeSamsungTv({
      device: { name: "[TV] Bedroom", modelName: "QE65S95C", wifiMac: "02:00:00:AA:BB:CC" },
    });

    expect(await driverFor(tv).identify(tv.host)).toEqual({
      name: "[TV] Bedroom",
      model: "QE65S95C",
      macAddress: "02:00:00:aa:bb:cc",
    });
  });

  it("pairs by opening the control socket without a token, as media-centre, and keeps the token the TV issues", async () => {
    tv = await startFakeSamsungTv();

    const credentials = await driverFor(tv).pair(tv.host);

    expect(tv.issuedTokens()).toEqual([credentials]);
    expect(tv.connections).toEqual([
      expect.objectContaining({ clientName: "media-centre", token: undefined, outcome: "paired" }),
    ]);
  });

  it("presents the token on its next connection, and is let in", async () => {
    tv = await startFakeSamsungTv();
    const driver = driverFor(tv);
    const credentials = await driver.pair(tv.host);

    expect(await driver.connect(tv.host, credentials)).toEqual({ accepted: true, credentials });
    expect(tv.connections[1]).toMatchObject({ clientName: "media-centre", token: credentials, outcome: "accepted" });
  });

  it("reports a token the TV refuses, once access is revoked on the TV, and pairs again with a new one", async () => {
    tv = await startFakeSamsungTv();
    const driver = driverFor(tv);
    const old = await driver.pair(tv.host);
    tv.revokeAccess();

    expect(await driver.connect(tv.host, old)).toEqual({ accepted: false });

    const fresh = await driver.pair(tv.host);
    expect(fresh).not.toBe(old);
    expect(await driver.connect(tv.host, fresh)).toEqual({ accepted: true, credentials: fresh });
  });

  it("says so when the person chooses Deny on the TV", async () => {
    tv = await startFakeSamsungTv({ pairing: "deny" });

    const error = await failure(driverFor(tv).pair(tv.host));

    expect(error.reason).toBe("not-allowed");
    expect(error.message).toBe("The TV at 127.0.0.1 didn't allow the Hub. Try again, and choose Allow on the TV.");
  });

  it("gives up when nobody answers the TV's prompt in time", async () => {
    tv = await startFakeSamsungTv({ pairing: "ignore" });

    const error = await failure(driverFor(tv, { pairingTimeoutMs: 300 }).pair(tv.host));

    expect(error.reason).toBe("timed-out");
    expect(error.message).toContain("choose Allow on the TV when it asks");
  });

  it("says no TV answered when nothing is listening at the address", async () => {
    const driver = samsungTvDriver({ restPort: await freePort(), controlPort: await freePort() });

    for (const work of [driver.identify("127.0.0.1"), driver.pair("127.0.0.1"), driver.connect("127.0.0.1", "1")]) {
      const error = await failure(work);
      expect(error.reason).toBe("unreachable");
      expect(error.message).toBe(
        "No TV answered at 127.0.0.1. Check that it is switched on and on the same network as the Hub.",
      );
    }
  });

  it("says what answered is not a TV it can control", async () => {
    const other = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Router</h1>");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));

    try {
      const driver = samsungTvDriver({ restPort: (other.address() as AddressInfo).port });
      const error = await failure(driver.identify("127.0.0.1"));
      expect(error.reason).toBe("not-recognised");
      expect(error.message).toBe("What answered at 127.0.0.1 is not a TV the Hub can control.");
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("reads the TV's power state from its device info, without pairing: on, standby, and unreachable once stopped", async () => {
    tv = await startFakeSamsungTv();
    const driver = driverFor(tv);

    expect(await driver.readPowerState(tv.host)).toBe("on");
    tv.setPowerState("standby");
    expect(await driver.readPowerState(tv.host)).toBe("standby");
    tv.setPowerState("on");
    expect(await driver.readPowerState(tv.host)).toBe("on");
    expect(tv.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(Array(3).fill("GET /api/v2/"));
    expect(tv.connections).toEqual([]);

    await tv.stop();
    tv = undefined;
    expect(await driver.readPowerState("127.0.0.1")).toBe("unreachable");
  });

  it("takes a TV whose firmware reports no power state to be on, since it answered", async () => {
    tv = await startFakeSamsungTv({ leaveOut: ["PowerState"] });

    expect(await driverFor(tv).readPowerState(tv.host)).toBe("on");
  });

  it.each([
    [
      "answers as something other than a TV",
      (response: ServerResponse) => response.writeHead(200, { "content-type": "text/html" }).end("<h1>Router</h1>"),
    ],
    ["doesn't answer in time", () => undefined],
  ])("says a TV is unreachable when what is at its address %s", async (_, answer) => {
    const other = createServer((_request, response) => {
      answer(response);
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));

    try {
      const driver = samsungTvDriver({ restPort: (other.address() as AddressInfo).port, powerTimeoutMs: 200 });
      expect(await driver.readPowerState("127.0.0.1")).toBe("unreachable");
    } finally {
      other.closeAllConnections();
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("never puts the token in an error", async () => {
    tv = await startFakeSamsungTv();
    const driver = driverFor(tv);
    const credentials = await driver.pair(tv.host);
    await tv.stop();

    const error = await failure(driver.connect(tv.host, credentials));

    const everything = [error.message, error.stack, String(error.cause), (error.cause as Error).stack].join("\n");
    expect(everything).not.toContain(credentials);
    tv = undefined;
  });

  it("runs on other ports only when the environment says so", async () => {
    tv = await startFakeSamsungTv();
    const driver = samsungTvDriverFromEnvironment({
      SAMSUNG_TV_REST_PORT: String(tv.restPort),
      SAMSUNG_TV_CONTROL_PORT: String(tv.controlPort),
    });

    expect((await driver.identify(tv.host)).model).toBe("QE55Q60TAUXXU");
    expect(() => samsungTvDriverFromEnvironment({ SAMSUNG_TV_CONTROL_PORT: "eight" })).toThrow(
      'SAMSUNG_TV_CONTROL_PORT must be a port number, not "eight"',
    );
  });

  it("runs other programs in place of Samsung's sdb and tizen only when the environment says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samsung-tools-"));
    try {
      // An sdb that connects to anything, so that tizen is run next.
      const sdb = join(dir, "sdb");
      await writeFile(sdb, '#!/bin/sh\necho "connected to $2"\n', { mode: 0o755 });
      const launch = (env: Readonly<Record<string, string>>): Promise<unknown> =>
        samsungTvDriverFromEnvironment(env).playerTools?.launch("127.0.0.2", () => undefined) ?? Promise.resolve();

      await expect(launch({ SAMSUNG_TV_SDB: join(dir, "missing-sdb") })).rejects.toThrow(
        `it hasn't got Samsung's ${join(dir, "missing-sdb")} tool`,
      );
      await expect(launch({ SAMSUNG_TV_SDB: sdb, SAMSUNG_TV_TIZEN: join(dir, "missing-tizen") })).rejects.toThrow(
        `it hasn't got Samsung's ${join(dir, "missing-tizen")} tool`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the Samsung TV Driver switching a TV on and off, against the fake Samsung TV (FR-17)", () => {
  /** Sends Wake-on-LAN to the fake's own address, and holds a Frame's power key for less time than a real one. */
  const powerDriverFor = (fake: FakeSamsungTv): Driver =>
    samsungTvDriver({
      restPort: fake.restPort,
      controlPort: fake.controlPort,
      wakePort: fake.wakePort,
      powerHoldMs: 400,
    });

  it("switches a TV in standby on with a magic packet for its MAC address", async () => {
    tv = await startFakeSamsungTv({ macAddress: "02:00:00:AA:BB:CC" });
    tv.setPowerState("standby");
    const driver = powerDriverFor(tv);

    await driver.switchOn?.({ address: tv.host, macAddress: "02:00:00:aa:bb:cc" });

    await expect.poll(() => tv?.wakes.length).toBe(1);
    expect(tv.wakes[0]?.macAddress).toBe("02:00:00:aa:bb:cc");
    expect(await driver.readPowerState(tv.host)).toBe("on");
    expect(tv.connections).toEqual([]);
  });

  it("wakes a TV whose firmware doesn't answer in standby, so it is unreachable", async () => {
    tv = await startFakeSamsungTv({ answersInStandby: false });
    tv.setPowerState("standby");
    const driver = powerDriverFor(tv);
    expect(await driver.readPowerState(tv.host)).toBe("unreachable");

    await driver.switchOn?.({ address: tv.host, macAddress: "02:00:00:00:00:01" });

    await expect.poll(() => tv?.wakes.length).toBe(1);
    expect(await driver.readPowerState(tv.host)).toBe("on");
  });

  it("switches a TV off with one press of its power key, on its control socket", async () => {
    tv = await startFakeSamsungTv();
    const driver = powerDriverFor(tv);
    const credentials = await driver.pair(tv.host);

    expect(await driver.switchOff?.(tv.host, credentials)).toEqual({ accepted: true, credentials });

    await expect.poll(() => tv?.keys.length).toBe(1);
    expect(tv.keys.map(({ code, command }) => ({ code, command }))).toEqual([{ code: "KEY_POWER", command: "Click" }]);
    expect(await driver.readPowerState(tv.host)).toBe("standby");
    expect(tv.wakes).toEqual([]);
  });

  it("holds the power key of a Frame TV, as its device info says it is, rather than pressing it", async () => {
    tv = await startFakeSamsungTv({ frame: true, frameHoldMs: 300 });
    const driver = powerDriverFor(tv);
    const credentials = await driver.pair(tv.host);

    const started = Date.now();
    expect(await driver.switchOff?.(tv.host, credentials)).toEqual({ accepted: true, credentials });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);

    await expect.poll(() => tv?.keys.length).toBe(2);
    const [down, up] = tv.keys;
    expect([down, up].map((key) => ({ code: key?.code, command: key?.command }))).toEqual([
      { code: "KEY_POWER", command: "Press" },
      { code: "KEY_POWER", command: "Release" },
    ]);
    expect((up?.receivedAt ?? 0) - (down?.receivedAt ?? 0)).toBeGreaterThanOrEqual(350);
    expect(await driver.readPowerState(tv.host)).toBe("standby");
  });

  it("holds a Frame's power key for 3 seconds unless told otherwise", async () => {
    tv = await startFakeSamsungTv({ frame: true });
    const driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort });
    const credentials = await driver.pair(tv.host);

    await driver.switchOff?.(tv.host, credentials);

    const [down, up] = tv.keys;
    expect((up?.receivedAt ?? 0) - (down?.receivedAt ?? 0)).toBeGreaterThanOrEqual(2_950);
    expect(await driver.readPowerState(tv.host)).toBe("standby");
  }, 10_000);

  it("presses keys asked for while the power key is held only once it is let go", async () => {
    tv = await startFakeSamsungTv({ frame: true, frameHoldMs: 300 });
    const driver = powerDriverFor(tv);
    const credentials = await driver.pair(tv.host);

    const switchingOff = driver.switchOff?.(tv.host, credentials);
    await expect.poll(() => tv?.keys.length).toBe(1);
    await Promise.all([switchingOff, driver.pressKey?.(tv.host, credentials, "ok")]);

    await expect.poll(() => tv?.keys.length).toBe(3);
    expect(tv.keys.map(({ command, code }) => `${command} ${code}`)).toEqual([
      "Press KEY_POWER",
      "Release KEY_POWER",
      "Click KEY_ENTER",
    ]);
  });

  it("reports a token the TV refuses, and sends no key", async () => {
    tv = await startFakeSamsungTv();
    const driver = powerDriverFor(tv);
    const credentials = await driver.pair(tv.host);
    tv.revokeAccess();

    expect(await driver.switchOff?.(tv.host, credentials)).toEqual({ accepted: false });
    expect(tv.keys).toEqual([]);
  });

  it("says no TV answered when it can't read whether the TV is a Frame", async () => {
    const driver = samsungTvDriver({ restPort: await freePort(), controlPort: await freePort(), powerTimeoutMs: 200 });

    const error = await failure(driver.switchOff?.("127.0.0.1", "1") ?? Promise.resolve());

    expect(error.reason).toBe("unreachable");
    expect(error.message).toBe(
      "No TV answered at 127.0.0.1. Check that it is switched on and on the same network as the Hub.",
    );
  });

  it("says so when it can't send the magic packet", async () => {
    const driver = samsungTvDriver({ wakePort: 0 });

    const error = await failure(
      driver.switchOn?.({ address: "127.0.0.1", macAddress: "02:00:00:00:00:01" }) ?? Promise.resolve(),
    );

    expect(error.reason).toBe("unreachable");
    expect(error.message).toBe(
      "The Hub couldn't send the TV at 127.0.0.1 its wake-up call. Check that the Hub is on the same network as the TV.",
    );
  });

  it("sends Wake-on-LAN to the TV's own address on another port only when the environment says so", async () => {
    tv = await startFakeSamsungTv();
    tv.setPowerState("standby");
    const driver = samsungTvDriverFromEnvironment({
      SAMSUNG_TV_REST_PORT: String(tv.restPort),
      SAMSUNG_TV_WAKE_PORT: String(tv.wakePort),
    });

    await driver.switchOn?.({ address: tv.host, macAddress: "02:00:00:00:00:01" });

    await expect.poll(() => tv?.wakes.length).toBe(1);
    expect(() => samsungTvDriverFromEnvironment({ SAMSUNG_TV_WAKE_PORT: "nine" })).toThrow(
      'SAMSUNG_TV_WAKE_PORT must be a port number, not "nine"',
    );
  });
});

describe("the Samsung TV Driver finding TVs, against fake Samsung TVs", () => {
  const fakes: FakeSamsungTv[] = [];
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
  });

  /** A fake TV at `host`, sharing the first one's ports, as TVs on one network do. */
  const fakeAt = async (host: string, name: string, macAddress: string): Promise<FakeSamsungTv> => {
    const [first] = fakes;
    const fake = await startFakeSamsungTv({
      host,
      name,
      macAddress,
      ...(first === undefined
        ? {}
        : { restPort: first.restPort, controlPort: first.controlPort, ssdpPort: first.ssdpPort }),
    });
    fakes.push(fake);
    return fake;
  };

  /** Searches each fake TV's own address, as the multicast group would reach them all. */
  const finder = (hosts: readonly string[], port: number): Driver =>
    samsungTvDriver({
      restPort: fakes[0]?.restPort ?? 1,
      searchTargets: hosts.map((host) => ({ host, port })),
      searchWindowMs: 300,
    });

  it("finds each TV that answers its search, by its own name, IP, model and MAC address", async () => {
    const bedroom = await fakeAt("127.0.0.3", "[TV] Bedroom", "02:00:00:00:00:0B");
    const living = await fakeAt("127.0.0.2", "[TV] Living room", "02:00:00:00:00:0A");

    const found = await finder(["127.0.0.3", "127.0.0.2"], bedroom.ssdpPort).discover?.();

    expect(found).toEqual([
      { address: "127.0.0.2", name: "[TV] Living room", model: "QE55Q60TAUXXU", macAddress: "02:00:00:00:00:0a" },
      { address: "127.0.0.3", name: "[TV] Bedroom", model: "QE55Q60TAUXXU", macAddress: "02:00:00:00:00:0b" },
    ]);
    // Each TV was searched for as SSDP asks, then asked for its device info.
    for (const tv of [living, bedroom]) {
      const [search] = tv.searches.map(parseSsdpMessage);
      expect(search?.startLine).toBe("M-SEARCH * HTTP/1.1");
      expect(Object.fromEntries(search?.headers ?? [])).toEqual({
        host: `${tv.host}:${String(tv.ssdpPort)}`,
        man: '"ssdp:discover"',
        mx: "2",
        st: SAMSUNG_TV_SEARCH_TARGET,
      });
      expect(tv.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/v2/"]);
      expect(tv.connections).toEqual([]);
    }
  });

  it("lists a TV once, however many times or on however many addresses it answers", async () => {
    const tv = await fakeAt("127.0.0.2", "[TV] Living room", "02:00:00:00:00:0A");
    // The same TV on its cable as well as its Wi-Fi.
    await fakeAt("127.0.0.4", "[TV] Living room", "02:00:00:00:00:0A");

    const found = await finder(["127.0.0.2", "127.0.0.2", "127.0.0.4"], tv.ssdpPort).discover?.();

    expect(found).toEqual([expect.objectContaining({ address: "127.0.0.2", name: "[TV] Living room" })]);
  });

  it("leaves out something that answers as a Samsung TV but has no TV's device info", async () => {
    const tv = await fakeAt("127.0.0.2", "[TV] Living room", "02:00:00:00:00:0A");
    const impostor = createSocket({ type: "udp4" });
    const host = "127.0.0.5";
    impostor.on("message", (_data, from) => {
      impostor.send(
        `HTTP/1.1 200 OK\r\nST: ${SAMSUNG_TV_SEARCH_TARGET}\r\nLOCATION: http://${host}:7676/\r\n\r\n`,
        from.port,
        from.address,
      );
    });
    await new Promise<void>((resolve) => impostor.bind(tv.ssdpPort, host, resolve));

    try {
      const found = await finder(["127.0.0.2", host], tv.ssdpPort).discover?.();
      expect(found?.map(({ address }) => address)).toEqual(["127.0.0.2"]);
    } finally {
      await new Promise<void>((resolve) => impostor.close(resolve));
    }
  });

  it("finds nothing when no TV answers", async () => {
    const driver = samsungTvDriver({
      searchTargets: [{ host: "127.0.0.1", port: await freePort() }],
      searchWindowMs: 200,
    });

    expect(await driver.discover?.()).toEqual([]);
  });

  it("says so when it can't send its search at all", async () => {
    // Broadcast without asking for it is refused, as a search with no network would be.
    const driver = samsungTvDriver({ searchTargets: [{ host: "255.255.255.255", port: 1900 }], searchWindowMs: 200 });

    const error = await failure(driver.discover?.() ?? Promise.resolve());

    expect(error.reason).toBe("unreachable");
    expect(error.message).toBe("The Hub couldn't search its network for TVs. Add the TV by its IP address instead.");
  });

  it("searches the addresses the environment gives instead of the multicast group, only when it says so", async () => {
    const tv = await fakeAt("127.0.0.2", "[TV] Living room", "02:00:00:00:00:0A");
    const driver = samsungTvDriverFromEnvironment({
      SAMSUNG_TV_REST_PORT: String(tv.restPort),
      SAMSUNG_TV_SEARCH_TARGETS: `127.0.0.2:${String(tv.ssdpPort)}, 127.0.0.6:${String(tv.ssdpPort)}`,
    });

    expect((await driver.discover?.())?.map(({ name }) => name)).toEqual(["[TV] Living room"]);
    for (const targets of ["127.0.0.2", "tv.local:1900", "127.0.0.2:0", "127.0.0.2:1900,"]) {
      expect(() => samsungTvDriverFromEnvironment({ SAMSUNG_TV_SEARCH_TARGETS: targets })).toThrow(
        `SAMSUNG_TV_SEARCH_TARGETS must be IPv4 host:port pairs, separated by commas, not "${targets}"`,
      );
    }
  });
});
