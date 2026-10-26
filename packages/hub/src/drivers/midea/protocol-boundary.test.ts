import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/** Only the Midea Driver, and the fake Midea Air Conditioner standing in for a real one, may know Midea's protocol (NFR-6). */
const ALLOWED = ["packages/hub/src/drivers/midea/", "packages/hub/src/fakes/midea-aircon/"];

/** The cipher of v2's frames, which Tuya's protocol, in the Lepro Driver's transport, has too. */
const AES_128_ECB = /\baes-128-ecb\b/i;
const ALSO_TUYAS = "packages/hub/src/drivers/lepro/tuya.ts";

/**
 * What gives Midea's protocol away: its ports, the starts of its packets,
 * its sign key, its modules' names, its capability ids and its ciphers, the
 * names the Driver gives its frames' bodies and types, and the Driver's
 * modules that hold them, which nothing else imports: the rest of the Hub
 * knows only `midea-driver.ts`.
 */
const MIDEA_PROTOCOL = [
  /\b644[45]\b|\b20_?086\b/,
  /\b0x5a,\s*0x5a\b|\b5a5a\b/i,
  /\b0x83,\s*0x70\b|\b8370\b/,
  /xhdiwjnchekd4d512chdjx5d8e4c394D2D7S/,
  /\bnet_ac_/,
  /\b(?:AIR_CONDITIONER_TYPE|STATE_ANSWER|(?:QUERY|SET)_(?:STATE|CAPABILITIES|PROPERTIES)|FRAME_(?:SET|QUERY))\b/,
  /\bV3_[A-Z_]+\b|\b(?:SWING_(?:VERTICAL|HORIZONTAL)|MIDEA_(?:MODE|FAN))\b/,
  /drivers\/midea\/(?:frames|lan-packets|lan-connection|discovery|security|capabilities)\b/,
  /\b0x02(?:1[0-9a-f]|2[0-9a-f])\b/i,
  /\baes-256-cbc\b/i,
  AES_128_ECB,
];

const CODE = /\.(?:[cm]?[jt]sx?|html)$/;

const codeIn = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && CODE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"));
};

describe("Midea's protocol", () => {
  it("is known only to the Midea Driver and the fake Midea Air Conditioner", async () => {
    const roots = await readdir(ROOT);
    const files = [
      ...(await Promise.all(["packages", "e2e"].map(codeIn))).flat(),
      ...roots.filter((name) => CODE.test(name)),
    ];
    expect(files).toContain("packages/hub/src/hub.ts");
    expect(files).toContain("packages/shared/src/index.ts");

    // The patterns do find the protocol where it belongs.
    for (const [file, least] of [
      ["packages/hub/src/drivers/midea/lan-packets.ts", 3],
      ["packages/hub/src/drivers/midea/frames.ts", 2],
      ["packages/hub/src/drivers/midea/discovery.ts", 3],
      ["packages/hub/src/drivers/midea/capabilities.ts", 1],
    ] as const) {
      const code = await readFile(join(ROOT, file), "utf8");
      expect(MIDEA_PROTOCOL.filter((pattern) => pattern.test(code)).length, file).toBeGreaterThanOrEqual(least);
    }

    const leaks: string[] = [];
    for (const file of files.filter((name) => !ALLOWED.some((allowed) => name.startsWith(allowed)))) {
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const pattern of MIDEA_PROTOCOL) {
          if (pattern === AES_128_ECB && file === ALSO_TUYAS) continue;
          if (pattern.test(line)) leaks.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    expect(leaks).toEqual([]);
  });
});
