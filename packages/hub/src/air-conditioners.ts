import {
  APPLIANCE_NAME_MAX_LENGTH,
  CLOUD_LOGIN_MAX_LENGTH,
  type AirConditionerCapabilitiesReading,
  type AirConditionerChange,
  type AirConditionerMode,
  type AirConditionerPreset,
  type AirConditionerReading,
  type Appliance,
  type CloudLogin,
  type FanSpeed,
  type FoundAirConditioner,
} from "@media-centre/shared";

import { ApplianceRefusal, type ApplianceStore } from "./appliances.ts";
import { CredentialsRefused, DriverFailure, type AirConditionerDriver } from "./drivers/driver.ts";
import { HttpRefusal } from "./http.ts";
import { firstCharacters } from "./names.ts";

/**
 * Air Conditioners as the Hub adds, checks and reads them (FR-51), through
 * their Driver, which alone knows their protocol and their maker's cloud
 * (NFR-6). Their token and key are their credentials, kept as any
 * Appliance's are, and never logged or sent back (FR-4); the login they are
 * fetched with is used for that alone and forgotten (ADR 0009), and never
 * logged either, not even its account.
 */

/** Has the Driver search the subnet, "Find Air Conditioners" (FR-51). Whether each is added is for the Remote to show. */
export const searchAirConditioners = async (driver: AirConditionerDriver): Promise<FoundAirConditioner[]> => {
  const found = (await driver.discover()).map(({ address, name, serialNumber, needsKeys }): FoundAirConditioner => ({
    kind: "air-conditioner",
    address,
    name,
    serialNumber,
    needsLogin: needsKeys,
  }));
  console.log(`Searched the network for Air Conditioners, and found ${String(found.length)}`);
  return found;
};

export interface AirConditionerToAdd {
  readonly address: string;
  readonly name?: string;
  readonly roomId: number | null;
  readonly login?: CloudLogin;
}

/**
 * Asks the unit what it is, fetches its token and key with the owner's login
 * if it needs them (ADR 0009), and keeps it once it has answered with them,
 * so that what is kept is known to work. The name and Room are checked
 * first, so a refusal doesn't wait on the cloud. One that needs its keys and
 * comes with no login is refused with `needs: "login"`, so that the Remote
 * asks for it and sends the request again.
 */
export const addAirConditioner = async (
  appliances: ApplianceStore,
  driver: AirConditionerDriver,
  asked: AirConditionerToAdd,
): Promise<Appliance> => {
  const given = asked.name?.trim() ?? "";
  if (given !== "") appliances.checkPlace("air-conditioner", given, asked.roomId);

  const found = await driver.identify(asked.address);
  const already = appliances.withSerialNumber("air-conditioner", found.serialNumber);
  if (already !== undefined) {
    throw new ApplianceRefusal("taken", `That Air Conditioner is already added, as ${appliances.title(already)}.`);
  }
  const name = given === "" ? firstCharacters(found.name.trim(), APPLIANCE_NAME_MAX_LENGTH) : given;
  appliances.checkPlace("air-conditioner", name, asked.roomId);

  let credentials = found.credentials;
  if (found.needsKeys) {
    if (asked.login === undefined) throw loginNeeded();
    credentials = await driver.fetchKeys(asked.address, credentials, asked.login);
  } else {
    await driver.readCapabilities(asked.address, credentials);
  }
  const appliance = appliances.add(
    {
      kind: "air-conditioner",
      name,
      roomId: asked.roomId,
      address: asked.address,
      model: found.model,
      macAddress: "",
      serialNumber: found.serialNumber,
    },
    credentials,
  );
  console.log(`Added ${appliances.title(appliance)}, an Air Conditioner at ${appliance.address} (${appliance.model})`);
  return appliance;
};

const loginNeeded = (): HttpRefusal =>
  new HttpRefusal(
    401,
    "This Air Conditioner answers only once the Hub has its token and key. Sign in once, so that the Hub can fetch them from its maker's cloud.",
    "login",
  );

/**
 * Fetches the unit's token and key again, with the owner's login, in place
 * of those it no longer accepts, as after a factory reset (FR-51).
 */
export const fetchKeysAgain = async (
  appliances: ApplianceStore,
  driver: AirConditionerDriver,
  appliance: Appliance,
  login: CloudLogin,
): Promise<Appliance> => {
  const credentials = await driver.fetchKeys(appliance.address, appliances.credentials(appliance.id), login);
  const fetched = appliances.paired(appliance.id, credentials);
  console.log(`Fetched the token and key of ${appliances.title(fetched)} again`);
  return fetched;
};

/**
 * Does what needs the unit's token and key, noting whether it still accepts
 * them: one that refuses them is marked `"pair-again"`, so that the Remote
 * offers to fetch them again, and one that accepts them again is marked
 * `"paired"`. Resolves with "fetch-again" for one that refused them.
 */
const withKeys = async <T>(
  appliances: ApplianceStore,
  appliance: Appliance,
  work: (credentials: string) => Promise<T>,
): Promise<T | "fetch-again"> => {
  const credentials = appliances.credentials(appliance.id);
  try {
    const done = await work(credentials);
    if (appliance.pairing === "pair-again") appliances.paired(appliance.id, credentials);
    return done;
  } catch (error) {
    if (!(error instanceof CredentialsRefused)) throw error;
    if (appliance.pairing === "paired") {
      console.log(`${appliances.title(appliance)} refused the Hub's token and key, so they need fetching again`);
    }
    appliances.refused(appliance.id);
    return "fetch-again";
  }
};

/** Has the Driver read the unit's state, to check that it still accepts its token and key, and answers with it. */
export const checkKeys = async (
  appliances: ApplianceStore,
  driver: AirConditionerDriver,
  appliance: Appliance,
): Promise<Appliance> => {
  await withKeys(appliances, appliance, (credentials) => driver.readState(appliance.address, credentials));
  return appliances.get(appliance.id);
};

/** Whether the Driver failed for want of an answer, which a reading says rather than refusing (FR-51a). */
const isUnreachable = (error: unknown): boolean =>
  error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out");

/**
 * Reads what the unit is doing, now. The Remote asks every few seconds while
 * it shows it, so nothing is logged but a refusal of its token and key.
 */
export const readAirConditioner = async (
  appliances: ApplianceStore,
  driver: AirConditionerDriver,
  appliance: Appliance,
): Promise<AirConditionerReading> => {
  try {
    const state = await withKeys(appliances, appliance, (credentials) =>
      driver.readState(appliance.address, credentials),
    );
    return state === "fetch-again" ? { known: false, why: "fetch-again" } : { known: true, state };
  } catch (error) {
    if (isUnreachable(error)) return { known: false, why: "unreachable" };
    throw error;
  }
};

/**
 * Reads the controls the unit reports it has, now, for the Aircon tab to
 * show it with (FR-50). The Remote asks as it first shows the unit, and again
 * only until it answers, so nothing is logged but a refusal of its token and key.
 */
export const readAirConditionerCapabilities = async (
  appliances: ApplianceStore,
  driver: AirConditionerDriver,
  appliance: Appliance,
): Promise<AirConditionerCapabilitiesReading> => {
  try {
    const capabilities = await withKeys(appliances, appliance, (credentials) =>
      driver.readCapabilities(appliance.address, credentials),
    );
    return capabilities === "fetch-again" ? { known: false, why: "fetch-again" } : { known: true, capabilities };
  } catch (error) {
    if (isUnreachable(error)) return { known: false, why: "unreachable" };
    throw error;
  }
};

/**
 * Has the Driver change what is asked, and answers with the state the unit
 * then reports. A change is refused, not dropped, when the unit can't be
 * reached or refuses the Hub's token and key.
 */
export const changeAirConditioner = async (
  appliances: ApplianceStore,
  driver: AirConditionerDriver,
  appliance: Appliance,
  change: AirConditionerChange,
): Promise<AirConditionerReading> => {
  const state = await withKeys(appliances, appliance, (credentials) =>
    driver.setState(appliance.address, credentials, change),
  );
  if (state === "fetch-again") {
    throw new HttpRefusal(
      409,
      `${appliances.title(appliance)} no longer accepts the Hub's token and key. Fetch them again in Settings.`,
    );
  }
  return { known: true, state };
};

/** The owner's login in a request, or undefined where it has none. It is never quoted back. */
export const loginIn = (value: unknown): CloudLogin | undefined => {
  if (value === undefined) return undefined;
  const { account, password } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const fits = (text: unknown): text is string =>
    typeof text === "string" && text.trim() !== "" && text.length <= CLOUD_LOGIN_MAX_LENGTH;
  if (!fits(account) || !fits(password)) {
    throw new HttpRefusal(
      400,
      `Give the email address and password you sign in with, each at most ${String(CLOUD_LOGIN_MAX_LENGTH)} characters.`,
    );
  }
  return { account: account.trim(), password };
};

const MODES: readonly AirConditionerMode[] = ["cool", "heat", "dry", "fan", "auto"];
const FAN_SPEEDS: readonly (FanSpeed | "auto")[] = ["silent", "low", "medium", "high", "full", "auto"];
const PRESETS: readonly AirConditionerPreset[] = ["eco", "turbo", "sleep"];
/** Longer than any function's id or option's the Driver gives. */
const LONGEST_FUNCTION_TEXT = 40;

/**
 * An {@link AirConditionerChange} in a request, checked for its shape only:
 * whether the unit has each capability is for its Driver to say.
 */
export const airConditionerChangeIn = (body: unknown): AirConditionerChange => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpRefusal(400, "Say what to change.");
  const asked = body as Record<string, unknown>;
  const refuse = (message: string): never => {
    throw new HttpRefusal(400, message);
  };
  const known = ["power", "mode", "targetTemperature", "fanSpeed", "swing", "preset", "display", "functions"];
  const unknown = Object.keys(asked).filter((field) => !known.includes(field));
  if (unknown.length > 0) refuse(`An Air Conditioner has nothing called ${unknown.join(", ")} to change.`);
  if (Object.keys(asked).length === 0) refuse("Say what to change.");

  const { power, mode, targetTemperature, fanSpeed, swing, preset, display, functions } = asked;
  if (power !== undefined && typeof power !== "boolean") refuse("Say whether to switch it on, as true or false.");
  if (display !== undefined && typeof display !== "boolean") refuse("Say whether its display is on, as true or false.");
  if (mode !== undefined && !MODES.includes(mode as AirConditionerMode))
    refuse(`Give the mode as one of ${MODES.join(", ")}.`);
  if (targetTemperature !== undefined && (typeof targetTemperature !== "number" || !Number.isFinite(targetTemperature)))
    refuse("Give the target temperature in °C, as a number.");
  if (fanSpeed !== undefined && !FAN_SPEEDS.includes(fanSpeed as FanSpeed))
    refuse(`Give the fan speed as one of ${FAN_SPEEDS.join(", ")}.`);
  if (preset !== undefined && preset !== null && !PRESETS.includes(preset as AirConditionerPreset))
    refuse(`Give the preset as one of ${PRESETS.join(", ")}, or null for none.`);
  let swingChange: AirConditionerChange["swing"];
  if (swing !== undefined) {
    const ways = (typeof swing === "object" && swing !== null ? swing : undefined) as
      Record<string, unknown> | undefined;
    if (
      ways === undefined ||
      Object.keys(ways).some((way) => way !== "vertical" && way !== "horizontal") ||
      Object.values(ways).some((on) => typeof on !== "boolean")
    ) {
      refuse("Say which ways it swings, as vertical and horizontal, each true or false.");
    }
    swingChange = ways;
  }
  let functionsChange: Record<string, boolean | string> | undefined;
  if (functions !== undefined) {
    const values = (
      typeof functions === "object" && functions !== null && !Array.isArray(functions) ? functions : undefined
    ) as Record<string, unknown> | undefined;
    if (
      values === undefined ||
      Object.entries(values).some(
        ([id, value]) =>
          id.length > LONGEST_FUNCTION_TEXT ||
          !(typeof value === "boolean" || (typeof value === "string" && value.length <= LONGEST_FUNCTION_TEXT)),
      )
    ) {
      refuse("Give each function's new value by its id: on or off as true or false, or a choice's id.");
    }
    functionsChange = values as Record<string, boolean | string>;
  }
  return {
    ...(power === undefined ? {} : { power: power as boolean }),
    ...(mode === undefined ? {} : { mode: mode as AirConditionerMode }),
    ...(targetTemperature === undefined ? {} : { targetTemperature: targetTemperature as number }),
    ...(fanSpeed === undefined ? {} : { fanSpeed: fanSpeed as FanSpeed | "auto" }),
    ...(swingChange === undefined ? {} : { swing: swingChange }),
    ...(preset === undefined ? {} : { preset: preset as AirConditionerPreset | null }),
    ...(display === undefined ? {} : { display: display as boolean }),
    ...(functionsChange === undefined ? {} : { functions: functionsChange }),
  };
};
