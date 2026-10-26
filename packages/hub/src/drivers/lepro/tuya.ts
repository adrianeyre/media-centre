/**
 * Tuya's local protocol, v3.3, which the Lepro Driver reaches Lepro's Lights
 * by, on the reading that they are Tuya modules inside (Lights PRD, open
 * question 1). It is the Driver's one {@link LightTransport}: everything the
 * Driver knows of the protocol is here, and only this module and the fake
 * Lepro Light know it (NFR-6). If the spike (#48) finds Lepro's Lights speak
 * something else, this module and the fake are what change.
 *
 * - **Connections** are TCP, on port 6668, one at a time, as a Tuya module is
 *   known to take only one.
 * - **Frames** start `000055aa`, then a sequence number, a command and a
 *   length, each 4 bytes, big-endian; the Light's own frames then have a
 *   4-byte return code; then the payload, a CRC-32 of everything before it,
 *   and `0000aa55`.
 * - **Payloads** are JSON, encrypted with AES-128-ECB, PKCS #7 padded, under
 *   the Light's local key, 16 characters that Tuya's cloud issues it as it is
 *   paired in its app. A command that changes something, and the Light's own
 *   reports of its state, have "3.3" and 12 zero bytes before that.
 * - **Data points** are what a Light has, each by its number: `20` on/off,
 *   `21` its mode (`white` or `colour`), `22` brightness from 10 to 1000,
 *   `23` colour temperature from 0, the warmest, to 1000, `24` colour as 12
 *   hex digits of hue (0 to 360), saturation and value (each 0 to 1000). A
 *   plug has `1`, on/off, alone, or `20` alone.
 * - **Discovery** is each module announcing itself, unasked, as a UDP
 *   broadcast: on port 6667 encrypted under a key every Tuya app knows, and
 *   on 6666 in plain JSON, by older modules.
 *
 * This is written from what the open-source libraries that speak it (tinytuya,
 * tuyapi, localtuya) say, before anyone has looked at a Lepro Light. Each
 * detail they are unsure of, or a Lepro Light may do otherwise, is marked
 * "Uncertain" where it is; a real Light corrects it in the fake first, then
 * here. Nothing here logs, but for what a search notes to the Driver, and
 * nothing it notes or throws quotes a Light's id or key, nor what the key
 * encrypts (FR-4).
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket as UdpSocket } from "node:dgram";
import { isIP, Socket } from "node:net";
import { crc32 } from "node:zlib";

import {
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_BRIGHTNESS_MIN,
  type ColourTemperatureRange,
  type LightCapabilities,
  type LightChange,
  type LightColour,
  type LightState,
} from "@media-centre/shared";

import {
  LightRefusedKeys,
  LightSilent,
  LightUnreachable,
  NotALight,
  type HeardLight,
  type LightAt,
  type LightKeys,
  type LightReport,
  type LightSession,
  type LightTransport,
  type SearchTarget,
} from "./transport.ts";

/** Where a Tuya module takes connections. */
export const TUYA_PORT = 6668;

/**
 * Where Tuya modules announce themselves: 6666 in plain JSON, 6667 encrypted,
 * and 7000 by modules on v3.5, which the Hub doesn't speak, so listens on
 * only to say so in its log.
 */
export const TUYA_DISCOVERY_PORTS: readonly number[] = [6666, 6667, 7000];

const PREFIX = 0x0000_55aa;
/** How a frame of Tuya's v3.5 starts, which the Hub doesn't speak. */
const PREFIX_V35 = 0x0000_6699;
const SUFFIX = 0x0000_aa55;

/** The commands a frame carries, by Tuya's numbers for them. */
export const TUYA_COMMAND = {
  /** An announcement in plain JSON, on 6666. */
  announcePlain: 0x00,
  /** Sets data points. */
  control: 0x07,
  /** The Light's report of data points that changed, which it sends unasked. */
  status: 0x08,
  heartbeat: 0x09,
  /** Asks for every data point. */
  query: 0x0a,
  /** An announcement encrypted under {@link UDP_KEY}, on 6667. */
  announce: 0x13,
} as const;

/**
 * The payloads that have the version and 12 zero bytes before them. Uncertain:
 * tinytuya leaves them off the query and the heartbeat only, and reads a
 * Light's answers with or without them, as {@link decodeMessage} does.
 */
const WITH_VERSION: ReadonlySet<number> = new Set([TUYA_COMMAND.control, TUYA_COMMAND.status]);

const VERSION = "3.3";
/** What a Light reached by this protocol is, for the person. */
const MODEL = `Lepro, protocol v${VERSION}`;
const VERSION_HEADER = Buffer.concat([Buffer.from(VERSION, "ascii"), Buffer.alloc(12)]);

/** The key of the announcements on 6667: the MD5 of a string every Tuya app has, which the libraries publish. */
const UDP_KEY = createHash("md5").update("yGAdlopoPVldABfn", "ascii").digest();

/** The most a frame's length may say, beyond which what arrives isn't Tuya's. */
const LENGTH_LIMIT = 0x1_0000;

/** What isn't one of Tuya's frames. */
export class NotAFrame extends Error {
  constructor(why: string) {
    super(why);
    this.name = "NotAFrame";
  }
}

/** A payload the key doesn't decrypt, or that isn't JSON once it does. Says nothing of what it held. */
export class Unreadable extends Error {
  constructor() {
    super("The payload doesn't read with that key");
    this.name = "Unreadable";
  }
}

export interface Frame {
  readonly seq: number;
  readonly command: number;
  /** In the Light's frames only: 0 when it took what it was sent. */
  readonly retcode?: number;
  readonly payload: Buffer;
}

const uint32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};

export const encodeFrame = ({ seq, command, retcode, payload }: Frame): Buffer => {
  const body = retcode === undefined ? payload : Buffer.concat([uint32(retcode), payload]);
  const header = Buffer.concat([uint32(PREFIX), uint32(seq), uint32(command), uint32(body.length + 8)]);
  const framed = Buffer.concat([header, body]);
  return Buffer.concat([framed, uint32(crc32(framed)), uint32(SUFFIX)]);
};

/**
 * How long the frame at the start of `buffered` is, or undefined while too
 * little of it has arrived to say. Throws {@link NotAFrame} for what doesn't
 * start as one.
 */
export const frameLength = (buffered: Uint8Array): number | undefined => {
  const bytes = Buffer.from(buffered.buffer, buffered.byteOffset, buffered.byteLength);
  const start = uint32(PREFIX).subarray(0, Math.min(4, bytes.length));
  if (!bytes.subarray(0, start.length).equals(start)) throw new NotAFrame("Not a Tuya frame");
  if (bytes.length < 16) return undefined;
  const length = bytes.readUInt32BE(12);
  if (length < 8 || length > LENGTH_LIMIT) throw new NotAFrame("A Tuya frame of no possible length");
  return 16 + length;
};

/** Reads one whole frame, a Light's when `fromLight`, with its return code. Throws {@link NotAFrame}. */
export const decodeFrame = (packet: Uint8Array, { fromLight }: { readonly fromLight: boolean }): Frame => {
  const bytes = Buffer.from(packet);
  if (frameLength(bytes) !== bytes.length) throw new NotAFrame("Not one whole Tuya frame");
  if (bytes.readUInt32BE(bytes.length - 4) !== SUFFIX) throw new NotAFrame("A Tuya frame without its end");
  if (bytes.readUInt32BE(bytes.length - 8) !== crc32(bytes.subarray(0, bytes.length - 8)) >>> 0) {
    throw new NotAFrame("A Tuya frame whose CRC is wrong");
  }
  const body = bytes.subarray(16, bytes.length - 8);
  if (fromLight && body.length < 4) throw new NotAFrame("A Light's frame without its return code");
  return {
    seq: bytes.readUInt32BE(4),
    command: bytes.readUInt32BE(8),
    ...(fromLight ? { retcode: body.readUInt32BE(0) } : {}),
    payload: Buffer.from(fromLight ? body.subarray(4) : body),
  };
};

const encrypt = (key: Uint8Array, data: Uint8Array): Buffer => {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

/** Decrypts, or throws {@link Unreadable} with no cause, which could hold what was decrypted. */
const decrypt = (key: Uint8Array, data: Uint8Array): Buffer => {
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Unreadable();
  }
};

/** A JSON object, or {@link Unreadable} with no cause, as a parse error quotes what it couldn't parse. */
const objectIn = (text: string): Record<string, unknown> => {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    throw new Unreadable();
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) throw new Unreadable();
  return read as Record<string, unknown>;
};

/** A Light's local key, as the AES key it is. */
const keyBytes = (key: string): Buffer => Buffer.from(key, "latin1");

/** The payload of a frame of `command`, `message` encrypted under the Light's local key. */
export const encodeMessage = (key: string, command: number, message: unknown): Buffer => {
  const encrypted = encrypt(keyBytes(key), Buffer.from(JSON.stringify(message), "utf8"));
  return WITH_VERSION.has(command) ? Buffer.concat([VERSION_HEADER, encrypted]) : encrypted;
};

/**
 * What a payload says, decrypted under the Light's local key, whichever way
 * it starts, or undefined when it is empty, as an acknowledgement is.
 * Throws {@link Unreadable}.
 */
export const decodeMessage = (key: string, payload: Uint8Array): Record<string, unknown> | undefined => {
  let encrypted = Buffer.from(payload);
  if (encrypted.subarray(0, 3).toString("latin1") === VERSION) encrypted = encrypted.subarray(VERSION_HEADER.length);
  if (encrypted.length === 0) return undefined;
  return objectIn(decrypt(keyBytes(key), encrypted).toString("utf8"));
};

/** Tuya's clock, in whole seconds, as text. */
const now = (): string => String(Math.floor(Date.now() / 1_000));

/** What a query says: the Light's id, three times over, as tinytuya sends it. */
export const queryMessage = (id: string) => ({ gwId: id, devId: id, uid: id, t: now() });

/** What a control says: the data points to set. */
export const controlMessage = (id: string, dps: DataPoints) => ({ devId: id, uid: id, t: now(), dps });

/** A Light's data points, by their numbers as text, as its JSON has them. */
export type DataPoints = Readonly<Record<string, boolean | number | string>>;

/** The data points in a message, or undefined where it has none. Others than true/false, numbers and text are left out. */
export const dataPointsIn = (message: Record<string, unknown> | undefined): DataPoints | undefined => {
  const dps = message?.dps;
  if (typeof dps !== "object" || dps === null || Array.isArray(dps)) return undefined;
  return Object.fromEntries(
    Object.entries(dps as Record<string, unknown>).filter(
      (entry): entry is [string, boolean | number | string] =>
        typeof entry[1] === "boolean" || typeof entry[1] === "number" || typeof entry[1] === "string",
    ),
  );
};

/** Whether `id` and `key` are as Tuya has them: an id of letters and digits, and a key of 16 printable characters. */
export const areTuyaKeys = (keys: { readonly id: unknown; readonly key: unknown }): keys is LightKeys =>
  typeof keys.id === "string" &&
  /^[A-Za-z0-9]{1,64}$/.test(keys.id) &&
  typeof keys.key === "string" &&
  /^[\x21-\x7e]{16}$/.test(keys.key);

/** The data points a Light has, by their numbers. */
export const DATA_POINT = {
  /** On/off, a plug's, which has no other a Light needs. */
  plugSwitch: "1",
  /** On/off. */
  switch: "20",
  /** What it shows: `white`, `colour`, or one of its maker's app's effects, `scene` or `music`. */
  mode: "21",
  /** Brightness in white, from {@link BRIGHTNESS_SCALE}'s `min` to its `max`. */
  brightness: "22",
  /** Colour temperature, from 0, the warmest, to {@link TEMPERATURE_SCALE}. */
  temperature: "23",
  /** Colour, as {@link colourText} writes it. */
  colour: "24",
} as const;

export const BRIGHTNESS_SCALE = { min: 10, max: 1_000 } as const;
export const TEMPERATURE_SCALE = 1_000;
/** The most a colour's saturation and value go to; its hue goes to 360. */
export const COLOUR_SCALE = 1_000;

/**
 * The colour temperatures a Light's 0 to 1000 stand for. Uncertain: a Tuya
 * module doesn't say on the home network, only to its maker's cloud, so this
 * is what Lepro's white-and-colour Lights are sold as; a real one may differ.
 */
export const COLOUR_TEMPERATURES: ColourTemperatureRange = { min: 2_700, max: 6_500 };

/** A colour as data point 24 has it: hue, saturation and value, each as 4 hex digits. */
export const colourText = ({ hue, saturation, value }: { hue: number; saturation: number; value: number }): string =>
  [hue, saturation, value].map((each) => Math.round(each).toString(16).padStart(4, "0")).join("");

/** What {@link colourText} wrote, or undefined for what it can't have. */
export const colourFrom = (text: string): { hue: number; saturation: number; value: number } | undefined => {
  if (!/^[0-9a-fA-F]{12}$/.test(text)) return undefined;
  const [hue = 0, saturation = 0, value = 0] = [0, 4, 8].map((at) => Number.parseInt(text.slice(at, at + 4), 16));
  if (hue > 360 || saturation > COLOUR_SCALE || value > COLOUR_SCALE) return undefined;
  return { hue, saturation, value };
};

/** Which data point switches it: `20` where it is on/off, and a plug's `1` otherwise. */
const switchOf = (dps: DataPoints): string | undefined => {
  // A plug that measures what it supplies has 18 to 26 as readings, 20 its
  // voltage, a number, so 20 is on/off only where it is true or false.
  if (typeof dps[DATA_POINT.switch] === "boolean") return DATA_POINT.switch;
  if (typeof dps[DATA_POINT.plugSwitch] === "boolean") return DATA_POINT.plugSwitch;
  return undefined;
};

/**
 * The controls a Light has, by which of its data points it reports.
 * Throws {@link NotALight} for one with no on/off. Uncertain: older Tuya
 * Lights have theirs on data points 1 to 5, with other scales, which this
 * reads as on/off alone.
 */
export const capabilitiesFrom = (dps: DataPoints): LightCapabilities => {
  const power = switchOf(dps);
  if (power === undefined) throw new NotALight("Reports no on/off");
  if (power === DATA_POINT.plugSwitch) {
    return { onOff: true, brightness: false, colourTemperature: null, colour: false };
  }
  return {
    onOff: true,
    brightness: typeof dps[DATA_POINT.brightness] === "number",
    colourTemperature: typeof dps[DATA_POINT.temperature] === "number" ? COLOUR_TEMPERATURES : null,
    colour: typeof dps[DATA_POINT.colour] === "string" && typeof dps[DATA_POINT.mode] === "string",
  };
};

const percentOf = (value: number, max: number): number =>
  Math.min(LIGHT_BRIGHTNESS_MAX, Math.max(LIGHT_BRIGHTNESS_MIN, Math.round((value / max) * LIGHT_BRIGHTNESS_MAX)));

const kelvinOf = (value: number, range: ColourTemperatureRange): number =>
  Math.round(
    range.min + (Math.min(TEMPERATURE_SCALE, Math.max(0, value)) / TEMPERATURE_SCALE) * (range.max - range.min),
  );

const temperatureOf = (kelvin: number, range: ColourTemperatureRange): number =>
  Math.round(((kelvin - range.min) / (range.max - range.min)) * TEMPERATURE_SCALE);

/** What a Light with these capabilities is doing, by its data points. */
export const stateFrom = (dps: DataPoints, capabilities: LightCapabilities): LightState => {
  const on = dps[switchOf(dps) ?? DATA_POINT.switch] === true;
  const mode = dps[DATA_POINT.mode];
  const white = typeof dps[DATA_POINT.brightness] === "number" ? (dps[DATA_POINT.brightness] as number) : undefined;
  const brightness = capabilities.brightness && white !== undefined ? percentOf(white, BRIGHTNESS_SCALE.max) : null;
  if (capabilities.colour && mode === "colour") {
    const colour = colourFrom(String(dps[DATA_POINT.colour]));
    if (colour !== undefined) {
      return {
        on,
        brightness: percentOf(colour.value, COLOUR_SCALE),
        colourTemperature: null,
        colour: { hue: colour.hue % 360, saturation: Math.round((colour.saturation / COLOUR_SCALE) * 100) },
      };
    }
  }
  // A Light with no mode shows white; one showing its maker's app's effects, neither.
  const showsWhite = mode === undefined || mode === "white";
  const temperature = dps[DATA_POINT.temperature];
  return {
    on,
    brightness,
    colourTemperature:
      showsWhite && capabilities.colourTemperature !== null && typeof temperature === "number"
        ? kelvinOf(temperature, capabilities.colourTemperature)
        : null,
    colour: null,
  };
};

/**
 * The data points that make `change`, already checked against the Light's
 * capabilities, from what it reported last. Brightness is data point 22 in
 * white and the colour's value in colour, so it is set in whichever it is to
 * show; a Light changing between them is sent its brightness in the other.
 */
export const dataPointsFor = (change: LightChange, dps: DataPoints): DataPoints => {
  const capabilities = capabilitiesFrom(dps);
  const state = stateFrom(dps, capabilities);
  const set: Record<string, boolean | number | string> = {};
  const hasMode = typeof dps[DATA_POINT.mode] === "string";
  const brightness = change.brightness ?? state.brightness ?? LIGHT_BRIGHTNESS_MAX;
  const colourValue = (colour: LightColour, percent: number): string =>
    colourText({
      hue: colour.hue,
      saturation: (colour.saturation / 100) * COLOUR_SCALE,
      value: (percent / LIGHT_BRIGHTNESS_MAX) * COLOUR_SCALE,
    });
  const whiteValue = (percent: number): number => (percent / LIGHT_BRIGHTNESS_MAX) * BRIGHTNESS_SCALE.max;

  if (change.on !== undefined) set[switchOf(dps) ?? DATA_POINT.switch] = change.on;
  if (change.colour !== undefined) {
    set[DATA_POINT.mode] = "colour";
    set[DATA_POINT.colour] = colourValue(change.colour, brightness);
  } else if (change.colourTemperature !== undefined && capabilities.colourTemperature !== null) {
    if (hasMode) set[DATA_POINT.mode] = "white";
    set[DATA_POINT.temperature] = temperatureOf(change.colourTemperature, capabilities.colourTemperature);
    if (capabilities.brightness && (change.brightness !== undefined || state.colour !== null)) {
      set[DATA_POINT.brightness] = whiteValue(brightness);
    }
  } else if (change.brightness !== undefined) {
    if (state.colour !== null) set[DATA_POINT.colour] = colourValue(state.colour, change.brightness);
    else set[DATA_POINT.brightness] = whiteValue(change.brightness);
  }
  return set;
};

/** What a module says of itself, announcing itself. */
export interface Announcement {
  /** Its IP address. */
  readonly ip: string;
  /** Its id, which is secret. */
  readonly id: string;
  /** Which of its maker's products it is, as Tuya's cloud knows it. */
  readonly productKey: string;
}

/** An announcement, as a module broadcasts it: encrypted, as on 6667, or in plain JSON, as on 6666. */
export const encodeAnnouncement = (announcement: Announcement, { plain = false } = {}): Buffer => {
  const json = Buffer.from(
    JSON.stringify({
      ip: announcement.ip,
      gwId: announcement.id,
      active: 2,
      // Tuya's own spelling.
      ablilty: 0,
      encrypt: true,
      productKey: announcement.productKey,
      version: VERSION,
    }),
    "utf8",
  );
  return encodeFrame({
    seq: 0,
    command: plain ? TUYA_COMMAND.announcePlain : TUYA_COMMAND.announce,
    retcode: 0,
    payload: plain ? json : encrypt(UDP_KEY, json),
  });
};

/**
 * The Light in an announcement, or why what arrived isn't one the Hub can
 * use, for its log, never quoting the module's id, which is secret (FR-4).
 * Uncertain: every Tuya module on the subnet announces itself so, Lepro's
 * or not; which `productKey`s are Lepro's is for the spike to find.
 */
export const readAnnouncement = (
  datagram: Uint8Array,
  from: string,
): { readonly light: HeardLight } | { readonly ignored: string } => {
  const bytes = Buffer.from(datagram);
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === PREFIX_V35) {
    return { ignored: "a frame of Tuya's protocol v3.5, which the Hub doesn't speak" };
  }
  let frame: Frame;
  try {
    frame = decodeFrame(bytes, { fromLight: true });
  } catch (error) {
    const why = error instanceof NotAFrame ? ` (${error.message})` : "";
    return {
      ignored: `${String(bytes.length)} bytes that aren't a Tuya frame${why}, starting ${bytes.subarray(0, 8).toString("hex")}`,
    };
  }
  if (frame.command !== TUYA_COMMAND.announce && frame.command !== TUYA_COMMAND.announcePlain) {
    return { ignored: `a Tuya frame of command 0x${frame.command.toString(16)}, not an announcement` };
  }
  let said: Record<string, unknown>;
  try {
    said =
      frame.command === TUYA_COMMAND.announcePlain
        ? objectIn(frame.payload.toString("utf8"))
        : objectIn(decrypt(UDP_KEY, frame.payload).toString("utf8"));
  } catch {
    return { ignored: "a Tuya announcement that doesn't read with the key announcements are encrypted under" };
  }
  const { ip, gwId, version, productKey } = said;
  const product = typeof productKey === "string" ? `, product ${productKey}` : "";
  if (typeof gwId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(gwId)) {
    return { ignored: `a Tuya announcement with no device id the Hub can read${product}` };
  }
  if (version !== VERSION) {
    const on = typeof version === "string" ? `v${version}` : "a version it doesn't say";
    return { ignored: `a Tuya module on protocol ${on}${product}, where the Hub speaks v${VERSION} alone` };
  }
  return {
    light: {
      address: typeof ip === "string" && isIP(ip) === 4 ? ip : from,
      id: gwId,
      model: MODEL,
    },
  };
};

/** The Light in an announcement, or undefined for what isn't one, as {@link readAnnouncement} reads it. */
export const decodeAnnouncement = (datagram: Uint8Array, from: string): HeardLight | undefined => {
  const read = readAnnouncement(datagram, from);
  return "light" in read ? read.light : undefined;
};

/**
 * What a search sends a fake Lepro Light's own address, as a real Light is
 * asked nothing: it announces itself every few seconds (uncertain: about
 * every 5) whether anyone listens or not. The fake, which can't broadcast
 * where tests run, announces itself to whoever sends it this.
 */
export const SEARCH_ASK = encodeFrame({ seq: 0, command: TUYA_COMMAND.announce, payload: Buffer.alloc(0) });

/** Whether a datagram is {@link SEARCH_ASK}. */
export const isSearchAsk = (datagram: Uint8Array): boolean => Buffer.from(datagram).equals(SEARCH_ASK);

const bind = (socket: UdpSocket, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => {
      socket.off("error", reject);
      resolve();
    });
  });

/**
 * Listens on `ports` for `windowMs` for Lights announcing themselves, or,
 * given `targets`, asks each instead, and resolves with each Light heard,
 * once each, by its address, as soon as every target has answered. Given
 * `address`, it resolves as soon as it hears that one, and hears no other.
 * It rejects only when it can listen on none of `ports`.
 *
 * `note` hears what it did, a line at a time, for the Hub's log: each port it
 * listens on or can't, each datagram that arrives and what it was, and what
 * it found. Never a Light's id (FR-4).
 */
export const searchForTuyaLights = async ({
  ports,
  targets,
  windowMs,
  address,
  note = () => undefined,
}: {
  readonly ports: readonly number[];
  readonly targets?: readonly SearchTarget[];
  readonly windowMs: number;
  readonly address?: string;
  readonly note?: (line: string) => void;
}): Promise<HeardLight[]> => {
  const heard = new Map<string, HeardLight>();
  const sockets: UdpSocket[] = [];
  let datagrams = 0;
  let finish = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const unanswered = new Set(targets?.map(({ host, port }) => `${host}:${String(port)}`));
  const hear =
    (on: number) =>
    (datagram: Buffer, from: RemoteInfo): void => {
      datagrams += 1;
      const at = `on UDP port ${String(on)} from ${from.address}:${String(from.port)}`;
      const read = readAnnouncement(datagram, from.address);
      if ("ignored" in read) {
        note(`Heard ${at}: ignored ${read.ignored}`);
        return;
      }
      const { light } = read;
      if (address !== undefined && light.address !== address) {
        note(`Heard ${at}: the Light at ${light.address}, not the one asked for`);
        return;
      }
      note(`Heard ${at}: ${heard.has(light.address) ? "again, " : ""}the Light at ${light.address}, ${light.model}`);
      if (!heard.has(light.address)) heard.set(light.address, light);
      unanswered.delete(`${from.address}:${String(from.port)}`);
      if (address !== undefined || (targets !== undefined && unanswered.size === 0)) finish();
    };
  const open = async (port: number): Promise<UdpSocket | undefined> => {
    // Others on the Hub's machine may listen for the same broadcasts.
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(socket);
    try {
      await bind(socket, port);
    } catch (error) {
      note(`Couldn't listen on UDP port ${String(port)}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const bound = socket.address().port;
    socket.on("message", hear(bound));
    socket.on("error", (error) => {
      note(`UDP port ${String(bound)} failed: ${error.message}`);
    });
    if (port !== 0) note(`Listening on UDP port ${String(bound)}`);
    return socket;
  };
  const started = Date.now();
  const timer = setTimeout(finish, windowMs);
  try {
    if (targets === undefined) {
      note(`Listening for ${String(windowMs / 1_000)} s for Lights announcing themselves`);
      const opened = await Promise.all(ports.map(open));
      if (opened.every((socket) => socket === undefined)) {
        throw new Error(`Couldn't listen on any of UDP ports ${ports.join(", ")}`);
      }
    } else {
      const socket = await open(0);
      if (socket === undefined) throw new Error("Couldn't open a UDP port to ask from");
      for (const target of targets) {
        note(`Asking ${target.host}:${String(target.port)}`);
        socket.send(SEARCH_ASK, target.port, target.host);
      }
    }
    await finished;
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.close();
  }
  const took = `${((Date.now() - started) / 1_000).toFixed(1)} s`;
  if (datagrams === 0) {
    note(
      `Heard nothing at all in ${took}: no Tuya module announced itself on the Hub's subnet, or a firewall ` +
        `on the Hub's machine, as Windows Defender Firewall's rules for Node.js, dropped what arrived on UDP ports ${ports.join(", ")}`,
    );
  } else {
    const lights = `${String(heard.size)} Light${heard.size === 1 ? "" : "s"}`;
    note(`Heard ${String(datagrams)} datagram${datagrams === 1 ? "" : "s"} in ${took}, from ${lights}`);
  }
  return [...heard.values()];
};

/**
 * One connection to a Light: it connects, then sends frames and waits for
 * the Light's answer to each, skipping what else it sends meanwhile, such as
 * its reports of what changed.
 */
const connectToLight = async (
  light: LightAt,
  { port, connectMs, answerMs }: { readonly port: number; readonly connectMs: number; readonly answerMs: number },
): Promise<LightSession> => {
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LightUnreachable());
    }, connectMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new LightUnreachable({ cause: error }));
    });
    socket.connect(port, light.address, () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve();
    });
  });
  socket.on("error", () => undefined);

  let buffered = Buffer.alloc(0);
  const frames: Frame[] = [];
  let ended: Error | undefined;
  let waiting: { readonly resolve: (frame: Frame) => void; readonly reject: (error: Error) => void } | undefined;
  const hand = (): void => {
    if (waiting === undefined) return;
    const frame = frames.shift();
    if (frame !== undefined) waiting.resolve(frame);
    else if (ended !== undefined) waiting.reject(ended);
    else return;
    waiting = undefined;
  };
  socket.on("data", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    try {
      for (;;) {
        const length = frameLength(buffered);
        if (length === undefined || length > buffered.length) break;
        frames.push(decodeFrame(buffered.subarray(0, length), { fromLight: true }));
        buffered = buffered.subarray(length);
      }
    } catch {
      ended ??= new NotALight("Answered with what isn't a Tuya frame");
      socket.destroy();
    }
    hand();
  });
  socket.on("close", () => {
    ended ??= new LightSilent("The Light closed the connection");
    hand();
  });

  const next = (deadline: number): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          waiting = undefined;
          reject(new LightSilent("The Light didn't answer"));
        },
        Math.max(0, deadline - Date.now()),
      );
      waiting = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      hand();
    });

  let seq = 0;
  /** Sends a frame of `command`, and resolves with the Light's next frame of the same command. */
  const ask = async (command: number, message: unknown): Promise<Frame> => {
    seq += 1;
    socket.write(encodeFrame({ seq, command, payload: encodeMessage(light.key, command, message) }));
    const deadline = Date.now() + answerMs;
    for (;;) {
      const frame = await next(deadline);
      if (frame.command === command) return frame;
    }
  };

  let last: DataPoints | undefined;
  const read = async (): Promise<LightReport> => {
    const answer = await ask(TUYA_COMMAND.query, queryMessage(light.id));
    // Uncertain: a module is said to answer a key or id it can't read with
    // a return code that isn't 0 and a few words in plain text, as the fake
    // does; one may instead close the connection, or say nothing.
    if (answer.retcode !== 0) throw new LightRefusedKeys();
    let dps: DataPoints | undefined;
    try {
      dps = dataPointsIn(decodeMessage(light.key, answer.payload));
    } catch {
      throw new LightRefusedKeys();
    }
    if (dps === undefined) throw new NotALight("Answered the query with no data points");
    const capabilities = capabilitiesFrom(dps);
    last = dps;
    return { capabilities, state: stateFrom(dps, capabilities) };
  };

  return {
    read,
    write: async (change) => {
      if (last === undefined) await read();
      const set = dataPointsFor(change, last ?? {});
      if (Object.keys(set).length === 0) return;
      const answer = await ask(TUYA_COMMAND.control, controlMessage(light.id, set));
      if (answer.retcode !== 0) throw new LightRefusedKeys();
    },
    close: () => socket.destroy(),
  };
};

export interface TuyaTransportOptions {
  /** {@link TUYA_PORT} on a real Light. Only tests against the fake change it. */
  readonly port?: number;
  /** {@link TUYA_DISCOVERY_PORTS} on a real network, where a search listens. Only tests against the fake change them. */
  readonly discoveryPorts?: readonly number[];
  /**
   * Where a search asks, rather than listening for broadcasts: each fake
   * Light's own discovery port, as tests can't rely on a broadcast.
   */
  readonly searchTargets?: readonly SearchTarget[];
  /** How long a search listens: a little longer than a Light takes between announcements. */
  readonly searchWindowMs?: number;
  /** How long a Light has to accept a connection. */
  readonly connectTimeoutMs?: number;
  /** How long it has to answer each frame. */
  readonly answerTimeoutMs?: number;
}

/** Reaches Lights by Tuya's local protocol, v3.3, with no cloud (ADR 0007). */
export const tuyaTransport = ({
  port = TUYA_PORT,
  discoveryPorts = TUYA_DISCOVERY_PORTS,
  searchTargets,
  searchWindowMs = 6_000,
  connectTimeoutMs = 3_000,
  answerTimeoutMs = 5_000,
}: TuyaTransportOptions = {}): LightTransport => ({
  search: (address, note) =>
    searchForTuyaLights({
      ports: discoveryPorts,
      windowMs: searchWindowMs,
      ...(note === undefined ? {} : { note }),
      ...(address === undefined
        ? searchTargets === undefined
          ? {}
          : { targets: searchTargets }
        : {
            address,
            ...(searchTargets === undefined
              ? {}
              : { targets: discoveryPorts.map((each) => ({ host: address, port: each })) }),
          }),
    }),
  connect: (light) => connectToLight(light, { port, connectMs: connectTimeoutMs, answerMs: answerTimeoutMs }),
  areKeys: areTuyaKeys,
  ports: new Map([[TUYA_PORT, "Tuya device, as a Lepro Light may be"]]),
  model: MODEL,
});
