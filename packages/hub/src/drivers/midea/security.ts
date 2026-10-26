/**
 * The cryptography of Midea's LAN protocol, as the open-source libraries
 * (msmart-ng, midea-local, midea-beautiful-air) implement it. Only the Midea
 * Driver and the fake Midea Air Conditioner know it (NFR-6). Nothing here
 * logs, and nothing it throws quotes a token, a key or what they encrypt
 * (FR-51).
 */
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

/**
 * The key every Midea app signs its v2 packets with, which the open-source
 * libraries publish. Its MD5 is the AES key of the v2 frames and of the
 * answers to discovery.
 */
const SIGN_KEY = Buffer.from("xhdiwjnchekd4d512chdjx5d8e4c394D2D7S", "ascii");

/** The AES-128 key of the v2 frames and of discovery's answers. */
const APP_KEY = createHash("md5").update(SIGN_KEY).digest();

/** A v3 unit's token is 64 bytes, and its key 32, which the cloud gives as hex. */
export const V3_TOKEN_LENGTH = 64;
export const V3_KEY_LENGTH = 32;

/** Encrypts a frame as a v2 packet carries it: AES-128-ECB under the app key, PKCS #7 padded. */
export const encryptFrame = (data: Uint8Array): Buffer => {
  const cipher = createCipheriv("aes-128-ecb", APP_KEY, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

/** Decrypts what {@link encryptFrame} encrypted. Throws if it isn't that. */
export const decryptFrame = (data: Uint8Array): Buffer => {
  const decipher = createDecipheriv("aes-128-ecb", APP_KEY, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
};

/** The 16 bytes that end a v2 packet: the MD5 of the packet before them and the sign key. */
export const signPacket = (data: Uint8Array): Buffer => createHash("md5").update(data).update(SIGN_KEY).digest();

/**
 * AES-256-CBC with a zero IV and no padding, as v3 encrypts its handshake
 * and its messages, under the unit's key and then the session's key.
 */
export const encryptCbc = (data: Uint8Array, key: Uint8Array): Buffer => {
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16)).setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

export const decryptCbc = (data: Uint8Array, key: Uint8Array): Buffer => {
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16)).setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
};

export const sha256 = (...parts: readonly Uint8Array[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** Whether two signatures are the same, without saying where they differ. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

export const xor = (a: Uint8Array, b: Uint8Array): Buffer =>
  Buffer.from(a.map((byte, index) => byte ^ (b[index] ?? 0)));

/** The CRC-8 (Dallas/Maxim) that ends a frame's body. */
export const crc8 = (data: Uint8Array): number => {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
  }
  return crc;
};
