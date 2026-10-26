import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeHiveCloud, type FakeHiveCloud } from "../../fakes/hive-cloud/fake-hive-cloud.ts";
import { hiveDriver } from "./hive-driver.ts";

const LOGIN = { account: "owner@example.com", password: "correct horse battery staple" };
const CODE = "246810";
const WRONG_CODE = "135797";

/** As much of a secret as is as good as a leak, from anywhere in it, for one long enough not to turn up by chance. */
const PART = 12;

/**
 * Every form a secret could be written in: as it is, either case, base64,
 * base64url and hex, and, for one longer than {@link PART}, each part of any
 * of them that long, from wherever it starts.
 */
const formsOf = (secret: string): string[] => {
  const bytes = Buffer.from(secret, "utf8");
  const forms = [
    secret,
    secret.toLowerCase(),
    secret.toUpperCase(),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ];
  if (secret.length <= PART) return forms;
  return forms.flatMap((form) => Array.from({ length: form.length - PART + 1 }, (_, at) => form.slice(at, at + PART)));
};

/** Every string in what the Driver handed the Hub to keep: Hive's tokens, the session, and the device's key, group key and password. */
const secretsIn = (kept: string): string[] => {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(JSON.parse(kept));
  return strings;
};

let lines: string[];
let cloud: FakeHiveCloud;

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
  await cloud.stop();
});

describe("The Hive Driver's log", () => {
  it("never has the password, a code, a token or a device's keys in it, nor do the errors the Hub would log", async () => {
    cloud = await startFakeHiveCloud({ ...LOGIN, code: CODE });
    // The Driver logs as the Hub runs it, to the console.
    const driver = hiveDriver({ apiUrl: cloud.url, authUrl: cloud.url, timeoutMs: 1_000 });

    const kept: string[] = [];
    const errors: unknown[] = [];
    const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work();
      } catch (error) {
        errors.push(error);
        return undefined;
      }
    };

    await attempt(() => driver.signIn({ ...LOGIN, password: "Tr0ub4dor&3" }));
    const asked = await driver.signIn(LOGIN);
    if (asked.signedIn) throw new Error("Hive asked no code");
    kept.push(asked.pending);
    await attempt(() => driver.enterCode(asked.pending, WRONG_CODE));
    let credentials = await driver.enterCode(asked.pending, CODE);
    kept.push(credentials);

    // Signed in again, as the trusted device.
    const again = await driver.signIn(LOGIN, credentials);
    if (!again.signedIn) throw new Error("Hive asked for a code again");
    credentials = again.credentials;
    kept.push(credentials);

    credentials = await driver.refresh(credentials);
    kept.push(credentials);
    const { appliances } = await driver.listAppliances(credentials);
    const [first, , , study] = appliances;
    await driver.readStates(credentials);
    await driver.setState(credentials, first?.id ?? "", { boost: { target: 22, minutes: 60 } });
    await attempt(() => driver.setState(credentials, first?.id ?? "", { target: 99 }));
    cloud.setProduct(study?.id ?? "", { refusesChanges: true });
    await attempt(() => driver.setState(credentials, study?.id ?? "", { target: 21 }));

    // Hive's tokens expire, and are renewed.
    cloud.advance(61);
    const renewed = await driver.readStates(credentials);
    kept.push(renewed.credentials);

    // Hive stops taking them, then can't be reached.
    cloud.revoke();
    await attempt(() => driver.readStates(renewed.credentials));
    await attempt(() => driver.refresh(renewed.credentials));
    await cloud.stop();
    await attempt(() => driver.readStates(renewed.credentials));
    await attempt(() => driver.signIn(LOGIN, renewed.credentials));

    // What the Hub would log of each failure: its message, its stack and everything it was caused by.
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const error of errors) {
      lines.push(String(error), inspect(error, { depth: 10 }), JSON.stringify(error));
    }
    // The Driver did log, so the test sees what it would write.
    expect(lines.some((line) => line.includes("Signed in to Hive"))).toBe(true);
    expect(lines.some((line) => line.includes("Renewed the Hub's tokens for Hive"))).toBe(true);
    expect(lines.some((line) => line.includes("Hive refused the change to Study"))).toBe(true);

    const secrets = [
      LOGIN.password,
      "Tr0ub4dor&3",
      CODE,
      WRONG_CODE,
      // The tokens, the session and the device's key, group key and password; not the time they expire.
      ...kept.flatMap(secretsIn),
    ];
    // Each kind of secret was there to look for.
    expect(new Set(kept.flatMap((each) => Object.keys(JSON.parse(each) as object)))).toEqual(
      new Set(["session", "user", "device", "accessToken", "idToken", "refreshToken", "expiresAt"]),
    );
    // The session and its user, then four times three tokens and a device's three secrets.
    expect(kept.flatMap(secretsIn)).toHaveLength(2 + 4 * 6);

    const forms = [...new Set(secrets.flatMap(formsOf))];
    const leaks = lines.filter((line) => forms.some((secret) => line.includes(secret)));
    expect(leaks).toEqual([]);
  });
});
