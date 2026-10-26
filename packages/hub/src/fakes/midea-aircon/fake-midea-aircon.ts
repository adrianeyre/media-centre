import { randomBytes } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from "node:net";

import { CAPABILITY } from "../../drivers/midea/capabilities.ts";
import { encodeDiscoveryAnswer, isDiscoveryRequest } from "../../drivers/midea/discovery.ts";
import {
  buildFrame,
  capabilitiesAnswerBody,
  capabilitiesPageAsked,
  FRAME_QUERY,
  isToggleDisplay,
  MIDEA_MODE,
  parseFrame,
  parsePropertiesQuery,
  parsePropertiesSet,
  parseSetState,
  propertiesAnswerBody,
  QUERY_CAPABILITIES,
  QUERY_PROPERTIES,
  QUERY_STATE,
  SET_PROPERTIES,
  SET_STATE,
  stateAnswerBody,
  SWING_HORIZONTAL,
  SWING_VERTICAL,
  type Entry,
  type MideaState,
} from "../../drivers/midea/frames.ts";
import {
  decodeV2Packet,
  decodeV3Packet,
  encodeV2Packet,
  encodeV3Packet,
  handshakeAnswer,
  handshakeRefusal,
  isV2Packet,
  isV3Packet,
  v2PacketLength,
  v3PacketLength,
  V3_ENCRYPTED_ANSWER,
  V3_ENCRYPTED_REQUEST,
  V3_HANDSHAKE_REQUEST,
  v3KeysFrom,
  type V3Keys,
  type V3Session,
} from "../../drivers/midea/lan-packets.ts";
import { sameBytes } from "../../drivers/midea/security.ts";

/**
 * A fake Midea Air Conditioner for tests (ADR 0004): it speaks Midea's LAN
 * protocol on TCP, v2 or v3, as the open-source libraries say a real unit
 * does, and records every command it receives. When a real unit turns out to
 * behave differently, change this first, then the Midea Driver.
 *
 * On v3 it makes the handshake with the token and key it is given, and
 * refuses any other token with "ERROR", closing the connection, as msmart-ng
 * says a unit does; a Hub with the wrong key can't read its answer. It
 * answers Midea's UDP discovery sent to its own address, as a real unit
 * answers those broadcast, which tests can't rely on, with its id, serial
 * number, name and version.
 *
 * It reports the capabilities it is given, from {@link FAKE_AIRCON_FEATURES},
 * as a unit's `0xB5` answer, on two pages where there are many, and keeps a
 * state: power, mode, target temperature, fan, swing, eco, turbo and sleep,
 * display, the room and outdoor temperatures, and the value of each further
 * function it has. Its set command sets the whole state at once; its display
 * toggles; a swing it hasn't got stays off. A test changes its state through
 * `/_fake/state`, as its own remote, or the weather, would.
 *
 * On v3, `/_fake/keys` gives it a new token and key, which it expects from
 * then on, refusing the old ones, as a unit factory reset and paired again
 * in Midea's app would, once its cloud has issued it new ones.
 */

/**
 * What a fake unit can have, in the fake's own words: the modes besides fan,
 * which every unit has; the fan steps besides low and high, which every unit
 * that doesn't set its fan by percentage has; the swings; the presets besides
 * sleep, which no unit reports; the display; half-degree target
 * temperatures; an outdoor temperature sensor; and the further functions.
 */
export const FAKE_AIRCON_FEATURES = [
  "cool",
  "heat",
  "dry",
  "auto",
  "fan-silent",
  "fan-medium",
  "fan-auto",
  "fan-percent",
  "swing-vertical",
  "swing-horizontal",
  "eco",
  "turbo",
  "display",
  "half-degrees",
  "outdoor-temperature",
  "vertical-vane",
  "horizontal-vane",
  "breeze",
  "power-limit",
  "self-clean",
  "frost-protection",
  "electric-heater",
  "ionizer",
  "smart-eye",
  "air-towards-me",
  "air-away-from-me",
] as const;

export type FakeAirconFeature = (typeof FAKE_AIRCON_FEATURES)[number];

/** The further functions, by the capability that reports each and that it is read and set by, and their first value. */
const FUNCTIONS: Readonly<Partial<Record<FakeAirconFeature, { readonly id: number; readonly initial: number }>>> = {
  "vertical-vane": { id: CAPABILITY.verticalVane, initial: 50 },
  "horizontal-vane": { id: CAPABILITY.horizontalVane, initial: 50 },
  breeze: { id: CAPABILITY.breeze, initial: 1 },
  "power-limit": { id: CAPABILITY.powerLimit, initial: 100 },
  "self-clean": { id: CAPABILITY.selfClean, initial: 0 },
  "frost-protection": { id: CAPABILITY.frostProtection, initial: 0 },
  "electric-heater": { id: CAPABILITY.electricHeater, initial: 0 },
  ionizer: { id: CAPABILITY.ionizer, initial: 0 },
  "smart-eye": { id: CAPABILITY.smartEye, initial: 0 },
  "air-towards-me": { id: CAPABILITY.airTowardsMe, initial: 0 },
  "air-away-from-me": { id: CAPABILITY.airAwayFromMe, initial: 0 },
};

/** The value of a unit's modes entry for each set of modes, as a unit reports it (msmart-ng's reading). */
const MODES_VALUE: readonly (readonly [number, readonly string[]])[] = [
  [0, ["cool", "dry", "auto"]],
  [1, ["cool", "heat", "dry", "auto"]],
  [2, ["heat", "auto"]],
  [3, ["cool"]],
  [4, ["cool", "heat"]],
  [5, ["cool", "dry"]],
  [6, ["cool", "heat", "dry"]],
  [7, ["cool", "heat", "auto"]],
  [8, ["cool", "auto"]],
];

/** The value of a unit's fan entry for each set of fan steps besides low and high, and percentage. */
const FAN_VALUE: readonly (readonly [number, readonly string[]])[] = [
  [3, []],
  [4, ["fan-auto"]],
  [5, ["fan-medium", "fan-auto"]],
  [6, ["fan-silent", "fan-medium", "fan-auto"]],
  [7, ["fan-medium"]],
];

/** The most entries a unit sends on one page of its capabilities, as far as anyone knows. */
const ENTRIES_PER_PAGE = 8;

/** A mode's lowest and highest target temperatures, in °C. */
export type FakeRange = readonly [number, number];

export interface FakeTemperatureRanges {
  readonly cool: FakeRange;
  readonly auto: FakeRange;
  readonly heat: FakeRange;
}

/** The fake's state, as `/_fake/state` says it and takes changes to it. */
export interface FakeAirconState {
  readonly power: boolean;
  readonly mode: keyof typeof MIDEA_MODE;
  readonly targetTemperature: number;
  /** As the unit holds it: a percentage, or 102 for automatic. */
  readonly fanSpeed: number;
  readonly swing: { readonly vertical: boolean; readonly horizontal: boolean };
  readonly eco: boolean;
  readonly turbo: boolean;
  readonly sleep: boolean;
  readonly display: boolean;
  readonly roomTemperature: number | null;
  /** Always null on a unit without the "outdoor-temperature" feature. */
  readonly outdoorTemperature: number | null;
  /** The value the unit holds for each further function it has, by its feature's name. */
  readonly functions: Readonly<Partial<Record<FakeAirconFeature, number>>>;
}

/** One command the fake received, in the order it received them. */
export type FakeAirconCommand = {
  /** When it received it, in milliseconds since the epoch. */
  readonly receivedAt: number;
  /** Which of {@link FakeMideaAircon.connections} it came on. */
  readonly connection: number;
  /** On v3, the counter it came with, which rises with each; on v2, null. */
  readonly count: number | null;
} & (
  | { readonly command: "query-state" | "query-capabilities" | "toggle-display" }
  | { readonly command: "query-functions"; readonly functions: readonly string[] }
  | {
      readonly command: "set-state";
      readonly power: boolean;
      readonly mode: string;
      readonly targetTemperature: number;
      readonly fanSpeed: number;
      readonly swing: { readonly vertical: boolean; readonly horizontal: boolean };
      readonly eco: boolean;
      readonly turbo: boolean;
      readonly sleep: boolean;
    }
  | { readonly command: "set-functions"; readonly functions: Readonly<Record<string, number>> }
);

/** A command as {@link FakeAirconCommand} records it, before it is given when and where it came. */
type Unrecorded<Command> = Command extends unknown ? Omit<Command, "receivedAt" | "connection" | "count"> : never;

/** One connection to the fake, and what became of its handshake on v3. */
export interface FakeAirconConnection {
  readonly version: 2 | 3;
  /** "accepted" once a v3 handshake is made, "refused" for a token the fake doesn't know, and "none" on v2 or before. */
  readonly handshake: "none" | "accepted" | "refused";
}

export interface FakeMideaAirconOptions {
  readonly host?: string;
  /** The TCP port a real unit has on 6444. 0, the default, picks a free one. */
  readonly port?: number;
  /** The UDP port it answers discovery on, 6445 or 20086 on a real unit. 0, the default, picks a free one. */
  readonly discoveryPort?: number;
  /** The HTTP port of its `/_fake/` paths, which a real unit hasn't got. 0, the default, picks a free one. */
  readonly httpPort?: number;
  /** Its protocol version: 3 by default, as newer units are. */
  readonly version?: 2 | 3;
  /**
   * On v3, the token and key, in hex, that it expects, as Midea's cloud
   * issued them: 64 and 32 bytes. Random ones by default, which
   * {@link FakeMideaAircon.token} and {@link FakeMideaAircon.key} give.
   */
  readonly token?: string;
  readonly key?: string;
  /** Its id, 6 bytes. */
  readonly id?: number;
  readonly serialNumber?: string;
  /** Its module's Wi-Fi network's name, `net_ac_` and the end of its id by default. */
  readonly name?: string;
  /** What it has. Every feature by default. */
  readonly features?: readonly FakeAirconFeature[];
  /** Its target temperatures in cool, auto and heat: 16° to 30° in each by default. */
  readonly temperatureRanges?: FakeTemperatureRanges;
  /** Capability ids it reports beyond those the Driver knows, as a newer unit might, each with a value of 1. */
  readonly unknownCapabilities?: readonly number[];
  /**
   * On v3, how long, after refusing a token, it answers no handshake, as a
   * real unit has been seen to: none by default.
   */
  readonly silentAfterRefusalMs?: number;
}

export interface FakeMideaAircon {
  readonly host: string;
  readonly port: number;
  readonly discoveryPort: number;
  readonly httpPort: number;
  readonly version: 2 | 3;
  readonly id: number;
  readonly serialNumber: string;
  readonly name: string;
  /** On v3, the token and key it expects now, in hex; on v2, undefined. */
  readonly token: string | undefined;
  readonly key: string | undefined;
  /**
   * On v3, expects this token and key from now on, in hex, refusing the old
   * ones, as a unit factory reset and paired again in Midea's app would.
   * Connections already made keep their sessions.
   */
  readonly rekey: (token: string, key: string) => void;
  readonly features: readonly FakeAirconFeature[];
  /** Its state now. */
  readonly state: () => FakeAirconState;
  /** Changes its state, as its own remote, or the weather, would. */
  readonly setState: (change: Partial<FakeAirconState>) => FakeAirconState;
  /** Every command received, oldest first. */
  readonly commands: readonly FakeAirconCommand[];
  readonly connections: readonly FakeAirconConnection[];
  /** Forgets the commands and connections recorded so far. */
  readonly clear: () => void;
  readonly stop: () => Promise<void>;
}

/** Where `/_fake/state` answers with the state, and takes changes to it. */
export const FAKE_AIRCON_STATE_PATH = "/_fake/state";
/** Where `/_fake/commands` lists the commands received, and `DELETE` forgets them. */
export const FAKE_AIRCON_COMMANDS_PATH = "/_fake/commands";
/** Where `/_fake/connections` lists the connections made, and `DELETE` forgets them. */
export const FAKE_AIRCON_CONNECTIONS_PATH = "/_fake/connections";
/** Where `/_fake/capabilities` says what it has, as its features and temperature ranges. */
export const FAKE_AIRCON_CAPABILITIES_PATH = "/_fake/capabilities";
/**
 * Where `POST /_fake/keys` with `{"token": "…", "key": "…"}`, in hex, 64 and
 * 32 bytes, has a v3 fake expect those from then on (see
 * {@link FakeMideaAircon.rekey}). It answers 204, quoting neither back.
 */
export const FAKE_AIRCON_KEYS_PATH = "/_fake/keys";

const DEFAULT_RANGES: FakeTemperatureRanges = { cool: [16, 30], auto: [16, 30], heat: [16, 30] };

/** The value of an entry whose meaning is the set of `features` it lists, or a refusal naming what can't be. */
const valueFor = (
  table: readonly (readonly [number, readonly string[]])[],
  features: ReadonlySet<string>,
  among: readonly string[],
  what: string,
): number => {
  const asked = among.filter((feature) => features.has(feature));
  const found = table.find(
    ([, listed]) => listed.length === asked.length && listed.every((each) => asked.includes(each)),
  );
  if (found === undefined) throw new Error(`A Midea unit can't report ${what} ${asked.join(", ") || "none"}`);
  return found[0];
};

/** The capability entries a unit with these features reports. */
const entriesFor = (
  features: ReadonlySet<FakeAirconFeature>,
  ranges: FakeTemperatureRanges,
  unknown: readonly number[],
): Entry[] => {
  const one = (id: number, ...value: number[]): Entry => ({ id, value: Buffer.from(value) });
  const entries = [
    one(CAPABILITY.modes, valueFor(MODES_VALUE, features, ["cool", "heat", "dry", "auto"], "the modes")),
    one(
      CAPABILITY.fanSpeeds,
      features.has("fan-percent")
        ? 1
        : valueFor(FAN_VALUE, features, ["fan-silent", "fan-medium", "fan-auto"], "the fan steps low, high and"),
    ),
    one(
      CAPABILITY.swing,
      features.has("swing-vertical")
        ? features.has("swing-horizontal")
          ? 1
          : 0
        : features.has("swing-horizontal")
          ? 3
          : 2,
    ),
    one(
      CAPABILITY.temperatures,
      ...[ranges.cool, ranges.auto, ranges.heat].flatMap(([min, max]) => [min * 2, max * 2]),
      features.has("half-degrees") ? 1 : 0,
    ),
  ];
  if (features.has("eco")) entries.push(one(CAPABILITY.eco, 1));
  if (features.has("turbo")) entries.push(one(CAPABILITY.turbo, 1));
  if (features.has("display")) entries.push(one(CAPABILITY.display, 1));
  for (const [feature, definition] of Object.entries(FUNCTIONS)) {
    if (features.has(feature as FakeAirconFeature)) entries.push(one(definition.id, 1));
  }
  for (const id of unknown) entries.push(one(id, 1));
  return entries;
};

/** Starts a fake Midea Air Conditioner listening on loopback, by default on free ports. */
export const startFakeMideaAircon = async ({
  host = "127.0.0.1",
  port = 0,
  discoveryPort = 0,
  httpPort = 0,
  version = 3,
  token = version === 3 ? randomBytes(64).toString("hex") : undefined,
  key = version === 3 ? randomBytes(32).toString("hex") : undefined,
  id = 0x0123_4567_89ab,
  serialNumber = "000000P0000000Q1F0C9A1B2C3D40000",
  name = `net_ac_${(id & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`,
  features = FAKE_AIRCON_FEATURES,
  temperatureRanges = DEFAULT_RANGES,
  unknownCapabilities = [],
  silentAfterRefusalMs = 0,
}: FakeMideaAirconOptions = {}): Promise<FakeMideaAircon> => {
  /** Until when it answers no handshake, having refused a token. */
  let silentUntil = 0;
  const has = new Set(features);
  const entries = entriesFor(has, temperatureRanges, unknownCapabilities);
  let keys: V3Keys | undefined = version === 3 ? v3KeysFrom(token ?? "", key ?? "") : undefined;
  const swingMask =
    (has.has("swing-vertical") ? SWING_VERTICAL : 0) | (has.has("swing-horizontal") ? SWING_HORIZONTAL : 0);

  let state: MideaState = {
    power: false,
    mode: MIDEA_MODE.cool,
    targetTemperature: 24,
    fanSpeed: has.has("fan-auto") || has.has("fan-percent") ? 102 : 40,
    swing: 0,
    eco: false,
    turbo: false,
    sleep: false,
    display: true,
    indoorTemperature: 22.5,
    outdoorTemperature: has.has("outdoor-temperature") ? 14 : null,
  };
  const properties = new Map<number, number>(
    Object.entries(FUNCTIONS)
      .filter(([feature]) => has.has(feature as FakeAirconFeature))
      .map(([, definition]) => [definition.id, definition.initial]),
  );
  const featureOf = (property: number): string =>
    Object.entries(FUNCTIONS).find(([, definition]) => definition.id === property)?.[0] ?? `0x${property.toString(16)}`;

  const commands: FakeAirconCommand[] = [];
  const connections: FakeAirconConnection[] = [];

  const view = (): FakeAirconState => ({
    power: state.power,
    mode: (Object.entries(MIDEA_MODE).find(([, each]) => each === state.mode)?.[0] ??
      "auto") as keyof typeof MIDEA_MODE,
    targetTemperature: state.targetTemperature,
    fanSpeed: state.fanSpeed,
    swing: {
      vertical: (state.swing & SWING_VERTICAL) === SWING_VERTICAL,
      horizontal: (state.swing & SWING_HORIZONTAL) === SWING_HORIZONTAL,
    },
    eco: state.eco,
    turbo: state.turbo,
    sleep: state.sleep,
    display: state.display,
    roomTemperature: state.indoorTemperature,
    outdoorTemperature: state.outdoorTemperature,
    functions: Object.fromEntries([...properties].map(([property, value]) => [featureOf(property), value])),
  });

  const setState = (change: Partial<FakeAirconState>): FakeAirconState => {
    const swing =
      change.swing === undefined
        ? state.swing
        : (change.swing.vertical ? SWING_VERTICAL : 0) | (change.swing.horizontal ? SWING_HORIZONTAL : 0);
    state = {
      ...state,
      ...(change.power === undefined ? {} : { power: change.power }),
      ...(change.mode === undefined ? {} : { mode: MIDEA_MODE[change.mode] }),
      ...(change.targetTemperature === undefined ? {} : { targetTemperature: change.targetTemperature }),
      ...(change.fanSpeed === undefined ? {} : { fanSpeed: change.fanSpeed }),
      swing: swing & swingMask,
      ...(change.eco === undefined ? {} : { eco: change.eco }),
      ...(change.turbo === undefined ? {} : { turbo: change.turbo }),
      ...(change.sleep === undefined ? {} : { sleep: change.sleep }),
      ...(change.display === undefined ? {} : { display: change.display }),
      ...(change.roomTemperature === undefined ? {} : { indoorTemperature: change.roomTemperature }),
      ...(change.outdoorTemperature === undefined || !has.has("outdoor-temperature")
        ? {}
        : { outdoorTemperature: change.outdoorTemperature }),
    };
    for (const [feature, value] of Object.entries(change.functions ?? {})) {
      const definition = FUNCTIONS[feature as FakeAirconFeature];
      if (definition !== undefined && properties.has(definition.id)) properties.set(definition.id, value);
    }
    return view();
  };

  /** Answers one frame, recording it, or undefined for a frame a unit ignores. */
  const answer = (frame: Buffer, record: (command: Unrecorded<FakeAirconCommand>) => void): Buffer | undefined => {
    const { body } = parseFrame(frame);
    const stateAnswer = (): Buffer => buildFrame(stateAnswerBody(state), FRAME_QUERY);
    switch (body[0]) {
      case QUERY_STATE:
        if (isToggleDisplay(body)) {
          state = { ...state, display: !state.display };
          record({ command: "toggle-display" });
        } else record({ command: "query-state" });
        return stateAnswer();
      case SET_STATE: {
        const settings = parseSetState(body);
        state = { ...state, ...settings, swing: settings.swing & swingMask };
        const { swing, mode, ...rest } = settings;
        record({
          command: "set-state",
          ...rest,
          mode: Object.entries(MIDEA_MODE).find(([, each]) => each === mode)?.[0] ?? String(mode),
          swing: {
            vertical: (swing & SWING_VERTICAL) === SWING_VERTICAL,
            horizontal: (swing & SWING_HORIZONTAL) === SWING_HORIZONTAL,
          },
        });
        return stateAnswer();
      }
      case QUERY_CAPABILITIES: {
        record({ command: "query-capabilities" });
        const split = entries.length > ENTRIES_PER_PAGE ? Math.ceil(entries.length / 2) : entries.length;
        const page = capabilitiesPageAsked(body);
        return buildFrame(
          page === 1
            ? capabilitiesAnswerBody(entries.slice(0, split), split < entries.length)
            : capabilitiesAnswerBody(entries.slice(split), false),
          FRAME_QUERY,
        );
      }
      case QUERY_PROPERTIES: {
        const asked = parsePropertiesQuery(body);
        record({ command: "query-functions", functions: asked.map(featureOf) });
        return buildFrame(
          propertiesAnswerBody(
            QUERY_PROPERTIES,
            asked.flatMap((property) => {
              const value = properties.get(property);
              return value === undefined ? [] : [{ id: property, value: Buffer.of(value) }];
            }),
          ),
          FRAME_QUERY,
        );
      }
      case SET_PROPERTIES: {
        const set = parsePropertiesSet(body).filter(({ id: property }) => properties.has(property));
        for (const { id: property, value } of set) properties.set(property, value[0] ?? 0);
        record({
          command: "set-functions",
          functions: Object.fromEntries(set.map(({ id: property, value }) => [featureOf(property), value[0] ?? 0])),
        });
        return buildFrame(propertiesAnswerBody(SET_PROPERTIES, set), FRAME_QUERY);
      }
      default:
        return undefined;
    }
  };

  const serve = (socket: Socket): void => {
    const connection = connections.length;
    const recorded: { version: 2 | 3; handshake: FakeAirconConnection["handshake"] } = { version, handshake: "none" };
    connections.push(recorded);
    let session: V3Session | undefined;
    let buffered = Buffer.alloc(0);

    const handle = (packet: Buffer): void => {
      let inner = packet;
      let count: number | null = null;
      if (version === 3) {
        if (!isV3Packet(packet)) throw new Error("A v3 unit takes only v3 packets");
        if (session === undefined) {
          const request = decodeV3Packet(packet);
          if (request.type !== V3_HANDSHAKE_REQUEST) throw new Error("A v3 unit takes the handshake first");
          // Still sulking at the last token refused: it says nothing, whatever the token.
          if (Date.now() < silentUntil) return;
          if (keys === undefined || !sameBytes(request.data, keys.token)) {
            silentUntil = Date.now() + silentAfterRefusalMs;
            recorded.handshake = "refused";
            socket.end(handshakeRefusal(request.count));
            return;
          }
          const made = handshakeAnswer(keys.key, request.count);
          session = made.session;
          recorded.handshake = "accepted";
          socket.write(made.packet);
          return;
        }
        const request = decodeV3Packet(packet, session.key);
        if (request.type !== V3_ENCRYPTED_REQUEST) return;
        inner = request.data;
        count = request.count;
      }
      const { frame } = decodeV2Packet(inner, { checkSignature: true });
      const answered = answer(frame, (command) => {
        commands.push({ ...command, receivedAt: Date.now(), connection, count });
      });
      if (answered === undefined) return;
      const reply = encodeV2Packet(answered, id, "unit");
      if (session === undefined) socket.write(reply);
      else {
        socket.write(encodeV3Packet(reply, V3_ENCRYPTED_ANSWER, session.sent, session.key));
        session.sent += 1;
      }
    };

    socket.on("data", (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      try {
        for (;;) {
          const length = isV3Packet(buffered)
            ? v3PacketLength(buffered)
            : isV2Packet(buffered)
              ? v2PacketLength(buffered)
              : buffered.length > 1
                ? -1
                : undefined;
          if (length === -1) throw new Error("Not a Midea packet");
          if (length === undefined || length > buffered.length) return;
          const packet = Buffer.from(buffered.subarray(0, length));
          buffered = buffered.subarray(length);
          handle(packet);
        }
      } catch {
        // What a unit can't read, it hangs up on, as far as anyone knows.
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
  };

  const sockets = new Set<Socket>();
  const tcp: Server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket);
  });

  const discovery: UdpSocket = createSocket({ type: "udp4" });
  discovery.on("message", (data, from) => {
    if (!isDiscoveryRequest(data)) return;
    discovery.send(
      encodeDiscoveryAnswer({ id, ip: host, port: tcpPort, serialNumber, name, type: 0xac, version }),
      from.port,
      from.address,
    );
  });

  const http = createHttpServer((request, response) => {
    void readBody(request).then((body) => {
      const path = request.url ?? "/";
      if (path === FAKE_AIRCON_STATE_PATH) {
        if (request.method === "POST") {
          const change = stateChangeIn(body);
          if (change === undefined) {
            sendJson(response, 400, {
              message: 'Send part of the state, e.g. {"power": true, "mode": "heat", "roomTemperature": 19.5}',
            });
            return;
          }
          setState(change);
        }
        sendJson(response, 200, view());
        return;
      }
      if (path === FAKE_AIRCON_COMMANDS_PATH) {
        if (request.method === "DELETE") commands.length = 0;
        sendJson(response, 200, commands);
        return;
      }
      if (path === FAKE_AIRCON_CONNECTIONS_PATH) {
        if (request.method === "DELETE") connections.length = 0;
        sendJson(response, 200, connections);
        return;
      }
      if (path === FAKE_AIRCON_KEYS_PATH && request.method === "POST") {
        const given = keysIn(body);
        if (version !== 3 || given === undefined) {
          sendJson(response, 400, {
            message:
              version === 3
                ? 'Send the token and key, in hex, e.g. {"token": "<128 hex digits>", "key": "<64 hex digits>"}'
                : "A v2 unit has no token or key",
          });
          return;
        }
        rekey(given.token, given.key);
        response.writeHead(204).end();
        return;
      }
      if (path === FAKE_AIRCON_CAPABILITIES_PATH) {
        sendJson(response, 200, { version, features, temperatureRanges });
        return;
      }
      sendJson(response, 404, { message: "No such path" });
    });
  });

  const rekey = (newToken: string, newKey: string): void => {
    if (version !== 3) throw new Error("A v2 unit has no token or key");
    keys = v3KeysFrom(newToken, newKey);
  };

  let stopped: Promise<void> | undefined;
  await listen(tcp, port, host);
  const tcpPort = (tcp.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    discovery.once("error", reject);
    discovery.bind(discoveryPort, host, () => {
      discovery.off("error", reject);
      resolve();
    });
  });
  await listen(http, httpPort, host);

  return {
    host,
    port: tcpPort,
    discoveryPort: discovery.address().port,
    httpPort: (http.address() as AddressInfo).port,
    version,
    id,
    serialNumber,
    name,
    get token() {
      return keys?.token.toString("hex");
    },
    get key() {
      return keys?.key.toString("hex");
    },
    rekey,
    features: [...features],
    state: view,
    setState,
    commands,
    connections,
    clear: () => {
      commands.length = 0;
      connections.length = 0;
    },
    stop: () =>
      (stopped ??= (async () => {
        for (const socket of sockets) socket.destroy();
        http.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) =>
            tcp.close(() => {
              resolve();
            }),
          ),
          new Promise<void>((resolve) =>
            http.close(() => {
              resolve();
            }),
          ),
          new Promise<void>((resolve) =>
            discovery.close(() => {
              resolve();
            }),
          ),
        ]);
      })()),
  };
};

/** The token and key from `POST /_fake/keys`, or undefined if they aren't 64 and 32 bytes in hex. */
const keysIn = (body: string): { token: string; key: string } | undefined => {
  let read: unknown;
  try {
    read = JSON.parse(body);
  } catch {
    return undefined;
  }
  const { token, key } = (read ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || !/^[0-9a-fA-F]{128}$/.test(token)) return undefined;
  if (typeof key !== "string" || !/^[0-9a-fA-F]{64}$/.test(key)) return undefined;
  return { token, key };
};

/** A change to the state, from `POST /_fake/state`, or undefined if it isn't one. */
const stateChangeIn = (body: string): Partial<FakeAirconState> | undefined => {
  let read: unknown;
  try {
    read = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) return undefined;
  const change = read as Record<string, unknown>;
  const booleans = ["power", "eco", "turbo", "sleep", "display"];
  const numbers = ["targetTemperature", "fanSpeed"];
  const temperatures = ["roomTemperature", "outdoorTemperature"];
  for (const [field, value] of Object.entries(change)) {
    if (booleans.includes(field) && typeof value !== "boolean") return undefined;
    if (numbers.includes(field) && (typeof value !== "number" || !Number.isFinite(value))) return undefined;
    if (temperatures.includes(field) && value !== null && (typeof value !== "number" || !Number.isFinite(value)))
      return undefined;
    if (field === "mode" && !(typeof value === "string" && value in MIDEA_MODE)) return undefined;
    if (field === "swing") {
      const swing = value as Record<string, unknown> | null;
      if (typeof swing?.vertical !== "boolean" || typeof swing.horizontal !== "boolean") return undefined;
    }
    if (field === "functions") {
      if (typeof value !== "object" || value === null) return undefined;
      if (
        !Object.values(value).every(
          (each) => Number.isInteger(each) && (each as number) >= 0 && (each as number) <= 255,
        )
      )
        return undefined;
    }
    if (![...booleans, ...numbers, ...temperatures, "mode", "swing", "functions"].includes(field)) return undefined;
  }
  return change;
};

const listen = (server: Server | ReturnType<typeof createHttpServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk as string;
  return body;
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
};
