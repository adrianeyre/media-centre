import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  FAKE_AIRCON_KEYS_PATH,
  startFakeMideaAircon,
  type FakeMideaAircon,
} from "../../fakes/midea-aircon/fake-midea-aircon.ts";
import {
  startFakeMideaCloud,
  type FakeCloudApp,
  type FakeMideaCloud,
} from "../../fakes/midea-cloud/fake-midea-cloud.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure } from "../driver.ts";
import { MideaAuthError, mideaCredentials, mideaDriver } from "./midea-driver.ts";

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };

/** What MSmartHome's routers log for an account they don't know: each one's code, never the login. */
const NO_ROUTE = [
  "Midea's router at /v1/unitcenter/router/user/name named no server for the MSmartHome account: it answered code 10004",
  "Midea's router at /v1/multicloud/platform/user/route named no server for the MSmartHome account: it answered code 10004",
];

let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

/**
 * A v3 fake, and a fake of each of Midea's clouds: `setUpIn`'s, by default
 * MSmartHome's, which signs in the owner's login and issues the unit the
 * token and key it expects, and the other's, which knows neither, as a real
 * account is in only one.
 */
const start = async (
  version: 2 | 3 = 3,
  setUpIn: FakeCloudApp = "MSmartHome",
): Promise<{ aircon: FakeMideaAircon; cloud: FakeMideaCloud; mideaAir: FakeMideaCloud }> => {
  const aircon = await startFakeMideaAircon({ version });
  const units = version === 3 ? [{ id: aircon.id, token: aircon.token ?? "", key: aircon.key ?? "" }] : [];
  const cloudOf = (app: FakeCloudApp) =>
    startFakeMideaCloud(
      app === setUpIn
        ? { app, ...LOGIN, units }
        : { app, account: "someone-else@example.com", password: "not the owner's" },
    );
  const cloud = await cloudOf("MSmartHome");
  const mideaAir = await cloudOf("Midea Air");
  stops.push(aircon.stop, cloud.stop, mideaAir.stop);
  return { aircon, cloud, mideaAir };
};

const driverFor = (
  aircon: FakeMideaAircon,
  cloudUrl: string,
  mideaAirCloudUrl: string,
  log: (line: string) => void = () => undefined,
) =>
  mideaDriver({
    port: aircon.port,
    discoveryPorts: [aircon.discoveryPort],
    searchTargets: [{ host: aircon.host, port: aircon.discoveryPort }],
    searchWindowMs: 200,
    connectTimeoutMs: 1_000,
    answerTimeoutMs: 1_000,
    cloudUrl,
    mideaAirCloudUrl,
    cloudTimeoutMs: 1_000,
    log,
  });

describe("The Midea Driver's one-off token fetch (ADR 0009)", () => {
  it("fetches a v3 unit's token and key from the cloud with the owner's login, and controls it with them once the cloud is gone", async () => {
    const { aircon, cloud, mideaAir } = await start();
    const lines: string[] = [];
    const driver = driverFor(aircon, cloud.url, mideaAir.url, (line) => lines.push(line));
    const found = await driver.identify(aircon.host);
    // As discovery finds it, it answers nothing yet.
    await expect(driver.readState(aircon.host, found.credentials)).rejects.toThrow(MideaAuthError);

    const credentials = await driver.fetchKeys(aircon.host, found.credentials, LOGIN);

    expect(credentials).toBe(
      mideaCredentials({ id: aircon.id, version: 3, token: aircon.token ?? "", key: aircon.key ?? "" }),
    );
    expect(aircon.connections.at(-1)).toEqual({ version: 3, handshake: "accepted" });
    expect(lines).toEqual([
      // The server that holds the account, by its host alone, never the login.
      `Midea's router at /v1/unitcenter/router/user/name says the MSmartHome account is held at ${new URL(cloud.url).host}`,
      `Fetched the token and key of the Air Conditioner at ${aircon.host} from MSmartHome's cloud`,
    ]);

    await cloud.stop();
    const requests = cloud.requests.length;
    expect((await driver.setState(aircon.host, credentials, { power: true })).power).toBe(true);
    expect(aircon.state().power).toBe(true);
    expect(cloud.requests).toHaveLength(requests);
  });

  it("fetches them for an MSmartHome account held on a regional server, as Europe's holds a UK account", async () => {
    const aircon = await startFakeMideaAircon({ version: 3 });
    const units = [{ id: aircon.id, token: aircon.token ?? "", key: aircon.key ?? "" }];
    const cloud = await startFakeMideaCloud({ ...LOGIN, units, region: "eu" });
    const mideaAir = await startFakeMideaCloud({
      app: "Midea Air",
      account: "someone-else@example.com",
      password: "x",
    });
    stops.push(aircon.stop, cloud.stop, mideaAir.stop);
    const driver = driverFor(aircon, cloud.url, mideaAir.url);
    const { credentials } = await driver.identify(aircon.host);

    // As autofilled, with a space after the email, which the cloud would take for another account.
    const fetched = await driver.fetchKeys(aircon.host, credentials, { ...LOGIN, account: ` ${LOGIN.account} ` });

    expect(fetched).toBe(
      mideaCredentials({ id: aircon.id, version: 3, token: aircon.token ?? "", key: aircon.key ?? "" }),
    );
    expect(mideaAir.requests).toEqual([]);
  });

  it("refuses a login the cloud refuses, saying so, and asks the unit nothing", async () => {
    const { aircon, cloud, mideaAir } = await start();
    const driver = driverFor(aircon, cloud.url, mideaAir.url);
    const { credentials } = await driver.identify(aircon.host);
    aircon.clear();

    const failure = await driver
      .fetchKeys(aircon.host, credentials, { ...LOGIN, password: "wrong" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DriverFailure);
    expect(failure).toMatchObject({
      reason: "refused",
      message:
        "Neither MSmartHome nor Midea Air accepted that email and password. Check them, as you sign in to the app the Air Conditioner is set up in, then try again.",
    });
    expect(aircon.connections).toEqual([]);
  });

  it("fetches them from Midea Air's cloud for a unit set up in the Midea Air app, whose account MSmartHome doesn't know", async () => {
    const { aircon, cloud, mideaAir } = await start(3, "Midea Air");
    const lines: string[] = [];
    const driver = driverFor(aircon, cloud.url, mideaAir.url, (line) => lines.push(line));
    const { credentials } = await driver.identify(aircon.host);

    const fetched = await driver.fetchKeys(aircon.host, credentials, LOGIN);

    expect(fetched).toBe(
      mideaCredentials({ id: aircon.id, version: 3, token: aircon.token ?? "", key: aircon.key ?? "" }),
    );
    // Neither of MSmartHome's routers, nor its server, knows the account.
    expect(cloud.requests.map(({ outcome }) => outcome)).toEqual(["wrong-login", "wrong-login", "wrong-login"]);
    expect(mideaAir.requests.map(({ path, outcome }) => [path, outcome])).toEqual([
      ["/v1/user/login/id/get", "accepted"],
      ["/v1/user/login", "accepted"],
      ["/v1/iot/secure/getToken", "accepted"],
    ]);
    // Each cloud's code alone, never the login.
    expect(lines).toEqual([
      ...NO_ROUTE,
      "MSmartHome's cloud refused the login with code 3102",
      `Fetched the token and key of the Air Conditioner at ${aircon.host} from Midea Air's cloud`,
    ]);
    expect(lines.join(" ")).not.toContain(LOGIN.account);
    expect((await driver.setState(aircon.host, fetched, { power: true })).power).toBe(true);
  });

  it("refuses a wrong password for a Midea Air account, saying so, having tried both clouds", async () => {
    const { aircon, cloud, mideaAir } = await start(3, "Midea Air");
    const lines: string[] = [];
    const driver = driverFor(aircon, cloud.url, mideaAir.url, (line) => lines.push(line));
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, { ...LOGIN, password: "wrong" })).rejects.toMatchObject({
      reason: "refused",
    });
    expect(lines).toEqual([
      ...NO_ROUTE,
      "MSmartHome's cloud refused the login with code 3102",
      "Midea Air's cloud refused the login with code 3105",
    ]);
  });

  it("asks MSmartHome by the id its account lists the unit by, when that isn't the unit's own", async () => {
    const { aircon, cloud, mideaAir } = await start();
    cloud.setUnits([{ id: aircon.id, token: aircon.token ?? "", key: aircon.key ?? "", applianceCode: "99887766" }]);
    const driver = driverFor(aircon, cloud.url, mideaAir.url);
    const { credentials } = await driver.identify(aircon.host);

    const fetched = await driver.fetchKeys(aircon.host, credentials, LOGIN);

    expect(fetched).toBe(
      mideaCredentials({ id: aircon.id, version: 3, token: aircon.token ?? "", key: aircon.key ?? "" }),
    );
    expect(cloud.requests.map(({ path, outcome }) => [path, outcome])).toEqual([
      ["/v1/unitcenter/router/user/name", "accepted"],
      ["/v1/user/login/id/get", "accepted"],
      ["/mj/user/login", "accepted"],
      // By its own id, which the account doesn't know it by…
      ["/v1/iot/secure/getToken", "not-permitted"],
      ["/v1/iot/secure/getToken", "unknown-unit"],
      // …then by the id the account lists it by.
      ["/v1/appliance/user/list/get", "accepted"],
      ["/v1/iot/secure/getToken", "accepted"],
    ]);
  });

  it("says Midea no longer issues them through Midea Air, whose cloud signs in but answers every token request 9999", async () => {
    const { aircon, cloud } = await start(3, "Midea Air");
    const retired = await startFakeMideaCloud({
      app: "Midea Air",
      tokensRetired: true,
      ...LOGIN,
      units: [{ id: aircon.id, token: aircon.token ?? "", key: aircon.key ?? "" }],
    });
    stops.push(retired.stop);
    const driver = driverFor(aircon, cloud.url, retired.url);
    const { credentials } = await driver.identify(aircon.host);
    aircon.clear();

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toMatchObject({
      reason: "refused",
      message:
        "Midea no longer issues the token and key through Midea Air's cloud, though it signs you in. " +
        "Pair the Air Conditioner in the MSmartHome app, with a new MSmartHome account rather than one moved from Midea Air, " +
        "then sign in with that.",
    });
    expect(aircon.connections).toEqual([]);
  });

  it("logs why it fetched nothing: the cloud's code for each id it has no token for, never a token", async () => {
    const { aircon, cloud, mideaAir } = await start(3, "Midea Air");
    mideaAir.setUnits([]);
    const lines: string[] = [];
    const driver = driverFor(aircon, cloud.url, mideaAir.url, (line) => lines.push(line));
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toThrow(MideaAuthError);

    expect(lines).toEqual([
      ...NO_ROUTE,
      "MSmartHome's cloud refused the login with code 3102",
      `Midea Air's cloud has no token for the Air Conditioner at ${aircon.host} by its little-endian id, as appliance ${String(aircon.id)}: it answered code 3176`,
      `Midea Air's cloud has no token for the Air Conditioner at ${aircon.host} by its big-endian id, as appliance ${String(aircon.id)}: it answered code 3176`,
    ]);
  });

  it("logs that the unit refused what the cloud issued, for each id", async () => {
    const { aircon, cloud, mideaAir } = await start(3, "Midea Air");
    mideaAir.setUnits([
      { id: aircon.id, token: randomBytes(64).toString("hex"), key: randomBytes(32).toString("hex") },
    ]);
    const lines: string[] = [];
    const driver = driverFor(aircon, cloud.url, mideaAir.url, (line) => lines.push(line));
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toThrow(MideaAuthError);

    expect(lines).toContain(
      `The Air Conditioner at ${aircon.host} refused the token and key Midea Air's cloud issued for its little-endian id, as appliance ${String(aircon.id)}`,
    );
    expect(lines).toContain(
      `Midea Air's cloud has no token for the Air Conditioner at ${aircon.host} by its big-endian id, as appliance ${String(aircon.id)}: it answered code 3176`,
    );
  });

  it("asks again a unit that, having refused one id's token, doesn't answer at once, and takes the other id's", async () => {
    const aircon = await startFakeMideaAircon({ version: 3, silentAfterRefusalMs: 300 });
    // The id with its bytes the other way round, which the fake cloud hashes little-endian as the unit's big-endian id.
    const reversed = Buffer.alloc(6);
    reversed.writeUIntBE(aircon.id, 0, 6);
    const cloud = await startFakeMideaCloud({
      ...LOGIN,
      units: [
        { id: aircon.id, token: randomBytes(64).toString("hex"), key: randomBytes(32).toString("hex") },
        {
          id: reversed.readUIntLE(0, 6),
          token: aircon.token ?? "",
          key: aircon.key ?? "",
          applianceCode: String(aircon.id),
        },
      ],
    });
    const mideaAir = await startFakeMideaCloud({
      app: "Midea Air",
      account: "someone-else@example.com",
      password: "x",
    });
    stops.push(aircon.stop, cloud.stop, mideaAir.stop);
    const lines: string[] = [];
    const driver = mideaDriver({
      port: aircon.port,
      discoveryPorts: [aircon.discoveryPort],
      searchTargets: [{ host: aircon.host, port: aircon.discoveryPort }],
      connectTimeoutMs: 1_000,
      answerTimeoutMs: 200,
      cloudUrl: cloud.url,
      mideaAirCloudUrl: mideaAir.url,
      cloudTimeoutMs: 1_000,
      settleMs: 300,
      log: (line) => lines.push(line),
    });
    const { credentials } = await driver.identify(aircon.host);

    const fetched = await driver.fetchKeys(aircon.host, credentials, LOGIN);

    expect(fetched).toBe(
      mideaCredentials({ id: aircon.id, version: 3, token: aircon.token ?? "", key: aircon.key ?? "" }),
    );
    expect(lines).toContain(
      `The Air Conditioner at ${aircon.host} refused the token and key MSmartHome's cloud issued for its little-endian id, as appliance ${String(aircon.id)}`,
    );
    expect(lines).toContain(
      `The Air Conditioner at ${aircon.host} didn't answer as its token and key were tried, so the Hub asks again in 0 seconds`,
    );
    expect(lines.at(-1)).toBe(
      `Fetched the token and key of the Air Conditioner at ${aircon.host} from MSmartHome's cloud`,
    );
  });

  it("says the cloud can't be reached when MSmartHome refuses the login and Midea Air's can't be reached", async () => {
    const { aircon, cloud } = await start(3, "Midea Air");
    const nowhere = `http://127.0.0.1:${String(await freePort())}`;
    const driver = driverFor(aircon, cloud.url, nowhere);
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("says when the cloud can't be reached", async () => {
    const { aircon } = await start();
    const nowhere = `http://127.0.0.1:${String(await freePort())}`;
    const driver = driverFor(aircon, nowhere, nowhere);
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toMatchObject({
      reason: "unreachable",
      message: "The Hub couldn't reach Midea's cloud. Adding a v3 Air Conditioner needs the internet, once.",
    });
  });

  it("refuses with the auth error when the unit accepts nothing the cloud issued", async () => {
    const { aircon, cloud, mideaAir } = await start();
    cloud.setUnits([{ id: aircon.id, token: randomBytes(64).toString("hex"), key: randomBytes(32).toString("hex") }]);
    const driver = driverFor(aircon, cloud.url, mideaAir.url);
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toThrow(MideaAuthError);
    expect(aircon.connections.at(-1)).toEqual({ version: 3, handshake: "refused" });
  });

  it("fetches them again once the unit is given new ones, as after a factory reset, refusing the old", async () => {
    const { aircon, cloud, mideaAir } = await start();
    const driver = driverFor(aircon, cloud.url, mideaAir.url);
    const { credentials: found } = await driver.identify(aircon.host);
    const first = await driver.fetchKeys(aircon.host, found, LOGIN);

    const token = randomBytes(64).toString("hex");
    const key = randomBytes(32).toString("hex");
    const reset = await fetch(`http://${aircon.host}:${String(aircon.httpPort)}${FAKE_AIRCON_KEYS_PATH}`, {
      method: "POST",
      body: JSON.stringify({ token, key }),
    });
    expect(reset.status).toBe(204);
    expect(await reset.text()).toBe("");
    cloud.setUnits([{ id: aircon.id, token, key }]);

    await expect(driver.readState(aircon.host, first)).rejects.toThrow(MideaAuthError);
    const again = await driver.fetchKeys(aircon.host, first, LOGIN);

    expect(again).toBe(mideaCredentials({ id: aircon.id, version: 3, token, key }));
    expect((await driver.readState(aircon.host, again)).power).toBe(false);
  });

  it("fetches nothing for a v2 unit, which needs no token or key", async () => {
    const { aircon, cloud, mideaAir } = await start(2);
    const driver = driverFor(aircon, cloud.url, mideaAir.url);
    const { credentials } = await driver.identify(aircon.host);

    await expect(driver.fetchKeys(aircon.host, credentials, LOGIN)).rejects.toMatchObject({ reason: "not-supported" });
    expect(cloud.requests).toEqual([]);
  });
});
