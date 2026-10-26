import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/** Only the Hive Driver, and the fake Hive cloud standing in for Hive's, may know Hive's API (NFR-6). */
const ALLOWED = ["packages/hub/src/drivers/hive/", "packages/hub/src/fakes/hive-cloud/"];

/**
 * What gives Hive's API away: its hosts, its sign-in service and the steps
 * of signing in to it, the paths and the node types of its API, the names it
 * gives what a product reads and is set to, its modes as it writes them, and
 * the Driver's modules that hold them, which nothing else imports: the rest
 * of the Hub knows only `hive-driver.ts`.
 */
const HIVE_API = [
  /hivehome\.com|\bbeekeeper\b/i,
  /\bcognito\b|amazonaws|\bx-amz-/i,
  /\b(?:USER_SRP_AUTH|REFRESH_TOKEN_AUTH|PASSWORD_VERIFIER|DEVICE_SRP_AUTH|SMS_MFA|SRP_[AB]|USER_ID_FOR_SRP|SECRET_BLOCK)\b/,
  /\b(?:InitiateAuth|RespondToAuthChallenge|ConfirmDevice|UpdateDeviceStatus|AuthenticationResult|NewDeviceMetadata|DeviceGroupKey)\b/,
  /\bnodes\/(?:all|\$\{|[a-z]+\/)/,
  /\b(?:trvcontrol|hotwater|thermostatui|boilermodule)\b/,
  /\bzoneName\b/,
  /["'](?:SCHEDULE|MANUAL|BOOST)["']/,
  /drivers\/hive\/(?:cognito|srp|beekeeper|nodes)\b/,
];

const CODE = /\.(?:[cm]?[jt]sx?|html)$/;

const codeIn = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && CODE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"));
};

describe("Hive's API", () => {
  it("is known only to the Hive Driver and the fake Hive cloud", async () => {
    const roots = await readdir(ROOT);
    const files = [
      ...(await Promise.all(["packages", "e2e"].map(codeIn))).flat(),
      ...roots.filter((name) => CODE.test(name)),
    ];
    expect(files).toContain("packages/hub/src/hub.ts");
    expect(files).toContain("packages/hub/src/drivers/hive/hive-driver.ts");
    expect(files).toContain("packages/shared/src/index.ts");
    expect(files).toContain("playwright.config.ts");

    // The patterns do find the API where it belongs.
    for (const [file, least] of [
      ["packages/hub/src/drivers/hive/cognito.ts", 4],
      ["packages/hub/src/drivers/hive/beekeeper.ts", 2],
      ["packages/hub/src/drivers/hive/nodes.ts", 4],
      ["packages/hub/src/drivers/hive/hive-driver.ts", 1],
      ["packages/hub/src/fakes/hive-cloud/fake-hive-cloud.ts", 5],
    ] as const) {
      const code = await readFile(join(ROOT, file), "utf8");
      expect(HIVE_API.filter((pattern) => pattern.test(code)).length, file).toBeGreaterThanOrEqual(least);
    }

    const leaks: string[] = [];
    for (const file of files.filter((name) => !ALLOWED.some((allowed) => name.startsWith(allowed)))) {
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const pattern of HIVE_API) {
          if (pattern.test(line)) leaks.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    expect(leaks).toEqual([]);
  });
});
