import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

export interface RunningProcess {
  readonly child: ChildProcess;
  /** The match of `ready` against the line that said the process was ready. */
  readonly match: RegExpMatchArray;
  /** Every line the process has written to stdout or stderr so far. */
  readonly output: readonly string[];
  /** Sends SIGTERM and resolves with the exit code once the process has gone. */
  readonly stop: () => Promise<number | null>;
}

/**
 * Runs `node <script>` as its own process, as `pnpm start` would, and resolves
 * once it writes a line matching `ready`. It rejects if the process exits or
 * says nothing matching within `timeoutMs`.
 */
export const startNodeProcess = async (
  script: string,
  env: Readonly<Record<string, string>>,
  ready: RegExp,
  timeoutMs = 10_000,
): Promise<RunningProcess> => {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  const exited = once(child, "exit").then(([code]) => code as number | null);

  const match = await new Promise<RegExpMatchArray>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${script} was not ready after ${String(timeoutMs)} ms:\n${output.join("\n")}`));
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        output.push(line);
        const found = ready.exec(line);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      });
    }
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`${script} exited with ${String(code)} before it was ready:\n${output.join("\n")}`));
    });
  }).catch(async (error: unknown) => {
    child.kill();
    await exited;
    throw error;
  });

  return {
    child,
    match,
    output,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
};
