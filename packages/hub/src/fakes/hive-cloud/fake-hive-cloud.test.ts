import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hiveDriver } from "../../drivers/hive/hive-driver.ts";
import { freePort } from "../../testing/ports.ts";
import { startNodeProcess, type RunningProcess } from "../../testing/process.ts";
import {
  FAKE_HIVE_CLOCK_PATH,
  FAKE_HIVE_OUTAGE_PATH,
  FAKE_HIVE_PRODUCTS_PATH,
  FAKE_HIVE_REQUESTS_PATH,
  FAKE_HIVE_REVOKE_PATH,
  FAKE_HIVE_STATE_PATH,
  startFakeHiveCloud,
  type FakeHiveProductState,
  type FakeHiveRequest,
} from "./fake-hive-cloud.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const LISTENING =
  /Fake Hive cloud listening on (http:\/\/127\.0\.0\.1:\d+), with (\d+) Heating zones, (\d+) Radiator Valves and (\d+) Hot Water, asking for (a|no) code/;

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };
const CODE = "246810";

let running: RunningProcess | undefined;
let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

/** What the fake answered: its status, and its JSON, which each test says the shape of. */
const json = async (url: string, method = "GET", body?: unknown): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

const signedIn = async (url: string, code?: string): Promise<string> => {
  const driver = hiveDriver({ apiUrl: url, authUrl: url, timeoutMs: 2_000, log: () => undefined });
  const answer = await driver.signIn(LOGIN);
  if (answer.signedIn) return answer.credentials;
  if (code === undefined) throw new Error("It asked for a code");
  return driver.enterCode(answer.pending, code);
};

describe("The fake Hive cloud", () => {
  it("runs as its own process, with the products and code it is given, and never prints the password, the code or a token", async () => {
    const port = await freePort();
    running = await startNodeProcess(
      MAIN,
      {
        FAKE_HIVE_CLOUD_PORT: String(port),
        FAKE_HIVE_CLOUD_ACCOUNT: LOGIN.account,
        FAKE_HIVE_CLOUD_PASSWORD: LOGIN.password,
        FAKE_HIVE_CLOUD_CODE: CODE,
      },
      LISTENING,
    );
    const [, url = "", heating, valves, hotWater, asks] = running.match;
    expect([heating, valves, hotWater, asks]).toEqual(["2", "3", "1", "a"]);

    const credentials = await signedIn(url, CODE);
    const { states } = await hiveDriver({ apiUrl: url, authUrl: url, log: () => undefined }).readStates(credentials);
    expect(states.map(({ kind }) => kind)).toEqual([
      "heating",
      "heating",
      "radiator-valve",
      "radiator-valve",
      "radiator-valve",
      "hot-water",
    ]);

    const state = (await json(`${url}${FAKE_HIVE_STATE_PATH}`)).body as FakeHiveProductState[];
    expect(state.map(({ kind, name, zone }) => [kind, name, zone])).toEqual([
      ["heating", "Downstairs", null],
      ["heating", "Upstairs", null],
      ["radiator-valve", "Bedroom", "Upstairs"],
      ["radiator-valve", "Study", "Upstairs"],
      ["radiator-valve", "Living Room", "Downstairs"],
      ["hot-water", "Hot Water", null],
    ]);

    const requests = (await json(`${url}${FAKE_HIVE_REQUESTS_PATH}`)).body as FakeHiveRequest[];
    expect(requests.map(({ request, outcome }) => `${request} ${outcome}`)).toEqual([
      "InitiateAuth USER_SRP_AUTH accepted",
      "RespondToAuthChallenge PASSWORD_VERIFIER accepted",
      "RespondToAuthChallenge SMS_MFA accepted",
      "ConfirmDevice accepted",
      "UpdateDeviceStatus accepted",
      "GET /nodes/all accepted",
    ]);

    const output = running.output.join("\n");
    const kept = JSON.parse(credentials) as Record<string, unknown>;
    for (const secret of [LOGIN.password, CODE, kept.accessToken, kept.idToken, kept.refreshToken]) {
      expect(output).not.toContain(secret);
      expect(JSON.stringify(requests)).not.toContain(secret);
    }
  });

  it("runs with one zone and no Hot Water, and asks for no code, when told so", async () => {
    const port = await freePort();
    running = await startNodeProcess(
      MAIN,
      {
        FAKE_HIVE_CLOUD_PORT: String(port),
        FAKE_HIVE_CLOUD_ACCOUNT: LOGIN.account,
        FAKE_HIVE_CLOUD_PASSWORD: LOGIN.password,
        FAKE_HIVE_CLOUD_HEATING: "Heating",
        FAKE_HIVE_CLOUD_RADIATOR_VALVES: "",
        FAKE_HIVE_CLOUD_HOT_WATER: "false",
      },
      LISTENING,
    );
    const [, url = "", heating, valves, hotWater, asks] = running.match;
    expect([heating, valves, hotWater, asks]).toEqual(["1", "0", "0", "no"]);

    const { appliances } = await hiveDriver({ apiUrl: url, authUrl: url, log: () => undefined }).listAppliances(
      await signedIn(url),
    );
    expect(appliances.map(({ kind, name }) => [kind, name])).toEqual([["heating", "Heating"]]);
  });

  it.each([
    ["no password", { FAKE_HIVE_CLOUD_PASSWORD: "" }, "FAKE_HIVE_CLOUD_PASSWORD must be that account's password"],
    [
      "a Radiator Valve in a Heating it hasn't got",
      { FAKE_HIVE_CLOUD_RADIATOR_VALVES: "Bedroom:Loft" },
      "FAKE_HIVE_CLOUD_RADIATOR_VALVES must be <name>:<Heating>",
    ],
    ["Hot Water neither true nor false", { FAKE_HIVE_CLOUD_HOT_WATER: "yes" }, "FAKE_HIVE_CLOUD_HOT_WATER must be"],
  ])("won't start with %s", async (_, env, message) => {
    await expect(
      startNodeProcess(
        MAIN,
        {
          FAKE_HIVE_CLOUD_PORT: "0",
          FAKE_HIVE_CLOUD_ACCOUNT: LOGIN.account,
          FAKE_HIVE_CLOUD_PASSWORD: LOGIN.password,
          ...env,
        },
        LISTENING,
      ),
    ).rejects.toThrow(message);
  });

  it("changes its state as Hive's app would, takes a valve offline, and refuses what isn't a change", async () => {
    const cloud = await startFakeHiveCloud(LOGIN);
    stops.push(cloud.stop);
    const bedroom = cloud.products().find(({ name }) => name === "Bedroom")?.id ?? "";
    const hotWater = cloud.products().find(({ kind }) => kind === "hot-water")?.id ?? "";

    const { status, body: answered } = await json(`${cloud.url}${FAKE_HIVE_STATE_PATH}`, "POST", [
      { id: bedroom, mode: "manual", target: 22.5, temperature: 17, working: true, online: false, battery: 10 },
      { id: hotWater, mode: "on", working: true },
    ]);
    const body = answered as FakeHiveProductState[];

    expect(status).toBe(200);
    expect(body.find(({ id }) => id === bedroom)).toEqual({
      id: bedroom,
      kind: "radiator-valve",
      name: "Bedroom",
      mode: "manual",
      target: 22.5,
      boost: null,
      temperature: 17,
      working: true,
      online: false,
      battery: 10,
      zone: "Upstairs",
      refusesChanges: false,
    });
    expect(body.find(({ id }) => id === hotWater)).toMatchObject({ mode: "on", target: null, working: true });

    for (const wrong of [
      { id: "no-such-id", target: 20 },
      { id: bedroom, mode: "auto" },
      { id: bedroom, target: 99 },
      { id: hotWater, battery: 50 },
    ]) {
      expect((await json(`${cloud.url}${FAKE_HIVE_STATE_PATH}`, "POST", wrong)).status).toBe(400);
    }
  });

  it("counts a Boost down on a clock the test moves on, and goes back to the mode and target it had", async () => {
    const cloud = await startFakeHiveCloud(LOGIN);
    stops.push(cloud.stop);
    const upstairs = cloud.products().find(({ name }) => name === "Upstairs")?.id ?? "";

    await json(`${cloud.url}${FAKE_HIVE_STATE_PATH}`, "POST", { id: upstairs, boost: 30, target: 23 });
    expect(cloud.products().find(({ id }) => id === upstairs)).toMatchObject({ mode: "boost", boost: 30, target: 23 });

    expect((await json(`${cloud.url}${FAKE_HIVE_CLOCK_PATH}`, "POST", { minutes: 20 })).body).toEqual({ minutes: 20 });
    expect(cloud.products().find(({ id }) => id === upstairs)).toMatchObject({ mode: "boost", boost: 10 });

    await json(`${cloud.url}${FAKE_HIVE_CLOCK_PATH}`, "POST", { minutes: 10 });
    expect(cloud.products().find(({ id }) => id === upstairs)).toMatchObject({
      mode: "schedule",
      boost: null,
      target: 19,
    });
    expect((await json(`${cloud.url}${FAKE_HIVE_CLOCK_PATH}`, "POST", { minutes: -1 })).status).toBe(400);
  });

  it("replaces its products, refuses the tokens once revoked, and forgets the requests it answered", async () => {
    const cloud = await startFakeHiveCloud({ ...LOGIN, code: CODE });
    stops.push(cloud.stop);
    const credentials = await signedIn(cloud.url, CODE);
    const { idToken } = JSON.parse(credentials) as { idToken: string };

    const { body: answer } = await json(`${cloud.url}${FAKE_HIVE_PRODUCTS_PATH}`, "PUT", [
      { kind: "heating", name: "Heating" },
    ]);
    const replaced = answer as FakeHiveProductState[];
    expect(replaced.map(({ kind, name }) => [kind, name])).toEqual([["heating", "Heating"]]);
    expect((await json(`${cloud.url}${FAKE_HIVE_PRODUCTS_PATH}`, "PUT", [{ kind: "kettle", name: "x" }])).status).toBe(
      400,
    );

    const nodes = (): Promise<Response> =>
      fetch(`${cloud.url}/nodes/all?products=true&devices=true&actions=true`, { headers: { authorization: idToken } });
    expect((await nodes()).status).toBe(200);
    expect((await json(`${cloud.url}${FAKE_HIVE_REVOKE_PATH}`, "POST")).body).toEqual({
      revoked: true,
      devices: false,
    });
    expect((await nodes()).status).toBe(401);
    expect(cloud.requests.at(-1)).toMatchObject({ outcome: "not-signed-in" });

    // The device is still trusted, so signing in again asks no code; forgetting it, it does.
    const driver = hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, log: () => undefined });
    expect((await driver.signIn(LOGIN, credentials)).signedIn).toBe(true);
    await json(`${cloud.url}${FAKE_HIVE_REVOKE_PATH}`, "POST", { devices: true });
    expect((await driver.signIn(LOGIN, credentials)).signedIn).toBe(false);

    expect(((await json(`${cloud.url}${FAKE_HIVE_REQUESTS_PATH}`)).body as unknown[]).length).toBeGreaterThan(0);
    expect((await json(`${cloud.url}${FAKE_HIVE_REQUESTS_PATH}`, "DELETE")).body).toEqual([]);
    expect(cloud.requests).toEqual([]);
  });

  it("refuses a token it didn't issue, and a password claim that doesn't prove the password", async () => {
    const cloud = await startFakeHiveCloud(LOGIN);
    stops.push(cloud.stop);

    const forged = await fetch(`${cloud.url}/nodes/all?products=true&devices=true&actions=true`, {
      headers: { authorization: "not a token it issued" },
    });
    expect(forged.status).toBe(401);

    // Neither a sign-in step, which says its operation, nor a request with a token.
    expect((await json(`${cloud.url}/`, "POST", { AuthFlow: "USER_SRP_AUTH" })).status).toBe(401);

    const driver = hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, log: () => undefined });
    await expect(driver.signIn({ ...LOGIN, password: "nearly correct horse battery staple" })).rejects.toMatchObject({
      what: "login",
    });
    expect(cloud.requests.map(({ request, outcome }) => `${request} ${outcome}`).slice(-2)).toEqual([
      "InitiateAuth USER_SRP_AUTH accepted",
      "RespondToAuthChallenge PASSWORD_VERIFIER wrong-login",
    ]);
  });

  it("drops every connection but a test's while it is down, keeping its state and tokens, and answers once it is back", async () => {
    const cloud = await startFakeHiveCloud(LOGIN);
    stops.push(cloud.stop);
    const credentials = await signedIn(cloud.url);
    const driver = hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, timeoutMs: 1_000, log: () => undefined });
    const study = cloud.products().find(({ name }) => name === "Study")?.id ?? "";
    await json(`${cloud.url}${FAKE_HIVE_STATE_PATH}`, "POST", { id: study, target: 22 });
    cloud.clear();

    expect((await json(`${cloud.url}${FAKE_HIVE_OUTAGE_PATH}`, "POST", { down: true })).body).toEqual({ down: true });
    await expect(driver.readStates(credentials)).rejects.toMatchObject({ name: "HiveUnreachableError" });
    expect((await json(`${cloud.url}${FAKE_HIVE_OUTAGE_PATH}`)).body).toEqual({ down: true });
    expect(cloud.requests.map(({ request, outcome }) => `${request} ${outcome}`)).toEqual(["GET /nodes/all dropped"]);
    expect((await json(`${cloud.url}${FAKE_HIVE_OUTAGE_PATH}`, "POST", { down: "yes" })).status).toBe(400);

    await json(`${cloud.url}${FAKE_HIVE_OUTAGE_PATH}`, "POST", { down: false });
    const { states } = await driver.readStates(credentials);
    expect(states.find(({ id }) => id === study)?.state).toMatchObject({ target: 22 });

    cloud.setDown(true);
    await expect(driver.readStates(credentials)).rejects.toMatchObject({ name: "HiveUnreachableError" });
    cloud.setDown(false);
    expect((await driver.readStates(credentials)).states).toHaveLength(6);
  });

  it("goes back to the target it had as a Boost is cancelled back to its schedule, as Hive does", async () => {
    const cloud = await startFakeHiveCloud(LOGIN);
    stops.push(cloud.stop);
    const credentials = await signedIn(cloud.url);
    const driver = hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, log: () => undefined });
    const downstairs = cloud.products().find(({ name }) => name === "Downstairs")?.id ?? "";

    await driver.setState(credentials, downstairs, { boost: { target: 23, minutes: 60 } });
    expect(cloud.products().find(({ id }) => id === downstairs)).toMatchObject({ mode: "boost", target: 23 });
    const { state } = await driver.setState(credentials, downstairs, { boost: null });

    expect(state.state).toMatchObject({ mode: "schedule", target: 20, boost: null });
    expect(cloud.products().find(({ id }) => id === downstairs)).toMatchObject({ mode: "schedule", target: 20 });
  });
});
