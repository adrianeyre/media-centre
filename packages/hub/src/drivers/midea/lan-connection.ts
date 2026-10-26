/**
 * One connection from the Midea Driver to a unit on TCP port 6444: it
 * connects, makes v3's handshake where the unit is on v3, then sends frames
 * and waits for the unit's answer to each, skipping anything else the unit
 * sends meanwhile, such as the reports some units send of themselves. Only
 * the Driver knows this (NFR-6). Nothing here logs, and nothing it throws
 * quotes a token, a key or what they encrypt (FR-51).
 */
import { Socket } from "node:net";

import { buildFrame, parseFrame } from "./frames.ts";
import {
  decodeV2Packet,
  decodeV3Packet,
  encodeV2Packet,
  encodeV3Packet,
  HANDSHAKE_REFUSED,
  handshakeRequest,
  isV2Packet,
  isV3Packet,
  sessionFrom,
  v2PacketLength,
  v3PacketLength,
  V3_ENCRYPTED_ANSWER,
  V3_ENCRYPTED_REQUEST,
  type V3Keys,
  type V3Session,
} from "./lan-packets.ts";

/** A unit to connect to: on v2 by its id alone, on v3 with its token and key too. */
export interface LanUnit {
  readonly address: string;
  readonly port: number;
  readonly id: number;
  readonly keys?: V3Keys;
}

export interface LanTimeouts {
  /** How long the unit has to accept the connection. */
  readonly connectMs: number;
  /** How long it has to answer the handshake, and each frame. */
  readonly answerMs: number;
}

/** Nothing accepted a connection at the unit's address: it is switched off, or not there. */
export class UnitUnreachable extends Error {
  constructor(options?: ErrorOptions) {
    super("Nothing accepted a connection", options);
    this.name = "UnitUnreachable";
  }
}

/** The unit accepted the connection but didn't answer, or closed it. */
export class UnitSilent extends Error {
  constructor(why: string) {
    super(why);
    this.name = "UnitSilent";
  }
}

export interface LanConnection {
  /**
   * Sends `body` in a frame of `type`, and resolves with the body of the first
   * frame the unit answers with that `isAnswer` says is the answer to it.
   */
  readonly ask: (body: Uint8Array, type: number, isAnswer: (answer: Buffer) => boolean) => Promise<Buffer>;
  readonly close: () => void;
}

/** v3 counters go no higher than this, then start again from 0, as midea-beautiful-air counts. */
const COUNTER_LIMIT = 0xfff;

/**
 * Splits what a unit sends into its packets, whichever version they are, and
 * hands them out one at a time. A unit refusing a token sends "ERROR", in a
 * v3 packet or, as some say, alone, which is handed out alone too.
 */
const packetReader = (socket: Socket) => {
  let buffered = Buffer.alloc(0);
  const packets: Buffer[] = [];
  let waiting: { resolve: (packet: Buffer) => void; reject: (error: Error) => void } | undefined;
  let ended: Error | undefined;

  const split = (): void => {
    for (;;) {
      const refusal = HANDSHAKE_REFUSED.subarray(0, buffered.length);
      if (buffered.length > 0 && buffered.subarray(0, refusal.length).equals(refusal)) {
        // All of "ERROR", or the start of it, still arriving.
        if (refusal.length < HANDSHAKE_REFUSED.length) return;
        packets.push(HANDSHAKE_REFUSED);
        buffered = buffered.subarray(HANDSHAKE_REFUSED.length);
        continue;
      }
      const length = isV3Packet(buffered)
        ? v3PacketLength(buffered)
        : isV2Packet(buffered)
          ? v2PacketLength(buffered)
          : buffered.length > 1
            ? -1
            : undefined;
      // What isn't a packet can't be found the end of, so it is all dropped.
      if (length === -1) buffered = Buffer.alloc(0);
      if (length === undefined || length === -1 || length > buffered.length) return;
      packets.push(Buffer.from(buffered.subarray(0, length)));
      buffered = buffered.subarray(length);
    }
  };
  const hand = (): void => {
    if (waiting === undefined) return;
    const packet = packets.shift();
    if (packet !== undefined) waiting.resolve(packet);
    else if (ended !== undefined) waiting.reject(ended);
    else return;
    waiting = undefined;
  };

  socket.on("data", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    split();
    hand();
  });
  socket.on("close", () => {
    ended = new UnitSilent("The unit closed the connection");
    hand();
  });

  return {
    next: (timeoutMs: number): Promise<Buffer> =>
      new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined;
          reject(new UnitSilent("The unit didn't answer"));
        }, timeoutMs);
        waiting = {
          resolve: (packet) => {
            clearTimeout(timer);
            resolve(packet);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        hand();
      }),
  };
};

const openSocket = (address: string, port: number, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new UnitUnreachable());
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new UnitUnreachable({ cause: error }));
    });
    socket.connect(port, address, () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      // Errors after connecting end the connection, which the reader hears as its close.
      socket.on("error", () => undefined);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });

/**
 * Connects to the unit, and on v3 makes the handshake. Rejects with a
 * {@link UnitUnreachable} when nothing accepts the connection, a
 * {@link UnitSilent} when the unit doesn't answer the handshake, and a
 * `HandshakeRefused` when it refuses the token or answers with what the key
 * doesn't read. A unit that closes the connection on a token it doesn't
 * know, as some may, is silent: nothing says it was the token.
 */
export const connectToUnit = async (unit: LanUnit, timeouts: LanTimeouts): Promise<LanConnection> => {
  const socket = await openSocket(unit.address, unit.port, timeouts.connectMs);
  const reader = packetReader(socket);
  let session: V3Session | undefined;
  try {
    if (unit.keys !== undefined) {
      socket.write(handshakeRequest(unit.keys));
      const answer = await reader.next(timeouts.answerMs);
      session = sessionFrom(
        answer.equals(HANDSHAKE_REFUSED) ? { type: 0, count: 0, data: answer } : decodeV3Packet(answer),
        unit.keys,
      );
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }

  const send = (frame: Buffer): void => {
    const packet = encodeV2Packet(frame, unit.id);
    if (session === undefined) {
      socket.write(packet);
      return;
    }
    socket.write(encodeV3Packet(packet, V3_ENCRYPTED_REQUEST, session.sent, session.key));
    session.sent = session.sent + 1 >= COUNTER_LIMIT ? 0 : session.sent + 1;
  };

  /** The frames in a packet from the unit, or none where it isn't an answer to the Hub. */
  const framesIn = (packet: Buffer): Buffer[] => {
    let inner = packet;
    if (session !== undefined) {
      const decoded = decodeV3Packet(packet, session.key);
      if (decoded.type !== V3_ENCRYPTED_ANSWER) return [];
      inner = decoded.data;
    }
    // A v3 packet may carry more than one v2 packet, as midea-local reads it.
    const frames: Buffer[] = [];
    while (isV2Packet(inner)) {
      const length = v2PacketLength(inner) ?? inner.length;
      frames.push(decodeV2Packet(inner).frame);
      inner = inner.subarray(length);
    }
    return frames;
  };

  return {
    ask: async (body, type, isAnswer) => {
      send(buildFrame(body, type));
      const deadline = Date.now() + timeouts.answerMs;
      for (;;) {
        const packet = await reader.next(Math.max(0, deadline - Date.now()));
        for (const frame of framesIn(packet)) {
          const answer = parseFrame(frame).body;
          if (isAnswer(answer)) return answer;
        }
      }
    },
    close: () => {
      socket.destroy();
    },
  };
};
