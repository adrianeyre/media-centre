import { createCipheriv } from "node:crypto";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLAYER_APP_ID, type PlayerActionStep } from "@media-centre/shared";

import { CommandMissing, runCommand, type CommandResult, type RunCommand } from "../../commands.ts";
import { DriverFailure, type PlayerBuild, type PlayerTools, type SigningCertificate } from "../driver.ts";

/** The port a Samsung TV in Developer Mode lets its Developer IP connect to with `sdb`. */
export const SDB_PORT = 26_101;

/** The name of the security profile the Player is signed with, which lives only as long as one signing. */
const PROFILE_NAME = "media-centre";

/** What each folder the Player is signed in is named, before what makes it unique. */
const WORK_PREFIX = "media-centre-player-";

/**
 * The key the `tizen` CLI reads a password in its security profiles with,
 * when it is kept there rather than in the desktop's keyring, which a Hub in
 * a container hasn't got. It is the CLI's own, fixed and public, so this
 * only stops the password reading as itself; the profile is deleted as soon
 * as the Player is signed.
 */
const TIZEN_PROFILE_KEY = Buffer.from("KYANINYLhijklmnopqrstuvwx").subarray(0, 24);

export interface SamsungPlayerToolsOptions {
  /** How the tools are run. By default, as programs on the Hub's machine. */
  readonly run?: RunCommand;
  /** Samsung's `sdb`, by default the one on the `PATH`. */
  readonly sdb?: string;
  /** Samsung's `tizen` CLI, by default the one on the `PATH`. */
  readonly tizen?: string;
  /** How long `sdb` has to connect to a TV. */
  readonly connectTimeoutMs?: number;
  /** How long the `tizen` CLI has for each thing it does, which on a TV can take a minute. */
  readonly toolTimeoutMs?: number;
  /** Where the Player is signed, each time in a folder of its own. By default, the system's temporary folder. */
  readonly tempDir?: string;
}

/** The `tizen` CLI's password, as its security profiles keep it. */
const profilePassword = (password: string): string => {
  const cipher = createCipheriv("des-ede3", TIZEN_PROFILE_KEY, null);
  return Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString("base64");
};

const xmlAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A `tizen` CLI security profile of the signing certificate's two halves at
 * these paths, as Tizen Studio's Certificate Manager writes one.
 */
const securityProfile = (certificate: SigningCertificate, author: string, distributor: string): string => {
  const item = (index: number, key: string, password: string): string =>
    `<profileitem ca="" distributor="${String(index)}" key="${xmlAttribute(key)}" ` +
    `password="${xmlAttribute(password === "" ? "" : profilePassword(password))}" rootca=""/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<profiles active="${PROFILE_NAME}" version="3.1">`,
    `<profile name="${PROFILE_NAME}">`,
    item(0, author, certificate.authorPassword),
    item(1, distributor, certificate.distributorPassword),
    item(2, "", ""),
    "</profile>",
    "</profiles>",
    "",
  ].join("\n");
};

/** What the tools said about why they failed, for the person: the lines that say so, or else the last. */
const reasonIn = (output: string): string => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    // Leaving out the CLI's timings, and sdb's news of its own server, such as "* Server has started successfully *".
    .filter((line) => line !== "" && !/^Total time:/i.test(line) && !/^\*.*\*$/.test(line));
  const saying = lines.filter((line) => /fail|error|reason|not |cannot|can't|invalid/i.test(line));
  const reason = (saying.length > 0 ? saying : lines.slice(-1)).join(" ");
  return reason.length > 300 ? `${reason.slice(0, 299)}…` : reason;
};

/** Whether a tool said it failed, which some say with an exit code of 0. */
const saysItFailed = ({ exitCode, output }: CommandResult): boolean =>
  exitCode !== 0 || /\bfail(?:ed|ure)?\b|\berror\b|\bcannot\b|\bcan not\b/i.test(output);

/**
 * Installs, launches and uninstalls the Player on Samsung TVs with Samsung's
 * own developer tools, `sdb` and the `tizen` CLI, from Tizen Studio (FR-31):
 *
 * 1. `sdb connect` connects to the TV on {@link SDB_PORT}, which a TV in
 *    Developer Mode allows only from its Developer IP.
 * 2. To install, `tizen package` signs a copy of the Player build with the
 *    signing certificate, in a folder of its own that only the Hub can read,
 *    deleted once the Player is installed, as are any a Hub stopped while it
 *    signed left behind, before the first install; then `tizen install` installs it,
 *    over any Player there.
 * 3. `tizen run` launches it, and `tizen uninstall` uninstalls it, by its app id.
 * 4. `sdb disconnect` disconnects from the TV, however it went.
 *
 * The `tizen` CLI reads the signing certificate's passwords from a security
 * profile in that folder, which it is pointed to before each signing, one
 * at a time; neither password is ever in a command's arguments, which other
 * programs on the Hub's machine could read. The tools say some failures with
 * an exit code of 0, so what they say is read too.
 */
export const samsungPlayerTools = ({
  run = runCommand,
  sdb = "sdb",
  tizen = "tizen",
  connectTimeoutMs = 30_000,
  toolTimeoutMs = 120_000,
  tempDir = tmpdir(),
}: SamsungPlayerToolsOptions = {}): PlayerTools => {
  /** Signing points the `tizen` CLI at one security profile, so one signing runs at a time. */
  let signing: Promise<unknown> = Promise.resolve();
  /**
   * Deletes the folders a Hub that was stopped while it signed left behind,
   * which hold the signing certificate, once, before the first install signs.
   */
  let leftBehindDeleted: Promise<void> | undefined;
  const deleteLeftBehind = (): Promise<void> => {
    leftBehindDeleted ??= readdir(tempDir).then(
      async (names) => {
        const left = names.filter((name) => name.startsWith(WORK_PREFIX));
        await Promise.all(left.map((name) => rm(join(tempDir, name), { recursive: true, force: true })));
      },
      () => undefined,
    );
    return leftBehindDeleted;
  };

  const tool = async (program: string, args: readonly string[], timeoutMs = toolTimeoutMs): Promise<CommandResult> => {
    try {
      return await run(program, args, { timeoutMs });
    } catch (error) {
      if (error instanceof CommandMissing) {
        throw new DriverFailure(
          "not-supported",
          `The Hub can't install the Player: it hasn't got Samsung's ${program} tool. The Hub's Docker image has ` +
            "it on amd64; on another machine, install Tizen Studio's command-line tools and put sdb and tizen on " +
            "the Hub's PATH.",
          { cause: error },
        );
      }
      throw error;
    }
  };

  const connect = async (serial: string): Promise<void> => {
    const result = await tool(sdb, ["connect", serial], connectTimeoutMs);
    const connected = /\bconnected to\b|\bis already connected\b/i.test(result.output);
    if (!connected || saysItFailed(result)) {
      throw new DriverFailure(
        "unreachable",
        "The TV didn't let the Hub connect to install apps. Check that Developer Mode is on with the Hub's IP as " +
          "the Developer IP, that the TV has been restarted since, and that no other computer is connected to it " +
          `for development. (${reasonIn(result.output) || "It said nothing."})`,
      );
    }
  };

  /** Connects to the TV at `address`, does `then`, and disconnects, however it went. */
  const connected = async (
    address: string,
    step: (step: PlayerActionStep) => void,
    then: (serial: string) => Promise<void>,
  ): Promise<void> => {
    const serial = `${address}:${String(SDB_PORT)}`;
    step("connecting");
    await connect(serial);
    try {
      await then(serial);
    } finally {
      await tool(sdb, ["disconnect", serial], connectTimeoutMs).catch(() => undefined);
    }
  };

  /** Signs a copy of the Player build in `work`, and resolves with the folder and name of the package it made. */
  const sign = async (work: string, { dir, certificate }: PlayerBuild): Promise<{ dir: string; name: string }> => {
    const author = join(work, "author.p12");
    const distributor = join(work, "distributor.p12");
    const profiles = join(work, "profiles.xml");
    const player = join(work, "player");
    const output = join(work, "package");
    await writeFile(author, certificate.author, { mode: 0o600 });
    await writeFile(distributor, certificate.distributor, { mode: 0o600 });
    await writeFile(profiles, securityProfile(certificate, author, distributor), { mode: 0o600 });
    // The CLI writes beside the files it signs, which the Hub's own build may not let it.
    await cp(dir, player, { recursive: true });

    const signed = signing.then(async () => {
      const configured = await tool(tizen, ["cli-config", `profiles.path=${profiles}`]);
      if (saysItFailed(configured)) {
        throw new DriverFailure("refused", `Samsung's tizen tool couldn't be set up: ${reasonIn(configured.output)}`);
      }
      return tool(tizen, ["package", "-t", "wgt", "-s", PROFILE_NAME, "-o", output, "--", player]);
    });
    signing = signed.catch(() => undefined);
    const result = await signed;
    // Without a profile it can sign with, the CLI packages the Player unsigned, and says only that.
    const unsigned = /not found .*signature/i.test(result.output);
    const name = (await readdir(output).catch(() => [])).find((file) => file.endsWith(".wgt"));
    if (saysItFailed(result) || unsigned || name === undefined) {
      throw new DriverFailure(
        "refused",
        "The Player couldn't be signed with the signing certificate in Settings. Check its passwords, and that its " +
          "files are a Samsung TV certificate's author and distributor certificates.",
      );
    }
    return { dir: output, name };
  };

  return {
    install: (address, build, step) =>
      connected(address, step, async (serial) => {
        step("signing");
        await deleteLeftBehind();
        const work = await mkdtemp(join(tempDir, WORK_PREFIX));
        try {
          const signed = await sign(work, build);
          step("installing");
          const result = await tool(tizen, ["install", "-s", serial, "-n", signed.name, "--", signed.dir]);
          if (saysItFailed(result)) {
            throw new DriverFailure(
              "refused",
              "The TV didn't install the Player. If it says the certificate doesn't match, the Player there was " +
                "signed with another author certificate: uninstall it first. If it says the certificate is invalid, " +
                `the distributor certificate must list this TV. (${reasonIn(result.output)})`,
            );
          }
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      }),

    launch: (address, step) =>
      connected(address, step, async (serial) => {
        step("launching");
        const result = await tool(tizen, ["run", "-s", serial, "-p", PLAYER_APP_ID]);
        if (saysItFailed(result)) {
          throw new DriverFailure(
            "refused",
            `The TV didn't launch the Player. Check that it is installed. (${reasonIn(result.output)})`,
          );
        }
      }),

    uninstall: (address, step) =>
      connected(address, step, async (serial) => {
        step("uninstalling");
        const result = await tool(tizen, ["uninstall", "-s", serial, "-p", PLAYER_APP_ID]);
        if (saysItFailed(result)) {
          throw new DriverFailure(
            "refused",
            `The TV didn't uninstall the Player. Check that it is installed. (${reasonIn(result.output)})`,
          );
        }
      }),
  };
};
