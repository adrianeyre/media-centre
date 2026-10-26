import { randomInt, randomUUID } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import { PLAYER_APP_ID, PLAYER_LAUNCH_HUB_KEY, type DeveloperSettings } from "@media-centre/shared";

import {
  APP_ICON_EVENT,
  APP_LAUNCH_EVENT,
  applicationPath,
  INSTALLED_APPS_EVENT,
  type SamsungAppIcon,
  type SamsungAppLaunch,
  type SamsungAppLaunchAnswer,
  type SamsungAppStatus,
  type SamsungInstalledApps,
} from "../../drivers/samsung-tv/applications.ts";
import {
  CHANNEL_EMIT_METHOD,
  CONNECT_EVENT,
  ERROR_EVENT,
  KEYBOARD_CLOSED_EVENT,
  KEYBOARD_OPEN_EVENT,
  REMOTE_CONTROL_METHOD,
  REMOTE_CONTROL_PATH,
  UNAUTHORIZED_EVENT,
  type ControlSocketEvent,
  type EmitAnswer,
  type EmitCommand,
  type ErrorEvent,
  type KeyCommand,
  type OnScreenKeyboardEvent,
  type TextCommand,
  type TextEndCommand,
} from "../../drivers/samsung-tv/control-socket.ts";
import {
  DEVICE_INFO_PATH,
  type SamsungDevice,
  type SamsungDeviceInfoResponse,
} from "../../drivers/samsung-tv/device-info.ts";
import { SAMSUNG_KEY_CODES, SAMSUNG_POWER_KEY } from "../../drivers/samsung-tv/keys.ts";
import {
  actionElement,
  elementText,
  RENDERING_CONTROL_PATH,
  RENDERING_CONTROL_SERVICE,
  soapEnvelope,
  type RenderingControlArguments,
} from "../../drivers/samsung-tv/rendering-control.ts";
import { parseSsdpMessage, SAMSUNG_TV_SEARCH_TARGET, SEARCH_ALL } from "../../drivers/samsung-tv/ssdp.ts";
import { magicPacketTarget } from "../../drivers/wake-on-lan.ts";
import { startFakePlayer, type FakePlayer, type FakePlayerStatus } from "../player/fake-player.ts";
import { selfSignedCertificate } from "./certificate.ts";
import { fakeAppIcon } from "./icons.ts";

/**
 * A fake Samsung TV for tests (ADR 0004): it answers as a real TV does, as far
 * as we know, and records every request it receives. When a real TV turns out
 * to behave differently, change this first, then the Driver.
 *
 * It answers the REST device-info call and has the secure control socket,
 * where it pairs a client that comes without a token, as the person choosing
 * Allow on a real TV would, and lets in a client presenting a token it issued.
 * It answers SSDP searches for Samsung TVs sent to its own address, as a real
 * TV answers those sent to the multicast group, which tests can't rely on.
 * It can be put in standby and woken, as the TV's own remote would, which its
 * device info reports; a test stops it to make it unreachable. Its device
 * info reports Developer Mode off with no Developer IP until told otherwise,
 * or neither, as some firmware doesn't. It records
 * every Wake-on-LAN magic packet sent to it, and one for its own MAC address
 * switches it on. Its power key switches it off; as a Frame TV, a tap of it
 * shows Art Mode instead, and it must be held.
 * It records every key pressed on its control socket, and when, as a real TV
 * acts on it. Revoking access closes the sockets the revoked tokens opened, as
 * far as we know a real TV does, and a test can drop every socket, as a TV
 * going into standby may.
 * It answers UPnP rendering-control calls that read and set its volume and
 * mute, only while it is on, and records each. Its volume keys change its
 * volume too, and a test can change it as the TV's own remote would.
 * A test can open and close its on-screen keyboard, as choosing a search box
 * on the TV would, which it tells every client let in on its control socket.
 * It records every text typed into it there, and submitting the text closes it.
 * It has a list of installed apps, which a test can change, that it lists,
 * with their icons, on its control socket. It launches and closes them over
 * REST, and says which are running and which one is visible there, as a real
 * TV's app status does; only one app is visible at a time, and standby closes
 * them all. In standby it neither lists nor launches them. A test can bring
 * an app to the front, or none, as the TV's own remote would.
 * It launches an app on its control socket too, with the data it is given
 * there. The Player, once installed, runs as a fake Player, which connects to
 * the Hub at the address it was launched with there, or the one it last had,
 * and records the Media Files the Hub sends it (FR-35).
 * A test can have it ignore keys, as a model or firmware without them would:
 * it records them, but does nothing with them, and says nothing, as far as we
 * know a real TV doesn't, unless told to answer with its error event, as
 * firmware that does would (FR-24).
 */

export interface RecordedRequest {
  readonly method: string;
  /** The path and query, exactly as sent. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** One connection to the control socket. */
export interface RecordedConnection {
  /** The path, without the query. */
  readonly path: string;
  /** The name the client gave, decoded from base64 as the TV shows it. */
  readonly clientName: string | undefined;
  /** The token the client presented, if any. */
  readonly token: string | undefined;
  /** What the TV did: issued a token, let it in on its token, refused it, or left it waiting. */
  readonly outcome: "paired" | "accepted" | "refused" | "unanswered";
  /** The token the TV issued on this connection, if it did. */
  readonly issuedToken: string | undefined;
  /** Every message the client sent, oldest first. */
  readonly messages: readonly string[];
}

/** One key pressed on the control socket. */
export interface RecordedKey {
  /** The key's code, as the TV's protocol names it. */
  readonly code: string;
  /** "Click" for a tap, "Press" and "Release" for a key held down and let go. */
  readonly command: string;
  /** When the TV received it, in milliseconds since the epoch, to time a key from the Remote's tap. */
  readonly receivedAt: number;
  /** Which of {@link FakeSamsungTv.connections} it came on. */
  readonly connection: number;
  /** Whether the TV ignored it, as one of its {@link FakeIgnoredKeys}. */
  readonly ignored: boolean;
}

/**
 * The keys the TV ignores, by the codes its protocol names them by, as a
 * model or firmware without them does, and what it says of one: nothing, as
 * far as we know a real TV says, or its error event, as firmware might.
 */
export interface FakeIgnoredKeys {
  readonly keys: readonly string[];
  readonly answer: "silence" | "error";
}

/** Text typed into the on-screen keyboard on the control socket. */
export interface RecordedText {
  /** The text, decoded as the TV shows it. */
  readonly text: string;
  /** Whether its on-screen keyboard was open to take it: a real TV's does nothing with text otherwise. */
  readonly keyboardOpen: boolean;
  /** When the TV received it, in milliseconds since the epoch. */
  readonly receivedAt: number;
  /** Which of {@link FakeSamsungTv.connections} it came on. */
  readonly connection: number;
}

/** One packet received on the port it listens for Wake-on-LAN on. */
export interface RecordedWake {
  /** The MAC address it was a magic packet for, lower case, or undefined if it wasn't one. */
  readonly macAddress: string | undefined;
  /** When the TV received it, in milliseconds since the epoch. */
  readonly receivedAt: number;
}

/**
 * What the person at the TV does when its "Allow" prompt appears: allows the
 * client, denies it, or walks away and lets the prompt time out.
 */
export type PairingAnswer = "allow" | "deny" | "ignore";

export interface FakeSamsungTvOptions {
  readonly host?: string;
  /** The REST port a real TV has on 8001. 0, the default, picks a free one. */
  readonly restPort?: number;
  /** The secure control socket's port, 8002 on a real TV. 0, the default, picks a free one. */
  readonly controlPort?: number;
  /** The port it answers SSDP searches on, 1900 on a real TV. 0, the default, picks a free one. */
  readonly ssdpPort?: number;
  /**
   * The UDP port it listens for Wake-on-LAN on. A real TV's network card
   * reads every port, broadcast; the fake hears only those sent to its own
   * address here. 0, the default, picks a free one.
   */
  readonly wakePort?: number;
  /**
   * How long it takes to come on after a magic packet for it: no time by
   * default. A real TV takes a few seconds.
   */
  readonly wakeDelayMs?: number;
  /** The port it answers UPnP on, 9197 on a real TV. 0, the default, picks a free one. */
  readonly upnpPort?: number;
  /** Its volume and mute to begin with: 11, and not muted, by default. */
  readonly volume?: Partial<FakeVolume>;
  /** A Frame TV, as its device info says, whose power key must be held to switch it off. */
  readonly frame?: boolean;
  /**
   * How long a Frame's power key must be held to switch it off: 2 seconds by
   * default. As far as we know a real Frame needs no more, and the Driver
   * holds it longer.
   */
  readonly frameHoldMs?: number;
  /**
   * False for firmware that doesn't answer at all in standby, so that a TV in
   * standby is unreachable. True by default.
   */
  readonly answersInStandby?: boolean;
  /** "allow" by default. */
  readonly pairing?: PairingAnswer;
  /**
   * The TV's own name, model and MAC address, in the Hub's terms, for tests
   * outside the Driver, which mustn't know Samsung's format (NFR-6).
   */
  readonly name?: string;
  readonly model?: string;
  readonly macAddress?: string;
  /** Overrides for the device info it reports, e.g. `{ PowerState: "standby" }`. */
  readonly device?: Partial<SamsungDevice>;
  /** Fields to leave out of the device info, as older firmware does. */
  readonly leaveOut?: readonly OptionalDeviceField[];
  /** The apps it has installed: {@link FAKE_APPS} by default. */
  readonly apps?: readonly FakeApp[];
  /** The keys it ignores: none by default. */
  readonly ignoredKeys?: FakeIgnoredKeys;
}

export type OptionalDeviceField = "PowerState" | "networkType" | "developerMode" | "developerIP";

/** An app installed on the fake TV. */
export interface FakeApp {
  /** Its id, as Samsung's are, e.g. "111299001912" for YouTube. */
  readonly id: string;
  readonly name: string;
  /** Whether the TV gives an icon for it: true by default. */
  readonly icon?: boolean;
}

/** An installed app, and whether it is running, and in front, which only one app is at a time. */
export interface FakeAppStatus {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  readonly visible: boolean;
}

/** The Player, as the fake TV has it installed once a test installs it, which runs as a fake Player. */
export const FAKE_PLAYER_APP: FakeApp = { id: PLAYER_APP_ID, name: "Media Centre" };

/** The apps the fake TV has installed unless it is given others: three with icons, and one without. */
export const FAKE_APPS: readonly FakeApp[] = [
  { id: "111299001912", name: "YouTube" },
  { id: "3201907018807", name: "Netflix" },
  { id: "3201910019365", name: "Prime Video" },
  { id: "org.tizen.browser", name: "Internet", icon: false },
];

/** The TV's volume, 0 to 100, and whether it is muted. */
export interface FakeVolume {
  readonly volume: number;
  readonly muted: boolean;
}

export interface FakeSamsungTv {
  readonly host: string;
  readonly restPort: number;
  readonly controlPort: number;
  readonly ssdpPort: number;
  readonly wakePort: number;
  readonly upnpPort: number;
  /** Every UPnP request received on {@link upnpPort}, oldest first, answered or not. */
  readonly upnpRequests: readonly RecordedRequest[];
  /** Its volume and mute now. */
  readonly volume: () => FakeVolume;
  /** Changes its volume, its mute or both, as its own remote would, whatever its power state. */
  readonly setVolume: (change: Partial<FakeVolume>) => void;
  /** Every packet received on {@link wakePort}, oldest first, whether or not it was a magic packet. */
  readonly wakes: readonly RecordedWake[];
  /** Every SSDP message received, oldest first, whether or not it answered it. */
  readonly searches: readonly string[];
  /** Every request received, oldest first, except those to the `/_fake/` paths. */
  readonly requests: readonly RecordedRequest[];
  readonly clearRequests: () => void;
  /** Every connection to the control socket, oldest first. */
  readonly connections: readonly RecordedConnection[];
  /** Every key pressed on a control socket the TV let the client in on, oldest first, ignored or not. */
  readonly keys: readonly RecordedKey[];
  /** The keys it ignores now, and what it says of them. */
  readonly ignoredKeys: () => FakeIgnoredKeys;
  /** Ignores these keys from now on instead of those it did, as another model or firmware would. */
  readonly ignoreKeys: (ignored: FakeIgnoredKeys) => void;
  /** Whether its on-screen keyboard is open now. */
  readonly keyboardOpen: () => boolean;
  /**
   * Opens or closes its on-screen keyboard, as choosing a search box on the TV
   * or leaving it would, and tells every client let in on its control socket.
   * A TV in standby shows no keyboard, so it opens none.
   */
  readonly setKeyboard: (open: boolean) => void;
  /** Every text typed into its on-screen keyboard on a control socket it let the client in on, oldest first. */
  readonly texts: readonly RecordedText[];
  /** Each installed app, in the order it lists them, and whether it is running and visible now. */
  readonly apps: () => readonly FakeAppStatus[];
  /**
   * Installs these apps instead of those it has, as installing and removing
   * them on the TV would. One removed is closed; one still installed carries on.
   */
  readonly setApps: (apps: readonly FakeApp[]) => void;
  /**
   * Brings the installed app with this id to the front, launching it if it
   * isn't running, as choosing it with the TV's own remote would; or, given
   * undefined, none, as switching to live TV or another input would, leaving
   * every app running behind. Returns false, and changes nothing, for an app
   * it hasn't got, or in standby, which shows nothing.
   */
  readonly bringToFront: (appId: string | undefined) => boolean;
  /** Its Player, while it runs: the fake Player, connecting to the Hub. */
  readonly player: () => FakePlayer | undefined;
  /** What its Player is doing, as `/_fake/player` says. */
  readonly playerStatus: () => FakePlayerStatus;
  /**
   * Closes every open control socket, as a TV going into standby may, and
   * resolves once each client has answered that it is closed.
   */
  readonly dropConnections: () => Promise<void>;
  /** Every token the TV has issued, oldest first. */
  readonly issuedTokens: () => readonly string[];
  /** Sets what the person at the TV does the next time it asks. */
  readonly answerPairing: (answer: PairingAnswer) => void;
  /** Refuses every token issued so far, and closes the sockets they opened, as revoking the Hub's access on the TV does. */
  readonly revokeAccess: () => void;
  /** Puts the TV in standby or switches it on, as its own remote would. Its device info says which. */
  readonly setPowerState: (state: FakePowerState) => void;
  /**
   * Its Developer Mode and Developer IP as its device info reports them now,
   * in the Hub's terms; or null when it reports neither.
   */
  readonly developer: () => DeveloperSettings | null;
  /**
   * Switches Developer Mode on or off, with this Developer IP, as doing that
   * at the TV with its own remote, then restarting it, would; or, given null,
   * leaves both out of its device info, as firmware that doesn't report them.
   */
  readonly setDeveloper: (developer: DeveloperSettings | null) => void;
  readonly stop: () => Promise<void>;
}

/**
 * Not part of a real TV. A test that started the fake as its own process
 * reads the REST requests it recorded with `GET`, and forgets them with `DELETE`.
 */
export const FAKE_CONTROL_PATH = "/_fake/requests";

/** Not part of a real TV: `GET` answers with every {@link RecordedConnection}, and `DELETE` forgets them. */
export const FAKE_CONNECTIONS_PATH = "/_fake/connections";

/** Not part of a real TV: `GET` answers with every {@link RecordedKey}, and `DELETE` forgets them. */
export const FAKE_KEYS_PATH = "/_fake/keys";

/**
 * Not part of a real TV: `GET` answers with its {@link FakeIgnoredKeys}, and
 * `PUT` some to {@link FakeSamsungTv.ignoreKeys}.
 */
export const FAKE_IGNORED_KEYS_PATH = "/_fake/ignored-keys";

/** Not part of a real TV: `GET` answers with every {@link RecordedWake}, and `DELETE` forgets them. */
export const FAKE_WAKES_PATH = "/_fake/wakes";

/**
 * Not part of a real TV: `GET` answers with its {@link FakeVolume}, and `POST`
 * a partial one to {@link FakeSamsungTv.setVolume}, as its own remote would.
 */
export const FAKE_VOLUME_PATH = "/_fake/volume";

/**
 * Not part of a real TV: `GET` answers with a {@link FakeKeyboard}, and `POST`
 * one to {@link FakeSamsungTv.setKeyboard}. It refuses to open in standby.
 */
export const FAKE_KEYBOARD_PATH = "/_fake/keyboard";

export interface FakeKeyboard {
  readonly open: boolean;
}

/** Not part of a real TV: `GET` answers with every {@link RecordedText}, and `DELETE` forgets them. */
export const FAKE_TEXT_PATH = "/_fake/text";

/**
 * Not part of a real TV: `GET` answers with every {@link FakeAppStatus}, and
 * `PUT` a list of {@link FakeApp} to {@link FakeSamsungTv.setApps}.
 */
export const FAKE_APPS_PATH = "/_fake/apps";

/**
 * Not part of a real TV: `GET` answers with a {@link FakeFront}, and `POST`
 * one to {@link FakeSamsungTv.bringToFront}, as the TV's own remote would. It
 * refuses an app it hasn't got, and any in standby.
 */
export const FAKE_FRONT_PATH = "/_fake/front";

/** The id of the app in front, or null for none. */
export interface FakeFront {
  readonly app: string | null;
}

/**
 * Not part of a real TV: `GET` answers with its {@link FakeSamsungTv.developer},
 * and `PUT` one, or null, to {@link FakeSamsungTv.setDeveloper}.
 */
export const FAKE_DEVELOPER_PATH = "/_fake/developer";

/** Not part of a real TV: `POST` here to {@link FakeSamsungTv.revokeAccess}. */
export const FAKE_REVOKE_PATH = "/_fake/revoke-access";

/** What the fake TV can be put in: a stopped one is unreachable. */
export type FakePowerState = "on" | "standby";

/** Not part of a real TV: `GET` answers with a {@link FakePlayerStatus}, what its Player is doing. */
export const FAKE_PLAYER_PATH = "/_fake/player";

/** Not part of a real TV: `POST` a {@link FakePowerRequest} here to {@link FakeSamsungTv.setPowerState}. */
export const FAKE_POWER_PATH = "/_fake/power";

export interface FakePowerRequest {
  readonly power: FakePowerState;
}

/** The TV's unique id, the same in its device info and its answers to a search. */
const DEVICE_ID = "uuid:0d5e1f3c-5c4b-4a6e-9a8f-fa4e00000001";

/** Everything the TV can report about itself, with the fake's own values where it is given none. */
const fullDevice = (host: string, overrides: Partial<SamsungDevice>): SamsungDevice => {
  const id = DEVICE_ID;
  return {
    name: "[TV] Samsung Q60 Series (55)",
    modelName: "QE55Q60TAUXXU",
    model: "20_KANT_SU2E",
    // A locally administered address, so it can never be a real TV's.
    wifiMac: "02:00:00:00:00:01",
    ip: host,
    networkType: "wireless",
    type: "Samsung SmartTV",
    id,
    duid: id,
    udn: id,
    OS: "Tizen",
    resolution: "3840x2160",
    countryCode: "GB",
    Language: "en_GB",
    firmwareVersion: "Unknown",
    FrameTVSupport: "false",
    TokenAuthSupport: "true",
    PowerState: "on",
    developerMode: "0",
    developerIP: "0.0.0.0",
    ...overrides,
  };
};

const deviceInfo = (
  host: string,
  port: number,
  full: SamsungDevice,
  leaveOut: readonly OptionalDeviceField[],
): SamsungDeviceInfoResponse => {
  const id = DEVICE_ID;
  const device = Object.fromEntries(
    Object.entries(full).filter(([field]) => !(leaveOut as readonly string[]).includes(field)),
  ) as unknown as SamsungDevice;
  return {
    device,
    id,
    name: device.name,
    type: "Samsung SmartTV",
    uri: `http://${host}:${String(port)}${DEVICE_INFO_PATH}`,
    version: "2.0.25",
  };
};

export const startFakeSamsungTv = async ({
  host = "127.0.0.1",
  restPort = 0,
  controlPort = 0,
  ssdpPort = 0,
  wakePort = 0,
  wakeDelayMs = 0,
  upnpPort = 0,
  volume: initialVolume = {},
  frame,
  frameHoldMs = 2_000,
  answersInStandby = true,
  pairing = "allow",
  name,
  model,
  macAddress,
  device: overrides = {},
  leaveOut = [],
  apps: initialApps = FAKE_APPS,
  ignoredKeys: initialIgnoredKeys = { keys: [], answer: "silence" },
}: FakeSamsungTvOptions = {}): Promise<FakeSamsungTv> => {
  let device: Partial<SamsungDevice> = {
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { modelName: model }),
    ...(macAddress === undefined ? {} : { wifiMac: macAddress }),
    ...(frame === undefined ? {} : { FrameTVSupport: String(frame) }),
    ...overrides,
  };
  const requests: RecordedRequest[] = [];
  const connections: RecordedConnection[] = [];
  const keys: RecordedKey[] = [];
  let ignored: FakeIgnoredKeys = initialIgnoredKeys;
  /** Every token issued, and whether the TV still accepts it. */
  const tokens = new Map<string, boolean>();
  /** Each open socket the TV let in, with the token it was let in on. */
  const letIn = new Map<WebSocket, string>();
  let pairingAnswer = pairing;

  const revokeAccess = (): void => {
    for (const token of tokens.keys()) tokens.set(token, false);
    for (const socket of letIn.keys()) socket.close();
  };

  const inStandby = (): boolean => fullDevice(host, device).PowerState === "standby";

  /** The fields left out of its device info now. */
  let leftOut: readonly OptionalDeviceField[] = leaveOut;
  const DEVELOPER_FIELDS: readonly OptionalDeviceField[] = ["developerMode", "developerIP"];
  const developer = (): DeveloperSettings | null => {
    if (DEVELOPER_FIELDS.some((field) => leftOut.includes(field))) return null;
    const { developerMode, developerIP } = fullDevice(host, device);
    return { mode: developerMode === "1" ? "on" : "off", ip: developerIP === "0.0.0.0" ? null : (developerIP ?? null) };
  };
  const setDeveloper = (settings: DeveloperSettings | null): void => {
    leftOut = leftOut.filter((field) => !DEVELOPER_FIELDS.includes(field));
    if (settings === null) leftOut = [...leftOut, ...DEVELOPER_FIELDS];
    else
      device = { ...device, developerMode: settings.mode === "on" ? "1" : "0", developerIP: settings.ip ?? "0.0.0.0" };
  };

  let keyboardOpen = false;
  const texts: RecordedText[] = [];
  const setKeyboard = (open: boolean): void => {
    if ((open && inStandby()) || open === keyboardOpen) return;
    keyboardOpen = open;
    for (const socket of letIn.keys()) sendEvent(socket, { event: open ? KEYBOARD_OPEN_EVENT : KEYBOARD_CLOSED_EVENT });
  };

  let installed = [...initialApps];
  const running = new Set<string>();
  let visible: string | undefined;
  let player: FakePlayer | undefined;
  /** The Hub's address the Player last had, which it remembers, as the real one does (FR-39). */
  let playerHub: string | null = null;
  /**
   * Runs the app and brings it to the front. The Player starts the fake
   * Player, or tells it it was launched again, with the Hub's address it was
   * launched with, if any.
   */
  const runApp = (id: string, hubAddress: string | null = null): void => {
    running.add(id);
    visible = id;
    if (id !== PLAYER_APP_ID) return;
    playerHub = hubAddress ?? playerHub;
    if (player === undefined) player = startFakePlayer({ host, hubAddress: playerHub });
    else if (playerHub !== null) player.useHub(playerHub);
  };
  const closeApp = (id: string): void => {
    running.delete(id);
    if (visible === id) visible = undefined;
    if (id === PLAYER_APP_ID) {
      player?.stop();
      player = undefined;
    }
  };
  const setApps = (apps: readonly FakeApp[]): void => {
    installed = [...apps];
    for (const id of running) if (!installed.some((app) => app.id === id)) closeApp(id);
  };
  /** Launches an app as the control socket asks, with the Hub's address for the Player, if it was given one. */
  const launchOnSocket = (data: unknown): EmitAnswer => {
    const { appId, metaTag } = (typeof data === "object" && data !== null ? data : {}) as Partial<SamsungAppLaunch>;
    const answer = (status: SamsungAppLaunchAnswer): EmitAnswer => ({
      event: APP_LAUNCH_EVENT,
      from: "host",
      data: status,
    });
    if (typeof appId !== "string" || !installed.some(({ id }) => id === appId)) return answer(404);
    // The Player is given `metaTag` as `{"values": metaTag}`, and reads the Hub's address from it.
    runApp(appId, typeof metaTag === "string" ? new URLSearchParams(metaTag).get(PLAYER_LAUNCH_HUB_KEY) : null);
    return answer(200);
  };
  const appStatus = ({ id, name }: FakeApp): FakeAppStatus => ({
    id,
    name,
    running: running.has(id),
    visible: visible === id,
  });
  const bringToFront = (appId: string | undefined): boolean => {
    if (inStandby() || (appId !== undefined && !installed.some(({ id }) => id === appId))) return false;
    if (appId === undefined) visible = undefined;
    else runApp(appId);
    return true;
  };

  /** Going into standby closes the on-screen keyboard, and every app. */
  const setPowerState = (state: FakePowerState): void => {
    device = { ...device, PowerState: state };
    if (state === "standby") {
      setKeyboard(false);
      for (const id of running) closeApp(id);
    }
  };

  const playerStatus = (): FakePlayerStatus => ({
    running: player !== undefined,
    hubAddress: player?.hubAddress() ?? playerHub,
    connected: player?.connected() ?? false,
    received: [...(player?.received ?? [])],
    segments: [...(player?.segments ?? [])],
    playback: player?.playback.state() ?? "idle",
    positionMs: player?.playback.positionMs() ?? 0,
    audioTrack: player?.playback.audioTrack() ?? null,
    subtitleTrack: player?.subtitles.track() ?? null,
    subtitle: player?.subtitles.text() ?? null,
    music: player?.music() ?? null,
  });

  const wakes: RecordedWake[] = [];
  const onWake = (packet: Buffer): void => {
    const target = magicPacketTarget(packet);
    wakes.push({ macAddress: target, receivedAt: Date.now() });
    if (target === undefined || target !== fullDevice(host, device).wifiMac.toLowerCase()) return;
    if (wakeDelayMs === 0) setPowerState("on");
    else
      wakeTimer ??= setTimeout(() => {
        wakeTimer = undefined;
        setPowerState("on");
      }, wakeDelayMs);
  };
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;

  let sound: FakeVolume = { volume: 11, muted: false, ...initialVolume };
  const setVolume = (change: Partial<FakeVolume>): void => {
    sound = { ...sound, ...change };
  };

  /** A volume key turns the volume up or down by one and unmutes, as far as we know a real TV does, only while it is on. */
  const onVolumeKey = (step: number): void => {
    if (!inStandby()) setVolume({ volume: Math.min(100, Math.max(0, sound.volume + step)), muted: false });
  };

  /** When the power key went down, while it is held. */
  let powerHeldSince: number | undefined;
  const onPowerKey = ({ Cmd }: KeyCommand["params"], receivedAt: number): void => {
    if (inStandby()) return;
    const isFrame = fullDevice(host, device).FrameTVSupport === "true";
    switch (Cmd) {
      case "Press":
        powerHeldSince = receivedAt;
        return;
      case "Release": {
        const held = receivedAt - (powerHeldSince ?? receivedAt);
        powerHeldSince = undefined;
        if (!isFrame || held >= frameHoldMs) setPowerState("standby");
        return;
      }
      case "Click":
        // A Frame shows Art Mode, which its device info still reports as on, as far as we know.
        if (!isFrame) setPowerState("standby");
    }
  };

  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const path = request.url ?? "/";

      if (path === FAKE_CONTROL_PATH) {
        if (request.method === "DELETE") requests.length = 0;
        sendJson(response, 200, requests);
        return;
      }
      if (path === FAKE_CONNECTIONS_PATH) {
        if (request.method === "DELETE") connections.length = 0;
        sendJson(response, 200, connections);
        return;
      }
      if (path === FAKE_KEYS_PATH) {
        if (request.method === "DELETE") keys.length = 0;
        sendJson(response, 200, keys);
        return;
      }
      if (path === FAKE_IGNORED_KEYS_PATH) {
        if (request.method === "PUT") {
          const asked = ignoredKeysIn(body);
          if (asked === undefined) {
            sendJson(response, 400, { message: 'Send {"keys": ["KEY_PMODE", …], "answer": "silence" or "error"}' });
            return;
          }
          ignored = asked;
        }
        sendJson(response, 200, ignored);
        return;
      }
      if (path === FAKE_WAKES_PATH) {
        if (request.method === "DELETE") wakes.length = 0;
        sendJson(response, 200, wakes);
        return;
      }
      if (path === FAKE_VOLUME_PATH) {
        if (request.method === "POST") {
          const change = volumeIn(body);
          if (change === undefined) {
            sendJson(response, 400, { message: 'Send {"volume": 0 to 100, "muted": true or false}, either or both' });
            return;
          }
          setVolume(change);
        }
        sendJson(response, 200, sound);
        return;
      }
      if (path === FAKE_KEYBOARD_PATH) {
        if (request.method === "POST") {
          const open = keyboardIn(body);
          if (open === undefined) {
            sendJson(response, 400, { message: 'Send {"open": true} or {"open": false}' });
            return;
          }
          if (open && inStandby()) {
            sendJson(response, 409, { message: "A TV in standby shows no keyboard" });
            return;
          }
          setKeyboard(open);
        }
        sendJson(response, 200, { open: keyboardOpen } satisfies FakeKeyboard);
        return;
      }
      if (path === FAKE_TEXT_PATH) {
        if (request.method === "DELETE") texts.length = 0;
        sendJson(response, 200, texts);
        return;
      }
      if (path === FAKE_APPS_PATH) {
        if (request.method === "PUT") {
          const apps = appsIn(body);
          if (apps === undefined) {
            sendJson(response, 400, { message: 'Send [{"id": "111299001912", "name": "YouTube", "icon": true}, …]' });
            return;
          }
          setApps(apps);
        }
        sendJson(response, 200, installed.map(appStatus));
        return;
      }
      if (path === FAKE_FRONT_PATH) {
        if (request.method === "POST") {
          const front = frontIn(body);
          if (front === undefined) {
            sendJson(response, 400, { message: 'Send {"app": "111299001912"}, or {"app": null} for none' });
            return;
          }
          if (!bringToFront(front.app ?? undefined)) {
            sendJson(response, 409, { message: "The TV is in standby, or hasn't got that app" });
            return;
          }
        }
        sendJson(response, 200, { app: visible ?? null } satisfies FakeFront);
        return;
      }
      if (path === FAKE_PLAYER_PATH) {
        sendJson(response, 200, playerStatus());
        return;
      }
      if (path === FAKE_DEVELOPER_PATH) {
        if (request.method === "PUT") {
          const asked = developerIn(body);
          if (asked === undefined) {
            sendJson(response, 400, { message: 'Send {"mode": "on" or "off", "ip": "192.168.1.10" or null}, or null' });
            return;
          }
          setDeveloper(asked);
        }
        sendJson(response, 200, developer());
        return;
      }
      if (path === FAKE_REVOKE_PATH && request.method === "POST") {
        revokeAccess();
        sendJson(response, 200, {});
        return;
      }
      if (path === FAKE_POWER_PATH && request.method === "POST") {
        const power = powerIn(body);
        if (power === undefined) {
          sendJson(response, 400, { message: 'Send {"power": "on"} or {"power": "standby"}' });
          return;
        }
        setPowerState(power);
        sendJson(response, 200, {});
        return;
      }

      requests.push({ method: request.method ?? "GET", path, headers: request.headers, body });

      if (!answersInStandby && inStandby()) {
        request.socket.destroy();
        return;
      }

      if (request.method === "GET" && path === DEVICE_INFO_PATH) {
        sendJson(
          response,
          200,
          deviceInfo(host, (server.address() as AddressInfo).port, fullDevice(host, device), leftOut),
        );
        return;
      }
      const app = installed.find(({ id }) => path === applicationPath(id));
      if (app !== undefined && ["GET", "POST", "DELETE"].includes(request.method ?? "")) {
        // A TV in standby doesn't answer for its apps, as far as we know.
        if (inStandby()) {
          sendJson(response, 503, { message: "Service Unavailable" });
          return;
        }
        if (request.method === "POST") runApp(app.id);
        if (request.method === "DELETE") closeApp(app.id);
        const { running: isRunning, visible: isVisible } = appStatus(app);
        const status: SamsungAppStatus = {
          id: app.id,
          name: app.name,
          running: isRunning,
          version: "1.0.0",
          visible: isVisible,
        };
        sendJson(response, 200, request.method === "GET" ? status : true);
        return;
      }
      sendJson(response, 404, { message: "Not Found" });
    });
  });

  const secureServer = createHttpsServer(await selfSignedCertificate());
  const sockets = new WebSocketServer({ server: secureServer });
  sockets.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "wss://localhost");
    const name = url.searchParams.get("name");
    const presented = url.searchParams.get("token") ?? undefined;
    const messages: string[] = [];
    const connection = connections.length;
    const record = (outcome: RecordedConnection["outcome"], issuedToken?: string): void => {
      connections.push({
        path: url.pathname,
        clientName: name === null ? undefined : Buffer.from(name, "base64").toString("utf8"),
        token: presented,
        outcome,
        issuedToken,
        messages,
      });
    };
    socket.on("message", (data: Buffer) => {
      const receivedAt = Date.now();
      const text = data.toString("utf8");
      messages.push(text);
      const key = keyIn(text);
      if (key !== undefined && letIn.has(socket)) {
        const ignoring = ignored.keys.includes(key.DataOfCmd);
        keys.push({ code: key.DataOfCmd, command: key.Cmd, receivedAt, connection, ignored: ignoring });
        if (ignoring) {
          // The message is the fake's own: nothing is known of what a real TV's would say.
          if (ignored.answer === "error") {
            sendEvent(socket, { event: ERROR_EVENT, data: { message: `unable to handle key : ${key.DataOfCmd}` } });
          }
        } else {
          if (key.DataOfCmd === SAMSUNG_POWER_KEY) onPowerKey(key, receivedAt);
          if (key.Cmd === "Click" && key.DataOfCmd === SAMSUNG_KEY_CODES["volume-up"]) onVolumeKey(1);
          if (key.Cmd === "Click" && key.DataOfCmd === SAMSUNG_KEY_CODES["volume-down"]) onVolumeKey(-1);
        }
      }
      const typed = textIn(text);
      if (typed !== undefined && letIn.has(socket)) texts.push({ text: typed, keyboardOpen, receivedAt, connection });
      if (isTextEnd(text) && letIn.has(socket)) setKeyboard(false);
      const question = emitIn(text);
      // A TV in standby doesn't answer for its apps, as far as we know.
      if (question !== undefined && letIn.has(socket) && !inStandby()) {
        const answer =
          question.event === APP_LAUNCH_EVENT ? launchOnSocket(question.data) : answerTo(question, installed);
        if (answer !== undefined) socket.send(JSON.stringify(answer));
      }
    });
    socket.on("close", () => {
      letIn.delete(socket);
    });

    if (url.pathname !== REMOTE_CONTROL_PATH) {
      record("refused");
      socket.close(1008);
      return;
    }

    if (presented !== undefined && tokens.has(presented)) {
      if (tokens.get(presented) === true) {
        record("accepted");
        letIn.set(socket, presented);
        sendEvent(socket, connectEvent(presented));
      } else {
        record("refused");
        refuse(socket);
      }
      return;
    }

    // No token, or one this TV never issued: the TV asks the person.
    switch (pairingAnswer) {
      case "allow": {
        const token = String(randomInt(10_000_000, 100_000_000));
        tokens.set(token, true);
        record("paired", token);
        letIn.set(socket, token);
        sendEvent(socket, connectEvent(token));
        return;
      }
      case "deny":
        record("refused");
        refuse(socket);
        return;
      case "ignore":
        record("unanswered");
    }
  });

  const searches: string[] = [];
  const ssdp = createSocket({ type: "udp4" });
  ssdp.on("message", (data, from) => {
    const text = data.toString("utf8");
    searches.push(text);
    const search = parseSsdpMessage(text);
    const target = search.headers.get("st");
    if (
      search.startLine !== "M-SEARCH * HTTP/1.1" ||
      search.headers.get("man") !== '"ssdp:discover"' ||
      (target !== SAMSUNG_TV_SEARCH_TARGET && target !== SEARCH_ALL)
    ) {
      return;
    }
    ssdp.send(searchAnswer(host, device.udn ?? DEVICE_ID), from.port, from.address);
  });

  const upnpRequests: RecordedRequest[] = [];
  const upnp = createServer((request, response) => {
    void readBody(request).then((body) => {
      const path = request.url ?? "/";
      upnpRequests.push({ method: request.method ?? "GET", path, headers: request.headers, body });
      // A TV in standby doesn't answer UPnP, as far as we know.
      if (inStandby()) {
        request.socket.destroy();
        return;
      }
      if (request.method !== "POST" || path !== RENDERING_CONTROL_PATH) {
        response.writeHead(404).end();
        return;
      }
      const answer = renderingControl(request.headers.soapaction, body, sound, setVolume);
      response
        .writeHead(answer.fault ? 500 : 200, { "content-type": 'text/xml; charset="utf-8"' })
        .end(soapEnvelope(answer.body));
    });
  });

  await listen(server, restPort, host);
  await listen(upnp, upnpPort, host);
  await listen(secureServer, controlPort, host);
  await bind(ssdp, ssdpPort, host);
  const wake = createSocket({ type: "udp4" });
  wake.on("message", onWake);
  await bind(wake, wakePort, host);

  return {
    host,
    restPort: (server.address() as AddressInfo).port,
    controlPort: (secureServer.address() as AddressInfo).port,
    ssdpPort: ssdp.address().port,
    wakePort: wake.address().port,
    upnpPort: (upnp.address() as AddressInfo).port,
    upnpRequests,
    volume: () => sound,
    setVolume,
    wakes,
    searches,
    requests,
    clearRequests: () => {
      requests.length = 0;
    },
    connections,
    keys,
    ignoredKeys: () => ignored,
    ignoreKeys: (asked) => {
      ignored = asked;
    },
    keyboardOpen: () => keyboardOpen,
    setKeyboard,
    texts,
    apps: () => installed.map(appStatus),
    setApps,
    bringToFront,
    player: () => player,
    playerStatus,
    dropConnections: async () => {
      await Promise.all(
        [...sockets.clients].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once("close", () => {
                resolve();
              });
              socket.close();
            }),
        ),
      );
    },
    issuedTokens: () => [...tokens.keys()],
    answerPairing: (answer) => {
      pairingAnswer = answer;
    },
    revokeAccess,
    setPowerState,
    developer,
    setDeveloper,
    stop: async () => {
      clearTimeout(wakeTimer);
      player?.stop();
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all([
        close(server),
        close(secureServer),
        close(upnp),
        new Promise<void>((resolve) => ssdp.close(resolve)),
        new Promise<void>((resolve) => wake.close(resolve)),
      ]);
    },
  };
};

/** Where the fake TV keeps an app's icon, as a real TV's are kept, as far as we know. */
const iconPathFor = (appId: string): string => `/opt/share/webappservice/apps_icon/FirstScreen/${appId}/250x250.png`;

/**
 * Answers a question asked on the control socket, as far as we know a real TV
 * does: its installed apps, or one's icon, by where it keeps it, empty for
 * one it doesn't have. Any other question goes unanswered.
 */
const answerTo = (question: EmitCommand["params"], installed: readonly FakeApp[]): EmitAnswer | undefined => {
  switch (question.event) {
    case INSTALLED_APPS_EVENT: {
      const data: SamsungInstalledApps = {
        data: installed.map(({ id, name, icon = true }) => ({
          appId: id,
          app_type: /^[0-9]+$/.test(id) ? 2 : 4,
          icon: icon ? iconPathFor(id) : "",
          is_lock: 0,
          name,
        })),
      };
      return { event: INSTALLED_APPS_EVENT, from: "host", data };
    }
    case APP_ICON_EVENT: {
      const iconPath =
        typeof question.data === "object" && "iconPath" in question.data && typeof question.data.iconPath === "string"
          ? question.data.iconPath
          : "";
      const app = installed.find(({ id, icon = true }) => icon && iconPathFor(id) === iconPath);
      const data: SamsungAppIcon = {
        iconPath,
        imageBase64: app === undefined ? "" : fakeAppIcon(app.id).toString("base64"),
      };
      return { event: APP_ICON_EVENT, from: "host", data };
    }
    default:
      return undefined;
  }
};

/**
 * A Samsung TV's answer to a search, as far as we know it. Only `ST` and
 * `LOCATION`, whose host is the TV's address, matter to the Driver.
 */
const searchAnswer = (host: string, udn: string): string =>
  [
    "HTTP/1.1 200 OK",
    "CACHE-CONTROL: max-age=1800",
    `DATE: ${new Date().toUTCString()}`,
    "EXT:",
    `LOCATION: http://${host}:7676/smp_15_`,
    "SERVER: SHP, UPnP/1.0, Samsung UPnP SDK/1.0",
    `ST: ${SAMSUNG_TV_SEARCH_TARGET}`,
    `USN: ${udn}::${SAMSUNG_TV_SEARCH_TARGET}`,
    "CONTENT-LENGTH: 0",
    "",
    "",
  ].join("\r\n");

/**
 * Answers one rendering-control call, as far as we know a real TV does: the
 * volume and mute of its Master channel, read or set, or a UPnP fault for an
 * action it hasn't got (401) or arguments it can't take (402).
 */
const renderingControl = (
  soapActionHeader: string | string[] | undefined,
  body: string,
  sound: FakeVolume,
  setVolume: (change: Partial<FakeVolume>) => void,
): { readonly fault: boolean; readonly body: string } => {
  const action = /^"?([^"#]+)#([A-Za-z]+)"?$/.exec(String(soapActionHeader ?? ""));
  const answer = (args: RenderingControlArguments) => ({
    fault: false,
    body: actionElement(`${action?.[2] ?? ""}Response`, args),
  });
  const valid = elementText(body, "InstanceID") === "0" && elementText(body, "Channel") === "Master";
  if (action?.[1] !== RENDERING_CONTROL_SERVICE) return upnpFault(401, "Invalid Action");
  switch (action[2]) {
    case "GetVolume":
      return valid ? answer([["CurrentVolume", String(sound.volume)]]) : upnpFault(402, "Invalid Args");
    case "GetMute":
      return valid ? answer([["CurrentMute", sound.muted ? "1" : "0"]]) : upnpFault(402, "Invalid Args");
    case "SetVolume": {
      const desired = elementText(body, "DesiredVolume") ?? "";
      if (!valid || !/^[0-9]{1,3}$/.test(desired) || Number(desired) > 100) return upnpFault(402, "Invalid Args");
      setVolume({ volume: Number(desired) });
      return answer([]);
    }
    case "SetMute": {
      const desired = elementText(body, "DesiredMute");
      if (!valid || (desired !== "0" && desired !== "1")) return upnpFault(402, "Invalid Args");
      setVolume({ muted: desired === "1" });
      return answer([]);
    }
    default:
      return upnpFault(401, "Invalid Action");
  }
};

const upnpFault = (code: number, description: string) => ({
  fault: true,
  body:
    "<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>" +
    `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${String(code)}</errorCode>` +
    `<errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault>`,
});

const volumeIn = (body: string): Partial<FakeVolume> | undefined => {
  try {
    const { volume, muted } = JSON.parse(body) as Partial<Record<keyof FakeVolume, unknown>>;
    const okVolume =
      volume === undefined || (Number.isInteger(volume) && (volume as number) >= 0 && (volume as number) <= 100);
    const okMuted = muted === undefined || typeof muted === "boolean";
    if (!okVolume || !okMuted || (volume === undefined && muted === undefined)) return undefined;
    return {
      ...(volume === undefined ? {} : { volume: volume as number }),
      ...(muted === undefined ? {} : { muted }),
    };
  } catch {
    return undefined;
  }
};

const powerIn = (body: string): FakePowerState | undefined => {
  try {
    const { power } = JSON.parse(body) as Partial<FakePowerRequest>;
    return power === "on" || power === "standby" ? power : undefined;
  } catch {
    return undefined;
  }
};

/** The key in a message on the control socket, or undefined for any other message. */
const keyIn = (text: string): KeyCommand["params"] | undefined => {
  try {
    const { method, params } = JSON.parse(text) as Partial<KeyCommand>;
    return method === REMOTE_CONTROL_METHOD &&
      params?.TypeOfRemote === "SendRemoteKey" &&
      typeof params.DataOfCmd === "string"
      ? params
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The text in a message on the control socket, or undefined for any other
 * message, or text that isn't UTF-8 in base64 as a real TV takes it.
 */
const textIn = (text: string): string | undefined => {
  try {
    const { method, params } = JSON.parse(text) as {
      method?: unknown;
      params?: Partial<Record<keyof TextCommand["params"], unknown>>;
    };
    if (method !== REMOTE_CONTROL_METHOD || params?.TypeOfRemote !== "SendInputString") return undefined;
    if (params.DataOfCmd !== "base64" || typeof params.Cmd !== "string") return undefined;
    const bytes = Buffer.from(params.Cmd, "base64");
    if (bytes.toString("base64") !== params.Cmd) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Whether a message on the control socket submits the text in the on-screen keyboard. */
const isTextEnd = (text: string): boolean => {
  try {
    const { method, params } = JSON.parse(text) as Partial<TextEndCommand>;
    return method === REMOTE_CONTROL_METHOD && params?.TypeOfRemote === "SendInputEnd";
  } catch {
    return false;
  }
};

/** The question in a message on the control socket, or undefined for any other message. */
const emitIn = (text: string): EmitCommand["params"] | undefined => {
  try {
    const { method, params } = JSON.parse(text) as Partial<EmitCommand>;
    return method === CHANNEL_EMIT_METHOD && typeof params?.event === "string" ? params : undefined;
  } catch {
    return undefined;
  }
};

const appsIn = (body: string): FakeApp[] | undefined => {
  try {
    const apps: unknown = JSON.parse(body);
    if (!Array.isArray(apps)) return undefined;
    const valid = (apps as unknown[]).every((app) => {
      if (typeof app !== "object" || app === null) return false;
      const { id, name, icon } = app as Partial<Record<keyof FakeApp, unknown>>;
      return (
        typeof id === "string" &&
        id !== "" &&
        typeof name === "string" &&
        (icon === undefined || typeof icon === "boolean")
      );
    });
    return valid ? (apps as FakeApp[]) : undefined;
  } catch {
    return undefined;
  }
};

const frontIn = (body: string): FakeFront | undefined => {
  try {
    const { app } = JSON.parse(body) as Partial<Record<keyof FakeFront, unknown>>;
    return app === null || (typeof app === "string" && app !== "") ? { app } : undefined;
  } catch {
    return undefined;
  }
};

const ignoredKeysIn = (body: string): FakeIgnoredKeys | undefined => {
  try {
    const { keys, answer } = JSON.parse(body) as Partial<Record<keyof FakeIgnoredKeys, unknown>>;
    if (!Array.isArray(keys) || !(keys as unknown[]).every((key) => typeof key === "string" && key !== ""))
      return undefined;
    if (answer !== "silence" && answer !== "error") return undefined;
    return { keys: keys as string[], answer };
  } catch {
    return undefined;
  }
};

const developerIn = (body: string): DeveloperSettings | null | undefined => {
  try {
    const asked = JSON.parse(body) as unknown;
    if (asked === null) return null;
    if (typeof asked !== "object" || !("mode" in asked) || !("ip" in asked)) return undefined;
    const { mode, ip } = asked;
    if (mode !== "on" && mode !== "off") return undefined;
    if (ip !== null && (typeof ip !== "string" || ip === "")) return undefined;
    return { mode, ip };
  } catch {
    return undefined;
  }
};

const keyboardIn = (body: string): boolean | undefined => {
  try {
    const { open } = JSON.parse(body) as Partial<FakeKeyboard>;
    return typeof open === "boolean" ? open : undefined;
  } catch {
    return undefined;
  }
};

const connectEvent = (token: string): ControlSocketEvent => ({
  event: CONNECT_EVENT,
  data: { id: randomUUID(), clients: [], token },
});

const sendEvent = (socket: WebSocket, event: ControlSocketEvent | OnScreenKeyboardEvent | ErrorEvent): void => {
  socket.send(JSON.stringify(event));
};

const refuse = (socket: WebSocket): void => {
  sendEvent(socket, { event: UNAUTHORIZED_EVENT });
  socket.close();
};

const listen = (server: Server | HttpsServer, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const bind = (socket: Socket, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });

const close = (server: Server | HttpsServer): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
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
