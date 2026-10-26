/**
 * The frames Midea's Air Conditioners take and answer, inside the LAN
 * packets of `lan-packets.ts`, as the open-source libraries (msmart-ng,
 * midea-local, midea-beautiful-air) read and write them: a header that
 * starts `0xAA`, a body whose first byte says what it is, the body's CRC-8
 * and the frame's checksum. Only the Midea Driver and the fake Midea Air
 * Conditioner know them (NFR-6).
 *
 * The bodies are those of a unit's state query (`0x41`) and its answer
 * (`0xC0`), the set command (`0x40`), which carries the whole state, the
 * display's toggle, the capabilities query (`0xB5`), and the queries and sets
 * of the further functions a unit reports by id (`0xB1`, `0xB0`). Where the
 * libraries disagree, or a detail is known only from one of them, it is said
 * beside it: a real unit that answers otherwise changes this file, the fake
 * first (ADR 0004).
 */
import { crc8 } from "./security.ts";

/** The appliance type of an Air Conditioner, in every frame's header and in discovery's answers. */
export const AIR_CONDITIONER_TYPE = 0xac;

/** A frame's type, in its header: a set changes the unit; a query only reads it. */
export const FRAME_SET = 0x02;
export const FRAME_QUERY = 0x03;

const FRAME_START = 0xaa;
const HEADER_LENGTH = 10;

/** What each body starts with, which says what it is. */
export const SET_STATE = 0x40;
export const QUERY_STATE = 0x41;
export const STATE_ANSWER = 0xc0;
export const QUERY_CAPABILITIES = 0xb5;
export const QUERY_PROPERTIES = 0xb1;
export const SET_PROPERTIES = 0xb0;

/** The second byte of a `0x41` body that toggles the display rather than reading the state. */
const TOGGLE_DISPLAY = 0x61;

/** A frame that isn't one: too short, the wrong start, or a checksum that doesn't add up. */
export class NotAFrame extends Error {
  constructor(why: string) {
    super(`Not a Midea frame: ${why}`);
    this.name = "NotAFrame";
  }
}

/** The frame's checksum: the two's complement of the sum of every byte after the start. */
const checksum = (frame: Uint8Array): number => -frame.subarray(1).reduce((sum, byte) => sum + byte, 0) & 0xff;

/** Wraps a body in a frame of `type`, with its CRC-8 and the frame's checksum. */
export const buildFrame = (body: Uint8Array, type: number): Buffer => {
  const header = Buffer.alloc(HEADER_LENGTH);
  header[0] = FRAME_START;
  // The length counts every byte but the start: the header, the body, its CRC and the checksum.
  header[1] = HEADER_LENGTH + body.length + 1;
  header[2] = AIR_CONDITIONER_TYPE;
  header[9] = type;
  const unchecked = Buffer.concat([header, body, Buffer.of(crc8(body))]);
  return Buffer.concat([unchecked, Buffer.of(checksum(unchecked))]);
};

export interface Frame {
  readonly type: number;
  /** Without its CRC-8. */
  readonly body: Buffer;
}

/** Reads a frame, checking its start, length and checksum. A unit's CRC-8 isn't checked: not every library does. */
export const parseFrame = (data: Uint8Array): Frame => {
  if (data.length < HEADER_LENGTH + 2) throw new NotAFrame("too short");
  if (data[0] !== FRAME_START) throw new NotAFrame("wrong start");
  const length = (data[1] ?? 0) + 1;
  if (length > data.length || length < HEADER_LENGTH + 2) throw new NotAFrame("wrong length");
  const frame = data.subarray(0, length);
  if (checksum(frame.subarray(0, -1)) !== frame[length - 1]) throw new NotAFrame("wrong checksum");
  return { type: frame[9] ?? 0, body: Buffer.from(frame.subarray(HEADER_LENGTH, -2)) };
};

/** The body of the state query, as msmart-ng writes it. */
export const queryStateBody = (): Buffer =>
  Buffer.from([QUERY_STATE, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02, ...Array<number>(12).fill(0), 0x03]);

/** The body that toggles the indoor unit's display: Midea has no command that sets it on or off. */
export const toggleDisplayBody = (): Buffer =>
  Buffer.from([QUERY_STATE, TOGGLE_DISPLAY, 0x00, 0xff, 0x02, 0x00, 0x02, 0x00, ...Array<number>(13).fill(0)]);

export const isToggleDisplay = (body: Uint8Array): boolean => body[0] === QUERY_STATE && body[1] === TOGGLE_DISPLAY;

/** A unit's modes, as Midea numbers them. */
export const MIDEA_MODE = { auto: 1, cool: 2, dry: 3, heat: 4, fan: 5 } as const;

/** A unit's fan speeds, as Midea numbers them: a percentage, or 102 for automatic. */
export const MIDEA_FAN = { silent: 20, low: 40, medium: 60, high: 80, full: 100, auto: 102 } as const;

/** The bits of the swing byte: the louvres that swing up and down, and those that swing side to side. */
export const SWING_VERTICAL = 0x0c;
export const SWING_HORIZONTAL = 0x03;

/** What the set command sets, all of it at once: Midea has no command that sets one thing alone. */
export interface MideaSettings {
  readonly power: boolean;
  readonly mode: number;
  /** In °C, in half degrees. */
  readonly targetTemperature: number;
  readonly fanSpeed: number;
  /** {@link SWING_VERTICAL} and {@link SWING_HORIZONTAL}, or 0 for none. */
  readonly swing: number;
  readonly eco: boolean;
  readonly turbo: boolean;
  readonly sleep: boolean;
}

/** A unit's state, as its `0xC0` answer says it. */
export interface MideaState extends MideaSettings {
  readonly display: boolean;
  /** In °C, to a tenth, or null where it says none. */
  readonly indoorTemperature: number | null;
  readonly outdoorTemperature: number | null;
}

/** The target temperature in two parts: whole degrees, and whether it has a half. */
const targetParts = (temperature: number): { whole: number; half: boolean } => {
  const whole = Math.floor(temperature);
  return { whole, half: temperature - whole >= 0.5 };
};

/**
 * The byte that holds the mode and the target temperature: its whole degrees
 * less 16 in the low nibble, so 16 °C to 31 °C, a half degree in the next
 * bit, and the mode in the top three.
 */
const modeAndTarget = (mode: number, temperature: number): number => {
  const { whole, half } = targetParts(temperature);
  return ((mode & 0x07) << 5) | (half ? 0x10 : 0) | ((whole - 16) & 0x0f);
};

/**
 * Newer units also take the whole degrees less 12 in a byte of their own, so
 * 12 °C to 43 °C, which wins where it isn't 0 (msmart-ng's reading; others
 * read only the nibble).
 */
const wideTarget = (temperature: number): number => {
  const { whole } = targetParts(temperature);
  return whole >= 13 && whole <= 43 ? (whole - 12) & 0x1f : 0;
};

const targetFrom = (modeByte: number, wideByte: number): number => {
  const wide = wideByte & 0x1f;
  const whole = wide === 0 ? (modeByte & 0x0f) + 16 : wide + 12;
  return whole + (modeByte & 0x10 ? 0.5 : 0);
};

/** The set command's body, as msmart-ng writes it, with the timers off and a beep. */
export const setStateBody = (settings: MideaSettings): Buffer => {
  const body = Buffer.alloc(23);
  body[0] = SET_STATE;
  // 0x40 asks for a beep, and 0x02 is set by every library, for reasons none says.
  body[1] = 0x40 | 0x02 | (settings.power ? 0x01 : 0);
  body[2] = modeAndTarget(settings.mode, settings.targetTemperature);
  body[3] = settings.fanSpeed & 0x7f;
  // The on and off timers, unset.
  body[4] = 0x7f;
  body[5] = 0x7f;
  body[7] = 0x30 | (settings.swing & 0x0f);
  body[8] = settings.turbo ? 0x20 : 0;
  body[9] = settings.eco ? 0x80 : 0;
  body[10] = (settings.sleep ? 0x01 : 0) | (settings.turbo ? 0x02 : 0);
  body[18] = wideTarget(settings.targetTemperature);
  return body;
};

/** Reads a set command's body, as a unit does. */
export const parseSetState = (body: Uint8Array): MideaSettings => {
  const at = (index: number): number => body[index] ?? 0;
  return {
    power: (at(1) & 0x01) !== 0,
    mode: at(2) >> 5,
    targetTemperature: targetFrom(at(2), at(18)),
    fanSpeed: at(3) & 0x7f,
    swing: at(7) & 0x0f,
    eco: (at(9) & 0x80) !== 0,
    turbo: (at(10) & 0x02) !== 0 || (at(8) & 0x20) !== 0,
    sleep: (at(10) & 0x01) !== 0,
  };
};

/**
 * A measured temperature in two bytes: (°C × 2) + 50, so to a half degree,
 * with 0xFF for none, and the tenths in a nibble of a later byte, the
 * indoor unit's low and the outdoor's high.
 */
const temperatureByte = (temperature: number | null): number =>
  temperature === null ? 0xff : Math.min(0xfe, Math.max(0, Math.round(temperature * 2) + 50));

const tenths = (temperature: number | null): number =>
  temperature === null ? 0 : Math.round(Math.abs(temperature) * 10) % 10;

const temperatureFrom = (byte: number, tenthsNibble: number): number | null => {
  if (byte === 0xff || byte === 0) return null;
  const halves = (byte - 50) / 2;
  const whole = Math.trunc(halves);
  return halves < 0 ? whole - tenthsNibble / 10 : whole + tenthsNibble / 10;
};

/** A unit's answer with its state, as a unit writes it. */
export const stateAnswerBody = (state: MideaState): Buffer => {
  const body = Buffer.alloc(23);
  body[0] = STATE_ANSWER;
  body[1] = state.power ? 0x01 : 0;
  body[2] = modeAndTarget(state.mode, state.targetTemperature);
  body[3] = state.fanSpeed & 0x7f;
  body[7] = state.swing & 0x0f;
  body[8] = state.turbo ? 0x20 : 0;
  body[9] = state.eco ? 0x10 : 0;
  body[10] = (state.sleep ? 0x01 : 0) | (state.turbo ? 0x02 : 0);
  body[11] = temperatureByte(state.indoorTemperature);
  body[12] = temperatureByte(state.outdoorTemperature);
  body[13] = wideTarget(state.targetTemperature);
  // msmart-ng reads the display as on unless this byte is 0x70.
  body[14] = state.display ? 0 : 0x70;
  body[15] = (tenths(state.outdoorTemperature) << 4) | tenths(state.indoorTemperature);
  return body;
};

/** Reads a unit's answer with its state. */
export const parseStateAnswer = (body: Uint8Array): MideaState => {
  if (body[0] !== STATE_ANSWER || body.length < 16) throw new NotAFrame("not a state answer");
  const at = (index: number): number => body[index] ?? 0;
  return {
    power: (at(1) & 0x01) !== 0,
    mode: at(2) >> 5,
    targetTemperature: targetFrom(at(2), at(13)),
    fanSpeed: at(3) & 0x7f,
    swing: at(7) & 0x0f,
    eco: (at(9) & 0x10) !== 0,
    turbo: (at(10) & 0x02) !== 0 || (at(8) & 0x20) !== 0,
    sleep: (at(10) & 0x01) !== 0,
    display: at(14) !== 0x70,
    indoorTemperature: temperatureFrom(at(11), at(15) & 0x0f),
    outdoorTemperature: temperatureFrom(at(12), at(15) >> 4),
  };
};

/** One entry of a unit's capabilities, or of its further functions: an id of two bytes, and its value. */
export interface Entry {
  readonly id: number;
  readonly value: Buffer;
}

/**
 * The capabilities query: the first page, or, once a page says there are
 * more, the next. As far as msmart-ng says, a unit has at most two.
 */
export const queryCapabilitiesBody = (page: 1 | 2): Buffer =>
  page === 1 ? Buffer.from([QUERY_CAPABILITIES, 0x01, 0x11]) : Buffer.from([QUERY_CAPABILITIES, 0x01, 0x01, 0x01]);

/** Which page a capabilities query asks for. */
export const capabilitiesPageAsked = (body: Uint8Array): 1 | 2 => (body.length > 3 ? 2 : 1);

/**
 * A page of a unit's capabilities: how many, then each as its id, low byte
 * first, its length and its value, then a byte that isn't 0 when there is
 * another page.
 */
export const capabilitiesAnswerBody = (entries: readonly Entry[], more: boolean): Buffer =>
  Buffer.concat([
    Buffer.of(QUERY_CAPABILITIES, entries.length),
    ...entries.map(({ id, value }) => Buffer.concat([Buffer.of(id & 0xff, id >> 8, value.length), value])),
    Buffer.of(more ? 1 : 0),
  ]);

export const parseCapabilitiesAnswer = (body: Uint8Array): { entries: Entry[]; more: boolean } => {
  if (body[0] !== QUERY_CAPABILITIES) throw new NotAFrame("not a capabilities answer");
  const { entries, end } = readEntries(body, false);
  return { entries: entries.map(({ id, value }) => ({ id, value })), more: (body[end] ?? 0) !== 0 };
};

/**
 * Reads the entries of a body that counts them in its second byte: each an
 * id, low byte first, then, `withResult`, a byte that is 0 where the unit
 * took it, then its length and its value.
 */
const readEntries = (
  body: Uint8Array,
  withResult: boolean,
): { entries: (Entry & { readonly taken: boolean })[]; end: number } => {
  const entries: (Entry & { readonly taken: boolean })[] = [];
  const lengthAt = withResult ? 3 : 2;
  let at = 2;
  for (let index = 0; index < (body[1] ?? 0) && at + lengthAt + 1 <= body.length; index += 1) {
    const length = body[at + lengthAt] ?? 0;
    const start = at + lengthAt + 1;
    entries.push({
      id: (body[at] ?? 0) | ((body[at + 1] ?? 0) << 8),
      taken: !withResult || body[at + 2] === 0,
      value: Buffer.from(body.subarray(start, start + length)),
    });
    at = start + length;
  }
  return { entries, end: at };
};

/** The query for the further functions with these ids. */
export const queryPropertiesBody = (ids: readonly number[]): Buffer =>
  Buffer.concat([Buffer.of(QUERY_PROPERTIES, ids.length), ...ids.map((id) => Buffer.of(id & 0xff, id >> 8))]);

export const parsePropertiesQuery = (body: Uint8Array): number[] => {
  const ids: number[] = [];
  for (let index = 0, at = 2; index < (body[1] ?? 0) && at + 2 <= body.length; index += 1, at += 2) {
    ids.push((body[at] ?? 0) | ((body[at + 1] ?? 0) << 8));
  }
  return ids;
};

/** The set of the further functions with these ids, each to its value. */
export const setPropertiesBody = (entries: readonly Entry[]): Buffer =>
  Buffer.concat([
    Buffer.of(SET_PROPERTIES, entries.length),
    ...entries.map(({ id, value }) => Buffer.concat([Buffer.of(id & 0xff, id >> 8, value.length), value])),
  ]);

/** Reads a set of further functions, as a unit does. */
export const parsePropertiesSet = (body: Uint8Array): Entry[] =>
  readEntries(body, false).entries.map(({ id, value }) => ({ id, value }));

/**
 * A unit's answer to a query or set of further functions, which has the
 * same type: each function's id, a byte that is 0 where it took it, its
 * length and its value.
 */
export const propertiesAnswerBody = (type: number, entries: readonly Entry[]): Buffer =>
  Buffer.concat([
    Buffer.of(type, entries.length),
    ...entries.map(({ id, value }) => Buffer.concat([Buffer.of(id & 0xff, id >> 8, 0, value.length), value])),
  ]);

/** Reads that answer: the value of each function the unit took, by its id. */
export const parsePropertiesAnswer = (body: Uint8Array): Map<number, Buffer> =>
  new Map(
    readEntries(body, true)
      .entries.filter(({ taken }) => taken)
      .map(({ id, value }) => [id, value]),
  );
