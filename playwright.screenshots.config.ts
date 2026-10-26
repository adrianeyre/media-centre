import { defineConfig } from "@playwright/test";

import e2e from "./playwright.config.ts";
import { FAKE_AIRCON_PORT, FAKE_AIRCONS, FAKE_CLOUD_URL } from "./e2e/fake-air-conditioners.ts";
import { FAKE_HIVE_URL } from "./e2e/fake-hive.ts";
import { FAKE_LIGHT_PORT, FAKE_LIGHTS } from "./e2e/fake-lights.ts";
import { FAKE_TV_CONTROL_PORT, FAKE_TV_REST_PORT, FAKE_TVS } from "./e2e/fake-tvs.ts";

/**
 * The screenshots of the Remote in `docs/images/screenshots/` and the web app
 * manifest's in `packages/remote/public/screenshots/`, taken against the same
 * Hub and fakes the end-to-end run starts, filled with a demo home by
 * `scripts/screenshots/`. Run with `pnpm screenshots`, which runs this in
 * Docker, as the fakes need Linux's loopback addresses.
 *
 * The one difference from the end-to-end run's Hub: its Network tab scans
 * every fake, the Air Conditioners and Lights as well as the TVs, and
 * 127.0.0.1, where the fake clouds are, as a device that is no Appliance, so
 * that it has more than two devices to show.
 */
const NETWORK_SCAN_TARGETS = [
  "127.0.0.1",
  ...[...Object.values(FAKE_TVS), ...Object.values(FAKE_AIRCONS), ...Object.values(FAKE_LIGHTS)].map(
    ({ host }) => host,
  ),
].join(",");
const NETWORK_SCAN_PORTS = [
  FAKE_TV_REST_PORT,
  FAKE_TV_CONTROL_PORT,
  FAKE_AIRCON_PORT,
  FAKE_LIGHT_PORT,
  new URL(FAKE_CLOUD_URL).port,
  new URL(FAKE_HIVE_URL).port,
].join(",");

const servers = Array.isArray(e2e.webServer) ? e2e.webServer : e2e.webServer === undefined ? [] : [e2e.webServer];

export default defineConfig({
  testDir: "scripts/screenshots",
  testMatch: "*.screenshots.ts",
  workers: 1,
  retries: 1,
  timeout: 120_000,
  reporter: "list",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL: e2e.use?.baseURL },
  webServer: servers.map((server) =>
    server.command === "pnpm --filter @media-centre/hub start"
      ? { ...server, env: { ...server.env, NETWORK_SCAN_TARGETS, NETWORK_SCAN_PORTS } }
      : server,
  ),
});
