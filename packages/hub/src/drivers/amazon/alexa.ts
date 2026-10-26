/**
 * The Amazon Driver: reaches the owner's Echo devices through the Alexa
 * app's private cloud API (ADR 0011), by `alexa-remote2`, which this module
 * alone imports. Amazon neither documents nor supports that API, so any of it
 * may stop working; each failure is an {@link AmazonFailure} saying so.
 *
 * It signs in through `alexa-cookie2`'s sign-in page, served by the Hub,
 * where the person signs in to Amazon themselves, two-step code and all, so
 * the Hub never sees their password. The session it keeps is secret: the
 * library's own log, which writes it out, is never turned on (FR-4).
 */
import AlexaRemote from "alexa-remote2";
import type { AmazonDomain, AmazonQuickAction } from "@media-centre/shared";

import {
  AmazonFailure,
  alarmVolumeIn,
  bluetoothIn,
  devicesIn,
  doNotDisturbIn,
  equaliserIn,
  musicProvidersIn,
  notificationsIn,
  playerIn,
  routinesIn,
  signInSiteFor,
  volumeIn,
  type AmazonDriver,
} from "./amazon-driver.ts";

/** Each site's language, as Amazon's sign-in page and Alexa's answers are in it. */
const LANGUAGES: Readonly<Record<AmazonDomain, string>> = {
  "amazon.co.uk": "en-GB",
  "amazon.com": "en-US",
  "amazon.de": "de-DE",
  "amazon.fr": "fr-FR",
  "amazon.it": "it-IT",
  "amazon.es": "es-ES",
  "amazon.ca": "en-CA",
  "amazon.com.au": "en-AU",
  "amazon.in": "en-IN",
  "amazon.co.jp": "ja-JP",
  "amazon.com.br": "pt-BR",
};

/** What Alexa does for each quick action, by the library's name for the action in a routine. */
const QUICK: Readonly<Record<AmazonQuickAction, string>> = {
  weather: "weather",
  traffic: "traffic",
  news: "flashbriefing",
  "good-morning": "goodmorning",
  "fun-fact": "funfact",
  joke: "joke",
  story: "tellstory",
  song: "singasong",
  calendar: "calendarToday",
  stop: "deviceStop",
};

type Callback = (error?: Error | null, body?: unknown) => void;

/** The library's methods, called as it takes them, with a callback last. */
type Library = Record<string, (...args: unknown[]) => void> & {
  cookieData: unknown;
  init: (options: Record<string, unknown>, callback: (error?: Error | null) => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners: () => void;
  stop: () => void;
  stopProxyServer: (callback?: () => void) => void;
};

/** Calls one of the library's methods, as a promise, with Amazon's refusal as an {@link AmazonFailure}. */
const call = (library: Library, method: string, ...args: unknown[]): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const done: Callback = (error, body) => {
      if (error) reject(new AmazonFailure(`Amazon refused: ${error.message}`, { cause: error }));
      else resolve(body);
    };
    try {
      const fn = library[method];
      if (fn === undefined) throw new Error(`no ${method}`);
      fn.call(library, ...args, done);
    } catch (error) {
      reject(new AmazonFailure("Amazon's API couldn't be asked.", { cause: error }));
    }
  });

/** The Driver for Echo devices, through the Alexa app's cloud API. */
export const alexaDriver = (): AmazonDriver => {
  let library: Library | undefined;

  const signedIn = (): Library => {
    if (library === undefined) throw new AmazonFailure("The Hub isn't signed in to Amazon.");
    return library;
  };

  return {
    signIn: ({ domain: site, host, port, session, onSignInUrl, onSession }) => {
      library?.stop();
      library?.stopProxyServer();
      const alexa = new (AlexaRemote as unknown as new () => Library)();
      library = alexa;
      const language = LANGUAGES[site];
      const kept = session === undefined ? undefined : (JSON.parse(session) as Record<string, unknown>);
      let settled = false;
      return new Promise<void>((resolve, reject) => {
        alexa.on("cookie", () => {
          if (alexa.cookieData !== null && alexa.cookieData !== undefined) onSession(JSON.stringify(alexa.cookieData));
        });
        alexa.init(
          {
            ...(kept === undefined ? {} : { cookie: kept, formerRegistrationData: kept, macDms: kept.macDms }),
            proxyOnly: true,
            setupProxy: true,
            proxyOwnIp: host,
            proxyPort: port,
            proxyListenBind: "0.0.0.0",
            amazonPage: site,
            baseAmazonPage: signInSiteFor(site),
            acceptLanguage: language,
            amazonPageProxyLanguage: language.replace("-", "_"),
            bluetooth: true,
            notifications: true,
            useWsMqtt: false,
            usePushConnection: false,
          },
          (error?: Error | null) => {
            const signInPage = /Please open (https?:\/\/\S+?)\/? with your browser/.exec(error?.message ?? "")?.[1];
            if (signInPage !== undefined) {
              // Not a failure: the page is listening, and the callback is called again once signed in.
              onSignInUrl(`${signInPage}/`);
              return;
            }
            if (settled) return;
            settled = true;
            if (error) {
              reject(new AmazonFailure(`Signing in to Amazon failed: ${error.message}`));
              return;
            }
            alexa.stopProxyServer();
            if (alexa.cookieData !== null && alexa.cookieData !== undefined)
              onSession(JSON.stringify(alexa.cookieData));
            resolve();
          },
        );
      });
    },

    signOut: () => {
      library?.stop();
      library?.stopProxyServer();
      library?.removeAllListeners();
      library = undefined;
    },

    devices: async () => devicesIn(await call(signedIn(), "getDevices")),

    routines: async () => routinesIn(await call(signedIn(), "getAutomationRoutines", 2_000)),

    musicProviders: async () => musicProvidersIn(await call(signedIn(), "getMusicProviders")),

    state: async (serial) => {
      const alexa = signedIn();
      // Each part on its own, as a device may not have it: one Amazon refuses is left out.
      const [player, dnd, notifications, bluetooth, equaliser, alarm] = await Promise.all([
        call(alexa, "getPlayerInfo", serial).catch(() => null),
        call(alexa, "getDoNotDisturb").catch(() => null),
        call(alexa, "getNotifications", false).catch(() => null),
        call(alexa, "getBluetooth", false).catch(() => null),
        call(alexa, "getEqualizerSettings", serial).catch(() => null),
        call(alexa, "getDeviceNotificationState", serial).catch(() => null),
      ]);
      return {
        serial,
        player: playerIn(player),
        volume: volumeIn(player),
        doNotDisturb: doNotDisturbIn(dnd, serial),
        equaliser: equaliserIn(equaliser),
        alarmVolume: alarmVolumeIn(alarm),
        notifications: notificationsIn(notifications, serial),
        bluetooth: bluetoothIn(bluetooth, serial),
      };
    },

    act: async (serial, action) => {
      const alexa = signedIn();
      const notification = async (id: string): Promise<unknown> => {
        const all = await call(alexa, "getNotifications", false);
        const found =
          typeof all === "object" && all !== null && Array.isArray((all as { notifications?: unknown }).notifications)
            ? (all as { notifications: { id?: unknown }[] }).notifications.find((each) => each.id === id)
            : undefined;
        if (found === undefined) throw new AmazonFailure("That alarm, timer or reminder has gone. Look again.");
        return found;
      };
      switch (action.kind) {
        case "play":
        case "pause":
        case "next":
        case "previous":
          await call(alexa, "sendCommand", serial, action.kind, null);
          return;
        case "volume":
          await call(alexa, "sendSequenceCommand", serial, "volume", action.level);
          return;
        case "speak":
          await call(alexa, "sendSequenceCommand", serial, "speak", action.text);
          return;
        case "announce":
          await call(alexa, "sendSequenceCommand", serial, "announcement", action.text);
          return;
        case "ask":
          await call(alexa, "sendSequenceCommand", serial, "textCommand", action.text);
          return;
        case "quick":
          await call(alexa, "sendSequenceCommand", serial, QUICK[action.action], null);
          return;
        case "routine": {
          const routines = await call(alexa, "getAutomationRoutines", 2_000);
          const routine = Array.isArray(routines)
            ? (routines as { automationId?: unknown }[]).find((each) => each.automationId === action.routineId)
            : undefined;
          if (routine === undefined) throw new AmazonFailure("That routine has gone. Look again.");
          await call(alexa, "executeAutomationRoutine", serial, routine);
          return;
        }
        case "do-not-disturb":
          await call(alexa, "setDoNotDisturb", serial, action.on);
          return;
        case "music": {
          const played = await call(alexa, "playMusicProvider", serial, action.providerId, action.search).then(
            () => true,
            () => false,
          );
          // The library asks in German; where Amazon refuses, Alexa is asked as if out loud.
          if (!played) {
            const providers = musicProvidersIn(await call(alexa, "getMusicProviders").catch(() => []));
            const name = providers.find(({ id }) => id === action.providerId)?.name;
            await call(
              alexa,
              "sendSequenceCommand",
              serial,
              "textCommand",
              `play ${action.search}${name ? ` on ${name}` : ""}`,
            );
          }
          return;
        }
        case "equaliser":
          await call(alexa, "setEqualizerSettings", serial, action.bass, action.midrange, action.treble);
          return;
        case "alarm-volume":
          await call(alexa, "setDeviceNotificationVolume", serial, action.level);
          return;
        case "notification-on":
          await call(alexa, "changeNotification", await notification(action.id), action.on);
          return;
        case "notification-delete":
          await call(alexa, "deleteNotification", await notification(action.id));
          return;
        case "bluetooth":
          await call(alexa, action.connect ? "connectBluetooth" : "disconnectBluetooth", serial, action.address);
          return;
      }
    },

    announceEverywhere: async (text) => {
      const alexa = signedIn();
      const serials = devicesIn(await call(alexa, "getDevices"))
        .filter(({ online }) => online)
        .map(({ serial }) => serial);
      if (serials.length === 0) throw new AmazonFailure("No Echo is online to announce on.");
      await call(alexa, "sendSequenceCommand", serials, "announcement", text);
    },
  };
};
