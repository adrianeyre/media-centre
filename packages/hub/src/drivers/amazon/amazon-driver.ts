/**
 * What the Hub needs of Amazon's Echo devices, in its own terms: the one
 * interface between the Hub and the Alexa app's private cloud API (ADR 0011),
 * which `alexa.ts` alone speaks, and the fake Amazon stands in for in tests.
 * The session it hands the Hub is secret: never log it, nor quote it in an
 * error (FR-4).
 */
import type {
  AmazonAction,
  AmazonBluetoothDevice,
  AmazonCapabilities,
  AmazonDeviceState,
  AmazonDomain,
  AmazonMusicProvider,
  AmazonNotification,
  AmazonPlayer,
  AmazonRoutine,
} from "@media-centre/shared";

/** One device on the account, as the Driver reads it, before the Hub adds its Room. */
export interface AmazonDeviceInfo {
  readonly serial: string;
  readonly name: string;
  readonly family: string;
  readonly online: boolean;
  readonly capabilities: AmazonCapabilities;
}

export interface AmazonSignIn {
  readonly domain: AmazonDomain;
  /** Where the sign-in page is served, as the Remote reaches the Hub: its address on the home network. */
  readonly host: string;
  readonly port: number;
  /** The session kept from before, which the Driver refreshes, or undefined to sign in afresh. */
  readonly session?: string;
  /** Hears the sign-in page's address, once it is listening, to show the person. */
  readonly onSignInUrl: (url: string) => void;
  /** Hears the session, once signed in and each time it is refreshed, to keep. */
  readonly onSession: (session: string) => void;
}

/** Amazon refused, or couldn't be reached. The message is for the person, and never quotes the session. */
export class AmazonFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AmazonFailure";
  }
}

export interface AmazonDriver {
  /**
   * Signs in, with the session from before, or through the sign-in page,
   * where the person signs in to Amazon themselves. Resolves once signed in.
   */
  readonly signIn: (signIn: AmazonSignIn) => Promise<void>;
  /** Stops using the session, and the sign-in page if it is open. */
  readonly signOut: () => void;
  readonly devices: () => Promise<AmazonDeviceInfo[]>;
  readonly routines: () => Promise<AmazonRoutine[]>;
  readonly musicProviders: () => Promise<AmazonMusicProvider[]>;
  readonly state: (serial: string) => Promise<AmazonDeviceState>;
  readonly act: (serial: string, action: AmazonAction) => Promise<void>;
  readonly announceEverywhere: (text: string) => Promise<void>;
}

// What Amazon answers, read as no more than it is: anything, checked as it is read.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectsIn = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The families of what isn't a device to control: the Alexa app itself, and Amazon's shopping app. */
const NOT_DEVICES: ReadonlySet<string> = new Set(["VOX", "MSHOP", "UNKNOWN"]);

/**
 * The Amazon site to sign in on, and register the Hub with, for an account on
 * `site`: amazon.com, but for Japan's. Signed in on amazon.co.uk or another
 * European site, Amazon now leaves the authorization code out of its answer,
 * so the sign-in can never finish; on amazon.com it gives the code, for the
 * same account. The Echos are still reached on `site` (ADR 0011).
 */
export const signInSiteFor = (site: AmazonDomain): AmazonDomain => (site === "amazon.co.jp" ? site : "amazon.com");

/** What a family is, for the person, where Amazon's name for it is known; otherwise its own, in title case. */
const FAMILIES: Readonly<Record<string, string>> = {
  ECHO: "Echo",
  KNIGHT: "Echo Show",
  FIRE_TV: "Fire TV",
  TABLET: "Fire tablet",
  WHA: "Speaker group",
};

export const familyName = (family: string): string =>
  FAMILIES[family] ??
  family
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** The devices in Amazon's answer to `/api/devices-v2/device`, but those that aren't devices, by name. */
export const devicesIn = (answer: unknown): AmazonDeviceInfo[] =>
  objectsIn(isObject(answer) ? answer.devices : undefined)
    .filter((device) => !NOT_DEVICES.has(String(device.deviceFamily)) && text(device.serialNumber) !== null)
    .map((device) => {
      const capabilities = Array.isArray(device.capabilities)
        ? device.capabilities.filter((each): each is string => typeof each === "string")
        : [];
      const family = text(device.deviceFamily) ?? "UNKNOWN";
      return {
        serial: String(device.serialNumber),
        name: text(device.accountName) ?? String(device.serialNumber),
        family: familyName(family),
        online: device.online === true,
        capabilities: {
          music:
            ["AUDIO_PLAYER", "AMAZON_MUSIC", "TUNE_IN", "AUDIBLE"].some((each) => capabilities.includes(each)) ||
            family === "FIRE_TV",
          volume: capabilities.includes("VOLUME_SETTING"),
          alarms: capabilities.includes("TIMERS_AND_ALARMS") || capabilities.includes("REMINDERS"),
          equaliser: capabilities.some((each) => each.startsWith("EQUALIZER")),
          bluetooth: capabilities.some((each) => each.includes("BLUETOOTH")) || capabilities.includes("A2DP_SINK"),
        },
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

/** What Amazon's answer to `/api/np/player` says the device is playing, or null where it says nothing. */
export const playerIn = (answer: unknown): AmazonPlayer | null => {
  const info = isObject(answer) && isObject(answer.playerInfo) ? answer.playerInfo : undefined;
  if (info === undefined) return null;
  const infoText = isObject(info.infoText) ? info.infoText : {};
  const art = isObject(info.mainArt) ? info.mainArt : {};
  const provider = isObject(info.provider) ? info.provider : {};
  const progress = isObject(info.progress) ? info.progress : {};
  const state = (text(info.state) ?? "").toUpperCase();
  return {
    state: state === "PLAYING" ? "playing" : state === "PAUSED" ? "paused" : "idle",
    title: text(infoText.title),
    subtitle: text(infoText.subText1),
    provider: text(provider.providerName),
    artUrl: text(art.url) ?? text(art.mediumUrl) ?? text(art.smallUrl),
    progress: number(progress.mediaProgress),
    length: number(progress.mediaLength),
  };
};

/** The volume in the player's answer, from 0 to 100, or null. */
export const volumeIn = (answer: unknown): number | null => {
  const info = isObject(answer) && isObject(answer.playerInfo) ? answer.playerInfo : undefined;
  const volume = info !== undefined && isObject(info.volume) ? number(info.volume.volume) : null;
  return volume === null ? null : Math.max(0, Math.min(100, Math.round(volume)));
};

/** Whether Do Not Disturb is on for the device, in Amazon's answer to `/api/dnd/device-status-list`, or null. */
export const doNotDisturbIn = (answer: unknown, serial: string): boolean | null => {
  const status = objectsIn(isObject(answer) ? answer.doNotDisturbDeviceStatusList : undefined).find(
    (each) => each.deviceSerialNumber === serial,
  );
  return status === undefined ? null : status.enabled === true;
};

const NOTIFICATION_TYPES: Readonly<Record<string, AmazonNotification["type"]>> = {
  Alarm: "alarm",
  MusicAlarm: "alarm",
  Timer: "timer",
  Reminder: "reminder",
};

/** The device's alarms, timers and reminders, in Amazon's answer to `/api/notifications`, soonest first. */
export const notificationsIn = (answer: unknown, serial: string): AmazonNotification[] =>
  objectsIn(isObject(answer) ? answer.notifications : undefined)
    .filter(
      (each) =>
        each.deviceSerialNumber === serial &&
        typeof each.type === "string" &&
        each.type in NOTIFICATION_TYPES &&
        text(each.id) !== null &&
        each.status !== "INSTANCE_CANCELED",
    )
    .map((each): AmazonNotification => {
      const type = NOTIFICATION_TYPES[String(each.type)] ?? "reminder";
      const at = number(each.alarmTime);
      const remaining = number(each.remainingTime);
      return {
        id: String(each.id),
        type,
        label: text(each.reminderLabel) ?? text(each.timerLabel),
        on: each.status === "ON",
        at: at === null || at === 0 ? null : new Date(at).toISOString(),
        remaining: type === "timer" && remaining !== null ? Math.round(remaining / 1_000) : null,
      };
    })
    .toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

/** The device's Bluetooth pairings, in Amazon's answer to `/api/bluetooth`. */
export const bluetoothIn = (answer: unknown, serial: string): AmazonBluetoothDevice[] => {
  const state = objectsIn(isObject(answer) ? answer.bluetoothStates : undefined).find(
    (each) => each.deviceSerialNumber === serial,
  );
  return objectsIn(state?.pairedDeviceList)
    .filter((each) => text(each.address) !== null)
    .map((each) => ({
      address: String(each.address),
      name: text(each.friendlyName) ?? String(each.address),
      connected: each.connected === true,
    }));
};

/** The equaliser's bass, midrange and treble, in Amazon's answer to `/api/equalizer`, or null. */
export const equaliserIn = (answer: unknown): AmazonDeviceState["equaliser"] => {
  if (!isObject(answer)) return null;
  const bass = number(answer.bass);
  const midrange = number(answer.mid ?? answer.midrange);
  const treble = number(answer.treble);
  return bass === null || midrange === null || treble === null ? null : { bass, midrange, treble };
};

/** The alarm volume, from 0 to 100, in Amazon's answer to `/api/device-notification-state`, or null. */
export const alarmVolumeIn = (answer: unknown): number | null => (isObject(answer) ? number(answer.volumeLevel) : null);

/** The account's routines, in Amazon's answer to `/api/behaviors/v2/automations`, named, or by what triggers them. */
export const routinesIn = (answer: unknown): AmazonRoutine[] =>
  objectsIn(answer)
    .filter((each) => text(each.automationId) !== null)
    .map((each) => {
      const trigger = objectsIn(each.triggers)[0];
      const utterance = isObject(trigger?.payload) ? text(trigger.payload.utterance) : null;
      return {
        id: String(each.automationId),
        name: text(each.name) ?? (utterance === null ? "Unnamed routine" : `“${utterance}”`),
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

/** The music services available, in Amazon's answer to `/api/behaviors/entities`. */
export const musicProvidersIn = (answer: unknown): AmazonMusicProvider[] =>
  objectsIn(answer)
    .filter((each) => text(each.id) !== null && (each.availability === undefined || each.availability === "AVAILABLE"))
    .map((each) => ({ id: String(each.id), name: text(each.displayName) ?? String(each.id) }));
