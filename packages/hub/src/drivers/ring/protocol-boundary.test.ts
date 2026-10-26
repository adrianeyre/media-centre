import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Only the Ring Driver, and the fake Ring standing in for it, may know the
 * Ring app's API (ADR 0014), with the Driver's tests, which read Ring's
 * answers, and this test, which names what to look for. The rest of the Hub
 * knows only `ring-driver.ts`'s interface, but `hub.ts`, which picks the
 * Driver, as it does every other.
 */
const ALLOWED = ["packages/hub/src/drivers/ring/", "packages/hub/src/fakes/ring/"];

/**
 * What gives the Ring app's API away: the library that speaks it, the names
 * of its classes and calls, and the names Ring's answers give what a device
 * is and does.
 */
const RING_API = [
  /["']ring-client-api(?:\/[\w-]+)*["']/,
  // `new RingApi`, as the Remote's own `RingApi` is only the Hub's API.
  /\bnew RingApi\b|\b(?:RingRestClient|RingCamera|RingChime|createSimpleWebRtcSession|getRecordingUrl|onDoorbellPressed|onRefreshTokenUpdated|promptFor2fa)\b/,
  /\b(?:ding_id_str|battery_life|led_status|siren_status|motion_detection_enabled|recording_status|rssi_category)\b/,
  /\bdrivers\/ring\/ring\.ts\b/,
];

const CODE = /\.(?:[cm]?[jt]sx?|html)$/;

const codeIn = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && CODE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"));
};

describe("The Ring app's API", () => {
  it("is known only to the Ring Driver and the fake Ring", async () => {
    const files = (await Promise.all(["packages", "e2e"].map(codeIn))).flat();
    expect(files).toContain("packages/hub/src/ring.ts");
    expect(files).toContain("packages/remote/src/ring-tab.tsx");

    // The patterns do find the API where it belongs.
    const driver = await readFile(join(ROOT, "packages/hub/src/drivers/ring/ring.ts"), "utf8");
    const parsers = await readFile(join(ROOT, "packages/hub/src/drivers/ring/ring-driver.ts"), "utf8");
    expect(RING_API.filter((pattern) => pattern.test(driver)).length).toBeGreaterThanOrEqual(2);
    expect(RING_API.filter((pattern) => pattern.test(parsers)).length).toBeGreaterThanOrEqual(1);

    const leaks: string[] = [];
    for (const file of files.filter((name) => !ALLOWED.some((allowed) => name.startsWith(allowed)))) {
      // The Hub picks the Driver, as it does every other.
      if (file === "packages/hub/src/hub.ts") continue;
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const pattern of RING_API) {
          if (pattern.test(line)) leaks.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    expect(leaks).toEqual([]);
  });
});
