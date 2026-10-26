import { spawn } from "node:child_process";

/** What a program said and how it ended. */
export interface CommandResult {
  /** Its exit code, or null when it was stopped, e.g. for taking too long. */
  readonly exitCode: number | null;
  /** All it wrote, to its standard output and its standard error, as it wrote them. */
  readonly output: string;
}

/**
 * Runs a program with these arguments, never through a shell, so nothing in
 * them is ever taken for a command, and resolves once it has ended. It is
 * given no input, so a program that asks for any, e.g. a password, ends then
 * rather than wait. One still running after `timeoutMs` is stopped. Rejects
 * with a {@link CommandMissing} when there is no such program.
 */
export type RunCommand = (
  program: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<CommandResult>;

/** The program asked for isn't on the Hub's machine. */
export class CommandMissing extends Error {
  readonly program: string;

  constructor(program: string, options?: ErrorOptions) {
    super(`There is no ${program} on the Hub's machine`, options);
    this.name = "CommandMissing";
    this.program = program;
  }
}

/** More than any of the programs the Hub runs says; anything past it is dropped. */
const MAX_OUTPUT_LENGTH = 256 * 1024;

/** Runs programs on the Hub's own machine, as {@link RunCommand} says. */
export const runCommand: RunCommand = (program, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let output = "";
    const heard = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_LENGTH) output += chunk.toString("utf8");
    };
    child.stdout.on("data", heard);
    child.stderr.on("data", heard);
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") reject(new CommandMissing(program, { cause: error }));
      else reject(error);
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode, output });
    });
  });
