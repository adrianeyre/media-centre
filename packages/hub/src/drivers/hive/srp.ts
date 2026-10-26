/**
 * The Secure Remote Password exchange (SRP-6a) as AWS Cognito's user pools
 * speak it, which Hive's app signs in with: the arithmetic alone, with no
 * network, so that the Hive Driver's Cognito client proves the password and
 * the Hub's device password with it, and the fake Hive cloud checks each
 * proof as Cognito would. Only the Hive Driver and the fake Hive cloud know
 * this (NFR-6).
 *
 * It is written from AWS's own `amazon-cognito-identity-js`
 * (`AuthenticationHelper`), which pyhiveapi's `hive_auth` follows: the
 * 3072-bit group of RFC 5054 with g = 2; k = H(N | g); u = H(A | B); x =
 * H(salt | H(pool | user | ":" | password)); the key, HKDF of the shared
 * secret salted with u, as "Caldera Derived Key"; and the claim, an HMAC of
 * the pool, the user, the secret block and the time. No test reaches the
 * real Cognito, so it is proved only against the fake, which shares this
 * arithmetic: a slip in it would pass the tests and fail against Hive. Where
 * it is uncertain:
 *
 * - each hash is SHA-256 of the bytes that hexadecimal numbers, padded as
 *   {@link padHex} pads them, spell, and of a password's UTF-8;
 * - the time is `ddd MMM D HH:mm:ss UTC YYYY`, in English, the day not
 *   padded, as AWS's library writes it;
 * - a device signs in as its group key, in the pool's place, and its key, in
 *   the user's (Cognito's "remembered devices").
 */
import { createDiffieHellmanGroup, createHash, createHmac, randomBytes } from "node:crypto";

/** The 3072-bit group of RFC 5054, which is RFC 3526's 3072-bit MODP group, as Node has it. */
export const N = BigInt(`0x${createDiffieHellmanGroup("modp15").getPrime("hex")}`);
export const g = 2n;

const bigFromHex = (hex: string): bigint => BigInt(`0x${hex === "" ? "0" : hex}`);

/**
 * A positive number in hexadecimal, as Cognito hashes it: with no leading
 * zeros, then an even number of digits, with a leading `00` where the first
 * would otherwise read as a negative number's.
 */
export const padHex = (value: bigint | string): string => {
  let hex = (typeof value === "string" ? bigFromHex(value) : value).toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  else if (/^[89a-f]/i.test(hex)) hex = `00${hex}`;
  return hex.toLowerCase();
};

/** SHA-256 of the bytes `hex` spells, in hexadecimal, 64 digits. */
export const hexHash = (hex: string): string => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

/** SHA-256 of a string's UTF-8, in hexadecimal, 64 digits. */
const textHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `base` to the power `exponent`, modulo `modulus`, all positive. */
export const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
};

export const k = bigFromHex(hexHash(`${padHex(N)}${padHex(g)}`));

/** A random number below N, for a secret exponent, `a` or `b`. */
const randomExponent = (): bigint => bigFromHex(randomBytes(128).toString("hex")) % N;

/** The client's half of an exchange: its secret `a`, and `A`, which it sends, in hexadecimal. */
export interface ClientEphemeral {
  readonly a: bigint;
  readonly A: string;
}

export const clientEphemeral = (): ClientEphemeral => {
  for (;;) {
    const a = randomExponent();
    const A = modPow(g, a, N);
    if (A % N !== 0n) return { a, A: A.toString(16) };
  }
};

/** u = H(A | B), which binds the exchange to both halves. */
export const scramble = (A: string, B: string): bigint => bigFromHex(hexHash(`${padHex(A)}${padHex(B)}`));

/**
 * x, what the password is to SRP: H(salt | H(`group` | `user` | ":" | `password`)).
 * For a person, `group` is the pool's name, its id after the region, and
 * `user` their id for SRP; for a device, its group key and its key.
 */
export const passwordExponent = (group: string, user: string, password: string, salt: string): bigint =>
  bigFromHex(hexHash(`${padHex(salt)}${textHash(`${group}${user}:${password}`)}`));

/** The 16-byte key both sides derive from the shared secret S, salted with u, as Cognito's HKDF does. */
export const derivedKey = (S: bigint, u: bigint): Buffer => {
  const prk = createHmac("sha256", Buffer.from(padHex(u), "hex"))
    .update(Buffer.from(padHex(S), "hex"))
    .digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("Caldera Derived Key", "utf8"), Buffer.of(1)]))
    .digest()
    .subarray(0, 16);
};

/** The client's key, from the server's `B` and `salt`, its own half, and the password. */
export const clientKey = (
  { a, A }: ClientEphemeral,
  B: string,
  salt: string,
  group: string,
  user: string,
  password: string,
): Buffer => {
  const bigB = bigFromHex(B);
  if (bigB % N === 0n) throw new Error("The server's B is not one SRP takes");
  const u = scramble(A, B);
  if (u === 0n) throw new Error("The exchange's u is not one SRP takes");
  const x = passwordExponent(group, user, password, salt);
  const base = bigB - k * modPow(g, x, N);
  const S = modPow(base, a + u * x, N);
  return derivedKey(S, u);
};

/**
 * The time as Cognito's claim takes it, e.g. "Tue Oct 21 15:08:35 UTC 2026",
 * in English and UTC, its day not padded.
 */
export const claimTime = (at: Date): string => {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${days[at.getUTCDay()] ?? ""} ${months[at.getUTCMonth()] ?? ""} ${String(at.getUTCDate())} ${two(
    at.getUTCHours(),
  )}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} UTC ${String(at.getUTCFullYear())}`;
};

/** The claim that proves the key: an HMAC of `group`, `user`, the secret block's bytes and the time, in base64. */
export const claimSignature = (key: Buffer, group: string, user: string, secretBlock: string, time: string): string =>
  createHmac("sha256", key)
    .update(
      Buffer.concat([
        Buffer.from(`${group}${user}`, "utf8"),
        Buffer.from(secretBlock, "base64"),
        Buffer.from(time, "utf8"),
      ]),
    )
    .digest("base64");

/**
 * What a device gives Cognito as it is confirmed, so that it can later sign
 * in as itself: its verifier and salt, in base64. `password` is the device's
 * own, made up for it, which only the device keeps.
 */
export const deviceVerifier = (
  groupKey: string,
  deviceKey: string,
  password: string,
): { readonly passwordVerifier: string; readonly salt: string } => {
  const salt = padHex(randomBytes(16).toString("hex"));
  const verifier = modPow(g, passwordExponent(groupKey, deviceKey, password, salt), N);
  return {
    passwordVerifier: Buffer.from(padHex(verifier), "hex").toString("base64"),
    salt: Buffer.from(salt, "hex").toString("base64"),
  };
};

/** A device's own password, made up as it is confirmed: 40 random bytes, in base64. */
export const devicePassword = (): string => randomBytes(40).toString("base64");

/** The server's half of an exchange, for the fake: its secret `b`, and `B`, which it sends, in hexadecimal. */
export interface ServerEphemeral {
  readonly b: bigint;
  readonly B: string;
}

/** The server's half, from the verifier it keeps, v = g^x. */
export const serverEphemeral = (verifier: bigint): ServerEphemeral => {
  for (;;) {
    const b = randomExponent();
    const B = (k * verifier + modPow(g, b, N)) % N;
    if (B !== 0n) return { b, B: B.toString(16) };
  }
};

/** The server's key, from the client's `A`, its own half and the verifier: what the client's must equal. */
export const serverKey = (A: string, { b, B }: ServerEphemeral, verifier: bigint): Buffer => {
  const bigA = bigFromHex(A);
  if (bigA % N === 0n) throw new Error("The client's A is not one SRP takes");
  const u = scramble(A, B);
  const S = modPow(bigA * modPow(verifier, u, N), b, N);
  return derivedKey(S, u);
};

/** The verifier for a password, as the server keeps it: v = g^x. */
export const verifierFor = (group: string, user: string, password: string, salt: string): bigint =>
  modPow(g, passwordExponent(group, user, password, salt), N);

/** The verifier a device gave as it was confirmed, from its base64. */
export const verifierFromBase64 = (passwordVerifier: string): bigint =>
  bigFromHex(Buffer.from(passwordVerifier, "base64").toString("hex"));
