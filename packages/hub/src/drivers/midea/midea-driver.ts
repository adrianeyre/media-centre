import { isIP } from "node:net";

import type {
  AirConditionerCapabilities,
  AirConditionerChange,
  AirConditionerState,
  CloudLogin,
} from "@media-centre/shared";

import {
  CredentialsRefused,
  DriverFailure,
  type AirConditionerDriver,
  type DiscoveredAirConditioner,
} from "../driver.ts";
import { capabilitiesFrom, modeFrom, stateFrom, type ReadCapabilities } from "./capabilities.ts";
import {
  CloudHasNoToken,
  TOKENS_RETIRED_CODE,
  CloudLoginRefused,
  cloudUdpId,
  CloudUnreachable,
  MIDEA_AIR_CLOUD_URL,
  MIDEA_CLOUD_URL,
  signInToMideaAirCloud,
  signInToMideaCloud,
  type CloudSession,
} from "./cloud.ts";
import { MIDEA_DISCOVERY_PORTS, searchForMideaUnits, type DiscoveryTarget, type FoundUnit } from "./discovery.ts";
import {
  FRAME_QUERY,
  FRAME_SET,
  MIDEA_FAN,
  MIDEA_MODE,
  NotAFrame,
  parseCapabilitiesAnswer,
  parsePropertiesAnswer,
  parseStateAnswer,
  QUERY_CAPABILITIES,
  QUERY_PROPERTIES,
  queryCapabilitiesBody,
  queryPropertiesBody,
  queryStateBody,
  SET_PROPERTIES,
  setPropertiesBody,
  setStateBody,
  STATE_ANSWER,
  SWING_HORIZONTAL,
  SWING_VERTICAL,
  toggleDisplayBody,
  type Entry,
  type MideaState,
} from "./frames.ts";
import { connectToUnit, UnitSilent, UnitUnreachable, type LanConnection } from "./lan-connection.ts";
import { HandshakeRefused, MIDEA_LAN_PORT, NotAPacket, v3KeysFrom, type V3Keys } from "./lan-packets.ts";

/**
 * What the Midea Driver keeps of a unit, as the credentials it hands the Hub:
 * its id, which every packet to it carries, its protocol version, and on v3
 * its token and key, in hex, as Midea's cloud issues them (ADR 0009).
 */
export interface MideaUnitCredentials {
  readonly id: number;
  readonly version: 2 | 3;
  readonly token?: string;
  readonly key?: string;
}

/** The credentials the Hub keeps for a unit, as text it never reads. They are secret: never log them (FR-51). */
export const mideaCredentials = (unit: MideaUnitCredentials): string =>
  JSON.stringify({
    id: unit.id,
    version: unit.version,
    ...(unit.token === undefined ? {} : { token: unit.token }),
    ...(unit.key === undefined ? {} : { key: unit.key }),
  });

/**
 * The unit refused the Hub's token and key, or answered with what its key
 * doesn't read, as after a factory reset, when its maker's cloud issues it
 * new ones: it can be reached, and needs them fetched again (FR-51). The Hub
 * tells it from an Air Conditioner it can't reach, which is a
 * {@link DriverFailure} "unreachable".
 */
export class MideaAuthError extends CredentialsRefused {
  constructor(
    address: string,
    message = `The Air Conditioner at ${address} refused the Hub's token and key. Fetch them again.`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MideaAuthError";
  }
}

export interface MideaDriverOptions {
  /** 6444 on a real unit. Only tests against the fake change it. */
  readonly port?: number;
  /** 6445 and 20086 on a real unit, where searches and identifying go. Only tests against the fake change them. */
  readonly discoveryPorts?: readonly number[];
  /**
   * Where "Find Air Conditioners" sends its search: the broadcast address on
   * a real network. Tests send it to each fake instead, where a broadcast
   * can't be relied on.
   */
  readonly searchTargets?: readonly DiscoveryTarget[];
  /** How long a search listens for units to answer. */
  readonly searchWindowMs?: number;
  /** How long a unit has to accept a connection. */
  readonly connectTimeoutMs?: number;
  /** How long a unit has to answer the handshake and each frame. */
  readonly answerTimeoutMs?: number;
  /**
   * Where Midea's cloud is, which a v3 unit's token and key are fetched from
   * once (ADR 0009): {@link MIDEA_CLOUD_URL}, the MSmartHome app's API, on a
   * real network. Tests give the fake cloud's instead, and never reach it.
   */
  readonly cloudUrl?: string;
  /**
   * Where Midea's older cloud is, which the Midea Air app signs in to, and
   * which the Driver signs in to when MSmartHome's refuses the login:
   * {@link MIDEA_AIR_CLOUD_URL} on a real network. Tests give the fake's.
   */
  readonly mideaAirCloudUrl?: string;
  /** How long the cloud has to answer each request. */
  readonly cloudTimeoutMs?: number;
  /**
   * How long to wait before asking again a unit that didn't answer as its
   * token and key were tried, as a real one, having refused one token, may
   * not answer the next connection for a while; and how many times to ask.
   */
  readonly settleMs?: number;
  readonly settleTries?: number;
  /** Where the Driver writes what it did, a line at a time. Never a token or a key (FR-51). */
  readonly log?: (line: string) => void;
}

/**
 * The Midea Driver: controls Midea Air Conditioners over their LAN protocol
 * on TCP port 6444, v2 and v3, with no cloud (ADR 0007). It finds them by
 * Midea's UDP discovery. On v3 it makes the handshake with the token and key
 * the Hub fetched once from Midea's cloud (ADR 0009), on each connection. It
 * reads a unit's capabilities and turns them into the Appliance's, so that
 * nothing outside it knows Midea's protocol (NFR-6), and keeps them, to read
 * and set its state by. It sets the state Midea's way, the whole of it at
 * once, from what the unit says now, and the display by toggling it, as
 * Midea has no command that sets it. It talks to one unit on one connection
 * at a time, as units are known to take one at a time, and closes it once
 * done. Midea's cloud is asked only by {@link AirConditionerDriver.fetchKeys}.
 */
export const mideaDriver = ({
  port = MIDEA_LAN_PORT,
  discoveryPorts = MIDEA_DISCOVERY_PORTS,
  searchTargets,
  searchWindowMs = 3_000,
  connectTimeoutMs = 3_000,
  answerTimeoutMs = 5_000,
  cloudUrl = MIDEA_CLOUD_URL,
  mideaAirCloudUrl = MIDEA_AIR_CLOUD_URL,
  cloudTimeoutMs = 15_000,
  settleMs = 5_000,
  settleTries = 3,
  log = console.log,
}: MideaDriverOptions = {}): AirConditionerDriver => {
  const unreachable = (address: string, cause?: unknown): DriverFailure =>
    new DriverFailure(
      "unreachable",
      `No Air Conditioner answered at ${address}. Check that it is switched on and on the same network as the Hub.`,
      { cause },
    );

  /** Reads the credentials the Hub kept, which come from outside the Driver. Never quotes them. */
  const unitIn = (address: string, credentials: string): { id: number; keys?: V3Keys } => {
    const refused = new DriverFailure(
      "not-recognised",
      `The Hub's credentials for the Air Conditioner at ${address} aren't the Midea Driver's.`,
    );
    let read: unknown;
    try {
      read = JSON.parse(credentials);
    } catch {
      throw refused;
    }
    const { id, version, token, key } = (read ?? {}) as Partial<Record<keyof MideaUnitCredentials, unknown>>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || (version !== 2 && version !== 3))
      throw refused;
    if (version === 2) return { id };
    if (token === undefined && key === undefined) {
      // As discovery finds a v3 unit, before its keys are fetched (ADR 0009).
      throw new MideaAuthError(
        address,
        `The Air Conditioner at ${address} answers only once its token and key are fetched from Midea's cloud.`,
      );
    }
    if (typeof token !== "string" || typeof key !== "string") throw refused;
    try {
      return { id, keys: v3KeysFrom(token, key) };
    } catch {
      throw refused;
    }
  };

  /** The work on each unit, by address, so that each waits for the one before. */
  const queues = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(address: string, work: () => Promise<T>): Promise<T> => {
    const before = queues.get(address) ?? Promise.resolve();
    const done = before.catch(() => undefined).then(work);
    const tail = done.catch(() => undefined);
    queues.set(address, tail);
    void tail.then(() => {
      if (queues.get(address) === tail) queues.delete(address);
    });
    return done;
  };

  /** Connects to the unit, does `work`, and closes, in the Driver's terms: each failure the Hub tells apart. */
  const withUnit = <T>(address: string, credentials: string, work: (connection: LanConnection) => Promise<T>) =>
    oneAtATime(address, async () => {
      const unit = unitIn(address, credentials);
      let connection: LanConnection | undefined;
      try {
        connection = await connectToUnit(
          { address, port, ...unit },
          { connectMs: connectTimeoutMs, answerMs: answerTimeoutMs },
        );
        return await work(connection);
      } catch (error) {
        if (error instanceof DriverFailure) throw error;
        if (error instanceof HandshakeRefused) {
          // Why, as the handshake saw it, which says nothing of the token or key.
          log(
            `The Air Conditioner at ${address} refused the Hub's token and key, so they need fetching again (${error.message})`,
          );
          throw new MideaAuthError(address);
        }
        if (error instanceof UnitUnreachable) throw unreachable(address, error);
        if (error instanceof UnitSilent) {
          throw new DriverFailure("timed-out", `The Air Conditioner at ${address} didn't answer.`, { cause: error });
        }
        if (error instanceof NotAPacket || error instanceof NotAFrame) {
          throw new DriverFailure(
            "not-recognised",
            `What answered at ${address} is not an Air Conditioner the Hub can control.`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        connection?.close();
      }
    });

  const answers = (first: number) => (body: Buffer) => body[0] === first;

  const readMideaState = async (connection: LanConnection): Promise<MideaState> =>
    parseStateAnswer(await connection.ask(queryStateBody(), FRAME_QUERY, answers(STATE_ANSWER)));

  const readEntries = async (connection: LanConnection): Promise<Entry[]> => {
    const first = parseCapabilitiesAnswer(
      await connection.ask(queryCapabilitiesBody(1), FRAME_QUERY, answers(QUERY_CAPABILITIES)),
    );
    if (!first.more) return first.entries;
    const second = parseCapabilitiesAnswer(
      await connection.ask(queryCapabilitiesBody(2), FRAME_QUERY, answers(QUERY_CAPABILITIES)),
    );
    return [...first.entries, ...second.entries];
  };

  /** Each unit's capabilities, as last read, by its address and id. */
  const known = new Map<string, ReadCapabilities>();
  const knownKey = (address: string, credentials: string): string =>
    `${address}/${String(unitIn(address, credentials).id)}`;

  const capabilitiesOn = async (
    address: string,
    credentials: string,
    connection: LanConnection,
  ): Promise<ReadCapabilities> => {
    const kept = known.get(knownKey(address, credentials));
    if (kept !== undefined) return kept;
    const read = capabilitiesFrom(await readEntries(connection), await readMideaState(connection));
    known.set(knownKey(address, credentials), read);
    if (read.unknown.length > 0) {
      const ids = read.unknown.map((id) => `0x${id.toString(16).padStart(4, "0")}`).join(", ");
      log(
        `The Air Conditioner at ${address} reports functions the Midea Driver doesn't know, which it leaves out: ${ids}`,
      );
    }
    return read;
  };

  const stateOn = async (connection: LanConnection, read: ReadCapabilities): Promise<AirConditionerState> => {
    const state = await readMideaState(connection);
    const values =
      read.functions.length === 0
        ? new Map<number, Buffer>()
        : parsePropertiesAnswer(
            await connection.ask(
              queryPropertiesBody(read.functions.map(({ capability }) => capability)),
              FRAME_QUERY,
              answers(QUERY_PROPERTIES),
            ),
          );
    return stateFrom(state, read, values);
  };

  const identified = (unit: FoundUnit): DiscoveredAirConditioner => ({
    address: unit.address,
    name: unit.name,
    model: `Midea, protocol v${String(unit.version)}`,
    serialNumber: unit.serialNumber,
    credentials: mideaCredentials({ id: unit.id, version: unit.version }),
    needsKeys: unit.version === 3,
  });

  const readCapabilities = (address: string, credentials: string): Promise<AirConditionerCapabilities> =>
    withUnit(address, credentials, async (connection) => {
      known.delete(knownKey(address, credentials));
      return (await capabilitiesOn(address, credentials, connection)).capabilities;
    });

  /** The unit's id and version, from credentials as discovery gives them or as the Hub kept them. */
  const unitIdIn = (address: string, credentials: string): MideaUnitCredentials => {
    try {
      unitIn(address, credentials);
    } catch (error) {
      // A v3 unit whose keys aren't fetched yet is just what this is for.
      if (!(error instanceof MideaAuthError)) throw error;
    }
    const { id, version } = JSON.parse(credentials) as MideaUnitCredentials;
    return { id, version };
  };

  /**
   * Signs in to Midea's cloud with the owner's login, MSmartHome's, or else
   * Midea Air's, whose accounts MSmartHome doesn't know, asks it for the unit's
   * token and key by its UDP id, in each byte order its id may be hashed in,
   * as msmart-ng does, and keeps the first the unit accepts, reading its
   * capabilities with them. The login goes no further than the cloud.
   */
  /**
   * Tries a token and key the cloud issued on the unit, asking it again
   * after {@link settleMs} while it doesn't answer, up to {@link settleTries}
   * times: a real unit that has just refused one token may not answer the
   * next connection at once.
   */
  const triedPatiently = async (address: string, fetched: string): Promise<void> => {
    for (let tried = 1; ; tried += 1) {
      try {
        await readCapabilities(address, fetched);
        return;
      } catch (error) {
        if (!(error instanceof DriverFailure) || error.reason !== "timed-out" || tried >= settleTries) throw error;
        log(
          `The Air Conditioner at ${address} didn't answer as its token and key were tried, so the Hub asks again in ${String(Math.round(settleMs / 1000))} seconds`,
        );
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
    }
  };

  const fetchKeys = async (address: string, credentials: string, login: CloudLogin): Promise<string> => {
    const { id, version } = unitIdIn(address, credentials);
    if (version !== 3) {
      throw new DriverFailure("not-supported", `The Air Conditioner at ${address} needs no token or key.`);
    }
    const cloudUnreachable = (cause: unknown): DriverFailure =>
      new DriverFailure(
        "unreachable",
        "The Hub couldn't reach Midea's cloud. Adding a v3 Air Conditioner needs the internet, once.",
        { cause },
      );
    // An email autofilled with a space after it is another account to the cloud, which says it doesn't exist.
    const owner = { ...login, account: login.account.trim() };
    const clouds = [
      {
        app: "MSmartHome",
        signIn: () => signInToMideaCloud(owner, { baseUrl: cloudUrl, timeoutMs: cloudTimeoutMs, log }),
      },
      {
        app: "Midea Air",
        signIn: () => signInToMideaAirCloud(owner, { baseUrl: mideaAirCloudUrl, timeoutMs: cloudTimeoutMs }),
      },
    ];
    let session: CloudSession | undefined;
    let signedInTo = "";
    let unreachableCause: unknown;
    for (const { app, signIn } of clouds) {
      try {
        session = await signIn();
        signedInTo = app;
        break;
      } catch (error) {
        if (error instanceof CloudLoginRefused) {
          // Its code alone, which says why, never the login.
          log(`${app}'s cloud refused the login${error.code === undefined ? "" : ` with code ${error.code}`}`);
          continue;
        }
        unreachableCause = error;
      }
    }
    if (session === undefined) {
      if (unreachableCause !== undefined) throw cloudUnreachable(unreachableCause);
      throw new DriverFailure(
        "refused",
        "Neither MSmartHome nor Midea Air accepted that email and password. " +
          "Check them, as you sign in to the app the Air Conditioner is set up in, then try again.",
      );
    }
    // The unit's own id first, as the account usually knows it by that, then
    // each Air Conditioner the account lists, as it may know it by another.
    const codes = [String(id)];
    let listed = false;
    /** Each code a cloud answered in place of a token, to tell Midea Air's retired service. */
    const answered: (string | undefined)[] = [];
    for (let at = 0; at < codes.length; at += 1) {
      const code = codes[at] ?? "";
      for (const byteOrder of ["little", "big"] as const) {
        let issued;
        try {
          issued = await session.tokenFor(cloudUdpId(id, byteOrder), code);
        } catch (error) {
          if (error instanceof CloudHasNoToken) {
            answered.push(error.code);
            log(
              `${signedInTo}'s cloud has no token for the Air Conditioner at ${address} by its ${byteOrder}-endian id, as appliance ${code}: ${error.why}`,
            );
            continue;
          }
          if (error instanceof CloudUnreachable) throw cloudUnreachable(error);
          throw error;
        }
        const fetched = mideaCredentials({ id, version, token: issued.token, key: issued.key });
        try {
          await triedPatiently(address, fetched);
        } catch (error) {
          if (error instanceof MideaAuthError) {
            log(
              `The Air Conditioner at ${address} refused the token and key ${signedInTo}'s cloud issued for its ${byteOrder}-endian id, as appliance ${code}`,
            );
            continue;
          }
          throw error;
        }
        log(`Fetched the token and key of the Air Conditioner at ${address} from ${signedInTo}'s cloud`);
        return fetched;
      }
      if (at === codes.length - 1 && !listed) {
        listed = true;
        let listedCodes: string[];
        try {
          listedCodes = await session.airConditionerCodes();
        } catch (error) {
          if (error instanceof CloudUnreachable) throw cloudUnreachable(error);
          throw error;
        }
        for (const each of listedCodes) if (!codes.includes(each)) codes.push(each);
      }
    }
    if (signedInTo === "Midea Air" && answered.length > 0 && answered.every((code) => code === TOKENS_RETIRED_CODE)) {
      throw new DriverFailure(
        "refused",
        "Midea no longer issues the token and key through Midea Air's cloud, though it signs you in. " +
          "Pair the Air Conditioner in the MSmartHome app, with a new MSmartHome account rather than one moved from Midea Air, " +
          "then sign in with that.",
      );
    }
    throw new MideaAuthError(
      address,
      `Midea's cloud issued no token and key that the Air Conditioner at ${address} accepts. ` +
        `Check that it is paired in that ${signedInTo} account's app, not just shared with it, then try again.`,
    );
  };

  return {
    ports: new Map([[MIDEA_LAN_PORT, "Midea Air Conditioner"]]),
    /** Searches by Midea's UDP discovery. A unit that answers twice, on both ports, is found once. */
    discover: async () => {
      try {
        const found = await searchForMideaUnits({
          windowMs: searchWindowMs,
          ...(searchTargets === undefined ? {} : { targets: searchTargets }),
        });
        return found.map(identified);
      } catch (error) {
        throw new DriverFailure(
          "unreachable",
          "The Hub couldn't search its network for Air Conditioners. Add the Air Conditioner by its IP address instead.",
          { cause: error },
        );
      }
    },

    /** Sends the search to the unit's own address alone. */
    identify: async (address) => {
      if (isIP(address) !== 4) throw new DriverFailure("not-supported", `"${address}" is not an IPv4 address.`);
      const found = await searchForMideaUnits({
        targets: discoveryPorts.map((discoveryPort) => ({ host: address, port: discoveryPort })),
        windowMs: Math.min(searchWindowMs, answerTimeoutMs),
      }).catch((error: unknown) => {
        throw unreachable(address, error);
      });
      const unit = found.find((each) => each.address === address);
      if (unit === undefined) throw unreachable(address);
      return identified(unit);
    },

    fetchKeys,

    readCapabilities,

    readState: (address, credentials) =>
      withUnit(address, credentials, async (connection) =>
        stateOn(connection, await capabilitiesOn(address, credentials, connection)),
      ),

    setState: (address, credentials, change) =>
      withUnit(address, credentials, async (connection) => {
        const read = await capabilitiesOn(address, credentials, connection);
        const functions = functionEntries(read, change);
        const current = await readMideaState(connection);
        const settings = settingsFor(current, read.capabilities, change);

        let display = current.display;
        if (settings !== undefined)
          display = parseStateAnswer(
            await connection.ask(setStateBody(settings), FRAME_SET, answers(STATE_ANSWER)),
          ).display;
        if (change.display !== undefined && change.display !== display) {
          await connection.ask(toggleDisplayBody(), FRAME_QUERY, answers(STATE_ANSWER));
        }
        if (functions.length > 0)
          await connection.ask(setPropertiesBody(functions), FRAME_SET, answers(SET_PROPERTIES));
        return stateOn(connection, read);
      }),
  };
};

/** Refuses a change the unit hasn't the capability for, saying why to the person. */
const notSupported = (message: string): DriverFailure => new DriverFailure("not-supported", message);

/**
 * The whole of what the set command sets, from what the unit says now and
 * what is to change, or undefined where none of it changes. Each change is
 * checked against the unit's capabilities first. A mode whose range the
 * target temperature is outside of takes the nearest it has.
 */
const settingsFor = (
  current: MideaState,
  capabilities: AirConditionerCapabilities,
  change: AirConditionerChange,
): MideaState | undefined => {
  const { power, mode, targetTemperature, fanSpeed, swing, preset } = change;
  if (
    power === undefined &&
    mode === undefined &&
    targetTemperature === undefined &&
    fanSpeed === undefined &&
    swing === undefined &&
    preset === undefined
  ) {
    return undefined;
  }
  if (power !== undefined && !capabilities.power)
    throw notSupported("This Air Conditioner can't be switched on and off.");

  const modeName = mode ?? modeFrom(current.mode);
  const modeCapability = capabilities.modes.find((each) => each.mode === modeName);
  if (modeCapability === undefined) throw notSupported(`This Air Conditioner has no ${modeName} mode.`);
  const range = modeCapability.temperature;
  let target = current.targetTemperature;
  if (targetTemperature !== undefined) {
    if (range === null) throw notSupported(`This Air Conditioner takes no target temperature in ${modeName} mode.`);
    if (
      !Number.isFinite(targetTemperature) ||
      targetTemperature < range.min ||
      targetTemperature > range.max ||
      !Number.isInteger((targetTemperature - range.min) / range.step)
    ) {
      throw notSupported(
        `This Air Conditioner takes ${String(range.min)}° to ${String(range.max)}° in ${modeName} mode, ` +
          (range.step === 1 ? "in whole degrees." : "in half degrees."),
      );
    }
    target = targetTemperature;
  } else if (range !== null) {
    target = Math.min(range.max, Math.max(range.min, target));
  }

  let speed = current.fanSpeed;
  if (fanSpeed !== undefined) {
    if (fanSpeed === "auto" ? !capabilities.fan.auto : !capabilities.fan.speeds.includes(fanSpeed)) {
      throw notSupported(`This Air Conditioner has no ${fanSpeed} fan.`);
    }
    speed = MIDEA_FAN[fanSpeed];
  }

  let swingBits = current.swing;
  for (const [way, bits] of [
    ["vertical", SWING_VERTICAL],
    ["horizontal", SWING_HORIZONTAL],
  ] as const) {
    const on = swing?.[way];
    if (on === undefined) continue;
    if (!capabilities.swing[way])
      throw notSupported(`This Air Conditioner doesn't swing ${way === "vertical" ? "up and down" : "side to side"}.`);
    swingBits = on ? swingBits | bits : swingBits & ~bits;
  }

  let { eco, turbo, sleep } = current;
  if (preset !== undefined) {
    if (preset !== null && !capabilities.presets.includes(preset))
      throw notSupported(`This Air Conditioner has no ${preset} preset.`);
    eco = preset === "eco";
    turbo = preset === "turbo";
    sleep = preset === "sleep";
  }

  return {
    ...current,
    power: power ?? current.power,
    mode: MIDEA_MODE[modeName],
    targetTemperature: target,
    fanSpeed: speed,
    swing: swingBits,
    eco,
    turbo,
    sleep,
  };
};

/** The further functions to set, each to its value, checked against the unit's capabilities. */
const functionEntries = (read: ReadCapabilities, change: AirConditionerChange): Entry[] =>
  Object.entries(change.functions ?? {}).map(([id, value]) => {
    const definition = read.functions.find((each) => each.id === id);
    if (definition === undefined) throw notSupported(`This Air Conditioner has no function "${id}".`);
    if (definition.kind === "on-off") {
      if (typeof value !== "boolean") throw notSupported(`${definition.name} is on or off.`);
      return { id: definition.capability, value: Buffer.of(value ? 1 : 0) };
    }
    const unitValue = typeof value === "string" ? definition.values[value] : undefined;
    if (unitValue === undefined) {
      throw notSupported(`${definition.name} is one of ${definition.options.map(({ name }) => name).join(", ")}.`);
    }
    return { id: definition.capability, value: Buffer.of(unitValue) };
  });

/**
 * The Midea Driver, with the ports and search targets in the Hub's
 * environment, which only tests against the fake set: `MIDEA_PORT` for its
 * TCP port, `MIDEA_DISCOVERY_PORT` for where it identifies a unit by
 * address, and `MIDEA_SEARCH_TARGETS`, IPv4 `host:port` pairs separated by
 * commas, for where "Find Air Conditioners" searches; and `MIDEA_CLOUD_URL`
 * and `MIDEA_AIR_CLOUD_URL` for where it fetches a v3 unit's token and key,
 * MSmartHome's and Midea Air's, the fake clouds' in place of Midea's. One is
 * never set without the other, so that a test never reaches a real cloud.
 */
export const mideaDriverFromEnvironment = (env: Readonly<Record<string, string | undefined>>): AirConditionerDriver => {
  const portIn = (variable: string): number | undefined => {
    const value = env[variable];
    if (value === undefined) return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`${variable} must be a port number, not "${value}"`);
    return port;
  };
  const port = portIn("MIDEA_PORT");
  const discoveryPort = portIn("MIDEA_DISCOVERY_PORT");
  const targets = env.MIDEA_SEARCH_TARGETS;
  const cloudUrl = env.MIDEA_CLOUD_URL;
  const mideaAirCloudUrl = env.MIDEA_AIR_CLOUD_URL;
  for (const [variable, url] of [
    ["MIDEA_CLOUD_URL", cloudUrl],
    ["MIDEA_AIR_CLOUD_URL", mideaAirCloudUrl],
  ] as const) {
    if (url !== undefined && !/^https?:\/\/./.test(url)) {
      throw new Error(`${variable} must be an http:// or https:// URL, not "${url}"`);
    }
  }
  if ((cloudUrl === undefined) !== (mideaAirCloudUrl === undefined)) {
    throw new Error("MIDEA_CLOUD_URL and MIDEA_AIR_CLOUD_URL are set together, or neither is");
  }
  return mideaDriver({
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
    ...(mideaAirCloudUrl === undefined ? {} : { mideaAirCloudUrl }),
    ...(port === undefined ? {} : { port }),
    ...(discoveryPort === undefined ? {} : { discoveryPorts: [discoveryPort] }),
    ...(targets === undefined ? {} : { searchTargets: searchTargetsIn(targets) }),
  });
};

const searchTargetsIn = (value: string): DiscoveryTarget[] =>
  value.split(",").map((each) => {
    const match = /^\s*([0-9.]+):([0-9]{1,5})\s*$/.exec(each);
    const port = Number(match?.[2]);
    if (match?.[1] === undefined || isIP(match[1]) !== 4 || port < 1 || port > 65_535) {
      throw new Error(`MIDEA_SEARCH_TARGETS must be IPv4 host:port pairs, separated by commas, not "${value}"`);
    }
    return { host: match[1], port };
  });
