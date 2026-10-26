// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { PLAYER_APP_ID } from "@media-centre/shared";

const run = promisify(execFile);
const PLAYER = join(import.meta.dirname, "..");
const DIST = join(PLAYER, "dist");
const ES_CHECK = join(PLAYER, "node_modules", ".bin", "es-check");

/** Runs es-check with the Player's own checks (`.escheckrc`) over `dist/` in `dir`, and says whether they passed. */
const esCheck = async (dir: string): Promise<{ passed: boolean; output: string }> => {
  try {
    const { stdout, stderr } = await run(ES_CHECK, ["--config", join(PLAYER, ".escheckrc"), "--noColor"], { cwd: dir });
    return { passed: true, output: stdout + stderr };
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    return { passed: false, output: stdout + stderr };
  }
};

// `pnpm --filter player build` is how the Player is built, for Tizen Studio
// to package, so these run it as is.
describe("the Player's build", { timeout: 60_000 }, () => {
  const built = run("pnpm", ["run", "build"], { cwd: PLAYER });

  it("writes the web app's files", async () => {
    await built;

    expect((await readdir(DIST)).sort()).toEqual(["config.xml", "icon.png", "index.html", "player.js", "style.css"]);
  });

  it("loads its script as a classic one, which Chromium 56 can run, not a module", async () => {
    await built;
    const page = await readFile(join(DIST, "index.html"), "utf8");

    expect(page).toContain('<script src="player.js"></script>');
    expect(page).not.toContain('type="module"');
    expect(await readFile(join(DIST, "player.js"), "utf8")).not.toMatch(/^\s*(import|export)\b/m);
  });

  it("declares the app id from shared in its Tizen manifest", async () => {
    await built;

    expect(await readFile(join(DIST, "config.xml"), "utf8")).toContain(`<tizen:application id="${PLAYER_APP_ID}"`);
  });

  it("is ES2017 or lower, with nothing Tizen 4's Chromium 56 lacks, as es-check says", async () => {
    await built;

    const { passed, output } = await esCheck(PLAYER);

    expect(output).toContain("All files are ES8 compatible");
    expect(output).toContain("All files are ES7 compatible");
    expect(passed).toBe(true);
  });

  // So that the check above is known to catch what it is there for.
  it.each([
    ["ES2018 syntax", "const a = { b: 1 }; const c = { ...a };"],
    ["ES2020 syntax", "const a = {}; const b = a?.c ?? 1;"],
    ["an ES2019 method", "const a = [[1]].flat();"],
    ["an ES2017 method that Chromium 56 lacks", "const a = '1'.padStart(2, '0');"],
  ])("would fail with %s", async (_, code) => {
    const dir = await mkdtemp(join(tmpdir(), "player-es-check-"));
    try {
      await mkdir(join(dir, "dist"));
      await writeFile(join(dir, "dist", "player.js"), code);

      expect((await esCheck(dir)).passed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
