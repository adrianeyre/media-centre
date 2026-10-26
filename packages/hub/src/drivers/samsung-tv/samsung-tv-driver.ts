import { isIP } from "node:net";

import { PLAYER_APP_ID, playerLaunchParameter } from "@media-centre/shared";

import {
  DriverFailure,
  type AppIcon,
  type AppIconAnswer,
  type AppsAnswer,
  type ConnectionAnswer,
  type DiscoveredAppliance,
  type Driver,
  type KeyboardAnswer,
  type NowShowingAnswer,
  type ShortcutAnswer,
} from "../driver.ts";
import { imageTypeOf } from "../images.ts";
import { broadcastAddressFor, sendMagicPacket, WAKE_ON_LAN_PORT } from "../wake-on-lan.ts";
import {
  APP_ICON_EVENT,
  APP_LAUNCH_EVENT,
  AppsUnavailable,
  closeApplication,
  iconImageIn,
  INSTALLED_APPS_EVENT,
  installedAppsIn,
  isApplicationVisible,
  isIconFor,
  isNoSuchAppAnswer,
  launchApplication,
  NoSuchApp,
  type SamsungAppLaunch,
} from "./applications.ts";
import {
  askControlSocket,
  ControlSocketSilent,
  ControlSocketUnreachable,
  SAMSUNG_CONTROL_PORT,
} from "./control-socket.ts";
import {
  controlSockets,
  type AskAnswer,
  type KeyAnswer,
  type KeyboardAnswer as SocketKeyboardAnswer,
  type ListenedKeyAnswer,
} from "./control-sockets.ts";
import { NotASamsungTv, readDeviceInfo, SAMSUNG_REST_PORT } from "./device-info.ts";
import { SAMSUNG_POWER_KEY, samsungKeyCode, samsungShortcutCode } from "./keys.ts";
import { SAMSUNG_TV_PLAYABLE_FORMATS } from "./playable-formats.ts";
import { samsungPlayerTools, type SamsungPlayerToolsOptions } from "./player-tools.ts";
import {
  readRenderingControl,
  RenderingControlUnavailable,
  SAMSUNG_UPNP_PORT,
  setRenderingControlMute,
  setRenderingControlVolume,
} from "./rendering-control.ts";
import { FACTORY_KEY, namesFactoryKey, ServiceMenuRefusal } from "./service-menu.ts";
import { searchForSamsungTvs, type SsdpTarget } from "./ssdp.ts";

/** The name a TV shows on its "Allow" prompt and in its list of connected devices. */
export const CLIENT_NAME = "media-centre";

export interface SamsungTvDriverOptions {
  /** 8001 on a real TV. Only tests against the fake TV change it. */
  readonly restPort?: number;
  /** 8002 on a real TV. Only tests against the fake TV change it. */
  readonly controlPort?: number;
  /** How long the person has to choose Allow on the TV. */
  readonly pairingTimeoutMs?: number;
  /** How long a paired TV has to answer. */
  readonly connectTimeoutMs?: number;
  /** How long a TV has to answer for its power state, which the Remote asks for every few seconds. */
  readonly powerTimeoutMs?: number;
  /**
   * Where "Find TVs" sends its search: the SSDP multicast group on a real
   * network. Tests send it to each fake TV instead, where multicast can't reach.
   */
  readonly searchTargets?: readonly SsdpTarget[];
  /** How long "Find TVs" listens for TVs to answer. */
  readonly searchWindowMs?: number;
  /**
   * Where the Wake-on-LAN magic packet goes. On a real network it is broadcast
   * on the TV's subnet to port 9, as a TV in standby may not answer for its
   * own address. Tests send it to the TV's own address on this port instead,
   * where the fake TV listens and a broadcast can't reach.
   */
  readonly wakePort?: number;
  /** How long a Frame TV's power key is held to switch it off: 3 seconds, as far as we know. */
  readonly powerHoldMs?: number;
  /** The port a TV answers UPnP on, 9197 on a real TV. Only tests against the fake TV change it. */
  readonly upnpPort?: number;
  /** How long a TV has to answer for its volume, which the Remote asks for every few seconds. */
  readonly volumeTimeoutMs?: number;
  /** How long a TV has to list its apps, give an app's icon, or launch or close an app. */
  readonly appsTimeoutMs?: number;
  /** How long a TV has to say whether each app is in front, which the Remote asks every few seconds. */
  readonly nowShowingTimeoutMs?: number;
  /**
   * How long the Driver listens, after a shortcut's key is sent, for the TV to
   * say it won't take it (FR-24). A TV answers a command on the home network
   * in far less, as far as we know; keys pressed meanwhile don't wait.
   */
  readonly shortcutListenMs?: number;
  /** How the Player is installed, launched and uninstalled with Samsung's tools. By default, those on the `PATH`. */
  readonly playerTools?: SamsungPlayerToolsOptions;
}

/**
 * The Samsung TV Driver: controls Samsung Tizen TVs, 2018 and later, over
 * their local REST API and secure control socket (ADR 0007). The credentials
 * it hands the Hub are the token the TV issued on pairing. It keeps each TV's
 * control socket open between key presses (FR-22). It switches a TV on with
 * Wake-on-LAN, and off with its power key (FR-17). It reads and sets a TV's
 * volume and mute over UPnP, which needs no pairing (FR-19). It hears a TV's
 * on-screen keyboard open and close on its control socket, and types text
 * into it there (FR-20). It presses TV Menu mode's shortcuts as the keys it
 * alone maps them to, and listens for the TV to say it ignored one (FR-24).
 * It lists a TV's installed apps, and fetches their
 * icons, on its control socket, keeping each icon once fetched, and launches
 * and closes them over REST, which needs no pairing (FR-21). It tells which
 * app is in front from each one's status over REST (FR-26). It launches the
 * Player as a deep link on the control socket, with the Hub's address as its
 * launch data, which REST can't give it (FR-35). It reads a TV's
 * model, network type, Frame support, Developer Mode and Developer IP from its
 * device info (FR-28). It installs, launches and uninstalls the Player with
 * Samsung's own developer tools, on a TV in Developer Mode (FR-31).
 */
export const samsungTvDriver = ({
  restPort = SAMSUNG_REST_PORT,
  controlPort = SAMSUNG_CONTROL_PORT,
  pairingTimeoutMs = 30_000,
  connectTimeoutMs = 10_000,
  powerTimeoutMs = 2_000,
  searchTargets,
  searchWindowMs = 3_000,
  wakePort,
  powerHoldMs = 3_000,
  upnpPort = SAMSUNG_UPNP_PORT,
  volumeTimeoutMs = 2_000,
  appsTimeoutMs = 5_000,
  nowShowingTimeoutMs = 2_000,
  shortcutListenMs = 1_000,
  playerTools,
}: SamsungTvDriverOptions = {}): Driver => {
  const unreachable = (address: string, cause: unknown): DriverFailure =>
    new DriverFailure(
      "unreachable",
      `No TV answered at ${address}. Check that it is switched on and on the same network as the Hub.`,
      { cause },
    );

  const ask = async (address: string, token: string | undefined, timeoutMs: number) => {
    try {
      return await askControlSocket(address, {
        port: controlPort,
        clientName: CLIENT_NAME,
        timeoutMs,
        ...(token === undefined ? {} : { token }),
      });
    } catch (error) {
      if (error instanceof ControlSocketUnreachable) throw unreachable(address, error);
      throw error;
    }
  };

  const upnp = { port: upnpPort, timeoutMs: volumeTimeoutMs };

  /** Sets the volume or the mute, in the Driver's terms: a TV that doesn't answer, e.g. in standby, is told. */
  const setSound = async (address: string, set: () => Promise<void>): Promise<void> => {
    try {
      await set();
    } catch (error) {
      if (!(error instanceof RenderingControlUnavailable)) throw error;
      throw new DriverFailure(
        "unreachable",
        `The TV at ${address} isn't answering for its volume, as when it is in standby. Volume up and down still work.`,
        { cause: error },
      );
    }
  };

  const sockets = controlSockets({ port: controlPort, clientName: CLIENT_NAME, timeoutMs: connectTimeoutMs });

  /**
   * Sends a key or text, or reads the keyboard, on the control socket, in the
   * Driver's terms: a refused token, or a failure the person is told.
   */
  const onSocket = async <Answer extends KeyAnswer | ListenedKeyAnswer | SocketKeyboardAnswer | AskAnswer>(
    address: string,
    send: () => Promise<Answer>,
  ): Promise<Extract<Answer, { accepted: true }> | { readonly accepted: false }> => {
    try {
      const answer = await send();
      if (answer.accepted) return answer as Extract<Answer, { accepted: true }>;
      if (answer.why === "unauthorized") return { accepted: false };
      throw new DriverFailure("timed-out", `The TV at ${address} didn't answer.`);
    } catch (error) {
      if (error instanceof ServiceMenuRefusal) throw new DriverFailure("refused", error.message, { cause: error });
      if (error instanceof ControlSocketUnreachable) throw unreachable(address, error);
      if (error instanceof ControlSocketSilent) {
        throw new DriverFailure("timed-out", `The TV at ${address} didn't answer.`, { cause: error });
      }
      throw error;
    }
  };

  const sendKey = async (address: string, send: () => Promise<KeyAnswer>): Promise<ConnectionAnswer> => {
    const answer = await onSocket(address, send);
    return answer.accepted ? { accepted: true, credentials: answer.token } : answer;
  };

  /** Where each TV keeps each app's icon, by app id, as it last listed them: undefined for none. */
  const iconPaths = new Map<string, ReadonlyMap<string, string | undefined>>();
  /** Each TV's icons fetched so far, by where it keeps them: undefined for one it gave no image for. */
  const icons = new Map<string, Map<string, AppIcon | undefined>>();

  const listApps = async (address: string, token: string): Promise<AppsAnswer> => {
    const answer = await onSocket(address, () =>
      sockets.ask(address, token, { event: INSTALLED_APPS_EVENT }, appsTimeoutMs),
    );
    if (!answer.accepted) return answer;
    const installed = installedAppsIn(answer.data);
    if (installed === undefined) {
      throw new DriverFailure("not-recognised", `The TV at ${address} listed its apps in a way the Hub can't read.`);
    }
    iconPaths.set(address, new Map(installed.map(({ id, iconPath }) => [id, iconPath])));
    // Icons the TV no longer keeps there, e.g. of apps since removed, are let go.
    const kept = icons.get(address);
    const listed = new Set(installed.map(({ iconPath }) => iconPath));
    for (const path of kept?.keys() ?? []) if (!listed.has(path)) kept?.delete(path);
    return {
      accepted: true,
      credentials: answer.token,
      apps: installed.map(({ id, name, iconPath }) => ({ id, name, icon: iconPath !== undefined })),
    };
  };

  /** Turns the TV's failures to launch or close an app into the Driver's. */
  const onApp = async (address: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      if (error instanceof NoSuchApp)
        throw new DriverFailure("not-supported", "The TV has no such app.", { cause: error });
      if (!(error instanceof AppsUnavailable)) throw error;
      throw new DriverFailure(
        "unreachable",
        `The TV at ${address} isn't answering for its apps, as when it is in standby.`,
        { cause: error },
      );
    }
  };

  const app = { port: restPort, timeoutMs: appsTimeoutMs };

  /** Reads the device info, in the Driver's terms: a TV that doesn't answer, or something else that does. */
  const deviceInfo = async (address: string, timeoutMs?: number) => {
    try {
      return await readDeviceInfo(address, { port: restPort, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    } catch (error) {
      if (error instanceof NotASamsungTv) {
        throw new DriverFailure("not-recognised", `What answered at ${address} is not a TV the Hub can control.`, {
          cause: error,
        });
      }
      throw unreachable(address, error);
    }
  };

  return {
    kind: "tv",
    ports: new Map([
      [SAMSUNG_REST_PORT, "Samsung TV"],
      [SAMSUNG_CONTROL_PORT, "Samsung TV (secure)"],
    ]),

    identify: async (address) => {
      const { name, model, macAddress } = await deviceInfo(address);
      return { name, model, macAddress };
    },

    pair: async (address) => {
      const answer = await ask(address, undefined, pairingTimeoutMs);
      if (answer.accepted && answer.token !== undefined) return answer.token;
      if (!answer.accepted && answer.why === "timed-out") {
        throw new DriverFailure(
          "timed-out",
          `The TV at ${address} wasn't allowed in time. Try again, and choose Allow on the TV when it asks.`,
        );
      }
      throw new DriverFailure(
        "not-allowed",
        `The TV at ${address} didn't allow the Hub. Try again, and choose Allow on the TV.`,
      );
    },

    connect: async (address, token) => {
      const answer = await ask(address, token, connectTimeoutMs);
      if (answer.accepted) return { accepted: true, credentials: answer.token ?? token };
      if (answer.why === "unauthorized") return { accepted: false };
      throw new DriverFailure("timed-out", `The TV at ${address} didn't answer.`);
    },

    /**
     * Reads the device info, which a TV answers without pairing, on or in
     * standby (FR-16). A TV switched off at the wall, or one whose firmware
     * doesn't answer in standby, doesn't answer at all.
     */
    readPowerState: async (address) => {
      try {
        return (await readDeviceInfo(address, { port: restPort, timeoutMs: powerTimeoutMs })).powerState;
      } catch {
        return "unreachable";
      }
    },

    /**
     * Searches over SSDP, then reads the device info of each TV that answered.
     * One that doesn't answer that, e.g. something else of Samsung's, is left
     * out, as is a second answer from a TV on both Wi-Fi and a cable.
     */
    discover: async () => {
      let addresses: string[];
      try {
        addresses = await searchForSamsungTvs({
          windowMs: searchWindowMs,
          ...(searchTargets === undefined ? {} : { targets: searchTargets }),
        });
      } catch (error) {
        throw new DriverFailure(
          "unreachable",
          "The Hub couldn't search its network for TVs. Add the TV by its IP address instead.",
          { cause: error },
        );
      }
      const answers = await Promise.all(
        addresses.map(async (address) => {
          try {
            const { name, model, macAddress } = await readDeviceInfo(address, { port: restPort });
            return { address, name, model, macAddress };
          } catch {
            return undefined;
          }
        }),
      );
      const found = new Map<string, DiscoveredAppliance>();
      for (const tv of answers) if (tv !== undefined && !found.has(tv.macAddress)) found.set(tv.macAddress, tv);
      return [...found.values()].sort((a, b) => a.address.localeCompare(b.address, "en", { numeric: true }));
    },

    pressKey: async (address, token, key) => {
      // The factory key is no key the Remote has, but is handed to the guard
      // rather than turned away as unknown, so that it is refused as what it is.
      const code = samsungKeyCode(key) ?? (namesFactoryKey(key) ? FACTORY_KEY : undefined);
      if (code === undefined) throw new DriverFailure("not-supported", "The TV has no such key.");
      return sendKey(address, () => sockets.pressKey(address, token, code));
    },

    /**
     * Presses the shortcut's key (FR-24), then listens for the TV's error
     * event, the only thing a TV is known to say of a command it won't take.
     * A TV that ignores a key without a word, as those reported do, can't be
     * told from one that took it: the Remote says so rather than claiming it.
     */
    pressShortcut: async (address, token, shortcut): Promise<ShortcutAnswer> => {
      const code = samsungShortcutCode(shortcut);
      if (code === undefined) throw new DriverFailure("not-supported", "The TV has no such shortcut.");
      const answer = await onSocket(address, () => sockets.pressKeyListening(address, token, code, shortcutListenMs));
      return answer.accepted ? { accepted: true, credentials: answer.token, ignored: answer.ignored } : answer;
    },

    /**
     * Sends the Wake-on-LAN magic packet for the TV's MAC address, which a TV
     * in standby answers by switching on, if it is set to (FR-17). A TV
     * switched off at the wall doesn't.
     */
    switchOn: async ({ address, macAddress }) => {
      const target =
        wakePort === undefined
          ? { host: broadcastAddressFor(address), port: WAKE_ON_LAN_PORT }
          : { host: address, port: wakePort };
      try {
        await sendMagicPacket(macAddress, target);
      } catch (error) {
        throw new DriverFailure(
          "unreachable",
          `The Hub couldn't send the TV at ${address} its wake-up call. Check that the Hub is on the same network as the TV.`,
          { cause: error },
        );
      }
    },

    /**
     * Presses the power key, or holds it on a Frame TV, as its device info
     * says it is, which takes a tap of it for Art Mode (FR-17). The key passes
     * the service-menu guard like any other.
     */
    switchOff: async (address, token) => {
      let frame: boolean;
      try {
        ({ frame } = await readDeviceInfo(address, { port: restPort, timeoutMs: powerTimeoutMs }));
      } catch (error) {
        throw unreachable(address, error);
      }
      return sendKey(address, () =>
        frame
          ? sockets.holdKey(address, token, SAMSUNG_POWER_KEY, powerHoldMs)
          : sockets.pressKey(address, token, SAMSUNG_POWER_KEY),
      );
    },

    /** Reads the volume and mute, which a TV answers only while it is on (FR-19, FR-25). */
    readVolume: async (address) => {
      try {
        return { known: true, ...(await readRenderingControl(address, upnp)) };
      } catch {
        return { known: false };
      }
    },

    setVolume: (address, volume) => setSound(address, () => setRenderingControlVolume(address, volume, upnp)),

    setMute: (address, muted) => setSound(address, () => setRenderingControlMute(address, muted, upnp)),

    /**
     * Opens the TV's control socket, if it isn't open, and keeps it open to
     * hear the keyboard open and close. A TV whose keyboard was already open
     * when it was opened doesn't say so, as far as we know, until it opens again.
     */
    readKeyboard: async (address, token): Promise<KeyboardAnswer> => {
      const answer = await onSocket(address, () => sockets.readKeyboard(address, token));
      return answer.accepted ? { accepted: true, credentials: answer.token, open: answer.open } : answer;
    },

    enterText: (address, token, text) => sendKey(address, () => sockets.enterText(address, token, text)),

    listApps,

    /**
     * Fetches the icon from where the TV last listed it, listing the apps
     * first if they haven't been, and keeps it, so that each is fetched once.
     */
    readAppIcon: async (address, token, appId): Promise<AppIconAnswer> => {
      let credentials = token;
      if (iconPaths.get(address)?.has(appId) !== true) {
        const listing = await listApps(address, token);
        if (!listing.accepted) return listing;
        credentials = listing.credentials;
      }
      const iconPath = iconPaths.get(address)?.get(appId);
      if (iconPath === undefined) return { accepted: true, credentials, icon: undefined };
      const kept = icons.get(address) ?? new Map<string, AppIcon | undefined>();
      icons.set(address, kept);
      if (kept.has(iconPath)) return { accepted: true, credentials, icon: kept.get(iconPath) };

      const answer = await onSocket(address, () =>
        sockets.ask(
          address,
          credentials,
          { event: APP_ICON_EVENT, data: { iconPath }, answers: isIconFor(iconPath) },
          appsTimeoutMs,
        ),
      );
      if (!answer.accepted) return answer;
      const bytes = iconImageIn(answer.data);
      const type = bytes === undefined ? undefined : imageTypeOf(bytes);
      const icon = bytes === undefined || type === undefined ? undefined : { type, bytes };
      kept.set(iconPath, icon);
      return { accepted: true, credentials: answer.token, icon };
    },

    launchApp: (address, appId) => onApp(address, () => launchApplication(address, appId, app)),

    closeApp: (address, appId) => onApp(address, () => closeApplication(address, appId, app)),

    /**
     * Emits the deep link on the control socket, which a Tizen web app is
     * given as its launch data's `PAYLOAD`, and the Player reads the Hub's
     * address from. A Player already running is told it was launched again.
     */
    launchPlayer: async (address, token, hubAddress): Promise<ConnectionAnswer> => {
      const launch: SamsungAppLaunch = {
        appId: PLAYER_APP_ID,
        action_type: "DEEP_LINK",
        metaTag: playerLaunchParameter(hubAddress),
      };
      const answer = await onSocket(address, () =>
        sockets.ask(address, token, { event: APP_LAUNCH_EVENT, data: launch }, appsTimeoutMs),
      );
      if (!answer.accepted) return answer;
      if (isNoSuchAppAnswer(answer.data)) {
        throw new DriverFailure(
          "not-supported",
          "The Player isn't installed on the TV. Install it from the TV's Developer section first.",
        );
      }
      return { accepted: true, credentials: answer.token };
    },

    playableFormats: SAMSUNG_TV_PLAYABLE_FORMATS,

    /**
     * Lists the apps, then asks the TV's app status of each at once whether
     * it is in front: running and visible. One the TV doesn't answer for
     * isn't taken to be, so that a TV that answers for none can't tell, and
     * nor can one that says several are, rather than the Hub guessing.
     */
    readNowShowing: async (address, token): Promise<NowShowingAnswer> => {
      const listing = await listApps(address, token);
      if (!listing.accepted) return listing;
      const status = { port: restPort, timeoutMs: nowShowingTimeoutMs };
      const visible = await Promise.all(
        listing.apps.map((each) => isApplicationVisible(address, each.id, status).catch(() => false)),
      );
      const inFront = listing.apps.filter((_, index) => visible[index]);
      return { accepted: true, credentials: listing.credentials, app: inFront.length === 1 ? inFront[0] : undefined };
    },

    /**
     * Reads the device info, which a TV answers without pairing, on or in
     * standby, as {@link readPowerState} does (FR-28).
     */
    readDeviceInfo: async (address) => {
      const { name, model, macAddress, networkType, frame, developer } = await deviceInfo(address, powerTimeoutMs);
      return { name, model, macAddress, networkType, frame, developer };
    },

    playerTools: samsungPlayerTools(playerTools),

    disconnect: (address) => {
      sockets.close(address);
      iconPaths.delete(address);
      icons.delete(address);
    },
  };
};

/**
 * The Samsung TV Driver as the Hub runs it. `SAMSUNG_TV_REST_PORT`,
 * `SAMSUNG_TV_CONTROL_PORT` and `SAMSUNG_TV_UPNP_PORT` move it off a real TV's ports,
 * `SAMSUNG_TV_WAKE_PORT` sends Wake-on-LAN to the TV's own address on that
 * port rather than broadcasting it, and
 * `SAMSUNG_TV_SEARCH_TARGETS` ("host:port,host:port") sends "Find TVs" to
 * each of those addresses rather than the multicast group, and
 * `SAMSUNG_TV_SDB` and `SAMSUNG_TV_TIZEN` run those programs in place of
 * Samsung's `sdb` and `tizen` on the `PATH`, for tests that run the Hub
 * against fake TVs.
 */
export const samsungTvDriverFromEnvironment = (env: Readonly<Record<string, string | undefined>>): Driver => {
  const ports: { restPort?: number; controlPort?: number; wakePort?: number; upnpPort?: number } = {};
  for (const [option, variable] of [
    ["restPort", "SAMSUNG_TV_REST_PORT"],
    ["controlPort", "SAMSUNG_TV_CONTROL_PORT"],
    ["wakePort", "SAMSUNG_TV_WAKE_PORT"],
    ["upnpPort", "SAMSUNG_TV_UPNP_PORT"],
  ] as const) {
    const value = env[variable];
    if (value === undefined) continue;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${variable} must be a port number, not "${value}"`);
    }
    ports[option] = port;
  }
  const targets = env.SAMSUNG_TV_SEARCH_TARGETS;
  const { SAMSUNG_TV_SDB: sdb, SAMSUNG_TV_TIZEN: tizen } = env;
  return samsungTvDriver({
    ...ports,
    ...(targets === undefined ? {} : { searchTargets: searchTargetsIn(targets) }),
    playerTools: { ...(sdb === undefined ? {} : { sdb }), ...(tizen === undefined ? {} : { tizen }) },
  });
};

const searchTargetsIn = (value: string): SsdpTarget[] =>
  value.split(",").map((each) => {
    const match = /^\s*([0-9.]+):([0-9]{1,5})\s*$/.exec(each);
    const port = Number(match?.[2]);
    if (match?.[1] === undefined || isIP(match[1]) !== 4 || port < 1 || port > 65_535) {
      throw new Error(`SAMSUNG_TV_SEARCH_TARGETS must be IPv4 host:port pairs, separated by commas, not "${value}"`);
    }
    return { host: match[1], port };
  });
