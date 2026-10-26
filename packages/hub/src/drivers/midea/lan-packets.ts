/**
 * The packets Midea's Air Conditioners exchange on TCP port 6444, as the
 * open-source libraries (msmart-ng, midea-local, midea-beautiful-air) write
 * them. Only the Midea Driver and the fake Midea Air Conditioner know them
 * (NFR-6).
 *
 * On protocol v2 each frame of `frames.ts` travels in a packet that starts
 * `5a5a`: a 40-byte header with the unit's id, the frame encrypted with
 * AES-ECB under the app key, and an MD5 signature.
 *
 * On protocol v3 the same `5a5a` packets travel inside packets that start
 * `8370`, encrypted with AES-CBC under a key that the connection's handshake
 * agrees: the Hub sends the unit's token, and the unit answers with 32
 * random bytes encrypted under the unit's key, and their SHA-256. The
 * session's key is those bytes XORed with the unit's key. Each packet after
 * that carries a counter, which rises with each packet each way, and its
 * SHA-256, so a unit that answers with the wrong key, or a Hub with the
 * wrong one, fails at once.
 */
import { randomBytes } from "node:crypto";

import {
  decryptCbc,
  decryptFrame,
  encryptCbc,
  encryptFrame,
  V3_KEY_LENGTH,
  sameBytes,
  sha256,
  signPacket,
  V3_TOKEN_LENGTH,
  xor,
} from "./security.ts";

/** The TCP port every Midea Air Conditioner takes commands on. */
export const MIDEA_LAN_PORT = 6444;

const V2_START = [0x5a, 0x5a] as const;
const V2_HEADER_LENGTH = 40;
const V2_SIGNATURE_LENGTH = 16;

const V3_START = [0x83, 0x70] as const;
const V3_HEADER_LENGTH = 6;
const V3_SIGNATURE_LENGTH = 32;

/** What a v3 packet is, in the low nibble of its sixth byte. */
export const V3_HANDSHAKE_REQUEST = 0x0;
export const V3_HANDSHAKE_ANSWER = 0x1;
export const V3_ENCRYPTED_ANSWER = 0x3;
export const V3_ENCRYPTED_REQUEST = 0x6;

/** What a unit answers a token it doesn't know with, in place of its handshake. */
export const HANDSHAKE_REFUSED = Buffer.from("ERROR", "ascii");

/** A packet that isn't one, or whose signature doesn't add up. Its message never quotes what it carried. */
export class NotAPacket extends Error {
  constructor(why: string, options?: ErrorOptions) {
    super(`Not a Midea packet: ${why}`, options);
    this.name = "NotAPacket";
  }
}

/** The handshake's answer couldn't be read with the key the Hub has, or the unit refused its token. */
export class HandshakeRefused extends Error {
  constructor(why: string) {
    super(why);
    this.name = "HandshakeRefused";
  }
}

const startsWith = (data: Uint8Array, start: readonly [number, number]): boolean =>
  data[0] === start[0] && data[1] === start[1];

export const isV2Packet = (data: Uint8Array): boolean => startsWith(data, V2_START);
export const isV3Packet = (data: Uint8Array): boolean => startsWith(data, V3_START);

/**
 * The time as a v2 header carries it, hundredths of a second first, each
 * pair of decimal digits a byte, as msmart writes it. No unit is known to
 * read it.
 */
const packetTime = (now: Date): Buffer => {
  const digits = [
    now.getFullYear() % 100,
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    Math.floor(now.getMilliseconds() / 10),
  ];
  return Buffer.from([...digits.reverse(), Math.floor(now.getFullYear() / 100)]);
};

/**
 * A v2 packet carrying `frame` to or from the unit with this id, which is 6
 * bytes, low byte first. A unit's answers have `0x10` where requests have
 * `0x11` in the header's fourth byte, as far as midea-local says.
 */
export const encodeV2Packet = (frame: Uint8Array, unitId: number, from: "hub" | "unit" = "hub"): Buffer => {
  const encrypted = encryptFrame(frame);
  const header = Buffer.alloc(V2_HEADER_LENGTH);
  header[0] = V2_START[0];
  header[1] = V2_START[1];
  header[2] = 0x01;
  header[3] = from === "hub" ? 0x11 : 0x10;
  header.writeUInt16LE(V2_HEADER_LENGTH + encrypted.length + V2_SIGNATURE_LENGTH, 4);
  header[6] = 0x20;
  packetTime(new Date()).copy(header, 12);
  header.writeUIntLE(unitId, 20, 6);
  const unsigned = Buffer.concat([header, encrypted]);
  return Buffer.concat([unsigned, signPacket(unsigned)]);
};

/** How long the v2 packet at the start of `data` is, or undefined until its length has arrived. */
export const v2PacketLength = (data: Uint8Array): number | undefined =>
  data.length < 6 ? undefined : Buffer.from(data.buffer, data.byteOffset, data.byteLength).readUInt16LE(4);

export interface V2Packet {
  readonly unitId: number;
  readonly frame: Buffer;
}

/**
 * Reads a v2 packet. The fake checks its signature, as a unit would be
 * expected to; the Driver doesn't, as no library says a unit signs its answers
 * the same way.
 */
export const decodeV2Packet = (packet: Uint8Array, { checkSignature = false } = {}): V2Packet => {
  if (!isV2Packet(packet)) throw new NotAPacket("wrong start");
  const length = v2PacketLength(packet) ?? 0;
  if (length < V2_HEADER_LENGTH + V2_SIGNATURE_LENGTH || length > packet.length) {
    throw new NotAPacket("wrong length");
  }
  const whole = Buffer.from(packet.subarray(0, length));
  if (
    checkSignature &&
    !sameBytes(signPacket(whole.subarray(0, -V2_SIGNATURE_LENGTH)), whole.subarray(-V2_SIGNATURE_LENGTH))
  ) {
    throw new NotAPacket("wrong signature");
  }
  try {
    return {
      unitId: whole.readUIntLE(20, 6),
      frame: decryptFrame(whole.subarray(V2_HEADER_LENGTH, -V2_SIGNATURE_LENGTH)),
    };
  } catch (error) {
    throw new NotAPacket("it can't be decrypted", { cause: error });
  }
};

/** How long the v3 packet at the start of `data` is, or undefined until its length has arrived. */
export const v3PacketLength = (data: Uint8Array): number | undefined =>
  data.length < 4 ? undefined : Buffer.from(data.buffer, data.byteOffset, data.byteLength).readUInt16BE(2) + 8;

/** One end of a v3 connection: the key its handshake agreed, and its counter of the packets it has sent. */
export interface V3Session {
  readonly key: Buffer;
  /** The counter the next packet this end sends carries, which rises by one with each. */
  sent: number;
}

const isEncrypted = (type: number): boolean => type === V3_ENCRYPTED_ANSWER || type === V3_ENCRYPTED_REQUEST;

/**
 * A v3 packet of `type` carrying `data`, with the counter `count`, encrypted
 * under the session's key where it is a request or an answer. The size in
 * its header counts what follows the counter: the data, its padding and its
 * signature. (midea-beautiful-air adds the signature's 32 only where it pads,
 * which leaves an unpadded packet's size short; this always adds it.)
 */
export const encodeV3Packet = (data: Uint8Array, type: number, count: number, key?: Uint8Array): Buffer => {
  const encrypted = isEncrypted(type);
  // The counter and the data are padded to whole AES blocks with random bytes.
  const padding = encrypted ? (16 - ((data.length + 2) % 16)) % 16 : 0;
  const size = data.length + (encrypted ? padding + V3_SIGNATURE_LENGTH : 0);
  const header = Buffer.from([V3_START[0], V3_START[1], size >> 8, size & 0xff, 0x20, (padding << 4) | type]);
  const counted = Buffer.concat([Buffer.of((count >> 8) & 0xff, count & 0xff), data, randomBytes(padding)]);
  if (!encrypted) return Buffer.concat([header, counted]);
  if (key === undefined) throw new Error("An encrypted v3 packet needs the session's key");
  return Buffer.concat([header, encryptCbc(counted, key), sha256(header, counted)]);
};

export interface V3Packet {
  readonly type: number;
  readonly count: number;
  readonly data: Buffer;
}

/** Reads a v3 packet, decrypting it with the session's key where it is encrypted, and checking its signature. */
export const decodeV3Packet = (packet: Uint8Array, key?: Uint8Array): V3Packet => {
  if (!isV3Packet(packet)) throw new NotAPacket("wrong start");
  const length = v3PacketLength(packet) ?? 0;
  if (length > packet.length || packet[4] !== 0x20) throw new NotAPacket("wrong length");
  const header = packet.subarray(0, V3_HEADER_LENGTH);
  const type = (header[5] ?? 0) & 0x0f;
  const padding = (header[5] ?? 0) >> 4;
  let counted: Buffer = Buffer.from(packet.subarray(V3_HEADER_LENGTH, length));
  if (isEncrypted(type)) {
    if (key === undefined) throw new NotAPacket("it is encrypted, and no handshake has been made");
    const signature = counted.subarray(-V3_SIGNATURE_LENGTH);
    const encrypted = counted.subarray(0, -V3_SIGNATURE_LENGTH);
    if (encrypted.length === 0 || encrypted.length % 16 !== 0) throw new NotAPacket("wrong length");
    counted = decryptCbc(encrypted, key);
    if (!sameBytes(sha256(header, counted), signature)) throw new NotAPacket("wrong signature");
    counted = counted.subarray(0, counted.length - padding);
  }
  if (counted.length < 2) throw new NotAPacket("too short");
  return { type, count: counted.readUInt16BE(0), data: Buffer.from(counted.subarray(2)) };
};

/** The token and key of a v3 unit, as bytes. */
export interface V3Keys {
  readonly token: Buffer;
  readonly key: Buffer;
}

/** The Hub's half of the handshake: the unit's token. */
export const handshakeRequest = (keys: V3Keys): Buffer => encodeV3Packet(keys.token, V3_HANDSHAKE_REQUEST, 0);

/**
 * The unit's half, for a token it knows: 32 random bytes encrypted under its
 * key, then their SHA-256. It keeps the session that results.
 */
export const handshakeAnswer = (key: Uint8Array, count: number): { packet: Buffer; session: V3Session } => {
  const random = randomBytes(32);
  return {
    packet: encodeV3Packet(Buffer.concat([encryptCbc(random, key), sha256(random)]), V3_HANDSHAKE_ANSWER, count),
    session: { key: xor(random, key), sent: 0 },
  };
};

/** The unit's answer to a token it doesn't know, as far as msmart-ng says. */
export const handshakeRefusal = (count: number): Buffer =>
  encodeV3Packet(HANDSHAKE_REFUSED, V3_HANDSHAKE_ANSWER, count);

/**
 * The session the handshake agreed, from the unit's answer to it. Throws a
 * {@link HandshakeRefused} if the unit refused the token, or answered with
 * what the key doesn't decrypt to bytes matching their signature, as a wrong
 * key does.
 */
export const sessionFrom = (answer: V3Packet, keys: V3Keys): V3Session => {
  if (answer.data.subarray(0, HANDSHAKE_REFUSED.length).equals(HANDSHAKE_REFUSED)) {
    throw new HandshakeRefused("The unit refused the token");
  }
  if (answer.type !== V3_HANDSHAKE_ANSWER || answer.data.length !== 64) {
    throw new HandshakeRefused("The unit's answer to the handshake isn't one");
  }
  const random = decryptCbc(answer.data.subarray(0, 32), keys.key);
  if (!sameBytes(sha256(random), answer.data.subarray(32))) {
    throw new HandshakeRefused("The unit's answer to the handshake doesn't match the key");
  }
  return { key: xor(random, keys.key), sent: 0 };
};

/** Reads a v3 unit's token and key from hex, as the cloud gives them. Throws, without quoting them, if they aren't. */
export const v3KeysFrom = (token: string, key: string): V3Keys => {
  const bytes = (hex: string, length: number, what: string): Buffer => {
    if (!new RegExp(`^[0-9a-fA-F]{${String(length * 2)}}$`).test(hex)) {
      throw new Error(`A v3 unit's ${what} is ${String(length)} bytes, in hex`);
    }
    return Buffer.from(hex, "hex");
  };
  return { token: bytes(token, V3_TOKEN_LENGTH, "token"), key: bytes(key, V3_KEY_LENGTH, "key") };
};
