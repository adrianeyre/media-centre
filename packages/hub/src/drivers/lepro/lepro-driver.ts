import { isIP } from "node:net";

import {
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_BRIGHTNESS_MIN,
  type LightCapabilities,
  type LightChange,
} from "@media-centre/shared";

import { CredentialsRefused, DriverFailure, type DiscoveredLight, type LightDriver } from "../driver.ts";
import {
  LightRefusedKeys,
  LightSilent,
  LightUnreachable,
  NotALight,
  type HeardLight,
  type LightAt,
  type LightSession,
  type LightTransport,
  type SearchTarget,
} from "./transport.ts";
import { tuyaTransport } from "./tuya.ts";

/**
 * What the Lepro Driver keeps of a Light, as the credentials it hands the
 * Hub: its id, which says which Light it is, and its key, which its maker
 * issues it as it is paired in LampUX. Discovery finds the id alone.
 */
export interface LeproLightCredentials {
  readonly id: string;
  readonly key?: string;
}

/** The credentials the Hub keeps for a Light, as text it never reads. They are secret: never log them (FR-4). */
export const leproCredentials = (light: LeproLightCredentials): string =>
  JSON.stringify({ id: light.id, ...(light.key === undefined ? {} : { key: light.key }) });

/**
 * The Light refused the Hub's id and key, or answered with what the key
 * doesn't read, as after it is paired again in LampUX, which issues it a new
 * key: it can be reached, and needs its key again. The Hub tells it from a
 * Light it can't reach, which is a {@link DriverFailure} "unreachable".
 */
export class LeproKeyRefused extends CredentialsRefused {
  constructor(
    address: string,
    message = `The Light at ${address} refused the Hub's key. Give the Hub its key again.`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LeproKeyRefused";
  }
}

/** What a Lepro Light is called until the person names it, as it gives no name of its own. */
const LIGHT_NAME = "Lepro Light";

export interface LeproDriverOptions {
  /** How the Driver reaches each Light: by Tuya's local protocol unless a test gives another. */
  readonly transport?: LightTransport;
  /** Where the Driver writes what it did, a line at a time. Never a Light's id or key (FR-4). */
  readonly log?: (line: string) => void;
}

/**
 * The Lepro Driver: controls Lepro's Lights on the home network, with no
 * cloud (ADR 0007), through its {@link LightTransport}, which alone knows the
 * protocol they speak. It finds them by their announcements, reads which
 * controls each has, on/off, brightness, colour temperature and colour, as
 * the Appliance's capabilities (FR-52, NFR-6), and reads and sets each,
 * checking each change against them first. It talks to one Light on one
 * connection at a time, as a Light takes only one, and closes it once done.
 */
export const leproDriver = ({
  transport = tuyaTransport(),
  log = console.log,
}: LeproDriverOptions = {}): LightDriver => {
  const unreachable = (address: string, cause?: unknown): DriverFailure =>
    new DriverFailure(
      "unreachable",
      `No Light answered at ${address}. Check that it is switched on and on the same network as the Hub.`,
      { cause },
    );

  /** Reads the credentials the Hub kept, which come from outside the Driver. Never quotes them. */
  const lightIn = (address: string, credentials: string): LightAt => {
    const refused = new DriverFailure(
      "not-recognised",
      `The Hub's credentials for the Light at ${address} aren't the Lepro Driver's.`,
    );
    let read: unknown;
    try {
      read = JSON.parse(credentials);
    } catch {
      throw refused;
    }
    const { id, key } = (read ?? {}) as Partial<Record<keyof LeproLightCredentials, unknown>>;
    if (key === undefined && typeof id === "string") {
      // As discovery finds a Light, before the Hub has its key.
      throw new LeproKeyRefused(address, `The Light at ${address} answers only once the Hub has its key.`);
    }
    const keys = { id, key };
    if (!transport.areKeys(keys)) throw refused;
    return { address, id: keys.id, key: keys.key };
  };

  /** The id in credentials the Driver handed the Hub, or undefined for what isn't. Never quoted. */
  const idIn = (credentials: string): string | undefined => {
    try {
      const { id } = (JSON.parse(credentials) ?? {}) as Partial<Record<keyof LeproLightCredentials, unknown>>;
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  };

  /** The work on each Light, by address, so that each waits for the one before. */
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

  /** Connects to the Light, does `work`, and closes, in the Driver's terms: each failure the Hub tells apart. */
  const withLight = <T>(address: string, credentials: string, work: (session: LightSession) => Promise<T>) =>
    oneAtATime(address, async () => {
      const light = lightIn(address, credentials);
      let session: LightSession | undefined;
      try {
        session = await transport.connect(light);
        return await work(session);
      } catch (error) {
        if (error instanceof DriverFailure) throw error;
        if (error instanceof LightRefusedKeys) {
          log(`The Light at ${address} refused the Hub's key, so it needs giving again`);
          throw new LeproKeyRefused(address);
        }
        if (error instanceof LightUnreachable) throw unreachable(address, error);
        if (error instanceof LightSilent) {
          throw new DriverFailure("timed-out", `The Light at ${address} didn't answer.`, { cause: error });
        }
        if (error instanceof NotALight) {
          throw new DriverFailure("not-recognised", `What answered at ${address} is not a Light the Hub can control.`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        session?.close();
      }
    });

  const discovered = (light: HeardLight): DiscoveredLight => ({
    address: light.address,
    name: LIGHT_NAME,
    model: light.model,
    credentials: leproCredentials({ id: light.id }),
  });

  return {
    ...(transport.ports === undefined ? {} : { ports: transport.ports }),

    discover: async () => {
      try {
        const note = (line: string): void => {
          log(`Find Lights: ${line}`);
        };
        return (await transport.search(undefined, note)).map(discovered);
      } catch (error) {
        log(`Find Lights: the search failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new DriverFailure(
          "unreachable",
          "The Hub couldn't search its network for Lights. Add the Light by its IP address instead.",
          { cause: error },
        );
      }
    },

    identify: async (address) => {
      if (isIP(address) !== 4) throw new DriverFailure("not-supported", `"${address}" is not an IPv4 address.`);
      const note = (line: string): void => {
        log(`Add the Light at ${address}: ${line}`);
      };
      const heard = await transport.search(address, note).catch((error: unknown) => {
        throw unreachable(address, error);
      });
      const light = heard.find((each) => each.address === address);
      if (light === undefined) throw unreachable(address);
      return discovered(light);
    },

    given: (address, id) => ({
      address,
      name: LIGHT_NAME,
      model: transport.model,
      credentials: leproCredentials({ id: id.trim() }),
    }),

    withKey: (found, key) => {
      const keys = { id: idIn(found), key };
      if (!transport.areKeys(keys)) {
        throw new DriverFailure(
          "not-supported",
          "That isn't a Lepro Light's device id and local key. Check each, as they were read from the Light.",
        );
      }
      return leproCredentials(keys);
    },

    isSameLight: (credentials, other) => {
      const id = idIn(credentials);
      return id !== undefined && id === idIn(other);
    },

    readCapabilities: (address, credentials) =>
      withLight(address, credentials, async (session) => (await session.read()).capabilities),

    readState: (address, credentials) =>
      withLight(address, credentials, async (session) => (await session.read()).state),

    setState: (address, credentials, change) =>
      withLight(address, credentials, async (session) => {
        const { capabilities } = await session.read();
        checkChange(capabilities, change);
        await session.write(change);
        return (await session.read()).state;
      }),
  };
};

/** Refuses a change the Light hasn't the capability for, saying why to the person. */
const notSupported = (message: string): DriverFailure => new DriverFailure("not-supported", message);

const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/**
 * Checks each part of a change, which comes from outside the Hub, against
 * the Light's capabilities, and throws {@link DriverFailure} "not-supported"
 * for any it can't take, before anything is sent.
 */
const checkChange = (capabilities: LightCapabilities, change: LightChange): void => {
  const { on, brightness, colourTemperature, colour } = change as Partial<Record<keyof LightChange, unknown>>;
  if (on !== undefined && typeof on !== "boolean") throw notSupported("A Light is either on or off.");
  if (on !== undefined && !capabilities.onOff) throw notSupported("This Light can't be switched on and off.");
  if (brightness !== undefined) {
    if (!capabilities.brightness) throw notSupported("This Light doesn't dim.");
    if (!isWhole(brightness, LIGHT_BRIGHTNESS_MIN, LIGHT_BRIGHTNESS_MAX)) {
      throw notSupported(
        `This Light's brightness goes from ${String(LIGHT_BRIGHTNESS_MIN)}% to ${String(LIGHT_BRIGHTNESS_MAX)}%, in whole percent.`,
      );
    }
  }
  if (colourTemperature !== undefined && colour !== undefined) {
    throw notSupported("A Light shows white at a colour temperature or a colour, not both at once.");
  }
  if (colourTemperature !== undefined) {
    const range = capabilities.colourTemperature;
    if (range === null) throw notSupported("This Light has no colour temperatures.");
    if (!isWhole(colourTemperature, range.min, range.max)) {
      throw notSupported(`This Light's colour temperature goes from ${String(range.min)} K to ${String(range.max)} K.`);
    }
  }
  if (colour !== undefined) {
    if (!capabilities.colour) throw notSupported("This Light has no colours.");
    const { hue, saturation } = (colour ?? {}) as Partial<Record<"hue" | "saturation", unknown>>;
    if (!isWhole(hue, 0, 359) || !isWhole(saturation, 0, 100)) {
      throw notSupported("A colour is a hue from 0° to 359° and a saturation from 0% to 100%, each whole.");
    }
  }
};

/**
 * The Lepro Driver as the Hub runs it, from its environment, which tests
 * against the fake Lepro Light change and nothing else should:
 *
 * - `LEPRO_PORT` is where each Light takes connections.
 * - `LEPRO_DISCOVERY_PORT` is where a search listens, or, with
 *   `LEPRO_SEARCH_TARGETS`, where it asks a Light by its address.
 * - `LEPRO_SEARCH_TARGETS` is the `host:port` of each Light to ask,
 *   separated by commas, as a broadcast can't be relied on in tests.
 */
export const leproDriverFromEnvironment = (env: Readonly<Record<string, string | undefined>>): LightDriver => {
  const portIn = (variable: string): number | undefined => {
    const value = env[variable];
    if (value === undefined) return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`${variable} must be a port number, not "${value}"`);
    return port;
  };
  const port = portIn("LEPRO_PORT");
  const discoveryPort = portIn("LEPRO_DISCOVERY_PORT");
  const targets = env.LEPRO_SEARCH_TARGETS;
  return leproDriver({
    transport: tuyaTransport({
      ...(port === undefined ? {} : { port }),
      ...(discoveryPort === undefined ? {} : { discoveryPorts: [discoveryPort] }),
      ...(targets === undefined ? {} : { searchTargets: searchTargetsIn(targets) }),
    }),
  });
};

const searchTargetsIn = (value: string): SearchTarget[] =>
  value.split(",").map((each) => {
    const match = /^\s*([0-9.]+):([0-9]{1,5})\s*$/.exec(each);
    const port = Number(match?.[2]);
    if (match?.[1] === undefined || isIP(match[1]) !== 4 || port < 1 || port > 65_535) {
      throw new Error(`LEPRO_SEARCH_TARGETS must be IPv4 host:port pairs, separated by commas, not "${value}"`);
    }
    return { host: match[1], port };
  });
