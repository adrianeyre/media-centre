import { describe, expect, it } from "vitest";

import {
  claimSignature,
  claimTime,
  clientEphemeral,
  clientKey,
  deviceVerifier,
  k,
  N,
  padHex,
  serverEphemeral,
  serverKey,
  verifierFor,
  verifierFromBase64,
} from "./srp.ts";

describe("SRP as Cognito does it", () => {
  it("uses RFC 5054's 3072-bit group", () => {
    const hex = N.toString(16);
    expect(hex).toHaveLength(768);
    expect(hex.startsWith("ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd1")).toBe(true);
    expect(hex.endsWith("a93ad2caffffffffffffffff")).toBe(true);
    expect(k > 0n && k < 2n ** 256n).toBe(true);
  });

  it.each([
    [0x0fn, "0f"],
    [0x7fn, "7f"],
    [0x80n, "0080"],
    [0x123n, "0123"],
    ["000abc", "0abc"],
    ["00ff", "00ff"],
  ] as const)("pads %s as %s", (value, padded) => {
    expect(padHex(value)).toBe(padded);
  });

  it("writes the time as Cognito takes it, the day not padded", () => {
    expect(claimTime(new Date(Date.UTC(2026, 9, 1, 5, 4, 3)))).toBe("Thu Oct 1 05:04:03 UTC 2026");
    expect(claimTime(new Date(Date.UTC(2026, 9, 21, 15, 8, 35)))).toBe("Wed Oct 21 15:08:35 UTC 2026");
  });

  it("gives the client and the server the same key, for the right password only", () => {
    const salt = "1f2e3d4c5b6a79881f2e3d4c5b6a7988";
    const verifier = verifierFor("SamNfoWtf", "user-id", "correct horse battery staple", salt);
    const client = clientEphemeral();
    const server = serverEphemeral(verifier);

    const right = clientKey(client, server.B, salt, "SamNfoWtf", "user-id", "correct horse battery staple");
    const wrong = clientKey(client, server.B, salt, "SamNfoWtf", "user-id", "Tr0ub4dor&3");

    expect(right).toHaveLength(16);
    expect(right).toEqual(serverKey(client.A, server, verifier));
    expect(wrong).not.toEqual(serverKey(client.A, server, verifier));
  });

  it("lets a device sign in by the verifier it gave as it was confirmed", () => {
    const { passwordVerifier, salt } = deviceVerifier("-groupKey", "eu-west-1_device", "device password");
    const verifier = verifierFromBase64(passwordVerifier);
    const saltHex = Buffer.from(salt, "base64").toString("hex");
    const client = clientEphemeral();
    const server = serverEphemeral(verifier);

    const key = clientKey(client, server.B, saltHex, "-groupKey", "eu-west-1_device", "device password");
    const block = Buffer.from("secret block").toString("base64");
    const time = claimTime(new Date());

    expect(claimSignature(key, "-groupKey", "eu-west-1_device", block, time)).toBe(
      claimSignature(serverKey(client.A, server, verifier), "-groupKey", "eu-west-1_device", block, time),
    );
  });

  it("refuses a server's B that is a multiple of N", () => {
    expect(() => clientKey(clientEphemeral(), N.toString(16), "00", "pool", "user", "password")).toThrow();
  });
});
