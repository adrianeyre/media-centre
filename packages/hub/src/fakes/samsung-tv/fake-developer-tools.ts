import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResult, RunCommand } from "../../commands.ts";
import { CommandMissing } from "../../commands.ts";

/** One command a {@link FakeCommands} was asked to run. */
export interface RanCommand {
  readonly program: string;
  readonly args: readonly string[];
  /** When `tizen package` ran: the security profile it was pointed to, and the files beside it, with their modes. */
  readonly signing?: {
    readonly profile: string;
    readonly files: Readonly<Record<string, number>>;
  };
}

/** What a command answers: what it says and how it ends, or that there is no such program. */
export type FakeAnswer = CommandResult | "missing";

export interface FakeCommands {
  readonly run: RunCommand;
  /** Every command run, in the order each started. */
  readonly ran: RanCommand[];
  /**
   * Has every command from now on whose program and arguments `matches`
   * answer so, instead of as Samsung's tools do, and, given `waitFor`, only
   * once it resolves.
   */
  readonly answer: (
    matches: (program: string, args: readonly string[]) => boolean,
    answer: FakeAnswer,
    waitFor?: Promise<unknown>,
  ) => void;
}

/** What a tool said, ending as it did. */
const said = (output: string, exitCode = 0): CommandResult => ({ exitCode, output });

/**
 * Stands in for running Samsung's `sdb` and `tizen` tools in tests, where
 * there is no TV in Developer Mode: it records each command, and answers as
 * the real tools do when all goes well, from what they were seen to say,
 * writing the package `tizen package` would. {@link FakeCommands.answer}
 * has it answer otherwise, e.g. as they do when they fail, which some say
 * with an exit code of 0.
 */
export const fakeCommands = (): FakeCommands => {
  const ran: RanCommand[] = [];
  const answers: {
    readonly matches: (program: string, args: readonly string[]) => boolean;
    readonly answer: FakeAnswer;
    readonly waitFor: Promise<unknown> | undefined;
  }[] = [];
  /** The security profile `tizen cli-config` last pointed the CLI to. */
  let profilesPath: string | undefined;

  const asSamsungsTools = async (program: string, args: readonly string[]): Promise<CommandResult> => {
    const [command] = args;
    if (program === "sdb" && command === "connect")
      return said(`connecting to ${String(args[1])} ...\nconnected to ${String(args[1])}\n`);
    if (program === "sdb" && command === "disconnect") return said(`disconnected ${String(args[1])}\n`);
    if (program === "tizen" && command === "cli-config") {
      profilesPath = args[1]?.replace(/^profiles\.path=/, "");
      return said("Setting configuration is succeeded....\n");
    }
    if (program === "tizen" && command === "package") {
      const output = args[args.indexOf("-o") + 1] ?? "";
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "Media Centre.wgt"), "signed");
      return said(
        "Author certficate: author.p12\nDistributor1 certificate : distributor.p12\n" +
          `Package File Location: ${join(output, "Media Centre.wgt")}\n`,
      );
    }
    if (program === "tizen" && command === "install") {
      return said(
        "Transferring the package...\nInstalling the package...\napp_id[MediaCntre.Player] install completed\n" +
          "Installed the package: Id(MediaCntre)\nTotal time: 00:00:05.162\n",
      );
    }
    if (program === "tizen" && command === "run")
      return said("Launching the Tizen application...\n... successfully launched\n");
    if (program === "tizen" && command === "uninstall") return said("uninstall completed\nTotal time: 00:00:02.000\n");
    return said(`${program}: unknown command ${String(command)}\n`, 1);
  };

  /** The security profile and the files beside it, as `tizen package` would find them. */
  const signingNow = async (): Promise<RanCommand["signing"]> => {
    if (profilesPath === undefined) return undefined;
    const dir = join(profilesPath, "..");
    const files: Record<string, number> = {};
    for (const name of await readdir(dir).catch(() => [])) {
      files[name] = (await stat(join(dir, name))).mode & 0o777;
    }
    return { profile: await readFile(profilesPath, "utf8").catch(() => ""), files };
  };

  return {
    ran,
    answer: (matches, answer, waitFor) => {
      answers.unshift({ matches, answer, waitFor });
    },
    run: async (program, args) => {
      const signing = program === "tizen" && args[0] === "package" ? await signingNow() : undefined;
      ran.push({ program, args: [...args], ...(signing === undefined ? {} : { signing }) });
      const scripted = answers.find((each) => each.matches(program, args));
      if (scripted === undefined) return asSamsungsTools(program, args);
      await scripted.waitFor;
      if (scripted.answer === "missing") throw new CommandMissing(program);
      return scripted.answer;
    },
  };
};
