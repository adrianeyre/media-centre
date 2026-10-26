import { expect, type APIRequestContext } from "@playwright/test";

import { FAKE_HIVE_HOME } from "../packages/hub/src/fakes/hive-cloud/fake-hive-cloud.ts";

/**
 * The fake Hive cloud the end-to-end run starts beside its Hub, in place of
 * Hive's, which the run's Hub is given as both `HIVE_URL` and
 * `HIVE_AUTH_URL`, so that nothing in the run reaches Hive (ADR 0010). It
 * has the household's two Heating zones, three Radiator Valves and the Hot
 * Water, and asks for a code as Hive does, on the port beside the fake Midea
 * clouds' 18090 and 18091.
 */
export const FAKE_HIVE_URL = "http://127.0.0.1:18092";

/** The Hive login the fake takes, made up for the run: no real account's. */
export const FAKE_HIVE_LOGIN = { account: "owner@example.com", password: "a hive password for the run" } as const;

/** The code the fake asks for as it signs the Hub in, as Hive texts one, made up for the run. */
export const FAKE_HIVE_CODE = "246810";

/** Where the fake answers the run (see its `main.ts`). */
export const fakeHiveUrl = (
  path: "/_fake/state" | "/_fake/products" | "/_fake/revoke" | "/_fake/requests" | "/_fake/clock" | "/_fake/outage",
): string => `${FAKE_HIVE_URL}${path}`;

/** Signs the run's Hub in to the fake, with its code, as Settings would, adding its Heating, Radiator Valves and Hot Water. */
export const signInToFakeHive = async (request: APIRequestContext): Promise<void> => {
  const asked = await request.post("/api/hive/sign-in", { data: FAKE_HIVE_LOGIN });
  expect(asked.ok()).toBe(true);
  if (((await asked.json()) as { signedIn: boolean }).signedIn) return;
  expect((await request.post("/api/hive/code", { data: { code: FAKE_HIVE_CODE } })).ok()).toBe(true);
};

/**
 * Signs the run's Hub out of Hive, removing its Appliances, which nothing
 * else removes, and puts the fake back as the run started it: up, with the
 * household's products as they began, trusting no Hub, and its requests
 * forgotten.
 */
export const forgetHive = async (request: APIRequestContext): Promise<void> => {
  expect((await request.delete("/api/hive")).status()).toBe(204);
  expect((await request.post(fakeHiveUrl("/_fake/outage"), { data: { down: false } })).ok()).toBe(true);
  expect((await request.put(fakeHiveUrl("/_fake/products"), { data: FAKE_HIVE_HOME })).ok()).toBe(true);
  expect((await request.post(fakeHiveUrl("/_fake/revoke"), { data: { devices: true } })).ok()).toBe(true);
  expect((await request.delete(fakeHiveUrl("/_fake/requests"))).ok()).toBe(true);
};
