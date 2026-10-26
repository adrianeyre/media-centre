import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Only the Amazon Driver, and the fake Amazon standing in for it, may know
 * the Alexa app's API (ADR 0011), with the Driver's tests, which read
 * Amazon's answers, and this test, which names what to look for. The rest of
 * the Hub knows only `amazon-driver.ts`'s interface, but `hub.ts`, which
 * picks the Driver, as it does every other.
 */
const ALLOWED = ["packages/hub/src/drivers/amazon/", "packages/hub/src/fakes/amazon/"];

/**
 * What gives the Alexa app's API away: the library that speaks it, and its
 * sign-in's, the names of its calls, the routine actions it sends, and the
 * names Amazon's answers give what a device is and does.
 */
const ALEXA_API = [
  /["']alexa-(?:remote2|cookie2)["']/,
  /\b(?:sendSequenceCommand|sendCommand|getPlayerInfo|getDoNotDisturb|setDoNotDisturb|executeAutomationRoutine|playMusicProvider|getEqualizerSettings|getDeviceNotificationState)\b/,
  /\b(?:textCommand|flashbriefing|goodmorning|tellstory|singasong|calendarToday|deviceStop)\b/,
  /\b(?:playerInfo|doNotDisturbDeviceStatusList|bluetoothStates|pairedDeviceList|accountName|deviceFamily|automationId)\b/,
  /\bdrivers\/amazon\/alexa\b/,
];

const CODE = /\.(?:[cm]?[jt]sx?|html)$/;

const codeIn = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && CODE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"));
};

describe("The Alexa app's API", () => {
  it("is known only to the Amazon Driver and the fake Amazon", async () => {
    const files = (await Promise.all(["packages", "e2e"].map(codeIn))).flat();
    expect(files).toContain("packages/hub/src/amazon.ts");
    expect(files).toContain("packages/remote/src/amazon-tab.tsx");

    // The patterns do find the API where it belongs.
    const driver = await readFile(join(ROOT, "packages/hub/src/drivers/amazon/alexa.ts"), "utf8");
    expect(ALEXA_API.filter((pattern) => pattern.test(driver)).length).toBeGreaterThanOrEqual(3);

    const leaks: string[] = [];
    for (const file of files.filter((name) => !ALLOWED.some((allowed) => name.startsWith(allowed)))) {
      // The Hub picks the Driver, as it does every other, and `main.ts` the fake, to run it against.
      if (file === "packages/hub/src/hub.ts" || file === "packages/hub/src/main.ts") continue;
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const pattern of ALEXA_API) {
          if (pattern.test(line)) leaks.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    expect(leaks).toEqual([]);
  });
});
