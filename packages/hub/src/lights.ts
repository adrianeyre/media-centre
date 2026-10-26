import {
  APPLIANCE_NAME_MAX_LENGTH,
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_BRIGHTNESS_MIN,
  LIGHT_KEYS_MAX_LENGTH,
  type Appliance,
  type FoundLight,
  type LightCapabilitiesReading,
  type LightChange,
  type LightKeysGiven,
  type LightReading,
  type LightsChange,
  type LightsChangeRequest,
  type LightsOutcome,
} from "@media-centre/shared";

import { ApplianceRefusal, type ApplianceStore } from "./appliances.ts";
import { CredentialsRefused, DriverFailure, type LightDriver } from "./drivers/driver.ts";
import { HttpRefusal } from "./http.ts";
import { firstCharacters } from "./names.ts";

/**
 * Lights as the Hub adds, reads and changes them (FR-52 to FR-54, FR-57b),
 * through their Driver, which alone knows their protocol (NFR-6). The id
 * and key the person gives for each are its credentials, kept as any
 * Appliance's are, and never logged or sent back (FR-4).
 */

/**
 * Has the Driver search the subnet, "Find Lights" (FR-54), saying of each
 * found which Light it already is, as only the Hub can tell, from what each
 * said of itself, which never leaves it.
 */
export const searchLights = async (appliances: ApplianceStore, driver: LightDriver): Promise<FoundLight[]> => {
  const kept = lightsOf(appliances).map((light) => ({ id: light.id, credentials: appliances.credentials(light.id) }));
  const found = (await driver.discover()).map(({ address, name, model, credentials }): FoundLight => ({
    kind: "light",
    address,
    name,
    model,
    applianceId: kept.find((light) => driver.isSameLight(light.credentials, credentials))?.id ?? null,
  }));
  console.log(`Searched the network for Lights, and found ${String(found.length)}`);
  return found;
};

const lightsOf = (appliances: ApplianceStore): Appliance[] => appliances.list().filter(({ kind }) => kind === "light");

export interface LightToAdd {
  readonly address: string;
  readonly name?: string;
  readonly roomId: number | null;
  readonly light?: LightKeysGiven;
}

/**
 * Finds the Light at the address, or takes it as the person gives it, by
 * its id, and keeps it once it has answered to the key the person gave, so
 * that what is kept is known to work. The name and Room are checked first,
 * so a refusal doesn't wait on the Light.
 */
export const addLight = async (
  appliances: ApplianceStore,
  driver: LightDriver,
  asked: LightToAdd,
): Promise<Appliance> => {
  const given = asked.name?.trim() ?? "";
  if (given !== "") appliances.checkPlace("light", given, asked.roomId);
  if (asked.light === undefined) {
    throw new HttpRefusal(400, "Give the Light's local key, which lets the Hub in to it.");
  }

  const { id, key } = asked.light;
  const found = id === undefined ? await driver.identify(asked.address) : driver.given(asked.address, id);
  const credentials = driver.withKey(found.credentials, key);
  const already = lightsOf(appliances).find((light) =>
    driver.isSameLight(appliances.credentials(light.id), credentials),
  );
  if (already !== undefined) {
    throw new ApplianceRefusal("taken", `That Light is already added, as ${appliances.title(already)}.`);
  }
  const name = given === "" ? firstCharacters(found.name.trim(), APPLIANCE_NAME_MAX_LENGTH) : given;
  appliances.checkPlace("light", name, asked.roomId);

  try {
    await driver.readCapabilities(asked.address, credentials);
  } catch (error) {
    if (!(error instanceof CredentialsRefused)) throw error;
    throw new HttpRefusal(
      400,
      "The Light didn't answer to that device id and local key. Check each, as they were read from the Light.",
    );
  }
  const appliance = appliances.add(
    { kind: "light", name, roomId: asked.roomId, address: asked.address, model: found.model, macAddress: "" },
    credentials,
  );
  console.log(`Added ${appliances.title(appliance)}, a Light at ${appliance.address} (${appliance.model})`);
  return appliance;
};

/**
 * Does what needs the Light's key, noting whether it still answers to it:
 * one that refuses it is marked `"pair-again"`, and one that answers again
 * is marked `"paired"`. Resolves with "key-refused" for one that refused it.
 */
const withKey = async <T>(
  appliances: ApplianceStore,
  appliance: Appliance,
  work: (credentials: string) => Promise<T>,
): Promise<T | "key-refused"> => {
  const credentials = appliances.credentials(appliance.id);
  try {
    const done = await work(credentials);
    if (appliance.pairing === "pair-again") appliances.paired(appliance.id, credentials);
    return done;
  } catch (error) {
    if (!(error instanceof CredentialsRefused)) throw error;
    if (appliance.pairing === "paired") {
      console.log(`${appliances.title(appliance)} refused the Hub's key, so it needs giving again`);
    }
    appliances.refused(appliance.id);
    return "key-refused";
  }
};

/** Whether the Driver failed for want of an answer, which a reading says rather than refusing (FR-57b). */
const isUnreachable = (error: unknown): boolean =>
  error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out");

/** Reads what the Light is doing, now. The Remote asks every few seconds while it shows it, so nothing is logged. */
export const readLight = async (
  appliances: ApplianceStore,
  driver: LightDriver,
  appliance: Appliance,
): Promise<LightReading> => {
  try {
    const state = await withKey(appliances, appliance, (credentials) =>
      driver.readState(appliance.address, credentials),
    );
    return state === "key-refused" ? { known: false, why: "key-refused" } : { known: true, state };
  } catch (error) {
    if (isUnreachable(error)) return { known: false, why: "unreachable" };
    throw error;
  }
};

/**
 * Reads the controls the Light reports it has, now, for the Lights tab to
 * show it with (FR-52). The Remote asks as it first shows the Light, and
 * again only until it answers, so nothing is logged.
 */
export const readLightCapabilities = async (
  appliances: ApplianceStore,
  driver: LightDriver,
  appliance: Appliance,
): Promise<LightCapabilitiesReading> => {
  try {
    const capabilities = await withKey(appliances, appliance, (credentials) =>
      driver.readCapabilities(appliance.address, credentials),
    );
    return capabilities === "key-refused" ? { known: false, why: "key-refused" } : { known: true, capabilities };
  } catch (error) {
    if (isUnreachable(error)) return { known: false, why: "unreachable" };
    throw error;
  }
};

/**
 * Has the Driver change what is asked, and answers with the state the Light
 * then reports. A change is refused, not dropped, when the Light can't be
 * reached or refuses the Hub's key.
 */
export const changeLight = async (
  appliances: ApplianceStore,
  driver: LightDriver,
  appliance: Appliance,
  change: LightChange,
): Promise<LightReading> => {
  const state = await withKey(appliances, appliance, (credentials) =>
    driver.setState(appliance.address, credentials, change),
  );
  if (state === "key-refused") {
    throw new HttpRefusal(409, `${appliances.title(appliance)} no longer answers to the Hub's key.`);
  }
  return { known: true, state };
};

/**
 * A Room-wide control or All off (FR-53): makes the change of every Light in
 * the Room, or in the home, at once, each through its Driver, and answers
 * once each has answered or not, saying which didn't (FR-57b). A
 * brightness also switches on each Light that dims, and leaves one that
 * doesn't, such as a smart plug, as it is.
 */
export const changeLights = async (
  appliances: ApplianceStore,
  driver: LightDriver,
  { roomId, change }: LightsChangeRequest,
): Promise<LightsOutcome> => {
  const lights = roomId === undefined ? lightsOf(appliances) : appliances.inRoom("light", roomId);
  return changeEach(appliances, driver, lights, async (appliance, credentials) => {
    if (change.brightness === undefined) return change;
    const { brightness } = await driver.readCapabilities(appliance.address, credentials);
    if (brightness) return { on: true, ...change };
    return change.on === undefined ? undefined : { on: change.on };
  });
};

/**
 * Makes a change of each of the Lights at once, each through its Driver,
 * the one `changeFor` says, or none where it says none, and answers once
 * each has answered or not, saying which didn't (FR-57b), as a Room-wide
 * control and recalling a Light Scene do.
 */
export const changeEach = async (
  appliances: ApplianceStore,
  driver: LightDriver,
  lights: readonly Appliance[],
  changeFor: (appliance: Appliance, credentials: string) => Promise<LightChange | undefined>,
): Promise<LightsOutcome> => {
  const outcomes = await Promise.all(
    lights.map(async (appliance): Promise<{ id: number; reading: LightReading } | undefined> => {
      try {
        const state = await withKey(appliances, appliance, async (credentials) => {
          const asked = await changeFor(appliance, credentials);
          return asked === undefined ? undefined : driver.setState(appliance.address, credentials, asked);
        });
        if (state === undefined) return undefined;
        return {
          id: appliance.id,
          reading: state === "key-refused" ? { known: false, why: "key-refused" } : { known: true, state },
        };
      } catch (error) {
        if (!(error instanceof DriverFailure)) throw error;
        return { id: appliance.id, reading: { known: false, why: "unreachable" } };
      }
    }),
  );
  const answered = outcomes.filter((outcome) => outcome !== undefined);
  return {
    lights: answered,
    unreached: answered.filter(({ reading }) => !reading.known).map(({ id }) => id),
  };
};

/** The id and key a request gives for a Light, or undefined where it gives none. They are never quoted back. */
export const lightKeysIn = (value: unknown): LightKeysGiven | undefined => {
  if (value === undefined) return undefined;
  const { id, key } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const fits = (text: unknown): text is string =>
    typeof text === "string" && text.trim() !== "" && text.length <= LIGHT_KEYS_MAX_LENGTH;
  if (!fits(key) || (id !== undefined && !fits(id))) {
    throw new HttpRefusal(
      400,
      `Give the Light's local key, and its device id unless the Hub found it, each at most ${String(LIGHT_KEYS_MAX_LENGTH)} characters.`,
    );
  }
  return { key, ...(id === undefined ? {} : { id: id.trim() }) };
};

const isBrightness = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= LIGHT_BRIGHTNESS_MIN && (value as number) <= LIGHT_BRIGHTNESS_MAX;

/** Whole numbers, as every part of a Light's state is. */
const isWhole = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * A {@link LightChange} in a request, checked for its shape only: whether
 * the Light has each capability, and its ranges, are for its Driver to say.
 */
export const lightChangeIn = (body: unknown): LightChange => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpRefusal(400, "Say what to change.");
  const asked = body as Record<string, unknown>;
  const refuse = (message: string): never => {
    throw new HttpRefusal(400, message);
  };
  const unknown = Object.keys(asked).filter(
    (field) => !["on", "brightness", "colourTemperature", "colour"].includes(field),
  );
  if (unknown.length > 0) refuse(`A Light has nothing called ${unknown.join(", ")} to change.`);
  if (Object.keys(asked).length === 0) refuse("Say what to change.");

  const { on, brightness, colourTemperature, colour } = asked;
  if (on !== undefined && typeof on !== "boolean") refuse("Say whether to switch it on, as true or false.");
  if (brightness !== undefined && !isWhole(brightness)) refuse("Give the brightness in whole percent.");
  if (colourTemperature !== undefined && !isWhole(colourTemperature))
    refuse("Give the colour temperature in whole kelvin.");
  let colourChange: LightChange["colour"];
  if (colour !== undefined) {
    const { hue, saturation, ...rest } = (typeof colour === "object" && colour !== null ? colour : {}) as Record<
      string,
      unknown
    >;
    if (!isWhole(hue) || !isWhole(saturation) || Object.keys(rest).length > 0)
      refuse("Give the colour as a hue and a saturation, each a whole number.");
    colourChange = { hue: hue as number, saturation: saturation as number };
  }
  return {
    ...(on === undefined ? {} : { on: on as boolean }),
    ...(brightness === undefined ? {} : { brightness: brightness as number }),
    ...(colourTemperature === undefined ? {} : { colourTemperature: colourTemperature as number }),
    ...(colourChange === undefined ? {} : { colour: colourChange }),
  };
};

/** A {@link LightsChangeRequest}, checked in full, as it is made of every Light it reaches. */
export const lightsChangeRequestIn = (body: unknown): LightsChangeRequest => {
  const refuse = (message: string): never => {
    throw new HttpRefusal(400, message);
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) refuse("Say what to change.");
  const { roomId, change } = body as Record<string, unknown>;
  if (roomId !== undefined && !Number.isSafeInteger(roomId))
    refuse("Give the Room as its id, or leave it out for every Light.");
  const { on, brightness, ...rest } = (
    typeof change === "object" && change !== null && !Array.isArray(change) ? change : {}
  ) as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || (on === undefined && brightness === undefined))
    refuse("Say whether to switch the Lights on or off, or how bright to make them.");
  if (on !== undefined && typeof on !== "boolean") refuse("Say whether to switch them on, as true or false.");
  if (brightness !== undefined && !isBrightness(brightness)) {
    refuse(
      `Give the brightness in whole percent, from ${String(LIGHT_BRIGHTNESS_MIN)}% to ${String(LIGHT_BRIGHTNESS_MAX)}%.`,
    );
  }
  const asked: LightsChange = {
    ...(on === undefined ? {} : { on: on as boolean }),
    ...(brightness === undefined ? {} : { brightness: brightness as number }),
  };
  return { change: asked, ...(roomId === undefined ? {} : { roomId: roomId as number }) };
};
