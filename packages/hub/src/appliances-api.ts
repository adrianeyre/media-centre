import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import {
  APP_ID_MAX_LENGTH,
  APPLIANCE_NAME_MAX_LENGTH,
  APPLIANCE_SEARCH_PATH,
  APPLIANCES_PATH,
  type AddApplianceRequest,
  type Appliance,
  type ApplianceApps,
  type ApplianceDeviceInfo,
  type ApplianceKeyboard,
  type ApplianceKind,
  type AppliancePower,
  type ApplianceVolume,
  type FoundAppliance,
  KEYBOARD_TEXT_MAX_LENGTH,
  LIGHTS_PATH,
  type NowPlaying,
  type NowShowing,
  PLAYER_APP_ID,
  type PowerSwitch,
  type ShortcutOutcome,
  type UpdateApplianceRequest,
  VOLUME_MAX,
  type VolumeChange,
} from "@media-centre/shared";

import {
  addAirConditioner,
  airConditionerChangeIn,
  changeAirConditioner,
  checkKeys,
  fetchKeysAgain,
  loginIn,
  readAirConditioner,
  readAirConditionerCapabilities,
  searchAirConditioners,
} from "./air-conditioners.ts";
import { ApplianceRefusal, KIND_NAMES, type ApplianceStore } from "./appliances.ts";
import {
  DriverFailure,
  type AirConditionerDriver,
  type ConnectionAnswer,
  type Driver,
  type Drivers,
  type LightDriver,
} from "./drivers/driver.ts";
import { isHiveKind } from "./hive.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import {
  addLight,
  changeLight,
  changeLights,
  lightChangeIn,
  lightKeysIn,
  lightsChangeRequestIn,
  readLight,
  readLightCapabilities,
  searchLights,
} from "./lights.ts";
import { firstCharacters } from "./names.ts";

const APPLIANCE_PATH = new RegExp(
  `^${APPLIANCES_PATH}/([1-9][0-9]{0,15})(?:/(connection|pairing|power|keys|shortcuts|volume|keyboard|apps|now-showing|device-info|state|capabilities))?$`,
);

/** One app on an Appliance, or its icon (see `applianceAppPath` in `shared`), by an id still to be checked. */
const APP_PATH = new RegExp(`^${APPLIANCES_PATH}/([1-9][0-9]{0,15})/apps/([^/]+)(/icon)?$`);

/** What an app's id is made of, as `ApplianceApp.id` says: never only dots, which a URL takes as a folder. */
const APP_ID = new RegExp(`^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]{1,${String(APP_ID_MAX_LENGTH)}}$`);

export const REFUSAL_STATUS: Readonly<Record<ApplianceRefusal["reason"], number>> = {
  invalid: 400,
  taken: 409,
  missing: 404,
  stale: 409,
};

/**
 * Mostly that the Appliance didn't answer, or didn't do what was asked: not
 * the Hub's fault, nor the Remote's. A key the Driver doesn't have, or never
 * sends (FR-30), is the request's.
 */
export const DRIVER_FAILURE_STATUS: Readonly<Record<DriverFailure["reason"], number>> = {
  unreachable: 502,
  "not-recognised": 502,
  "not-allowed": 502,
  "timed-out": 502,
  "not-supported": 400,
  refused: 403,
};

/** The longest key or shortcut name the Hub hands a Driver; every real one is far shorter. */
const LONGEST_KEY_NAME = 40;

export interface AppliancesApiOptions {
  /**
   * What the Player on the TV at this address plays, or null for nothing,
   * which Now Showing says when the Player is in front (FR-27). Left out,
   * it says only that the Player is.
   */
  readonly nowPlayingAt?: (address: string) => NowPlaying | null;
  /**
   * Hears the Lights a person is about to change, by their ids, on their
   * own, Room-wide or by All off, so that a film Light Scene doesn't set
   * them back once the video stops (FR-57).
   */
  readonly onLightsChanged?: (ids: readonly number[]) => void;
}

/**
 * Answers the Remote's requests about Appliances (see `APPLIANCES_PATH` in
 * `shared`), or returns false for a path that isn't one of them. Everything a
 * brand needs is done by its Driver; nothing here knows a protocol (NFR-6).
 */
export const handleAppliancesRequest = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  { nowPlayingAt, onLightsChanged }: AppliancesApiOptions = {},
): Promise<boolean> => {
  try {
    if (pathname === APPLIANCES_PATH) {
      await appliancesCollection(appliances, drivers, request, response);
      return true;
    }
    if (pathname === APPLIANCE_SEARCH_PATH) {
      if (request.method === "POST") {
        const kind = searchRequestIn(await readJson(request), drivers);
        const airConditioners = drivers["air-conditioner"];
        const lights = drivers.light;
        sendJson(
          response,
          200,
          kind === "air-conditioner" && airConditioners !== undefined
            ? await searchAirConditioners(airConditioners)
            : kind === "light" && lights !== undefined
              ? await searchLights(appliances, lights)
              : await search(drivers, kind),
        );
      } else refuseMethod(response, ["POST"]);
      return true;
    }
    if (pathname === LIGHTS_PATH) {
      if (request.method === "POST") {
        const driver = drivers.light;
        if (driver === undefined) throw new HttpRefusal(400, "The Hub has no Lights to change.");
        const asked = lightsChangeRequestIn(await readJson(request));
        const lights =
          asked.roomId === undefined
            ? appliances.list().filter(({ kind }) => kind === "light")
            : appliances.inRoom("light", asked.roomId);
        onLightsChanged?.(lights.map(({ id: lightId }) => lightId));
        sendJson(response, 200, await changeLights(appliances, driver, asked));
      } else refuseMethod(response, ["POST"]);
      return true;
    }
    const match = APPLIANCE_PATH.exec(pathname);
    if (match?.[1] !== undefined) {
      const id = Number(match[1]);
      switch (match[2]) {
        case "connection":
          await onlyPost(request, response, () => connect(appliances, drivers, id));
          break;
        case "pairing":
          await onlyPost(request, response, () => pairAgain(appliances, drivers, id, request));
          break;
        case "state": {
          const appliance = appliances.get(id);
          if (appliance.kind === "light") {
            const driver = lightDriverOf(drivers, appliances, appliance);
            if (request.method === "GET" || request.method === "HEAD") {
              sendJson(response, 200, await readLight(appliances, driver, appliance));
            } else if (request.method === "PATCH") {
              const change = lightChangeIn(await readJson(request));
              onLightsChanged?.([appliance.id]);
              sendJson(response, 200, await changeLight(appliances, driver, appliance, change));
            } else refuseMethod(response, ["GET", "HEAD", "PATCH"]);
            break;
          }
          const driver = airConditionerDriverOf(drivers, appliances, appliance);
          if (request.method === "GET" || request.method === "HEAD") {
            sendJson(response, 200, await readAirConditioner(appliances, driver, appliance));
          } else if (request.method === "PATCH") {
            const change = airConditionerChangeIn(await readJson(request));
            sendJson(response, 200, await changeAirConditioner(appliances, driver, appliance, change));
          } else refuseMethod(response, ["GET", "HEAD", "PATCH"]);
          break;
        }
        case "capabilities": {
          const appliance = appliances.get(id);
          if (request.method !== "GET" && request.method !== "HEAD") {
            refuseMethod(response, ["GET", "HEAD"]);
          } else if (appliance.kind === "light") {
            const driver = lightDriverOf(drivers, appliances, appliance);
            sendJson(response, 200, await readLightCapabilities(appliances, driver, appliance));
          } else {
            const driver = airConditionerDriverOf(drivers, appliances, appliance);
            sendJson(response, 200, await readAirConditionerCapabilities(appliances, driver, appliance));
          }
          break;
        }
        case "keys":
          if (request.method === "POST") {
            await pressKey(appliances, drivers, id, keyRequestIn(await readJson(request)));
            response.writeHead(204).end();
          } else refuseMethod(response, ["POST"]);
          break;
        case "shortcuts":
          if (request.method === "POST") {
            const { ignored } = await pressShortcut(
              appliances,
              drivers,
              id,
              shortcutRequestIn(await readJson(request)),
            );
            // Sent now, so that the Remote sends the next key without waiting
            // while the Hub listens for the Appliance to say it ignored this one.
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).flushHeaders();
            const body: ShortcutOutcome = { outcome: (await ignored) ? "ignored" : "unconfirmed" };
            response.end(JSON.stringify(body));
          } else refuseMethod(response, ["POST"]);
          break;
        case "power":
          if (request.method === "GET" || request.method === "HEAD") {
            sendJson(response, 200, await readPower(appliances, drivers, id));
          } else if (request.method === "POST") {
            sendJson(response, 200, await switchPower(appliances, drivers, id));
          } else refuseMethod(response, ["GET", "HEAD", "POST"]);
          break;
        case "volume":
          if (request.method === "GET" || request.method === "HEAD") {
            sendJson(response, 200, await readVolume(appliances, drivers, id));
          } else if (request.method === "PATCH") {
            sendJson(
              response,
              200,
              await changeVolume(appliances, drivers, id, volumeChangeIn(await readJson(request))),
            );
          } else refuseMethod(response, ["GET", "HEAD", "PATCH"]);
          break;
        case "keyboard":
          if (request.method === "GET" || request.method === "HEAD") {
            sendJson(response, 200, await readKeyboard(appliances, drivers, id));
          } else if (request.method === "POST") {
            await enterText(appliances, drivers, id, keyboardTextIn(await readJson(request)));
            response.writeHead(204).end();
          } else refuseMethod(response, ["GET", "HEAD", "POST"]);
          break;
        case "apps":
          if (request.method === "GET" || request.method === "HEAD")
            sendJson(response, 200, await readApps(appliances, drivers, id));
          else refuseMethod(response, ["GET", "HEAD"]);
          break;
        case "now-showing":
          if (request.method === "GET" || request.method === "HEAD") {
            sendJson(response, 200, await readNowShowing(appliances, drivers, id, nowPlayingAt));
          } else refuseMethod(response, ["GET", "HEAD"]);
          break;
        case "device-info":
          if (request.method === "GET" || request.method === "HEAD") {
            sendJson(response, 200, await readDeviceInfo(appliances, drivers, id));
          } else refuseMethod(response, ["GET", "HEAD"]);
          break;
        default:
          await oneAppliance(appliances, drivers, id, request, response);
      }
      return true;
    }
    const app = APP_PATH.exec(pathname);
    if (app?.[1] !== undefined && app[2] !== undefined) {
      const id = Number(app[1]);
      const appId = appIdIn(app[2]);
      if (app[3] !== undefined) {
        if (request.method === "GET" || request.method === "HEAD") {
          await sendAppIcon(appliances, drivers, id, appId, request.method === "HEAD", response);
        } else refuseMethod(response, ["GET", "HEAD"]);
      } else if (request.method === "POST" || request.method === "DELETE") {
        await launchOrClose(appliances, drivers, id, appId, request.method === "POST" ? "launch" : "close");
        response.writeHead(204).end();
      } else refuseMethod(response, ["POST", "DELETE"]);
      return true;
    }
    if (pathname.startsWith(`${APPLIANCES_PATH}/`)) throw new HttpRefusal(404, "That Appliance has been removed.");
    return false;
  } catch (error) {
    if (error instanceof ApplianceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    if (error instanceof DriverFailure) throw new HttpRefusal(DRIVER_FAILURE_STATUS[error.reason], error.message);
    throw error;
  }
};

const appliancesCollection = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "GET":
    case "HEAD":
      sendJson(response, 200, appliances.list());
      return;
    case "POST": {
      const asked = addRequestIn(await readJson(request), drivers);
      const airConditioners = drivers["air-conditioner"];
      const lights = drivers.light;
      sendJson(
        response,
        201,
        asked.kind === "air-conditioner" && airConditioners !== undefined
          ? await addAirConditioner(appliances, airConditioners, asked)
          : asked.kind === "light" && lights !== undefined
            ? await addLight(appliances, lights, asked)
            : await add(appliances, drivers, asked),
      );
      return;
    }
    default:
      refuseMethod(response, ["GET", "HEAD", "POST"]);
  }
};

const oneAppliance = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "PATCH":
      sendJson(response, 200, appliances.update(id, updateRequestIn(await readJson(request))));
      return;
    case "DELETE": {
      const appliance = appliances.get(id);
      if (isHiveKind(appliance.kind)) {
        // Hive would list it again: it goes with the rest as the Hub signs out.
        throw new HttpRefusal(
          409,
          `${appliances.title(appliance)} is Hive's, and goes only as the Hub signs out of Hive, in Settings.`,
        );
      }
      const title = appliances.title(appliance);
      appliances.remove(id);
      if (appliance.kind === "tv") drivers.tv.disconnect?.(appliance.address);
      console.log(`Removed ${title}, and the credentials it issued`);
      response.writeHead(204).end();
      return;
    }
    default:
      refuseMethod(response, ["PATCH", "DELETE"]);
  }
};

const onlyPost = async (
  request: IncomingMessage,
  response: ServerResponse,
  work: () => Promise<Appliance>,
): Promise<void> => {
  if (request.method !== "POST") {
    refuseMethod(response, ["POST"]);
    return;
  }
  sendJson(response, 200, await work());
};

/**
 * Reads what the Appliance says about itself, pairs with it, and keeps it with
 * the credentials it issued (FR-12 to FR-14). The name and Room are checked
 * first, so a refusal doesn't keep the person waiting on a prompt.
 */
const add = async (appliances: ApplianceStore, drivers: Drivers, asked: AddApplianceRequest): Promise<Appliance> => {
  const driver = drivers.tv;
  const given = asked.name?.trim() ?? "";
  if (given !== "") appliances.checkPlace(asked.kind, given, asked.roomId);

  const identity = await driver.identify(asked.address);
  const already = appliances.withMacAddress(asked.kind, identity.macAddress);
  if (already !== undefined) {
    const kindName = KIND_NAMES[asked.kind];
    throw new ApplianceRefusal("taken", `That ${kindName} is already added, as ${appliances.title(already)}.`);
  }
  const name = given === "" ? firstCharacters(identity.name.trim(), APPLIANCE_NAME_MAX_LENGTH) : given;
  appliances.checkPlace(asked.kind, name, asked.roomId);

  const credentials = await driver.pair(asked.address);
  const appliance = appliances.add(
    {
      kind: asked.kind,
      name,
      roomId: asked.roomId,
      address: asked.address,
      model: identity.model,
      macAddress: identity.macAddress,
    },
    credentials,
  );
  const what = `a ${KIND_NAMES[asked.kind]} at ${appliance.address} (${appliance.model})`;
  console.log(`Added ${appliances.title(appliance)}, ${what}`);
  return appliance;
};

/**
 * Has the kind's Driver search the subnet (FR-12). Whether each found one is
 * already added is for the Remote to show, from the Appliances it lists.
 */
const search = async (drivers: Drivers, kind: ApplianceKind): Promise<FoundAppliance[]> => {
  const { discover } = drivers.tv;
  const kindName = KIND_NAMES[kind];
  if (discover === undefined) {
    throw new HttpRefusal(400, `The Hub can't search for ${kindName}s. Add one by its IP address instead.`);
  }
  const found = (await discover()).map(({ address, name, model, macAddress }) => ({
    kind,
    address,
    name,
    model,
    macAddress,
  }));
  console.log(`Searched the network for ${kindName}s, and found ${String(found.length)}`);
  return found;
};

/**
 * Connects with the stored credentials, and notes whether the Appliance still
 * accepts them (FR-13): for an Air Conditioner, its token and key (FR-51),
 * and for a Light, its key, reading its state with them.
 */
const connect = async (appliances: ApplianceStore, drivers: Drivers, id: number): Promise<Appliance> => {
  const appliance = appliances.get(id);
  if (appliance.kind === "air-conditioner") {
    return checkKeys(appliances, airConditionerDriverOf(drivers, appliances, appliance), appliance);
  }
  if (appliance.kind === "light") {
    await readLight(appliances, lightDriverOf(drivers, appliances, appliance), appliance);
    return appliances.get(id);
  }
  const answer = await tvDriverOf(drivers, appliances, appliance).connect(
    appliance.address,
    appliances.credentials(id),
  );
  if (answer.accepted) return appliances.paired(id, answer.credentials);
  if (appliance.pairing === "paired") {
    console.log(`${appliances.title(appliance)} refused the Hub's credentials, so it needs pairing again`);
  }
  return appliances.refused(id);
};

/**
 * Pairs again, replacing the credentials the Appliance no longer accepts
 * (FR-13): for an Air Conditioner, "Fetch again", with the owner's login in
 * the request (FR-51).
 */
const pairAgain = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  request: IncomingMessage,
): Promise<Appliance> => {
  const appliance = appliances.get(id);
  if (appliance.kind === "air-conditioner") {
    const driver = airConditionerDriverOf(drivers, appliances, appliance);
    const body = await readJson(request);
    const login = loginIn(typeof body === "object" && body !== null && "login" in body ? body.login : undefined);
    if (login === undefined) {
      throw new HttpRefusal(401, "Sign in to fetch this Air Conditioner's token and key again.", "login");
    }
    return fetchKeysAgain(appliances, driver, appliance, login);
  }
  const credentials = await tvDriverOf(drivers, appliances, appliance).pair(appliance.address);
  const paired = appliances.paired(id, credentials);
  console.log(`Paired ${appliances.title(paired)} again`);
  return paired;
};

/**
 * Asks the Appliance whether it is on, now (FR-16). The Remote asks every few
 * seconds while it shows the Appliance, so nothing is logged.
 */
const readPower = async (appliances: ApplianceStore, drivers: Drivers, id: number): Promise<AppliancePower> => {
  const appliance = appliances.get(id);
  return { power: await tvDriverOf(drivers, appliances, appliance).readPowerState(appliance.address) };
};

/**
 * Has the Appliance's Driver press the key (FR-18). Keys come quickly, so only
 * a refused one is logged.
 */
const pressKey = async (appliances: ApplianceStore, drivers: Drivers, id: number, key: string): Promise<void> => {
  const appliance = appliances.get(id);
  const { pressKey: press } = tvDriverOf(drivers, appliances, appliance);
  if (press === undefined) throw new HttpRefusal(400, `${appliances.title(appliance)} has no keys to press.`);
  await withCredentials(appliances, id, "a key", (credentials) => press(appliance.address, credentials, key));
};

/**
 * Has the Appliance's Driver press the shortcut's key (FR-24), and resolves
 * once it is sent, with `ignored` to say whether, a moment later, the
 * Appliance said it ignored it. One it ignored is logged, for whoever looks into which shortcuts a
 * model takes.
 */
const pressShortcut = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  shortcut: string,
): Promise<{ readonly ignored: Promise<boolean> }> => {
  const appliance = appliances.get(id);
  const { pressShortcut: press } = tvDriverOf(drivers, appliances, appliance);
  const title = appliances.title(appliance);
  if (press === undefined) throw new HttpRefusal(400, `${title} has no menu shortcuts.`);
  const { ignored } = await withCredentials(appliances, id, "a shortcut", (credentials) =>
    press(appliance.address, credentials, shortcut),
  );
  return {
    ignored: ignored.then((wasIgnored) => {
      if (wasIgnored) console.log(`${title} said it ignored the ${shortcut} shortcut's key`);
      return wasIgnored;
    }),
  };
};

/**
 * The Power button (FR-17): reads whether the Appliance is on now, rather than
 * trusting what the Remote last saw, and has its Driver switch it the other
 * way. One in standby or not answering is switched on, as Wake-on-LAN can
 * wake a TV whose firmware doesn't answer in standby.
 */
const switchPower = async (appliances: ApplianceStore, drivers: Drivers, id: number): Promise<PowerSwitch> => {
  const appliance = appliances.get(id);
  const { readPowerState, switchOn, switchOff } = tvDriverOf(drivers, appliances, appliance);
  const title = appliances.title(appliance);
  if (switchOn === undefined || switchOff === undefined)
    throw new HttpRefusal(400, `${title} can't be switched on or off.`);

  const power = await readPowerState(appliance.address);
  if (power === "on") {
    await withCredentials(appliances, id, "the power key", (credentials) => switchOff(appliance.address, credentials));
    console.log(`Switching ${title} off`);
    return { switching: "off" };
  }
  await switchOn(appliance);
  console.log(`Sent Wake-on-LAN to ${title}, which ${power === "standby" ? "was in standby" : "didn't answer"}`);
  return { switching: "on" };
};

/**
 * Asks the Appliance for its own volume and mute, now (FR-19). The Remote asks
 * every few seconds for the Selected TV's, so nothing is logged.
 */
const readVolume = async (appliances: ApplianceStore, drivers: Drivers, id: number): Promise<ApplianceVolume> => {
  const appliance = appliances.get(id);
  const { readVolume: read } = tvDriverOf(drivers, appliances, appliance);
  if (read === undefined) return { known: false };
  return read(appliance.address);
};

/**
 * Has the Driver set the volume, then the mute, and answers with them as the
 * Appliance says they are now. A slider sends many as it is dragged, so
 * nothing is logged.
 */
const changeVolume = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  change: VolumeChange,
): Promise<ApplianceVolume> => {
  const appliance = appliances.get(id);
  const { readVolume: read, setVolume, setMute } = tvDriverOf(drivers, appliances, appliance);
  if (read === undefined || setVolume === undefined || setMute === undefined) {
    throw new HttpRefusal(400, `${appliances.title(appliance)}'s volume can't be set.`);
  }
  if (change.volume !== undefined) await setVolume(appliance.address, change.volume);
  if (change.muted !== undefined) await setMute(appliance.address, change.muted);
  return read(appliance.address);
};

/**
 * Asks whether the Appliance's on-screen keyboard is open, now (FR-20). The
 * Remote asks every second for the Selected TV's, so nothing is logged. One
 * that can't be reached has no keyboard open; nor, as far as the Remote is
 * told, has one that needs pairing again, which isn't asked, as a TV may ask
 * the person to allow the Hub each time it is.
 */
const readKeyboard = async (appliances: ApplianceStore, drivers: Drivers, id: number): Promise<ApplianceKeyboard> => {
  const appliance = appliances.get(id);
  const { readKeyboard: read } = tvDriverOf(drivers, appliances, appliance);
  if (read === undefined || appliance.pairing === "pair-again") return { open: false };
  try {
    const { open } = await withCredentials(appliances, id, "a keyboard reading", (credentials) =>
      read(appliance.address, credentials),
    );
    return { open };
  } catch (error) {
    if (error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out")) {
      return { open: false };
    }
    throw error;
  }
};

/**
 * Has the Driver type the text into the Appliance's on-screen keyboard and
 * submit it (FR-20). The text may be a password, so it is never logged.
 */
const enterText = async (appliances: ApplianceStore, drivers: Drivers, id: number, text: string): Promise<void> => {
  const appliance = appliances.get(id);
  const { enterText: enter } = tvDriverOf(drivers, appliances, appliance);
  if (enter === undefined) throw new HttpRefusal(400, `${appliances.title(appliance)} has no keyboard to type on.`);
  await withCredentials(appliances, id, "text", (credentials) => enter(appliance.address, credentials, text));
};

/**
 * Asks the Appliance for its installed apps, now (FR-21), after asking
 * whether it is on, so that one in standby or not answering says so rather
 * than having no apps. One that needs pairing again isn't asked, as a TV may
 * ask the person to allow the Hub each time it is. The Remote asks again from
 * time to time, so nothing is logged.
 */
const readApps = async (appliances: ApplianceStore, drivers: Drivers, id: number): Promise<ApplianceApps> => {
  const appliance = appliances.get(id);
  const { readPowerState, listApps } = tvDriverOf(drivers, appliances, appliance);
  const title = appliances.title(appliance);
  if (listApps === undefined) throw new HttpRefusal(400, `${title} has no apps.`);
  const power = await readPowerState(appliance.address);
  if (power !== "on") return { known: false, why: power };
  if (appliance.pairing === "pair-again") throw pairAgainRefusal(title);
  try {
    const { apps } = await withCredentials(appliances, id, "a request for its apps", (credentials) =>
      listApps(appliance.address, credentials),
    );
    return { known: true, apps: [...apps].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })) };
  } catch (error) {
    if (error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out")) {
      return { known: false, why: "unreachable" };
    }
    throw error;
  }
};

/**
 * Asks the Appliance what is in front on it, now (FR-26), after asking
 * whether it is on, so that one in standby or not answering says so. One that
 * needs pairing again isn't asked, as for its apps. When it is the Player,
 * what that plays is added, as the Player last told the Hub (FR-27). Nothing
 * is sent that changes the Appliance, so the Remote may ask as often as it
 * likes, as it does every few seconds, and nothing is logged.
 */
const readNowShowing = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  nowPlayingAt: AppliancesApiOptions["nowPlayingAt"],
): Promise<NowShowing> => {
  const appliance = appliances.get(id);
  const { readPowerState, readNowShowing: read } = tvDriverOf(drivers, appliances, appliance);
  const title = appliances.title(appliance);
  if (read === undefined) throw new HttpRefusal(400, `${title} can't say what it is showing.`);
  const power = await readPowerState(appliance.address);
  if (power !== "on") return { known: false, why: power };
  if (appliance.pairing === "pair-again") throw pairAgainRefusal(title);
  try {
    const { app } = await withCredentials(appliances, id, "a request for what it is showing", (credentials) =>
      read(appliance.address, credentials),
    );
    if (app === undefined) return { known: false, why: "cannot-tell" };
    if (app.id !== PLAYER_APP_ID || nowPlayingAt === undefined) return { known: true, app };
    return { known: true, app, nowPlaying: nowPlayingAt(appliance.address) };
  } catch (error) {
    if (error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out")) {
      return { known: false, why: "unreachable" };
    }
    throw error;
  }
};

/**
 * Asks the Appliance what it reports about itself, now (FR-28). It needs no
 * credentials, so one that needs pairing again is asked too. Nothing is sent
 * that changes the Appliance, so the Remote may ask as often as it likes, as
 * it does every few seconds while it shows it, and nothing is logged.
 */
const readDeviceInfo = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
): Promise<ApplianceDeviceInfo> => {
  const appliance = appliances.get(id);
  const { readDeviceInfo: read } = tvDriverOf(drivers, appliances, appliance);
  if (read === undefined) throw new HttpRefusal(400, `${appliances.title(appliance)} reports no device info.`);
  try {
    return { known: true, info: await read(appliance.address) };
  } catch (error) {
    if (error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out")) {
      return { known: false, why: "unreachable" };
    }
    throw error;
  }
};

/**
 * Answers with the app's icon, as the Appliance gives it. The Remote asks for
 * each it shows, so nothing is logged. An icon changes only with the app, so
 * the browser may keep it a while.
 */
const sendAppIcon = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  appId: string,
  head: boolean,
  response: ServerResponse,
): Promise<void> => {
  const appliance = appliances.get(id);
  const { readAppIcon } = tvDriverOf(drivers, appliances, appliance);
  const title = appliances.title(appliance);
  if (readAppIcon === undefined) throw new HttpRefusal(400, `${title} has no apps.`);
  if (appliance.pairing === "pair-again") throw pairAgainRefusal(title);
  const { icon } = await withCredentials(appliances, id, "a request for an app's icon", (credentials) =>
    readAppIcon(appliance.address, credentials, appId),
  );
  if (icon === undefined) throw new HttpRefusal(404, `${title} gives no icon for that app.`);
  response
    .writeHead(200, {
      "content-type": icon.type,
      "content-length": String(icon.bytes.length),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    })
    .end(head ? undefined : icon.bytes);
};

/** Has the Driver launch or close the app (FR-21), which the person asked for, so it is logged. */
const launchOrClose = async (
  appliances: ApplianceStore,
  drivers: Drivers,
  id: number,
  appId: string,
  what: "launch" | "close",
): Promise<void> => {
  const appliance = appliances.get(id);
  const { launchApp, closeApp } = tvDriverOf(drivers, appliances, appliance);
  const title = appliances.title(appliance);
  const work = what === "launch" ? launchApp : closeApp;
  if (work === undefined) throw new HttpRefusal(400, `${title} has no apps.`);
  await work(appliance.address, appId);
  console.log(`${what === "launch" ? "Launched" : "Closed"} app ${appId} on ${title}`);
};

/**
 * Has the Driver do what needs the Appliance's credentials, and keeps any it
 * renewed. One that refuses them is marked to be paired again (FR-13), and one
 * the Driver refused to send, e.g. a service-menu key (FR-30), is logged as
 * `what`.
 */
export const withCredentials = async <Answer extends ConnectionAnswer>(
  appliances: ApplianceStore,
  id: number,
  what: string,
  work: (credentials: string) => Promise<Answer>,
): Promise<Extract<Answer, { accepted: true }>> => {
  const appliance = appliances.get(id);
  const title = appliances.title(appliance);
  const credentials = appliances.credentials(id);
  let answer;
  try {
    answer = await work(credentials);
  } catch (error) {
    if (error instanceof DriverFailure && error.reason === "refused") {
      console.log(`Refused to send ${what} to ${title}: ${error.message}`);
    }
    throw error;
  }
  if (answer.accepted) {
    if (answer.credentials !== credentials || appliance.pairing === "pair-again") {
      appliances.paired(id, answer.credentials);
    }
    return answer as Extract<Answer, { accepted: true }>;
  }
  if (appliance.pairing === "paired") console.log(`${title} refused the Hub's credentials, so it needs pairing again`);
  appliances.refused(id);
  throw pairAgainRefusal(title);
};

/** The Driver of a TV, or a refusal for an Appliance of another kind, which hasn't what a TV has. */
const tvDriverOf = (drivers: Drivers, appliances: ApplianceStore, appliance: Appliance): Driver => {
  if (appliance.kind !== "tv") throw new HttpRefusal(400, `${appliances.title(appliance)} isn't a TV.`);
  return drivers.tv;
};

/** The Driver of an Air Conditioner, or a refusal for an Appliance of another kind. */
const airConditionerDriverOf = (
  drivers: Drivers,
  appliances: ApplianceStore,
  appliance: Appliance,
): AirConditionerDriver => {
  const driver = drivers["air-conditioner"];
  if (appliance.kind !== "air-conditioner" || driver === undefined) {
    throw new HttpRefusal(400, `${appliances.title(appliance)} isn't an Air Conditioner the Hub can control.`);
  }
  return driver;
};

/** The Driver of a Light, or a refusal for an Appliance of another kind. */
const lightDriverOf = (drivers: Drivers, appliances: ApplianceStore, appliance: Appliance): LightDriver => {
  const driver = drivers.light;
  if (appliance.kind !== "light" || driver === undefined) {
    throw new HttpRefusal(400, `${appliances.title(appliance)} isn't a Light the Hub can control.`);
  }
  return driver;
};

export const pairAgainRefusal = (title: string): HttpRefusal =>
  new HttpRefusal(409, `${title} no longer lets the Hub in. Pair it again in Settings.`);

/** The app id in a path, which may be any text: see `ApplianceApp.id`. */
const appIdIn = (segment: string): string => {
  let appId: string;
  try {
    appId = decodeURIComponent(segment);
  } catch {
    appId = "";
  }
  if (!APP_ID.test(appId)) throw new HttpRefusal(400, "The TV has no such app.");
  return appId;
};

/** The key a `KeyPressRequest` names, which may be any text: see `Driver.pressKey`. */
const keyRequestIn = (body: unknown): string => {
  const key = typeof body === "object" && body !== null && "key" in body ? body.key : undefined;
  if (typeof key !== "string" || key.trim() === "" || key.length > LONGEST_KEY_NAME) {
    throw new HttpRefusal(400, "Say which key to press.");
  }
  return key;
};

/** The shortcut a `ShortcutRequest` names, which may be any text: see `Driver.pressShortcut`. */
const shortcutRequestIn = (body: unknown): string => {
  const shortcut = typeof body === "object" && body !== null && "shortcut" in body ? body.shortcut : undefined;
  if (typeof shortcut !== "string" || shortcut.trim() === "" || shortcut.length > LONGEST_KEY_NAME) {
    throw new HttpRefusal(400, "Say which shortcut to press.");
  }
  return shortcut;
};

/** The text a `KeyboardText` gives, exactly as typed. */
const keyboardTextIn = (body: unknown): string => {
  const text = typeof body === "object" && body !== null && "text" in body ? body.text : undefined;
  if (typeof text !== "string" || text === "") throw new HttpRefusal(400, "Type something to send to the TV.");
  if (text.length > KEYBOARD_TEXT_MAX_LENGTH) {
    throw new HttpRefusal(400, `Send at most ${KEYBOARD_TEXT_MAX_LENGTH.toLocaleString("en")} characters at a time.`);
  }
  // Half of a surrogate pair, which has no UTF-8 to send it as.
  if (!text.isWellFormed()) throw new HttpRefusal(400, "That text has a broken character in it. Type it again.");
  return text;
};

const volumeChangeIn = (body: unknown): VolumeChange => {
  if (typeof body !== "object" || body === null) throw new HttpRefusal(400, "Say what to change.");
  const volume = "volume" in body ? body.volume : undefined;
  const muted = "muted" in body ? body.muted : undefined;
  if (
    volume !== undefined &&
    !(Number.isInteger(volume) && (volume as number) >= 0 && (volume as number) <= VOLUME_MAX)
  ) {
    throw new HttpRefusal(400, `Give the volume as a whole number from 0 to ${String(VOLUME_MAX)}.`);
  }
  if (muted !== undefined && typeof muted !== "boolean")
    throw new HttpRefusal(400, "Say whether to mute, as true or false.");
  if (volume === undefined && muted === undefined)
    throw new HttpRefusal(400, "Say what to change: the volume, the mute or both.");
  return {
    ...(volume === undefined ? {} : { volume: volume as number }),
    ...(muted === undefined ? {} : { muted }),
  };
};

/** The kinds of Appliance found on the home network and added by address. */
const ADDED_BY_ADDRESS: readonly ApplianceKind[] = ["tv", "air-conditioner", "light"];

/**
 * Whether the Hub has a Driver for this kind of Appliance, which comes from
 * outside the Hub, and adds it by address: never a Driver that signs in to a
 * maker's cloud instead, as the Heating's does.
 */
const hasDriver = (drivers: Drivers, kind: unknown): kind is ApplianceKind =>
  typeof kind === "string" &&
  (ADDED_BY_ADDRESS as readonly string[]).includes(kind) &&
  drivers[kind as keyof Drivers] !== undefined;

const searchRequestIn = (body: unknown, drivers: Drivers): ApplianceKind => {
  const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : undefined;
  if (!hasDriver(drivers, kind)) throw new HttpRefusal(400, "The Hub can't search for that kind of Appliance.");
  return kind;
};

const addRequestIn = (body: unknown, drivers: Drivers): AddApplianceRequest => {
  if (typeof body !== "object" || body === null) throw new HttpRefusal(400, "Say which Appliance to add.");
  const kind = "kind" in body && hasDriver(drivers, body.kind) ? body.kind : undefined;
  if (kind === undefined) throw new HttpRefusal(400, "The Hub can't add that kind of Appliance.");
  const kindName = KIND_NAMES[kind];

  const address = "address" in body && typeof body.address === "string" ? body.address.trim() : "";
  if (isIP(address) === 0) throw new HttpRefusal(400, `Give the ${kindName}'s IP address, e.g. 192.168.1.20.`);

  if ("name" in body && body.name !== undefined && typeof body.name !== "string") {
    throw new HttpRefusal(400, `Give the ${kindName} a name, or leave it empty for the ${kindName}'s own.`);
  }
  const name = "name" in body && typeof body.name === "string" ? body.name : undefined;
  const roomId = "roomId" in body ? roomIdIn(body.roomId) : null;
  const login = kind === "air-conditioner" && "login" in body ? loginIn(body.login) : undefined;
  const light = kind === "light" && "light" in body ? lightKeysIn(body.light) : undefined;

  return {
    kind,
    address,
    roomId,
    ...(name === undefined ? {} : { name }),
    ...(login === undefined ? {} : { login }),
    ...(light === undefined ? {} : { light }),
  };
};

const updateRequestIn = (body: unknown): UpdateApplianceRequest => {
  if (typeof body !== "object" || body === null) throw new HttpRefusal(400, "Say what to change.");
  if ("name" in body && typeof body.name !== "string") throw new HttpRefusal(400, "Give the Appliance a name.");
  return {
    ...("name" in body && typeof body.name === "string" ? { name: body.name } : {}),
    ...("roomId" in body ? { roomId: roomIdIn(body.roomId) } : {}),
    ...("filmLightSceneId" in body ? { filmLightSceneId: filmLightSceneIdIn(body.filmLightSceneId) } : {}),
  };
};

const filmLightSceneIdIn = (value: unknown): number | null => {
  if (value === null || Number.isSafeInteger(value)) return value as number | null;
  throw new HttpRefusal(400, "Give the Light Scene as its id, or null for none.");
};

const roomIdIn = (value: unknown): number | null => {
  if (value === null || Number.isSafeInteger(value)) return value as number | null;
  throw new HttpRefusal(400, 'Give the Room as its id, or null for "No room".');
};
