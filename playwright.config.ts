import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  FAKE_TV_CONTROL_PORT,
  FAKE_TV_REST_PORT,
  FAKE_TV_SSDP_PORT,
  FAKE_TV_UPNP_PORT,
  FAKE_TV_WAKE_PORT,
  FAKE_TVS,
  fakeTvUrl,
} from "./e2e/fake-tvs.ts";
import {
  FAKE_AIRCON_DISCOVERY_PORT,
  FAKE_AIRCON_HTTP_PORT,
  FAKE_AIRCON_PORT,
  FAKE_AIRCONS,
  FAKE_CLOUD_LOGIN,
  FAKE_CLOUD_URL,
  FAKE_MIDEA_AIR_CLOUD_URL,
  fakeAirconUrl,
  fakeCloudUrl,
} from "./e2e/fake-air-conditioners.ts";
import { FAKE_HIVE_CODE, FAKE_HIVE_LOGIN, FAKE_HIVE_URL, fakeHiveUrl } from "./e2e/fake-hive.ts";
import { FAKE_LIGHT_DISCOVERY_PORT, FAKE_LIGHT_PORT, FAKE_LIGHT_SEARCH_TARGETS } from "./e2e/fake-lights.ts";

// Its own port, so a Hub left running on the default one doesn't answer the tests.
const HUB_PORT = 18_080;

// A database of its own for each run, so the tests never touch the Hub's real
// state. Set once in the runner's environment, which its workers inherit, and
// removed by the global teardown.
process.env.E2E_HUB_DATABASE ??= join(tmpdir(), `media-centre-e2e-${String(process.pid)}`, "media-centre.sqlite");
const HUB_DATABASE = process.env.E2E_HUB_DATABASE;

// The token and key the v3 fake Air Conditioner expects, and the fake cloud
// issues it, made up afresh for each run, likewise, and never written down.
process.env.E2E_AIRCON_TOKEN ??= randomBytes(64).toString("hex");
process.env.E2E_AIRCON_KEY ??= randomBytes(32).toString("hex");
const AIRCON_TOKEN = process.env.E2E_AIRCON_TOKEN;
const AIRCON_KEY = process.env.E2E_AIRCON_KEY;

// The Remote is phone-first (PRD NFR-2), so it is driven at a phone's size.
// `pnpm test:e2e` builds the Remote first; the Hub is started here and serves
// it, with two fake Samsung TVs beside it (ADR 0004), two fake Midea Air
// Conditioners, the fake Midea cloud, and the fake Hive cloud. The fake Lepro
// Lights are started by the tests that need them, which stop and start them
// (see `e2e/fake-lights.ts`).
export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  // One Hub holds the run's Rooms and TVs, so tests that change them take turns.
  workers: 1,
  reporter: "list",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${String(HUB_PORT)}`,
  },
  projects: [{ name: "phone", use: { ...devices["Pixel 7"] } }],
  webServer: [
    {
      command: "pnpm --filter @media-centre/hub start",
      url: `http://127.0.0.1:${String(HUB_PORT)}/api/hub`,
      env: {
        HUB_PORT: String(HUB_PORT),
        HUB_DATABASE,
        // Never GitHub's version, which would offer an update over every test (FR-61).
        HUB_LATEST_VERSION_URL: "",
        SAMSUNG_TV_REST_PORT: String(FAKE_TV_REST_PORT),
        SAMSUNG_TV_CONTROL_PORT: String(FAKE_TV_CONTROL_PORT),
        SAMSUNG_TV_WAKE_PORT: String(FAKE_TV_WAKE_PORT),
        SAMSUNG_TV_UPNP_PORT: String(FAKE_TV_UPNP_PORT),
        SAMSUNG_TV_SEARCH_TARGETS: Object.values(FAKE_TVS)
          .map(({ host }) => `${host}:${String(FAKE_TV_SSDP_PORT)}`)
          .join(","),
        // Stand-ins for Samsung's tools, which install the Player on the fake TVs as the real ones would on a TV.
        SAMSUNG_TV_SDB: join(import.meta.dirname, "packages/hub/src/fakes/samsung-tv/fake-sdb.ts"),
        SAMSUNG_TV_TIZEN: join(import.meta.dirname, "packages/hub/src/fakes/samsung-tv/fake-tizen.ts"),
        MIDEA_PORT: String(FAKE_AIRCON_PORT),
        MIDEA_DISCOVERY_PORT: String(FAKE_AIRCON_DISCOVERY_PORT),
        MIDEA_SEARCH_TARGETS: Object.values(FAKE_AIRCONS)
          .map(({ host }) => `${host}:${String(FAKE_AIRCON_DISCOVERY_PORT)}`)
          .join(","),
        MIDEA_CLOUD_URL: FAKE_CLOUD_URL,
        MIDEA_AIR_CLOUD_URL: FAKE_MIDEA_AIR_CLOUD_URL,
        LEPRO_PORT: String(FAKE_LIGHT_PORT),
        LEPRO_DISCOVERY_PORT: String(FAKE_LIGHT_DISCOVERY_PORT),
        LEPRO_SEARCH_TARGETS: FAKE_LIGHT_SEARCH_TARGETS,
        HIVE_URL: FAKE_HIVE_URL,
        HIVE_AUTH_URL: FAKE_HIVE_URL,
        // The Network tab scans the fake TVs, never the real network.
        NETWORK_SCAN_TARGETS: Object.values(FAKE_TVS)
          .map(({ host }) => host)
          .join(","),
        NETWORK_SCAN_PORTS: String(FAKE_TV_REST_PORT),
        // The fake Bluetooth helper's three devices, on any machine, never the real radio's.
        BLUETOOTH_HELPER: join(import.meta.dirname, "packages/hub/src/fakes/bluetooth/fake-ble-watch.ts"),
        BLUETOOTH_SCAN_SECONDS: "2",
        // The fake Amazon's two Echos, never the owner's Amazon account (ADR 0011).
        AMAZON_FAKE: "1",
        // The fake Ring's doorbell, camera and chime, never the owner's Ring account (ADR 0014).
        RING_FAKE: "1",
      },
      reuseExistingServer: false,
    },
    ...Object.values(FAKE_TVS).map(({ host, name, macAddress }) => ({
      command: "pnpm --filter @media-centre/hub fake-tv",
      url: fakeTvUrl(host, "/_fake/requests"),
      env: {
        FAKE_TV_HOST: host,
        FAKE_TV_REST_PORT: String(FAKE_TV_REST_PORT),
        FAKE_TV_CONTROL_PORT: String(FAKE_TV_CONTROL_PORT),
        FAKE_TV_SSDP_PORT: String(FAKE_TV_SSDP_PORT),
        FAKE_TV_WAKE_PORT: String(FAKE_TV_WAKE_PORT),
        FAKE_TV_UPNP_PORT: String(FAKE_TV_UPNP_PORT),
        FAKE_TV_NAME: name,
        FAKE_TV_MAC: macAddress,
      },
      reuseExistingServer: false,
    })),
    ...Object.values(FAKE_AIRCONS).map(({ host, version, id, serialNumber }) => ({
      command: "pnpm --filter @media-centre/hub fake-aircon",
      url: fakeAirconUrl(host, "/_fake/state"),
      env: {
        FAKE_AIRCON_HOST: host,
        FAKE_AIRCON_PORT: String(FAKE_AIRCON_PORT),
        FAKE_AIRCON_DISCOVERY_PORT: String(FAKE_AIRCON_DISCOVERY_PORT),
        FAKE_AIRCON_HTTP_PORT: String(FAKE_AIRCON_HTTP_PORT),
        FAKE_AIRCON_VERSION: String(version),
        FAKE_AIRCON_ID: String(id),
        FAKE_AIRCON_SERIAL: serialNumber,
        ...(version === 3 ? { FAKE_AIRCON_TOKEN: AIRCON_TOKEN, FAKE_AIRCON_KEY: AIRCON_KEY } : {}),
      },
      reuseExistingServer: false,
    })),
    {
      command: "pnpm --filter @media-centre/hub fake-midea-cloud",
      url: fakeCloudUrl("/_fake/requests"),
      env: {
        FAKE_MIDEA_CLOUD_PORT: new URL(FAKE_CLOUD_URL).port,
        FAKE_MIDEA_CLOUD_ACCOUNT: FAKE_CLOUD_LOGIN.account,
        FAKE_MIDEA_CLOUD_PASSWORD: FAKE_CLOUD_LOGIN.password,
        FAKE_MIDEA_CLOUD_UNITS: `${String(FAKE_AIRCONS.bedroom.id)}:${AIRCON_TOKEN}:${AIRCON_KEY}`,
      },
      reuseExistingServer: false,
    },
    {
      command: "pnpm --filter @media-centre/hub fake-midea-cloud",
      url: `${FAKE_MIDEA_AIR_CLOUD_URL}/_fake/requests`,
      env: {
        FAKE_MIDEA_CLOUD_APP: "Midea Air",
        FAKE_MIDEA_CLOUD_PORT: new URL(FAKE_MIDEA_AIR_CLOUD_URL).port,
        FAKE_MIDEA_CLOUD_ACCOUNT: "someone-else@example.com",
        FAKE_MIDEA_CLOUD_PASSWORD: "not the owner's",
      },
      reuseExistingServer: false,
    },
    {
      command: "pnpm --filter @media-centre/hub fake-hive-cloud",
      url: fakeHiveUrl("/_fake/requests"),
      env: {
        FAKE_HIVE_CLOUD_PORT: new URL(FAKE_HIVE_URL).port,
        FAKE_HIVE_CLOUD_ACCOUNT: FAKE_HIVE_LOGIN.account,
        FAKE_HIVE_CLOUD_PASSWORD: FAKE_HIVE_LOGIN.password,
        FAKE_HIVE_CLOUD_CODE: FAKE_HIVE_CODE,
      },
      reuseExistingServer: false,
    },
  ],
});
