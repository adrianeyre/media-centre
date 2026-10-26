/**
 * What the Hub needs of Ring's doorbells, cameras and chimes, in its own
 * terms: the one interface between the Hub and the Ring app's private cloud
 * API (ADR 0014), which `ring.ts` alone speaks, and the fake Ring stands in
 * for in tests. The token it hands the Hub is secret, and the password it is
 * given is used once: never log either, nor quote them in an error (FR-4).
 */
import type { RingAction, RingDeviceKind, RingDeviceState, RingEvent, RingLiveView } from "@media-centre/shared";

/** One device on the account, as the Driver reads it, before the Hub adds its Room. */
export interface RingDeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: RingDeviceKind;
  readonly model: string;
  readonly location: string;
  readonly online: boolean;
  readonly battery: number | null;
  readonly capabilities: { readonly light: boolean; readonly siren: boolean; readonly video: boolean };
}

/** Where signing in has got to: signed in, or waiting for the two-step code Ring has sent. */
export type RingSignInStep = { readonly kind: "signed-in" } | { readonly kind: "code-needed"; readonly prompt: string };

/** Ring refused, or couldn't be reached. The message is for the person, and never quotes the token nor password. */
export class RingFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RingFailure";
  }
}

export interface RingDriver {
  /**
   * Signs in with the account's email and password, which the Driver keeps
   * only until signed in, to send with the code. Resolves once signed in, or
   * once Ring has sent the two-step code. `onToken` hears the token, once
   * signed in and each time Ring refreshes it, to keep.
   */
  readonly signIn: (email: string, password: string, onToken: (token: string) => void) => Promise<RingSignInStep>;
  /** Gives Ring the two-step code it sent, for the sign-in under way. */
  readonly enterCode: (code: string) => Promise<RingSignInStep>;
  /** Signs in with the token kept from before, which the Driver refreshes. */
  readonly resume: (token: string, onToken: (token: string) => void) => Promise<void>;
  /** Stops using the token, and forgets any sign-in under way. */
  readonly signOut: () => void;
  readonly devices: () => Promise<RingDeviceInfo[]>;
  readonly state: (id: string) => Promise<RingDeviceState>;
  readonly act: (id: string, action: RingAction) => Promise<void>;
  /** The camera's latest snapshot, as a JPEG. */
  readonly snapshot: (id: string) => Promise<Uint8Array>;
  /** Hands Ring the Remote's WebRTC offer, for the camera's live video, and answers with Ring's. */
  readonly startLiveView: (id: string, sdp: string) => Promise<RingLiveView>;
  readonly endLiveView: (sessionId: string) => Promise<void>;
  /** Where to watch an event's recording, for a while. */
  readonly recordingUrl: (id: string, eventId: string) => Promise<string>;
}

// What Ring answers, read as no more than it is: anything, checked as it is read.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectsIn = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const idOf = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);

/** A battery's level, which Ring gives as a number or a string of one, from 0 to 100, or null. */
const batteryLife = (value: unknown): number | null => {
  const level = typeof value === "string" ? Number.parseFloat(value) : number(value);
  return level === null || Number.isNaN(level) ? null : Math.max(0, Math.min(100, Math.round(level)));
};

/**
 * A doorbell or camera, in Ring's data for it, with its model and the name
 * of its location, which the library works out, or null where it says too
 * little to be one.
 */
export const cameraIn = (data: unknown, doorbell: boolean, model: string, location: string): RingDeviceInfo | null => {
  if (!isObject(data)) return null;
  const id = idOf(data.id);
  if (id === null) return null;
  const alerts = isObject(data.alerts) ? data.alerts : {};
  return {
    id,
    name: text(data.description) ?? model,
    kind: doorbell ? "doorbell" : "camera",
    model,
    location,
    online: alerts.connection !== "offline",
    battery: batteryOf(data),
    capabilities: { light: data.led_status !== undefined, siren: data.siren_status !== undefined, video: true },
  };
};

/** A chime, in Ring's data for it, or null where it says too little to be one. */
export const chimeIn = (data: unknown, model: string, location: string): RingDeviceInfo | null => {
  if (!isObject(data)) return null;
  const id = idOf(data.id);
  if (id === null) return null;
  const alerts = isObject(data.alerts) ? data.alerts : {};
  return {
    id,
    name: text(data.description) ?? model,
    kind: "chime",
    model,
    location,
    online: alerts.connection !== "offline",
    battery: null,
    capabilities: { light: false, siren: false, video: false },
  };
};

/** The lower of a camera's batteries, or null where it has none, as the Ring app shows it. */
const batteryOf = (data: Json): number | null => {
  const levels = [batteryLife(data.battery_life), batteryLife(data.battery_life_2)].filter(
    (level): level is number => level !== null,
  );
  const health = isObject(data.health) ? data.health : undefined;
  if (
    levels.length === 0 ||
    (health !== undefined && !health.battery_percentage && !health.battery_present && !health.second_battery_percentage)
  ) {
    return null;
  }
  return Math.min(...levels);
};

/** A doorbell's or camera's state, in Ring's data for it, but its dings and events. */
export const cameraStateIn = (
  data: unknown,
): Pick<RingDeviceState, "online" | "battery" | "charging" | "wifi" | "light" | "siren" | "motionDetection"> => {
  const camera = isObject(data) ? data : {};
  const alerts = isObject(camera.alerts) ? camera.alerts : {};
  const health = isObject(camera.health) ? camera.health : {};
  const settings = isObject(camera.settings) ? camera.settings : {};
  const siren = isObject(camera.siren_status) ? camera.siren_status : undefined;
  const rssi = number(health.rssi);
  const battery = batteryOf(camera);
  const motion = settings.motion_detection_enabled ?? camera.motion_detection_enabled;
  return {
    online: alerts.connection !== "offline",
    battery,
    charging: battery === null ? null : camera.external_connection === true,
    wifi: rssi === null ? null : { rssi, quality: text(health.rssi_category) ?? "unknown" },
    light: camera.led_status === undefined ? null : camera.led_status === "on",
    siren: siren === undefined ? null : (number(siren.seconds_remaining) ?? 0) > 0,
    motionDetection: typeof motion === "boolean" ? motion : null,
  };
};

/** A chime's state, in Ring's data for it. */
export const chimeStateIn = (data: unknown): Pick<RingDeviceState, "online" | "volume" | "wifi"> => {
  const chime = isObject(data) ? data : {};
  const alerts = isObject(chime.alerts) ? chime.alerts : {};
  const settings = isObject(chime.settings) ? chime.settings : {};
  const volume = number(settings.volume);
  return {
    online: alerts.connection !== "offline",
    volume: volume === null ? null : Math.max(0, Math.min(11, Math.round(volume))),
    wifi: null,
  };
};

const EVENT_KINDS: Readonly<Record<string, RingEvent["kind"]>> = {
  ding: "ding",
  motion: "motion",
  on_demand: "live-view",
  on_demand_link: "live-view",
};

/** A camera's events, in Ring's answer to its `events`, newest first. */
export const eventsIn = (answer: unknown): RingEvent[] =>
  objectsIn(isObject(answer) ? answer.events : undefined)
    .filter((each) => (text(each.ding_id_str) ?? idOf(each.ding_id)) !== null && text(each.created_at) !== null)
    .map((each) => ({
      id: text(each.ding_id_str) ?? String(idOf(each.ding_id)),
      kind: EVENT_KINDS[String(each.kind)] ?? "other",
      at: new Date(String(each.created_at)).toISOString(),
      recorded: each.recording_status === "ready" || each.recorded === true,
    }))
    .toSorted((a, b) => b.at.localeCompare(a.at));
