import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/** Only the Samsung TV Driver, and the fake TV standing in for a real one, may know Samsung's protocol (NFR-6). */
const ALLOWED = ["packages/hub/src/drivers/samsung-tv/", "packages/hub/src/fakes/samsung-tv/"];

/**
 * What gives Samsung's protocol away: its ports, its URLs and its message
 * format, the SSDP search that finds its TVs, the UPnP calls that read
 * and set a TV's volume (FR-19), how it lists its apps and their icons (FR-21),
 * and the error event that may say it ignored a key (FR-24).
 */
const SAMSUNG_PROTOCOL = [
  /\b800[12]\b/,
  /\/api\/v2\b/,
  /\bwss:\/\//,
  /samsung\.remote\.control/,
  /\bms\.(?:channel|remote|error)\b/,
  /\bKEY_[A-Z0-9_]+\b/,
  /\bTokenAuthSupport\b|\bwifiMac\b|\bmodelName\b/,
  /M-SEARCH|\bssdp:|239\.255\.255\.250/,
  /urn:samsung\.com|RemoteControlReceiver/,
  /\b9197\b/,
  /\bupnp\b|schemas-upnp-org|RenderingControl|\bsoap/i,
  /\b(?:Get|Set)(?:Volume|Mute)\b|\b(?:Desired|Current)(?:Volume|Mute)\b|\bInstanceID\b/,
  /\bed\.(?:installedApp|apps)\b|\bimageBase64\b|\bapp_type\b|\/opt\/share\//,
];

const CODE = /\.(?:[cm]?[jt]sx?|html)$/;

const codeIn = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && CODE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"));
};

describe("Samsung's protocol", () => {
  it("is known only to the Samsung TV Driver and the fake Samsung TV", async () => {
    const roots = await readdir(ROOT);
    const files = [
      ...(await Promise.all(["packages", "e2e"].map(codeIn))).flat(),
      ...roots.filter((name) => CODE.test(name)),
    ];
    expect(files).toContain("packages/hub/src/hub.ts");
    expect(files).toContain("packages/remote/src/app.tsx");

    // The patterns do find the protocol where it belongs.
    const driver = await readFile(join(ROOT, "packages/hub/src/drivers/samsung-tv/control-socket.ts"), "utf8");
    expect(SAMSUNG_PROTOCOL.filter((pattern) => pattern.test(driver)).length).toBeGreaterThanOrEqual(3);
    const search = await readFile(join(ROOT, "packages/hub/src/drivers/samsung-tv/ssdp.ts"), "utf8");
    expect(SAMSUNG_PROTOCOL.filter((pattern) => pattern.test(search)).length).toBeGreaterThanOrEqual(2);
    const volume = await readFile(join(ROOT, "packages/hub/src/drivers/samsung-tv/rendering-control.ts"), "utf8");
    expect(SAMSUNG_PROTOCOL.filter((pattern) => pattern.test(volume)).length).toBeGreaterThanOrEqual(3);
    const apps = await readFile(join(ROOT, "packages/hub/src/drivers/samsung-tv/applications.ts"), "utf8");
    expect(SAMSUNG_PROTOCOL.filter((pattern) => pattern.test(apps)).length).toBeGreaterThanOrEqual(2);

    const leaks: string[] = [];
    for (const file of files.filter((name) => !ALLOWED.some((allowed) => name.startsWith(allowed)))) {
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const pattern of SAMSUNG_PROTOCOL) {
          if (pattern.test(line)) leaks.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    expect(leaks).toEqual([]);
  });
});
