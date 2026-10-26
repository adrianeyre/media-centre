import { createServer, type Socket } from "node:net";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeLeproLight, type FakeLeproLight } from "../../fakes/lepro-light/fake-lepro-light.ts";
import { leproCredentials, leproDriver } from "./lepro-driver.ts";
import { tuyaTransport } from "./tuya.ts";

/** Every form an id or key could be written in: as it is, either case, hex, base64 and base64url, and in part. */
const formsOf = (secret: string): string[] => {
  const bytes = Buffer.from(secret, "latin1");
  const forms = [
    secret,
    secret.toLowerCase(),
    secret.toUpperCase(),
    bytes.toString("hex"),
    bytes.toString("base64"),
    bytes.toString("base64url"),
  ];
  // Half of any of them is as good as a leak.
  return [...forms, ...forms.map((form) => form.slice(0, Math.ceil(form.length / 2)))];
};

let lines: string[];
let fake: FakeLeproLight;

beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 10 }))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
});

describe("The Lepro Driver's log", () => {
  it("never has a Light's id or key in it, nor do the errors the Hub would log, nor what it answers the Hub", async () => {
    fake = await startFakeLeproLight();
    const { id, key } = fake;
    const wrongId = "bf99999999999999999999";
    const wrongKey = "ZYXWVUTSRQPONMLK";
    const credentials = leproCredentials({ id, key });
    // Something that answers with what isn't a Light's, to fail as not one.
    const talker = createServer((socket: Socket) => {
      socket.on("error", () => undefined);
      socket.on("data", () => socket.end("not a Light"));
    });
    await new Promise<void>((resolve) => talker.listen(0, "127.0.0.2", resolve));
    const transport = (port: number) =>
      tuyaTransport({
        port,
        discoveryPorts: [fake.discoveryPort],
        searchTargets: [{ host: fake.host, port: fake.discoveryPort }],
        searchWindowMs: 200,
        answerTimeoutMs: 500,
      });
    // The Driver logs as the Hub runs it, to the console.
    const driver = leproDriver({ transport: transport(fake.port) });
    const talkerDriver = leproDriver({ transport: transport((talker.address() as { port: number }).port) });

    const errors: unknown[] = [];
    const answers: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        answers.push(await work());
      } catch (error) {
        errors.push(error);
      }
    };

    await attempt(() => driver.readCapabilities(fake.host, credentials));
    await attempt(() => driver.readState(fake.host, credentials));
    await attempt(() =>
      driver.setState(fake.host, credentials, { on: true, brightness: 40, colour: { hue: 200, saturation: 70 } }),
    );
    await attempt(() => driver.setState(fake.host, credentials, { colourTemperature: 3_000 }));
    await attempt(() => driver.setState(fake.host, credentials, { brightness: 400 }));
    await attempt(() => driver.readState(fake.host, leproCredentials({ id, key: wrongKey })));
    await attempt(() => driver.setState(fake.host, leproCredentials({ id: wrongId, key }), { on: false }));
    await attempt(() => driver.readState(fake.host, leproCredentials({ id })));
    await attempt(() => driver.readState(fake.host, credentials.replace(key, "short")));
    await attempt(() => talkerDriver.readState("127.0.0.2", credentials));
    await new Promise<void>((resolve) =>
      talker.close(() => {
        resolve();
      }),
    );
    await fake.stop();
    await attempt(() => driver.readState(fake.host, credentials));

    // What the Hub would log of each failure: its message, its stack and everything it was caused by.
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const error of errors) {
      lines.push(String(error), inspect(error, { depth: 10 }), JSON.stringify(error));
    }
    // What the Driver answers the Hub with, which the Hub would answer the Remote with.
    expect(answers.length).toBe(4);
    lines.push(...answers.map((answer) => JSON.stringify(answer)));
    // The Driver did log, so the test sees what it would write.
    expect(lines.some((line) => line.includes("refused the Hub's key"))).toBe(true);

    const secrets = [id, key, wrongId, wrongKey].flatMap(formsOf);
    const leaks = lines.filter((line) => secrets.some((secret) => line.includes(secret)));
    expect(leaks).toEqual([]);
  });
});
