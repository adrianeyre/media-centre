import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Only the Lepro Driver's transport, `tuya.ts`, and the fake Lepro Light
 * standing in for a real one, may know Tuya's protocol (NFR-6), with the
 * tests of each, the Driver's among them, which check what the fake records,
 * and this test, which names what to look for. The Driver itself knows only
 * its transport's interface, so that a different protocol changes only these.
 */
const ALLOWED = [
  "packages/hub/src/drivers/lepro/tuya.ts",
  "packages/hub/src/drivers/lepro/tuya.test.ts",
  "packages/hub/src/drivers/lepro/lepro-driver.test.ts",
  "packages/hub/src/drivers/lepro/protocol-boundary.test.ts",
  "packages/hub/src/fakes/lepro-light/",
];

/**
 * What gives Tuya's protocol away: its ports, the start and end of its
 * frames, the key of its announcements, the words of its messages, and the
 * names `tuya.ts` gives its commands, data points and scales, and the module
 * itself, which nothing else imports but the Driver, for its default.
 */
const TUYA_PROTOCOL = [
  /\b666[6-8]\b/,
  /\b(?:0x)?0000_?(?:55aa|aa55)\b/i,
  /yGAdlopoPVldABfn/,
  /\b(?:devId|gwId|ablilty|productKey|dps)\b/,
  /\bTUYA_[A-Z_]+\b|\bDATA_POINT\b|\b(?:BRIGHTNESS|TEMPERATURE|COLOUR)_SCALE\b|\bVERSION_HEADER\b/,
  /\bfrom\s+["'][^"']*drivers\/lepro\/tuya\b/,
];

const CODE = /\.(?:[cm]?[jt]sx?|html)$/;

const codeIn = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && CODE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"));
};

describe("Tuya's protocol", () => {
  it("is known only to the Lepro Driver's transport and the fake Lepro Light", async () => {
    const roots = await readdir(ROOT);
    const files = [
      ...(await Promise.all(["packages", "e2e"].map(codeIn))).flat(),
      ...roots.filter((name) => CODE.test(name)),
    ];
    expect(files).toContain("packages/hub/src/drivers/lepro/lepro-driver.ts");
    expect(files).toContain("packages/hub/src/drivers/lepro/transport.ts");
    expect(files).toContain("packages/shared/src/index.ts");

    // The patterns do find the protocol where it belongs.
    for (const [file, least] of [
      ["packages/hub/src/drivers/lepro/tuya.ts", 5],
      ["packages/hub/src/fakes/lepro-light/fake-lepro-light.ts", 3],
    ] as const) {
      const code = await readFile(join(ROOT, file), "utf8");
      expect(TUYA_PROTOCOL.filter((pattern) => pattern.test(code)).length, file).toBeGreaterThanOrEqual(least);
    }

    const leaks: string[] = [];
    for (const file of files.filter((name) => !ALLOWED.some((allowed) => name.startsWith(allowed)))) {
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const pattern of TUYA_PROTOCOL) {
          if (pattern.test(line)) leaks.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    expect(leaks).toEqual([]);
  });
});
