import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FAKE_HIVE_HOME,
  startFakeHiveCloud,
  type FakeHiveCloud,
  type FakeHiveCloudOptions,
} from "../../fakes/hive-cloud/fake-hive-cloud.ts";
import { CredentialsRefused, DriverFailure, type HeatingDriver } from "../driver.ts";
import { BOOST_MINUTES } from "./nodes.ts";
import {
  HiveAuthError,
  hiveDriver,
  hiveDriverFromEnvironment,
  HiveRefusedError,
  HiveSignInRefused,
  HiveUnreachableError,
  type HiveDriverOptions,
} from "./hive-driver.ts";

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };
const CODE = "246810";

let stops: (() => Promise<void>)[] = [];
let logged: string[];

beforeEach(() => {
  logged = [];
});

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

const startCloud = async (options: Partial<FakeHiveCloudOptions> = {}): Promise<FakeHiveCloud> => {
  const cloud = await startFakeHiveCloud({ ...LOGIN, ...options });
  stops.push(cloud.stop);
  return cloud;
};

const driverFor = (cloud: { url: string }, options: HiveDriverOptions = {}): HeatingDriver =>
  hiveDriver({
    apiUrl: cloud.url,
    authUrl: cloud.url,
    timeoutMs: 2_000,
    log: (line) => logged.push(line),
    ...options,
  });

const signIn = async (driver: HeatingDriver): Promise<string> => {
  const answer = await driver.signIn(LOGIN);
  if (!answer.signedIn) throw new Error("Hive asked for a code");
  return answer.credentials;
};

/** What the fake answered, as `request outcome`. */
const asked = (cloud: FakeHiveCloud): string[] => cloud.requests.map(({ request, outcome }) => `${request} ${outcome}`);

/** The id of the fake's product of this name. */
const idOf = (cloud: FakeHiveCloud, name: string): string => {
  const product = cloud.products().find((each) => each.name === name);
  if (product === undefined) throw new Error(`No product is called ${name}`);
  return product.id;
};

const changesTo = (cloud: FakeHiveCloud, id: string): unknown[] =>
  cloud.requests.filter((each) => each.product === id && each.outcome === "accepted").map(({ change }) => change);

const serverAnswering = async (handler: RequestListener): Promise<{ url: string }> => {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
};

describe("The Hive Driver", () => {
  describe("signing in", () => {
    it("signs in where Hive asks no code, and has Hive trust the Hub as a device", async () => {
      const cloud = await startCloud();

      const credentials = await signIn(driverFor(cloud));

      expect(asked(cloud)).toEqual([
        "InitiateAuth USER_SRP_AUTH accepted",
        "RespondToAuthChallenge PASSWORD_VERIFIER accepted",
        "ConfirmDevice accepted",
        "UpdateDeviceStatus accepted",
      ]);
      expect(credentials).not.toContain(LOGIN.password);
      expect(logged).toContain("Signed in to Hive");
    });

    it("answers that it needs the code Hive texts, then signs in with it, and isn't asked again as the same device", async () => {
      const cloud = await startCloud({ code: CODE });
      const driver = driverFor(cloud);

      const first = await driver.signIn(LOGIN);
      expect(first).toEqual({ signedIn: false, needs: "code", pending: expect.any(String) as unknown });
      if (first.signedIn) return;
      expect(first.pending).not.toContain(LOGIN.password);

      await expect(driver.enterCode(first.pending, "000000")).rejects.toMatchObject({
        name: "HiveSignInRefused",
        reason: "refused",
        what: "code",
      });
      const credentials = await driver.enterCode(first.pending, CODE);
      expect(credentials).not.toContain(LOGIN.password);

      // Signing in again, as after Hive stops taking the tokens, as the device Hive now trusts.
      cloud.clear();
      const again = await driver.signIn(LOGIN, credentials);

      expect(again).toEqual({ signedIn: true, credentials: expect.any(String) as unknown });
      expect(asked(cloud)).toEqual([
        "InitiateAuth USER_SRP_AUTH accepted",
        "RespondToAuthChallenge PASSWORD_VERIFIER accepted",
        "RespondToAuthChallenge DEVICE_SRP_AUTH accepted",
        "RespondToAuthChallenge DEVICE_PASSWORD_VERIFIER accepted",
      ]);
      expect(logged).toContain("Hive asked for the code it texted the account's owner");
    });

    it("is asked for a code again as a new device, or once Hive forgets the Hub", async () => {
      const cloud = await startCloud({ code: CODE });
      const driver = driverFor(cloud);
      const first = await driver.signIn(LOGIN);
      if (first.signedIn) throw new Error("Hive asked no code");
      const credentials = await driver.enterCode(first.pending, CODE);

      expect((await driver.signIn(LOGIN)).signedIn).toBe(false);
      cloud.revoke(true);
      expect((await driver.signIn(LOGIN, credentials)).signedIn).toBe(false);
    });

    it("refuses a code given after Hive stops waiting for it, as expired", async () => {
      const cloud = await startCloud({ code: CODE });
      const driver = driverFor(cloud);
      const first = await driver.signIn(LOGIN);
      if (first.signedIn) throw new Error("Hive asked no code");

      cloud.advance(4);

      await expect(driver.enterCode(first.pending, CODE)).rejects.toMatchObject({ what: "expired" });
      expect(cloud.requests.at(-1)).toMatchObject({
        request: "RespondToAuthChallenge SMS_MFA",
        outcome: "expired-session",
      });
      await expect(driver.enterCode("not what the Driver gave", CODE)).rejects.toMatchObject({ what: "expired" });
    });

    it.each([
      // Hive checks the password's claim, never the password itself, which isn't sent.
      [
        "a wrong password",
        { ...LOGIN, password: "Tr0ub4dor&3" },
        ["RespondToAuthChallenge PASSWORD_VERIFIER wrong-login"],
      ],
      [
        "an account Hive hasn't got",
        { ...LOGIN, account: "someone@example.com" },
        ["InitiateAuth USER_SRP_AUTH wrong-login"],
      ],
      ["no password", { ...LOGIN, password: "" }, []],
    ])("refuses %s, saying so", async (_, login, refusedAt) => {
      const cloud = await startCloud();

      const refused = await driverFor(cloud)
        .signIn(login)
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(HiveSignInRefused);
      expect(refused).toMatchObject({ reason: "refused", what: "login" });
      expect(asked(cloud).filter((line) => !line.endsWith(" accepted"))).toEqual(refusedAt);
      expect(cloud.requests.some(({ request }) => request.startsWith("ConfirmDevice"))).toBe(false);
    });
  });

  describe("with the account signed in", () => {
    it("lists two Heating zones, several Radiator Valves and the Hot Water, by Hive's names, with what each takes", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);

      const { appliances } = await driver.listAppliances(await signIn(driver));

      const heating = {
        modes: ["schedule", "manual", "off"],
        target: { min: 5, max: 32, step: 0.5 },
        boostMinutes: BOOST_MINUTES,
      };
      expect(appliances).toEqual([
        { kind: "heating", id: idOf(cloud, "Downstairs"), name: "Downstairs", capabilities: heating },
        { kind: "heating", id: idOf(cloud, "Upstairs"), name: "Upstairs", capabilities: heating },
        { kind: "radiator-valve", id: idOf(cloud, "Bedroom"), name: "Bedroom", capabilities: heating },
        { kind: "radiator-valve", id: idOf(cloud, "Study"), name: "Study", capabilities: heating },
        { kind: "radiator-valve", id: idOf(cloud, "Living Room"), name: "Living Room", capabilities: heating },
        {
          kind: "hot-water",
          id: idOf(cloud, "Hot Water"),
          name: "Hot Water",
          capabilities: { modes: ["schedule", "on", "off"], boostMinutes: BOOST_MINUTES },
        },
      ]);
      expect(BOOST_MINUTES[0]).toBe(15);
      expect(BOOST_MINUTES.at(-1)).toBe(360);
    });

    it("takes each Appliance's target range from what Hive reports", async () => {
      const cloud = await startCloud({ products: [{ kind: "radiator-valve", name: "Hall", min: 7, max: 30 }] });
      const driver = driverFor(cloud);

      const { appliances } = await driver.listAppliances(await signIn(driver));

      expect(appliances).toMatchObject([
        { kind: "radiator-valve", capabilities: { target: { min: 7, max: 30, step: 0.5 } } },
      ]);
    });

    it("lists only one zone where the account has one zone and no Hot Water", async () => {
      const cloud = await startCloud({ products: [{ kind: "heating", name: "Heating" }] });
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);

      expect((await driver.listAppliances(credentials)).appliances.map(({ kind, name }) => [kind, name])).toEqual([
        ["heating", "Heating"],
      ]);
      expect((await driver.readStates(credentials)).states.map(({ kind }) => kind)).toEqual(["heating"]);
    });

    it("reads every Appliance's state in one request", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      cloud.setProduct(idOf(cloud, "Downstairs"), { temperature: 18.5, working: true });
      cloud.clear();

      const { states } = await driver.readStates(credentials);

      expect(asked(cloud)).toEqual(["GET /nodes/all accepted"]);
      const heating = { mode: "schedule", boost: null, temperature: 19.5, callingForHeat: false, online: true };
      expect(states).toEqual([
        {
          kind: "heating",
          id: idOf(cloud, "Downstairs"),
          state: { ...heating, target: 20, temperature: 18.5, callingForHeat: true },
        },
        { kind: "heating", id: idOf(cloud, "Upstairs"), state: { ...heating, target: 19 } },
        {
          kind: "radiator-valve",
          id: idOf(cloud, "Bedroom"),
          state: { ...heating, target: 18, lowBattery: false, zone: { id: idOf(cloud, "Upstairs"), name: "Upstairs" } },
        },
        {
          kind: "radiator-valve",
          id: idOf(cloud, "Study"),
          state: { ...heating, target: 20, lowBattery: true, zone: { id: idOf(cloud, "Upstairs"), name: "Upstairs" } },
        },
        {
          kind: "radiator-valve",
          id: idOf(cloud, "Living Room"),
          state: {
            ...heating,
            target: 21,
            lowBattery: false,
            zone: { id: idOf(cloud, "Downstairs"), name: "Downstairs" },
          },
        },
        {
          kind: "hot-water",
          id: idOf(cloud, "Hot Water"),
          state: { mode: "schedule", boost: null, on: false, online: true },
        },
      ]);
    });

    it("reads, in the same one request, every Appliance with the controls it has, as it lists them", async () => {
      const cloud = await startCloud({
        products: [
          { kind: "heating", name: "Downstairs", min: 7, max: 28 },
          { kind: "hot-water", name: "Hot Water" },
        ],
      });
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      cloud.clear();

      const { appliances, states } = await driver.readStates(credentials);

      expect(asked(cloud)).toEqual(["GET /nodes/all accepted"]);
      expect(appliances).toEqual((await driver.listAppliances(credentials)).appliances);
      expect(appliances.map(({ id }) => id)).toEqual(states.map(({ id }) => id));
      expect(appliances[0]).toMatchObject({ capabilities: { target: { min: 7, max: 28, step: 0.5 } } });
    });

    it("reads a Radiator Valve Hive reports offline as its state, not as a failure", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      const bedroom = idOf(cloud, "Bedroom");

      cloud.setProduct(bedroom, { online: false });

      const { states } = await driver.readStates(credentials);
      expect(states.find(({ id }) => id === bedroom)?.state).toMatchObject({ online: false });
      expect(states.filter(({ state }) => !state.online)).toHaveLength(1);
    });

    it.each(["Downstairs", "Bedroom"])(
      "sets %s's target, mode and Boost, and cancels the Boost back to the mode and target it had",
      async (name) => {
        const cloud = await startCloud();
        const driver = driverFor(cloud);
        let credentials = await signIn(driver);
        const id = idOf(cloud, name);

        const set = async (change: Parameters<HeatingDriver["setState"]>[2]) => {
          const answer = await driver.setState(credentials, id, change);
          credentials = answer.credentials;
          expect(answer.state.id).toBe(id);
          return answer.state.state;
        };

        expect(await set({ target: 21.5 })).toMatchObject({ mode: "schedule", target: 21.5, boost: null });
        expect(await set({ mode: "manual" })).toMatchObject({ mode: "manual", target: 21.5, boost: null });
        expect(await set({ boost: { target: 23, minutes: 60 } })).toMatchObject({
          mode: "manual",
          target: 23,
          boost: { target: 23, minutesLeft: 60 },
        });
        expect(await set({ boost: null })).toMatchObject({ mode: "manual", target: 21.5, boost: null });
        expect(await set({ mode: "off" })).toMatchObject({ mode: "off", boost: null });
        expect(await set({ mode: "schedule" })).toMatchObject({ mode: "schedule", boost: null });

        expect(changesTo(cloud, id)).toEqual([
          { target: 21.5 },
          { mode: "MANUAL" },
          { mode: "BOOST", boost: 60, target: 23 },
          { mode: "MANUAL", target: 21.5 },
          { mode: "OFF" },
          { mode: "SCHEDULE" },
        ]);
        expect(cloud.products().find((each) => each.id === id)).toMatchObject({ mode: "schedule", target: 21.5 });
      },
    );

    it("sets the Hot Water's mode, On being Hive's Manual, and boosts it by duration, and cancels the Boost", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      const id = idOf(cloud, "Hot Water");

      const set = async (change: Parameters<HeatingDriver["setState"]>[2]) =>
        (await driver.setState(credentials, id, change)).state.state;

      expect(await set({ mode: "on" })).toEqual({ mode: "on", boost: null, on: false, online: true });
      expect(await set({ mode: "off" })).toMatchObject({ mode: "off", boost: null });
      expect(await set({ boost: { minutes: 30 } })).toMatchObject({ mode: "off", boost: { minutesLeft: 30 } });
      expect(await set({ boost: null })).toMatchObject({ mode: "off", boost: null });
      expect(await set({ mode: "schedule" })).toMatchObject({ mode: "schedule" });

      expect(changesTo(cloud, id)).toEqual([
        { mode: "MANUAL" },
        { mode: "OFF" },
        { mode: "BOOST", boost: 30 },
        { mode: "OFF" },
        { mode: "SCHEDULE" },
      ]);
    });

    it("reads a Boost counting down on Hive's clock, and the Appliance back in its mode once it ends", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      const id = idOf(cloud, "Bedroom");
      await driver.setState(credentials, id, { boost: { target: 22, minutes: 60 } });

      cloud.advance(45);
      const during = await driver.readStates(credentials);
      expect(during.states.find((each) => each.id === id)?.state).toMatchObject({
        mode: "schedule",
        target: 22,
        boost: { target: 22, minutesLeft: 15 },
      });

      cloud.advance(15);
      // Its tokens have expired on Hive's clock too, and are renewed.
      const after = await driver.readStates(during.credentials);
      expect(after.states.find((each) => each.id === id)?.state).toMatchObject({
        mode: "schedule",
        target: 18,
        boost: null,
      });
    });

    it("sends nothing to cancel a Boost that isn't on", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      const id = idOf(cloud, "Downstairs");
      cloud.clear();

      const { state } = await driver.setState(credentials, id, { boost: null });

      expect(state.state).toMatchObject({ boost: null });
      expect(cloud.requests.some(({ request }) => request.startsWith("POST"))).toBe(false);
    });

    it.each([
      ["a target out of range", "Downstairs", { target: 40 }],
      ["a target between half degrees", "Bedroom", { target: 20.25 }],
      ["a Boost of a duration Hive's app doesn't offer", "Downstairs", { boost: { target: 22, minutes: 20 } }],
      ["a mode it hasn't got", "Upstairs", { mode: "on" }],
      ["a target for the Hot Water", "Hot Water", { target: 50 }],
      ["a Boost with a target for the Hot Water", "Hot Water", { boost: { target: 50, minutes: 30 } }],
      ["two changes at once", "Downstairs", { target: 21, mode: "manual" }],
    ])("refuses %s before anything is sent", async (_, name, change) => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      cloud.clear();

      await expect(
        driver.setState(credentials, idOf(cloud, name), change as Parameters<HeatingDriver["setState"]>[2]),
      ).rejects.toMatchObject({ name: "DriverFailure", reason: "not-supported" });
      expect(cloud.requests.some(({ request }) => request.startsWith("POST"))).toBe(false);
    });

    it("says so of an Appliance Hive hasn't got", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);

      await expect(driver.setState(await signIn(driver), "no-such-id", { target: 20 })).rejects.toMatchObject({
        reason: "not-recognised",
      });
    });
  });

  describe("telling Hive's failures apart", () => {
    it("fails with an error of its own when Hive refuses the tokens, which isn't Hive being unreachable", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      cloud.revoke();
      cloud.clear();

      const failure = await driver.readStates(credentials).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HiveAuthError);
      expect(failure).toBeInstanceOf(CredentialsRefused);
      expect(failure).not.toBeInstanceOf(HiveUnreachableError);
      expect(failure).toMatchObject({ reason: "not-allowed" });
      expect(asked(cloud)).toEqual(["GET /nodes/all not-signed-in", "InitiateAuth REFRESH_TOKEN_AUTH not-signed-in"]);
      await expect(driver.refresh(credentials)).rejects.toBeInstanceOf(HiveAuthError);
      await expect(driver.readStates("not the Driver's")).rejects.toBeInstanceOf(HiveAuthError);
    });

    it("fails with an error of its own, saying which Appliance, when Hive refuses a change", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      const id = idOf(cloud, "Study");
      cloud.setProduct(id, { refusesChanges: true });

      const failure = await driver.setState(credentials, id, { target: 22 }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HiveRefusedError);
      expect(failure).not.toBeInstanceOf(CredentialsRefused);
      expect(failure).not.toBeInstanceOf(HiveUnreachableError);
      expect(failure).toMatchObject({
        reason: "refused",
        applianceId: id,
        message: "Hive refused the change to Study.",
      });
      expect(cloud.requests.at(-1)).toMatchObject({ outcome: "refused", product: id, change: { target: 22 } });
    });

    it("fails as unreachable when nothing answers", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      await cloud.stop();

      for (const failure of await Promise.all([
        driver.readStates(credentials).catch((error: unknown) => error),
        driver.setState(credentials, "any", { target: 20 }).catch((error: unknown) => error),
        driver.signIn(LOGIN).catch((error: unknown) => error),
        driver.refresh(credentials).catch((error: unknown) => error),
      ])) {
        expect(failure).toBeInstanceOf(HiveUnreachableError);
        expect(failure).toMatchObject({ reason: "unreachable" });
        expect(failure).not.toBeInstanceOf(CredentialsRefused);
      }
      expect(logged).toContain("Couldn't reach Hive");
    });

    it("fails as unreachable when Hive fails, with a 5xx, or doesn't answer in time", async () => {
      const cloud = await startCloud();
      const credentials = await signIn(driverFor(cloud));
      const failing = await serverAnswering((_, response) => {
        response.writeHead(503, { "content-type": "text/html" }).end("<h1>Service Unavailable</h1>");
      });
      const silent = await serverAnswering(() => {
        // Never answers.
      });

      for (const server of [failing, silent]) {
        const driver = driverFor(server, { timeoutMs: 300 });
        await expect(driver.readStates(credentials)).rejects.toBeInstanceOf(HiveUnreachableError);
        await expect(driver.signIn(LOGIN)).rejects.toBeInstanceOf(HiveUnreachableError);
      }
    });
  });

  describe("keeping the tokens", () => {
    it("renews tokens Hive no longer takes, as after an hour, and hands back the renewed ones", async () => {
      const cloud = await startCloud();
      const driver = driverFor(cloud);
      const credentials = await signIn(driver);
      cloud.advance(61);
      cloud.clear();

      const { credentials: renewed } = await driver.readStates(credentials);

      expect(asked(cloud)).toEqual([
        "GET /nodes/all not-signed-in",
        "InitiateAuth REFRESH_TOKEN_AUTH accepted",
        "GET /nodes/all accepted",
      ]);
      expect(renewed).not.toBe(credentials);
      cloud.clear();
      await driver.readStates(renewed);
      expect(asked(cloud)).toEqual(["GET /nodes/all accepted"]);
      expect(logged).toContain("Renewed the Hub's tokens for Hive");
    });

    it("renews them before they expire, by its own clock, and when asked", async () => {
      const cloud = await startCloud();
      let now = Date.UTC(2026, 9, 21, 12);
      const driver = driverFor(cloud, { now: () => now });
      const credentials = await signIn(driver);
      now += 60 * 60_000;
      cloud.clear();

      await driver.readStates(credentials);
      expect(asked(cloud)).toEqual(["InitiateAuth REFRESH_TOKEN_AUTH accepted", "GET /nodes/all accepted"]);

      cloud.clear();
      const refreshed = await driver.refresh(credentials);
      expect(refreshed).not.toBe(credentials);
      expect(asked(cloud)).toEqual(["InitiateAuth REFRESH_TOKEN_AUTH accepted"]);
    });

    it("never keeps the password, in the credentials or in what it holds between asking for a code and being given it", async () => {
      const cloud = await startCloud({ code: CODE });
      const driver = driverFor(cloud);

      const first = await driver.signIn(LOGIN);
      if (first.signedIn) throw new Error("Hive asked no code");
      const credentials = await driver.enterCode(first.pending, CODE);

      for (const kept of [first.pending, credentials]) {
        expect(kept).not.toContain(LOGIN.password);
        expect(kept).not.toContain(Buffer.from(LOGIN.password).toString("base64"));
        expect(kept).not.toContain(CODE);
      }
      // Hive's tokens and the device are all the Driver needs from then on.
      expect(Object.keys(JSON.parse(credentials) as object).sort()).toEqual([
        "accessToken",
        "device",
        "expiresAt",
        "idToken",
        "refreshToken",
      ]);
      expect(Object.keys(JSON.parse(first.pending) as object).sort()).toEqual(["device", "session", "user"]);
    });
  });

  describe("from the Hub's environment", () => {
    it("takes Hive's API and its sign-in service together, or neither", () => {
      expect(() => hiveDriverFromEnvironment({})).not.toThrow();
      expect(() =>
        hiveDriverFromEnvironment({ HIVE_URL: "http://127.0.0.1:18092", HIVE_AUTH_URL: "http://127.0.0.1:18092" }),
      ).not.toThrow();
      expect(() => hiveDriverFromEnvironment({ HIVE_URL: "http://127.0.0.1:18092" })).toThrow(
        "HIVE_URL and HIVE_AUTH_URL are set together, or neither is",
      );
      expect(() => hiveDriverFromEnvironment({ HIVE_AUTH_URL: "http://127.0.0.1:18092" })).toThrow(
        "HIVE_URL and HIVE_AUTH_URL are set together, or neither is",
      );
      expect(() => hiveDriverFromEnvironment({ HIVE_URL: "nowhere", HIVE_AUTH_URL: "http://127.0.0.1:1" })).toThrow(
        'HIVE_URL must be an http:// or https:// URL, not "nowhere"',
      );
    });

    it("reaches the fake Hive cloud at the addresses it is given", async () => {
      const cloud = await startCloud();
      const driver = hiveDriverFromEnvironment({ HIVE_URL: cloud.url, HIVE_AUTH_URL: cloud.url });

      const answer = await driver.signIn(LOGIN);

      expect(answer.signedIn).toBe(true);
      expect(FAKE_HIVE_HOME.length).toBe(6);
    });
  });

  it("is a DriverFailure whatever it fails with, so the Hub can say why", () => {
    for (const error of [
      new HiveAuthError(),
      new HiveUnreachableError(),
      new HiveRefusedError("id", "Study"),
      new HiveSignInRefused("code"),
    ]) {
      expect(error).toBeInstanceOf(DriverFailure);
    }
  });
});
