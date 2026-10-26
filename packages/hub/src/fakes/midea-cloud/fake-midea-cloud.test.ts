import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APPLIANCE_LIST_PATH,
  CloudHasNoToken,
  CloudLoginRefused,
  cloudUdpId,
  LEGACY_ROUTER_PATH,
  LOGIN_ID_PATH,
  LOGIN_PATH,
  MIDEA_AIR_LOGIN_PATH,
  ROUTER_PATH,
  signInToMideaAirCloud,
  signInToMideaCloud,
  TOKEN_PATH,
} from "../../drivers/midea/cloud.ts";
import { freePort } from "../../testing/ports.ts";
import { startNodeProcess, type RunningProcess } from "../../testing/process.ts";
import { FAKE_CLOUD_REQUESTS_PATH, FAKE_CLOUD_UNITS_PATH, startFakeMideaCloud } from "./fake-midea-cloud.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const LISTENING = /Fake Midea cloud listening on (http:\/\/127\.0\.0\.1:\d+), for (\d+) units/;

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };

/** A unit as the fake cloud knows it, with a token and key made up for the test. */
const unit = (id: number) => ({ id, token: randomBytes(64).toString("hex"), key: randomBytes(32).toString("hex") });

let running: RunningProcess | undefined;
let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

const startCloud = async (units: ReturnType<typeof unit>[]) => {
  const cloud = await startFakeMideaCloud({ ...LOGIN, units });
  stops.push(cloud.stop);
  return cloud;
};

describe("The fake Midea cloud", () => {
  it("signs in the account it has, and issues each unit it knows its token and key, by its UDP id", async () => {
    const living = unit(0x0123_4567_89ab);
    const bedroom = unit(0x0000_0000_1234);
    const cloud = await startCloud([living, bedroom]);

    const session = await signInToMideaCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 2_000 });

    expect(await session.tokenFor(cloudUdpId(living.id, "little"), String(living.id))).toEqual({
      token: living.token,
      key: living.key,
    });
    expect(await session.tokenFor(cloudUdpId(bedroom.id, "little"), String(bedroom.id))).toEqual({
      token: bedroom.token,
      key: bedroom.key,
    });
    // As far as anyone knows, the cloud knows a unit by its id hashed little-endian only.
    await expect(session.tokenFor(cloudUdpId(living.id, "big"), String(living.id))).rejects.toThrow(CloudHasNoToken);
    expect(cloud.requests.map(({ path, outcome }) => [path, outcome])).toEqual([
      [ROUTER_PATH, "accepted"],
      [LOGIN_ID_PATH, "accepted"],
      [LOGIN_PATH, "accepted"],
      [TOKEN_PATH, "accepted"],
      [TOKEN_PATH, "accepted"],
      [TOKEN_PATH, "unknown-unit"],
    ]);
  });

  describe("holding the account on a regional server, as Europe's holds a UK account", () => {
    const startRegional = async (routers: "both" | "legacy" | "none") => {
      const living = unit(42);
      const cloud = await startFakeMideaCloud({ ...LOGIN, units: [living], region: "eu", routers });
      stops.push(cloud.stop);
      return { cloud, living };
    };

    it("signs in on the server its router names, which alone knows the account", async () => {
      const { cloud, living } = await startRegional("both");

      const session = await signInToMideaCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 2_000 });

      expect(await session.tokenFor(cloudUdpId(living.id, "little"), String(living.id))).toEqual({
        token: living.token,
        key: living.key,
      });
      expect(cloud.requests.map(({ path, outcome }) => [path, outcome])).toEqual([
        [ROUTER_PATH, "accepted"],
        [LOGIN_ID_PATH, "accepted"],
        [LOGIN_PATH, "accepted"],
        [TOKEN_PATH, "accepted"],
      ]);
    });

    it("asks the legacy router, by the account as it is, where the other doesn't answer", async () => {
      const { cloud } = await startRegional("legacy");

      await signInToMideaCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 2_000 });

      expect(cloud.requests.map(({ path, outcome }) => [path, outcome]).slice(0, 3)).toEqual([
        [ROUTER_PATH, "not-found"],
        [LEGACY_ROUTER_PATH, "accepted"],
        [LOGIN_ID_PATH, "accepted"],
      ]);
    });

    it("says the account doesn't exist, 3102, on any other server, as where no router answers", async () => {
      const { cloud } = await startRegional("none");

      await expect(signInToMideaCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 2_000 })).rejects.toMatchObject({
        name: "CloudLoginRefused",
        code: "3102",
      });
    });
  });

  it("answers through a proxy's alias, as the real API is reached", async () => {
    const living = unit(42);
    const cloud = await startCloud([living]);

    const session = await signInToMideaCloud(LOGIN, {
      baseUrl: `${cloud.url}/mas/v5/app/proxy?alias=`,
      timeoutMs: 2_000,
    });

    expect((await session.tokenFor(cloudUdpId(42, "little"), String(42))).key).toBe(living.key);
  });

  it.each([
    ["a wrong password", { ...LOGIN, password: "Tr0ub4dor&3" }, LOGIN_PATH],
    ["an account it hasn't got", { ...LOGIN, account: "someone@example.com" }, LOGIN_ID_PATH],
  ])("refuses %s", async (_, login, refusedAt) => {
    const cloud = await startCloud([unit(42)]);

    await expect(signInToMideaCloud(login, { baseUrl: cloud.url, timeoutMs: 2_000 })).rejects.toThrow(
      CloudLoginRefused,
    );
    expect(cloud.requests.at(-1)).toMatchObject({ path: refusedAt, outcome: "wrong-login" });
  });

  it("issues a token only when asked with the id the account knows the unit by, and lists its units by those ids", async () => {
    const own = unit(0x0123_4567_89ab);
    const known = { ...unit(0x0000_0000_1234), applianceCode: "99887766" };
    const cloud = await startCloud([own, known]);
    const session = await signInToMideaCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 1_000 });

    expect(await session.airConditionerCodes()).toEqual([String(own.id), "99887766"]);
    expect((await session.tokenFor(cloudUdpId(known.id, "little"), "99887766")).key).toBe(known.key);
    await expect(session.tokenFor(cloudUdpId(known.id, "little"), String(known.id))).rejects.toMatchObject({
      name: "CloudHasNoToken",
      code: "3201",
    });
    await expect(session.tokenFor(cloudUdpId(own.id, "little"), "")).rejects.toMatchObject({ code: "3004" });
    expect(cloud.requests.map(({ path, outcome }) => [path, outcome]).slice(-4)).toEqual([
      [APPLIANCE_LIST_PATH, "accepted"],
      [TOKEN_PATH, "accepted"],
      [TOKEN_PATH, "not-permitted"],
      [TOKEN_PATH, "no-appliance-code"],
    ]);
  });

  describe("as Midea Air's, Midea's older cloud", () => {
    const startMideaAir = async (units: ReturnType<typeof unit>[]) => {
      const cloud = await startFakeMideaCloud({ app: "Midea Air", ...LOGIN, units });
      stops.push(cloud.stop);
      return cloud;
    };

    it("signs in the Midea Air account it has, and issues each unit it knows its token and key, by its UDP id", async () => {
      const living = unit(0x0123_4567_89ab);
      const cloud = await startMideaAir([living]);

      const session = await signInToMideaAirCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 1_000 });

      expect(await session.tokenFor(cloudUdpId(living.id, "little"), String(living.id))).toEqual({
        token: living.token,
        key: living.key,
      });
      await expect(session.tokenFor(cloudUdpId(living.id, "big"), String(living.id))).rejects.toThrow(CloudHasNoToken);
      expect(cloud.requests.map(({ path, outcome }) => [path, outcome])).toEqual([
        [LOGIN_ID_PATH, "accepted"],
        [MIDEA_AIR_LOGIN_PATH, "accepted"],
        [TOKEN_PATH, "accepted"],
        [TOKEN_PATH, "unknown-unit"],
      ]);
    });

    it("signs in, but answers every token request with 9999, as since Midea stopped issuing them to its accounts", async () => {
      const living = unit(42);
      const cloud = await startFakeMideaCloud({ app: "Midea Air", tokensRetired: true, ...LOGIN, units: [living] });
      stops.push(cloud.stop);
      const session = await signInToMideaAirCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 1_000 });

      await expect(session.tokenFor(cloudUdpId(living.id, "little"), String(living.id))).rejects.toMatchObject({
        name: "CloudHasNoToken",
        code: "9999",
      });
      expect(await session.airConditionerCodes()).toEqual([]);
    });

    it("refuses an account it doesn't know, and a wrong password, each with its code", async () => {
      const cloud = await startMideaAir([unit(42)]);

      await expect(
        signInToMideaAirCloud({ ...LOGIN, account: "someone@example.com" }, { baseUrl: cloud.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ name: "CloudLoginRefused", code: "3102" });
      await expect(
        signInToMideaAirCloud({ ...LOGIN, password: "wrong" }, { baseUrl: cloud.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ name: "CloudLoginRefused", code: "3105" });
    });

    it("refuses MSmartHome's sign-in, which it doesn't speak, and a form without Midea Air's signature", async () => {
      const cloud = await startMideaAir([unit(42)]);

      await expect(signInToMideaCloud(LOGIN, { baseUrl: cloud.url, timeoutMs: 1_000 })).rejects.toThrow();
      const unsigned = await fetch(`${cloud.url}${LOGIN_ID_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ loginAccount: LOGIN.account, sign: "0".repeat(64) }).toString(),
      });

      expect(await unsigned.json()).toEqual({ errorCode: "3301", msg: "sign illegal" });
      expect(cloud.requests.every(({ outcome }) => outcome === "bad-signature")).toBe(true);
    });
  });

  it("refuses a request without the app's signature, and a token asked for without signing in", async () => {
    const cloud = await startCloud([unit(42)]);

    const unsigned = await fetch(`${cloud.url}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", random: "1", sign: "0".repeat(64) },
      body: JSON.stringify({ udpid: cloudUdpId(42, "little") }),
    });

    expect(await unsigned.json()).toEqual({ code: 1001, msg: "sign illegal" });
    expect(cloud.requests).toEqual([expect.objectContaining({ path: TOKEN_PATH, outcome: "bad-signature" })]);
  });

  it("runs as its own process, issues the units it is given and is given later, and never prints them or the password", async () => {
    const living = unit(4660);
    const port = await freePort();
    running = await startNodeProcess(
      MAIN,
      {
        FAKE_MIDEA_CLOUD_PORT: String(port),
        FAKE_MIDEA_CLOUD_ACCOUNT: LOGIN.account,
        FAKE_MIDEA_CLOUD_PASSWORD: LOGIN.password,
        FAKE_MIDEA_CLOUD_UNITS: `${String(living.id)}:${living.token}:${living.key}`,
      },
      LISTENING,
    );
    const [, url = "", count] = running.match;
    expect(count).toBe("1");

    const session = await signInToMideaCloud(LOGIN, { baseUrl: url, timeoutMs: 2_000 });
    expect(await session.tokenFor(cloudUdpId(living.id, "little"), String(living.id))).toEqual({
      token: living.token,
      key: living.key,
    });

    // As after the unit is factory reset and paired again in Midea's app.
    const reset = unit(4660);
    const put = await fetch(`${url}${FAKE_CLOUD_UNITS_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([reset]),
    });
    expect(await put.json()).toEqual([{ id: 4660 }]);
    expect(await session.tokenFor(cloudUdpId(living.id, "little"), String(living.id))).toEqual({
      token: reset.token,
      key: reset.key,
    });

    const requests = (await (await fetch(`${url}${FAKE_CLOUD_REQUESTS_PATH}`)).json()) as { path: string }[];
    expect(requests.map(({ path }) => path)).toEqual([ROUTER_PATH, LOGIN_ID_PATH, LOGIN_PATH, TOKEN_PATH, TOKEN_PATH]);

    const output = running.output.join("\n");
    for (const secret of [LOGIN.password, living.token, living.key, reset.token, reset.key]) {
      expect(output).not.toContain(secret);
    }
  });
});
