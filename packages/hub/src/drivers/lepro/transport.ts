/**
 * How the Lepro Driver reaches a Lepro Light: the one interface between the
 * Driver and the protocol the Light speaks, in the Appliance's terms alone.
 * Everything that protocol is lives behind it, in one module, `tuya.ts`, so
 * that if Lepro's Lights turn out to speak something else, only that module
 * and the fake Lepro Light change, and the Driver doesn't.
 *
 * Nothing here, nor in what implements it, logs, but for what a search notes
 * to the Driver, and nothing it notes or throws quotes a Light's id or key
 * (FR-4).
 */
import type { LightCapabilities, LightChange, LightState } from "@media-centre/shared";

/** What says which Light it is, and lets the Hub in: its id, and the key its maker issued it. Both are secret. */
export interface LightKeys {
  readonly id: string;
  readonly key: string;
}

/** A Light to connect to, at its address, with its keys. */
export interface LightAt extends LightKeys {
  readonly address: string;
}

/** Where to send a search: one Light's own address and port, where a broadcast can't be relied on. */
export interface SearchTarget {
  readonly host: string;
  readonly port: number;
}

/** A Light the transport heard on the home network, and what it said of itself. */
export interface HeardLight {
  readonly address: string;
  /** Its id, which is secret, as {@link LightKeys.id}. */
  readonly id: string;
  /** What it is, for the person, e.g. its make and protocol. */
  readonly model: string;
}

/** What a Light reports: the controls it has, and what it is doing now. */
export interface LightReport {
  readonly capabilities: LightCapabilities;
  readonly state: LightState;
}

/** One connection to a Light, which the Driver closes once done. */
export interface LightSession {
  /** Reads what the Light reports now. */
  readonly read: () => Promise<LightReport>;
  /**
   * Sends `change`, which the Driver has checked against the capabilities
   * the Light last reported, and resolves once the Light has taken it. It
   * works from what the Light last reported, reading it first if it hasn't.
   */
  readonly write: (change: LightChange) => Promise<void>;
  readonly close: () => void;
}

export interface LightTransport {
  /**
   * Finds the Lights on the Hub's subnet, or only the one at `address`,
   * which it resolves with as soon as it hears it, and each other once.
   * `note` hears what it did, a line at a time, for the Hub's log: what it
   * heard, and why each wasn't a Light. Never a Light's id or key.
   */
  readonly search: (address?: string, note?: (line: string) => void) => Promise<HeardLight[]>;
  /** Connects to the Light. Rejects with one of the errors below. */
  readonly connect: (light: LightAt) => Promise<LightSession>;
  /** Whether `id` and `key` could be a Light's, as the protocol has them. */
  readonly areKeys: (keys: { readonly id: unknown; readonly key: unknown }) => keys is LightKeys;
  /** What each Light it reaches is, for the person, as {@link HeardLight.model} says of one it heard. */
  readonly model: string;
  /** The TCP ports a Light listens on, and what each is, for the Network tab. */
  readonly ports?: ReadonlyMap<number, string>;
}

/** Nothing accepted a connection at the Light's address: it is switched off, or not there. */
export class LightUnreachable extends Error {
  constructor(options?: ErrorOptions) {
    super("Nothing accepted a connection", options);
    this.name = "LightUnreachable";
  }
}

/** The Light accepted the connection but didn't answer, or closed it. */
export class LightSilent extends Error {
  constructor(why: string) {
    super(why);
    this.name = "LightSilent";
  }
}

/** The Light refused the id or key it was shown, or answered with what the key doesn't read. */
export class LightRefusedKeys extends Error {
  constructor() {
    super("The Light refused the id or key");
    this.name = "LightRefusedKeys";
  }
}

/** What answered isn't a Light the transport can read. */
export class NotALight extends Error {
  constructor(why: string) {
    super(why);
    this.name = "NotALight";
  }
}
