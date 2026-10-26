import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DISCOVERY_REQUEST, encodeDiscoveryAnswer, isDiscoveryRequest, parseDiscoveryAnswer } from "./discovery.ts";
import {
  decodeV2Packet,
  decodeV3Packet,
  encodeV2Packet,
  encodeV3Packet,
  HandshakeRefused,
  handshakeAnswer,
  handshakeRefusal,
  handshakeRequest,
  NotAPacket,
  sessionFrom,
  V3_ENCRYPTED_REQUEST,
  V3_HANDSHAKE_REQUEST,
  v3KeysFrom,
} from "./lan-packets.ts";

const keys = () => ({ token: randomBytes(64), key: randomBytes(32) });

describe("Midea's v2 packets", () => {
  it("carry a frame to and from a unit by its id, signed", () => {
    const frame = Buffer.from([0xaa, 0x0e, 0xac, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const packet = encodeV2Packet(frame, 0x0123_4567_89ab);

    expect(packet.subarray(0, 2)).toEqual(Buffer.from([0x5a, 0x5a]));
    expect(packet.readUInt16LE(4)).toBe(packet.length);
    expect(decodeV2Packet(packet, { checkSignature: true })).toEqual({ unitId: 0x0123_4567_89ab, frame });

    const tampered = Buffer.from(packet);
    tampered[45] = (tampered[45] ?? 0) ^ 0xff;
    expect(() => decodeV2Packet(tampered, { checkSignature: true })).toThrow(NotAPacket);
  });
});

describe("Midea's v3 packets", () => {
  it("agree a session's key in the handshake, from the token and key", () => {
    const unit = keys();
    const request = decodeV3Packet(handshakeRequest(unit));
    expect(request).toMatchObject({ type: V3_HANDSHAKE_REQUEST, data: unit.token });

    const { packet, session } = handshakeAnswer(unit.key, request.count);
    const hub = sessionFrom(decodeV3Packet(packet), unit);

    expect(hub.key).toEqual(session.key);
    expect(hub.key).not.toEqual(unit.key);
  });

  it("refuse a handshake answered with what the key doesn't read, or with ERROR", () => {
    const unit = keys();
    const { packet } = handshakeAnswer(randomBytes(32), 0);

    expect(() => sessionFrom(decodeV3Packet(packet), unit)).toThrow(HandshakeRefused);
    expect(() => sessionFrom(decodeV3Packet(handshakeRefusal(0)), unit)).toThrow(HandshakeRefused);
  });

  it("encrypt and sign each message under the session's key, padded or not, with its counter", () => {
    const key = randomBytes(32);
    // 14 bytes and the counter fill a block exactly, which needs no padding.
    for (const length of [14, 1, 30, 72, 100]) {
      const data = randomBytes(length);
      const packet = encodeV3Packet(data, V3_ENCRYPTED_REQUEST, 7, key);

      expect(packet.readUInt16BE(2) + 8).toBe(packet.length);
      expect(decodeV3Packet(packet, key)).toEqual({ type: V3_ENCRYPTED_REQUEST, count: 7, data });
      expect(() => decodeV3Packet(packet, randomBytes(32))).toThrow(NotAPacket);
    }
  });

  it("take a token and key only as hex of the right lengths, without quoting them", () => {
    const token = randomBytes(64).toString("hex");
    const key = randomBytes(32).toString("hex");

    expect(v3KeysFrom(token, key).key.toString("hex")).toBe(key);
    for (const [badToken, badKey] of [
      [token.slice(2), key],
      [token, `${key}00`],
      [token, key.replace(/./, "z")],
    ] as const) {
      expect(() => v3KeysFrom(badToken, badKey)).toThrow(/is \d+ bytes, in hex$/);
      try {
        v3KeysFrom(badToken, badKey);
      } catch (error) {
        expect(String(error)).not.toContain(badToken.slice(0, 16));
        expect(String(error)).not.toContain(badKey.slice(0, 16));
      }
    }
  });
});

describe("Midea's discovery", () => {
  it("answers with a unit's id, serial number, name, type and version, v2 or v3", () => {
    expect(isDiscoveryRequest(DISCOVERY_REQUEST)).toBe(true);
    for (const version of [2, 3] as const) {
      const answer = {
        id: 0x0123_4567_89ab,
        ip: "192.168.1.40",
        port: 6444,
        serialNumber: "000000P0000000Q1F0C9A1B2C3D40000",
        name: "net_ac_89AB",
        type: 0xac,
        version,
      };
      expect(parseDiscoveryAnswer(encodeDiscoveryAnswer(answer))).toEqual(answer);
    }
    expect(parseDiscoveryAnswer(Buffer.from("hello"))).toBeUndefined();
  });
});
