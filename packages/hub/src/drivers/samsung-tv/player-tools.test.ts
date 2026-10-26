import { createDecipheriv } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlayerActionStep } from "@media-centre/shared";

import { fakeCommands, type FakeCommands } from "../../fakes/samsung-tv/fake-developer-tools.ts";
import { DriverFailure, type SigningCertificate } from "../driver.ts";
import { samsungPlayerTools } from "./player-tools.ts";

const TV = "192.168.1.50";
const SERIAL = "192.168.1.50:26101";

const CERTIFICATE: SigningCertificate = {
  author: new Uint8Array([0x30, 0x82, 0x01, 0x02, 0xa1]),
  authorPassword: 'author-pass&<"word>',
  distributor: new Uint8Array([0x30, 0x82, 0x03, 0x04, 0xd1]),
  distributorPassword: "distributor-password",
};

let build: string;
/** Where the Player is signed, the test's own, as other test files sign beside it. */
let temp: string;
let commands: FakeCommands;
let steps: PlayerActionStep[];

beforeEach(async () => {
  build = await mkdtemp(join(tmpdir(), "player-build-"));
  await writeFile(join(build, "config.xml"), "<widget/>");
  await writeFile(join(build, "index.html"), "<!doctype html>");
  temp = await mkdtemp(join(tmpdir(), "player-signing-"));
  commands = fakeCommands();
  steps = [];
});

afterEach(async () => {
  await rm(build, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
});

const tools = () => samsungPlayerTools({ run: commands.run, tempDir: temp });
const step = (each: PlayerActionStep): void => {
  steps.push(each);
};
const commandLines = (): string[] => commands.ran.map(({ program, args }) => [program, ...args].join(" "));

/** Where `tizen package` was told the security profile is, which is in the folder the Player was signed in. */
const signingFolder = (): string => {
  const configured = commands.ran.find(({ args }) => args[0] === "cli-config");
  return join(String(configured?.args[1]).replace("profiles.path=", ""), "..");
};

/** A password as the `tizen` CLI reads it from a security profile. */
const decrypt = (kept: string): string => {
  const decipher = createDecipheriv("des-ede3", Buffer.from("KYANINYLhijklmnopqrstuvwx").subarray(0, 24), null);
  return Buffer.concat([decipher.update(Buffer.from(kept, "base64")), decipher.final()]).toString("utf8");
};

const failure = async (promise: Promise<unknown>): Promise<DriverFailure> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

describe("installing the Player on a Samsung TV", () => {
  it("connects, signs the build with the certificate, installs it and disconnects, in that order", async () => {
    await tools().install(TV, { dir: build, certificate: CERTIFICATE }, step);

    const work = signingFolder();
    expect(commandLines()).toEqual([
      `sdb connect ${SERIAL}`,
      `tizen cli-config profiles.path=${join(work, "profiles.xml")}`,
      `tizen package -t wgt -s media-centre -o ${join(work, "package")} -- ${join(work, "player")}`,
      `tizen install -s ${SERIAL} -n Media Centre.wgt -- ${join(work, "package")}`,
      `sdb disconnect ${SERIAL}`,
    ]);
    expect(steps).toEqual(["connecting", "signing", "installing"]);
  });

  it("signs a copy of the build, with a security profile only the Hub can read, deleted once installed", async () => {
    await tools().install(TV, { dir: build, certificate: CERTIFICATE }, step);

    const signing = commands.ran.find(({ args }) => args[0] === "package")?.signing;
    const work = signingFolder();
    expect(signing?.files).toEqual({
      "author.p12": 0o600,
      "distributor.p12": 0o600,
      "profiles.xml": 0o600,
      player: expect.any(Number) as number,
    });
    const items = [...String(signing?.profile).matchAll(/<profileitem [^>]*\/>/g)].map(([item]) => item);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain(`distributor="0" key="${join(work, "author.p12")}"`);
    expect(items[1]).toContain(`distributor="1" key="${join(work, "distributor.p12")}"`);
    const passwords = items.map((item) => /password="([^"]*)"/.exec(item)?.[1] ?? "");
    expect(decrypt(String(passwords[0]))).toBe(CERTIFICATE.authorPassword);
    expect(decrypt(String(passwords[1]))).toBe(CERTIFICATE.distributorPassword);
    expect(passwords[2]).toBe("");

    await expect(readdir(work)).rejects.toThrow();
  });

  it("first deletes what a Hub stopped while it signed left behind, and nothing else", async () => {
    await mkdir(join(temp, "media-centre-player-AbC123"));
    await writeFile(join(temp, "media-centre-player-AbC123", "author.p12"), "left behind");
    await mkdir(join(temp, "something-else"));

    await tools().install(TV, { dir: build, certificate: CERTIFICATE }, step);

    expect(await readdir(temp)).toEqual(["something-else"]);
  });

  it("never puts a password in a command's arguments", async () => {
    await tools().install(TV, { dir: build, certificate: CERTIFICATE }, step);

    for (const line of commandLines()) {
      expect(line).not.toContain(CERTIFICATE.authorPassword);
      expect(line).not.toContain(CERTIFICATE.distributorPassword);
    }
  });

  it("is unreachable when the TV doesn't let the Hub connect, though sdb says so with an exit code of 0", async () => {
    commands.answer((program, args) => program === "sdb" && args[0] === "connect", {
      exitCode: 0,
      output:
        "* Server is not running. Start it now on port 26099 *\n* Server has started successfully *\n" +
        "error: failed to connect to remote target '192.168.1.50'\n",
    });

    const error = await failure(tools().install(TV, { dir: build, certificate: CERTIFICATE }, step));

    expect(error.reason).toBe("unreachable");
    expect(error.message).toContain("Developer Mode is on with the Hub's IP as the Developer IP");
    expect(error.message).toMatch(/\(error: failed to connect to remote target '192\.168\.1\.50'\)$/);
    expect(commandLines()).toEqual([`sdb connect ${SERIAL}`]);
    expect(steps).toEqual(["connecting"]);
  });

  it("refuses to install a package the CLI made unsigned, which it says only with a warning", async () => {
    commands.answer((program, args) => program === "tizen" && args[0] === "package", {
      exitCode: 0,
      output:
        "Warning: Not found tizen signature file\nWarning: Not found tizen author signature file\n" +
        "Package File Location: /tmp/x/Media Centre.wgt\n",
    });

    const error = await failure(tools().install(TV, { dir: build, certificate: CERTIFICATE }, step));

    expect(error.reason).toBe("refused");
    expect(error.message).toContain("couldn't be signed with the signing certificate in Settings");
    expect(commandLines().some((line) => line.startsWith("tizen install"))).toBe(false);
    expect(commandLines().at(-1)).toBe(`sdb disconnect ${SERIAL}`);
    expect(steps).toEqual(["connecting", "signing"]);
  });

  it("says why the TV refused the Player, and still deletes what it signed and disconnects", async () => {
    commands.answer((program, args) => program === "tizen" && args[0] === "install", {
      exitCode: 0,
      output:
        "app_id[MediaCntre.Player] install failed[118, -12], reason: Check certificate error : " +
        ":Invalid certificate chain with certificate in signature.\nTotal time: 00:00:03.000\n",
    });

    const error = await failure(tools().install(TV, { dir: build, certificate: CERTIFICATE }, step));

    expect(error.reason).toBe("refused");
    expect(error.message).toContain("The TV didn't install the Player.");
    expect(error.message).toContain("Invalid certificate chain");
    expect(error.message).not.toContain("Total time");
    expect(steps).toEqual(["connecting", "signing", "installing"]);
    expect(commandLines().at(-1)).toBe(`sdb disconnect ${SERIAL}`);
    await expect(readdir(signingFolder())).rejects.toThrow();
  });

  it("is not supported on a machine without Samsung's tools", async () => {
    commands.answer((program) => program === "sdb", "missing");

    const error = await failure(tools().install(TV, { dir: build, certificate: CERTIFICATE }, step));

    expect(error.reason).toBe("not-supported");
    expect(error.message).toContain("hasn't got Samsung's sdb tool");
  });

  it("signs for one TV at a time, as each points the CLI at its own security profile", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Whichever TV's package comes first waits, and fails; the other's must not point the CLI elsewhere meanwhile.
    let packaged = 0;
    commands.answer(
      (program, args) => program === "tizen" && args[0] === "package" && ++packaged === 1,
      { exitCode: 1, output: "An error has occurred." },
      held,
    );
    const shared = tools();

    const both = Promise.allSettled([
      shared.install(TV, { dir: build, certificate: CERTIFICATE }, () => undefined),
      shared.install("192.168.1.51", { dir: build, certificate: CERTIFICATE }, () => undefined),
    ]);
    await expect.poll(() => commandLines().filter((line) => line.startsWith("tizen package"))).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commandLines().filter((line) => line.startsWith("tizen cli-config"))).toHaveLength(1);

    release();
    expect((await both).map(({ status }) => status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const signingLines = commandLines().filter((line) => /^tizen (cli-config|package)/.test(line));
    expect(signingLines.map((line) => line.split(" ")[1])).toEqual(["cli-config", "package", "cli-config", "package"]);
  });
});

describe("launching and uninstalling the Player on a Samsung TV", () => {
  it("launches it by its app id", async () => {
    await tools().launch(TV, step);

    expect(commandLines()).toEqual([
      `sdb connect ${SERIAL}`,
      `tizen run -s ${SERIAL} -p MediaCntre.Player`,
      `sdb disconnect ${SERIAL}`,
    ]);
    expect(steps).toEqual(["connecting", "launching"]);
  });

  it("uninstalls it by its app id", async () => {
    await tools().uninstall(TV, step);

    expect(commandLines()).toEqual([
      `sdb connect ${SERIAL}`,
      `tizen uninstall -s ${SERIAL} -p MediaCntre.Player`,
      `sdb disconnect ${SERIAL}`,
    ]);
    expect(steps).toEqual(["connecting", "uninstalling"]);
  });

  it("says why the TV didn't launch it", async () => {
    commands.answer((program, args) => program === "tizen" && args[0] === "run", {
      exitCode: 1,
      output: "Package ID is not valid. Please check the package ID again.\n",
    });

    const error = await failure(tools().launch(TV, step));

    expect(error.reason).toBe("refused");
    expect(error.message).toContain("The TV didn't launch the Player. Check that it is installed.");
    expect(error.message).toContain("Package ID is not valid");
    expect(commandLines().at(-1)).toBe(`sdb disconnect ${SERIAL}`);
  });

  it("says why the TV didn't uninstall it", async () => {
    commands.answer((program, args) => program === "tizen" && args[0] === "uninstall", {
      exitCode: 0,
      output: "uninstall failed[1, -1], reason: Not installed\n",
    });

    const error = await failure(tools().uninstall(TV, step));

    expect(error.reason).toBe("refused");
    expect(error.message).toContain("Not installed");
  });
});
