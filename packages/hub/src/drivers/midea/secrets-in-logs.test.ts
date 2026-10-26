import { randomBytes } from "node:crypto";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeMideaAircon, type FakeMideaAircon } from "../../fakes/midea-aircon/fake-midea-aircon.ts";
import { mideaCredentials, mideaDriver } from "./midea-driver.ts";

/** Every form a token or key could be written in: hex either case, base64 and base64url, and in part. */
const formsOf = (hex: string): string[] => {
  const bytes = Buffer.from(hex, "hex");
  const forms = [hex.toLowerCase(), hex.toUpperCase(), bytes.toString("base64"), bytes.toString("base64url")];
  // A third of any of them is as good as a leak.
  return [...forms, ...forms.map((form) => form.slice(0, Math.ceil(form.length / 3)))];
};

let lines: string[];
let fake: FakeMideaAircon;

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

describe("The Midea Driver's log", () => {
  it("never has a token or a key in it, nor do the errors the Hub would log", async () => {
    fake = await startFakeMideaAircon({ version: 3, unknownCapabilities: [0x0099] });
    const token = fake.token ?? "";
    const key = fake.key ?? "";
    const wrongToken = randomBytes(64).toString("hex");
    const wrongKey = randomBytes(32).toString("hex");
    const credentials = mideaCredentials({ id: fake.id, version: 3, token, key });
    // The Driver logs as the Hub runs it, to the console.
    const driver = mideaDriver({
      port: fake.port,
      discoveryPorts: [fake.discoveryPort],
      searchTargets: [{ host: fake.host, port: fake.discoveryPort }],
      searchWindowMs: 200,
      answerTimeoutMs: 1_000,
    });

    const errors: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };

    await attempt(() => driver.discover());
    await attempt(() => driver.identify(fake.host));
    await attempt(() => driver.readCapabilities(fake.host, credentials));
    await attempt(() => driver.readState(fake.host, credentials));
    await attempt(() =>
      driver.setState(fake.host, credentials, {
        power: true,
        mode: "heat",
        targetTemperature: 22.5,
        fanSpeed: "high",
        swing: { vertical: true, horizontal: true },
        preset: "eco",
        display: false,
        functions: { breeze: "mild", "self-clean": true },
      }),
    );
    await attempt(() => driver.setState(fake.host, credentials, { mode: "heat", targetTemperature: 99 }));
    await attempt(() =>
      driver.readState(fake.host, mideaCredentials({ id: fake.id, version: 3, token: wrongToken, key })),
    );
    await attempt(() =>
      driver.readState(fake.host, mideaCredentials({ id: fake.id, version: 3, token, key: wrongKey })),
    );
    await attempt(() => driver.readState(fake.host, credentials.replace('"version":3', '"version":4')));
    await fake.stop();
    await attempt(() => driver.readState(fake.host, credentials));

    // What the Hub would log of each failure: its message, its stack and everything it was caused by.
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const error of errors) {
      lines.push(String(error), inspect(error, { depth: 10 }), JSON.stringify(error));
    }
    // The Driver did log, so the test sees what it would write.
    expect(lines.some((line) => line.includes("refused the Hub's token and key"))).toBe(true);
    expect(lines.some((line) => line.includes("doesn't know"))).toBe(true);

    const secrets = [token, key, wrongToken, wrongKey].flatMap(formsOf);
    const leaks = lines.filter((line) => secrets.some((secret) => line.includes(secret)));
    expect(leaks).toEqual([]);
  });
});
