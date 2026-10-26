import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { AppsUnavailable, isApplicationVisible } from "./applications.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";

let tv: FakeSamsungTv;
let driver: Driver;
let token: string;

beforeEach(async () => {
  tv = await startFakeSamsungTv();
  driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort, appsTimeoutMs: 1_000 });
  token = await driver.pair(tv.host);
});

afterEach(async () => {
  driver.disconnect?.(tv.host);
  await tv.stop();
});

const readNowShowing = (credentials = token, on = driver) => {
  if (on.readNowShowing === undefined) throw new Error("The Samsung TV Driver reads what is in front");
  return on.readNowShowing(tv.host, credentials);
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

describe("the Samsung TV Driver's Now Showing, against the fake Samsung TV (FR-26)", () => {
  it("says which app is in front, as the TV's app status says, with whether the TV gives an icon for it", async () => {
    tv.bringToFront("111299001912");

    expect(await readNowShowing()).toEqual({
      accepted: true,
      credentials: token,
      app: { id: "111299001912", name: "YouTube", icon: true },
    });

    tv.bringToFront("org.tizen.browser");
    expect(await readNowShowing()).toMatchObject({ app: { id: "org.tizen.browser", name: "Internet", icon: false } });
  });

  it("says no app when none is in front, as with live TV, even with apps running behind", async () => {
    expect(await readNowShowing()).toEqual({ accepted: true, credentials: token, app: undefined });

    tv.bringToFront("3201907018807");
    tv.bringToFront(undefined);

    expect(await readNowShowing()).toEqual({ accepted: true, credentials: token, app: undefined });
  });

  it("follows an app installed since, brought to the front", async () => {
    await readNowShowing();
    tv.setApps([{ id: "a.plex", name: "Plex" }]);
    tv.bringToFront("a.plex");

    expect(await readNowShowing()).toMatchObject({ app: { id: "a.plex", name: "Plex" } });
  });

  it("changes nothing on the TV: it only asks, pressing no key and launching or closing nothing", async () => {
    tv.bringToFront("111299001912");
    const before = tv.apps();
    tv.clearRequests();

    await readNowShowing();
    await readNowShowing();

    expect(tv.apps()).toEqual(before);
    expect(tv.keys).toEqual([]);
    expect(tv.texts).toEqual([]);
    expect(tv.requests.length).toBeGreaterThan(0);
    expect(tv.requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("asks on the control socket kept open for keys, and the TV's REST API for each app", async () => {
    await readNowShowing();
    await readNowShowing();

    expect(tv.connections.filter(({ outcome }) => outcome === "accepted")).toHaveLength(1);
    const asked = new Set(tv.requests.map(({ path }) => path));
    expect(asked).toEqual(new Set(tv.apps().map(({ id }) => `/api/v2/applications/${id}`)));
  });

  it("reports a token the TV refuses once access is revoked on it", async () => {
    await readNowShowing();
    tv.revokeAccess();
    await tv.dropConnections();

    expect(await readNowShowing()).toEqual({ accepted: false });
  });

  it("says the TV didn't answer when it doesn't list its apps, as in standby", async () => {
    tv.setPowerState("standby");

    const error = await failure(readNowShowing());

    expect(error.reason).toBe("timed-out");
    expect(error.message).not.toContain(token);
  });

  it("says no TV answered when nothing is listening at the address, without quoting the token", async () => {
    const nowhere = samsungTvDriver({ restPort: await freePort(), controlPort: await freePort() });

    const error = await failure(readNowShowing(token, nowhere));

    expect(error.reason).toBe("unreachable");
    expect(error.message).not.toContain(token);
  });
});

describe("an app's status, read from a TV's REST API", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    running.closeAllConnections();
    await new Promise((done) => running.close(done));
  });

  /** A TV's REST API that answers every app's status with this. */
  const answering = async (status: number, body: string): Promise<number> => {
    server = createServer((_, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    return (server.address() as AddressInfo).port;
  };

  const visible = async (port: number) => isApplicationVisible("127.0.0.1", "a.b", { port, timeoutMs: 1_000 });

  it.each([
    ['{"id": "a.b", "name": "B", "running": true, "version": "1", "visible": true}', true],
    ['{"id": "a.b", "name": "B", "running": true, "version": "1", "visible": false}', false],
    // Not running, whatever else it says, is not in front.
    ['{"id": "a.b", "name": "B", "running": false, "version": "1", "visible": true}', false],
  ])("is in front only when the TV says it is running and visible (%s)", async (body, inFront) => {
    expect(await visible(await answering(200, body))).toBe(inFront);
  });

  it("is not in front when the TV has no such app", async () => {
    expect(await visible(await answering(404, '{"message": "Not Found"}'))).toBe(false);
  });

  it.each([
    [503, '{"message": "Service Unavailable"}'],
    [200, '{"visible": "yes"}'],
    [200, "true"],
    [200, "not json"],
  ])("can't be told from a TV that answers %i with %s", async (status, body) => {
    await expect(visible(await answering(status, body))).rejects.toBeInstanceOf(AppsUnavailable);
  });

  it("can't be told from a TV that doesn't answer", async () => {
    await expect(visible(await freePort())).rejects.toBeInstanceOf(AppsUnavailable);
  });
});
