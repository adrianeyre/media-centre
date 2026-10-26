/**
 * The fake Midea Air Conditioners the end-to-end run starts beside its Hub,
 * each at its own loopback address, as two units on the home network would
 * be, one on protocol v2 and one on v3, and the fake Midea cloud the Hub
 * fetches the v3 unit's token and key from, in place of Midea's. They share
 * ports off a real unit's, which the run's Hub is told to use, and the Hub
 * searches each unit's own address, as a broadcast can't be relied on here.
 */
export const FAKE_AIRCON_PORT = 16_444;
/** Where each fake answers discovery, which the run's Hub sends to each, not broadcast. */
export const FAKE_AIRCON_DISCOVERY_PORT = 16_445;
/** Where each fake answers the run, outside what a real unit has. */
export const FAKE_AIRCON_HTTP_PORT = 16_446;

export const FAKE_AIRCONS = {
  living: { host: "127.0.0.5", version: 2, id: 0x1005, serialNumber: "000000P0000000Q1F0C9A1B2C3D50000" },
  bedroom: { host: "127.0.0.6", version: 3, id: 0x1006, serialNumber: "000000P0000000Q1F0C9A1B2C3D60000" },
} as const;

/**
 * A third fake Air Conditioner, on v2, on the same ports, which the run
 * doesn't start: a test that needs one with fewer capabilities, or one it can
 * switch off at the wall, starts this one itself.
 */
export const SPARE_FAKE_AIRCON = {
  host: "127.0.0.7",
  version: 2,
  id: 0x1007,
  serialNumber: "000000P0000000Q1F0C9A1B2C3D70000",
} as const;

/** Where the fake Midea cloud listens, which the run's Hub is given as `MIDEA_CLOUD_URL`. */
export const FAKE_CLOUD_URL = "http://127.0.0.1:18090";

/**
 * Where the fake Midea Air cloud listens, which the run's Hub is given as
 * `MIDEA_AIR_CLOUD_URL`. It knows no one, so that the Hub tries it and is
 * refused, as Midea Air's cloud refuses an MSmartHome account, and never
 * reaches the real one.
 */
export const FAKE_MIDEA_AIR_CLOUD_URL = "http://127.0.0.1:18091";

/** The MSmartHome login the fake cloud takes, made up for the run: no real account's. */
export const FAKE_CLOUD_LOGIN = { account: "owner@example.com", password: "correct horse battery staple" } as const;

/** Where a fake Air Conditioner answers the run (see the fake's `main.ts`). */
export const fakeAirconUrl = (
  host: string,
  path: "/_fake/state" | "/_fake/commands" | "/_fake/connections" | "/_fake/capabilities" | "/_fake/keys",
): string => `http://${host}:${String(FAKE_AIRCON_HTTP_PORT)}${path}`;

/** Where the fake cloud answers the run (see its `main.ts`). */
export const fakeCloudUrl = (path: "/_fake/requests" | "/_fake/units"): string => `${FAKE_CLOUD_URL}${path}`;
