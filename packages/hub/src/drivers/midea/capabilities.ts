/**
 * How the Midea Driver turns a unit's report of its capabilities, the
 * entries of its `0xB5` answer, into the Appliance's capabilities (FR-50),
 * and a unit's state into the Appliance's state, so that nothing outside the
 * Driver knows Midea's ids and values (NFR-6).
 *
 * The ids, and what their values mean, are msmart-ng's, as best they are
 * known without a unit to hand: the further functions especially are known
 * only from msmart-ng and midea-local, and each is marked where the libraries
 * are unsure of it. A real unit that reports otherwise changes this file and
 * the fake (ADR 0004).
 */
import type {
  AirConditionerCapabilities,
  AirConditionerFunction,
  AirConditionerMode,
  AirConditionerModeCapability,
  AirConditionerPreset,
  AirConditionerState,
  FanSpeed,
  TemperatureRange,
} from "@media-centre/shared";

import { MIDEA_FAN, MIDEA_MODE, SWING_HORIZONTAL, SWING_VERTICAL, type Entry, type MideaState } from "./frames.ts";

/** The ids of the capabilities a unit reports, two bytes each. */
export const CAPABILITY = {
  fanSpeeds: 0x0210,
  eco: 0x0212,
  frostProtection: 0x0213,
  modes: 0x0214,
  swing: 0x0215,
  electricHeater: 0x0219,
  turbo: 0x021a,
  ionizer: 0x021e,
  display: 0x0224,
  temperatures: 0x0225,
  verticalVane: 0x0009,
  horizontalVane: 0x000a,
  smartEye: 0x0030,
  airTowardsMe: 0x0032,
  airAwayFromMe: 0x0033,
  selfClean: 0x0039,
  breeze: 0x0043,
  powerLimit: 0x0048,
} as const;

/**
 * Which modes the value of a unit's modes entry gives it, besides fan, which
 * every unit has. A unit that doesn't report its modes is taken to have
 * them all, as msmart-ng takes it.
 */
const MODES_BY_VALUE: Readonly<Record<number, readonly AirConditionerMode[]>> = {
  0: ["cool", "dry", "auto"],
  1: ["cool", "heat", "dry", "auto"],
  2: ["heat", "auto"],
  3: ["cool"],
  4: ["cool", "heat"],
  5: ["cool", "dry"],
  6: ["cool", "heat", "dry"],
  7: ["cool", "heat", "auto"],
  8: ["cool", "auto"],
  9: ["cool", "heat", "dry", "auto"],
};

/** The order the Remote shows the modes in, as the PRD lists them. */
const MODE_ORDER: readonly AirConditionerMode[] = ["cool", "heat", "dry", "fan", "auto"];

/** Which fan steps the value of a unit's fan entry gives it, and whether it has an automatic fan. */
const FAN_BY_VALUE: Readonly<Record<number, { speeds: readonly FanSpeed[]; auto: boolean }>> = {
  // A fan set by percentage, which the Driver offers in the five steps Midea's own app names.
  1: { speeds: ["silent", "low", "medium", "high", "full"], auto: true },
  3: { speeds: ["low", "high"], auto: false },
  4: { speeds: ["low", "high"], auto: true },
  5: { speeds: ["low", "medium", "high"], auto: true },
  6: { speeds: ["silent", "low", "medium", "high"], auto: true },
  7: { speeds: ["low", "medium", "high"], auto: false },
};
const DEFAULT_FAN = { speeds: ["low", "medium", "high"], auto: true } as const;

/** Which ways the value of a unit's swing entry has it swing. One that doesn't report it doesn't swing. */
const SWING_BY_VALUE: Readonly<Record<number, { vertical: boolean; horizontal: boolean }>> = {
  0: { vertical: true, horizontal: false },
  1: { vertical: true, horizontal: true },
  2: { vertical: false, horizontal: false },
  3: { vertical: false, horizontal: true },
};

/** The target temperatures of a unit that doesn't report them, in whole degrees, as msmart-ng defaults. */
const DEFAULT_RANGE = { min: 16, max: 30 } as const;

/**
 * A further function, the capability that says a unit has it, and the
 * values it is set and read by, one byte, through the `0xB1` and `0xB0`
 * bodies, by the same id. A unit reports it with a value of 1.
 *
 * Uncertain: msmart-ng sets frost protection and the electric heater in
 * the set command's bits on some units, rather than by id; and its breeze
 * values and power limits are read from a single model each.
 */
export type FunctionDefinition =
  | (Extract<AirConditionerFunction, { kind: "on-off" }> & { readonly capability: number })
  | (Extract<AirConditionerFunction, { kind: "choice" }> & {
      readonly capability: number;
      /** The unit's value for each option, by the option's id. */
      readonly values: Readonly<Record<string, number>>;
    });

const POSITIONS = [
  { id: "1", name: "Position 1" },
  { id: "2", name: "Position 2" },
  { id: "3", name: "Position 3" },
  { id: "4", name: "Position 4" },
  { id: "5", name: "Position 5" },
];
const POSITION_VALUES = { "1": 1, "2": 25, "3": 50, "4": 75, "5": 100 };

export const FUNCTIONS: readonly FunctionDefinition[] = [
  {
    id: "vertical-vane",
    name: "Up-and-down louvre",
    kind: "choice",
    options: POSITIONS,
    values: POSITION_VALUES,
    capability: CAPABILITY.verticalVane,
  },
  {
    id: "horizontal-vane",
    name: "Side-to-side louvre",
    kind: "choice",
    options: POSITIONS,
    values: POSITION_VALUES,
    capability: CAPABILITY.horizontalVane,
  },
  {
    id: "breeze",
    name: "Breeze",
    kind: "choice",
    options: [
      { id: "off", name: "Off" },
      { id: "away", name: "Breeze away" },
      { id: "mild", name: "Breeze mild" },
      { id: "less", name: "Breezeless" },
    ],
    values: { off: 1, away: 2, mild: 3, less: 4 },
    capability: CAPABILITY.breeze,
  },
  {
    id: "power-limit",
    name: "Power limit",
    kind: "choice",
    options: [
      { id: "100", name: "100%" },
      { id: "75", name: "75%" },
      { id: "50", name: "50%" },
    ],
    values: { "100": 100, "75": 75, "50": 50 },
    capability: CAPABILITY.powerLimit,
  },
  { id: "self-clean", name: "Self-clean", kind: "on-off", capability: CAPABILITY.selfClean },
  { id: "frost-protection", name: "Frost protection", kind: "on-off", capability: CAPABILITY.frostProtection },
  { id: "electric-heater", name: "Electric heater", kind: "on-off", capability: CAPABILITY.electricHeater },
  { id: "ionizer", name: "Ionizer", kind: "on-off", capability: CAPABILITY.ionizer },
  { id: "smart-eye", name: "Smart eye", kind: "on-off", capability: CAPABILITY.smartEye },
  { id: "air-towards-me", name: "Air towards me", kind: "on-off", capability: CAPABILITY.airTowardsMe },
  { id: "air-away-from-me", name: "Air away from me", kind: "on-off", capability: CAPABILITY.airAwayFromMe },
];

/** Every capability id the Driver reads: any other a unit reports is one it doesn't know. */
const KNOWN = new Set<number>([
  CAPABILITY.fanSpeeds,
  CAPABILITY.eco,
  CAPABILITY.modes,
  CAPABILITY.swing,
  CAPABILITY.turbo,
  CAPABILITY.display,
  CAPABILITY.temperatures,
  ...FUNCTIONS.map(({ capability }) => capability),
]);

/** The Appliance's capabilities, read from a unit's, and the further functions' definitions, to read and set them by. */
export interface ReadCapabilities {
  readonly capabilities: AirConditionerCapabilities;
  readonly functions: readonly FunctionDefinition[];
  /** The ids the unit reported that the Driver doesn't know, which it leaves out. */
  readonly unknown: readonly number[];
}

/**
 * The Appliance's capabilities from a unit's entries. Whether it reports
 * the outdoor temperature isn't among them, so it is read from its state:
 * a unit reports none where it has no outdoor sensor.
 */
export const capabilitiesFrom = (entries: readonly Entry[], state: MideaState): ReadCapabilities => {
  const value = (id: number): number | undefined => entries.find((entry) => entry.id === id)?.value[0];
  const has = (id: number): boolean => entries.some((entry) => entry.id === id);

  const modes = new Set<AirConditionerMode>(MODES_BY_VALUE[value(CAPABILITY.modes) ?? 1] ?? MODES_BY_VALUE[1]);
  modes.add("fan");
  const ranges = rangesFrom(entries.find((entry) => entry.id === CAPABILITY.temperatures)?.value);
  const presets: AirConditionerPreset[] = [];
  const eco = value(CAPABILITY.eco);
  if (eco === 1 || eco === 2) presets.push("eco");
  if (has(CAPABILITY.turbo)) presets.push("turbo");
  // Midea reports no capability for sleep, which every unit is taken to have, as msmart-ng takes it.
  presets.push("sleep");
  const functions = FUNCTIONS.filter((each) => value(each.capability) === 1);

  return {
    capabilities: {
      power: true,
      modes: MODE_ORDER.filter((mode) => modes.has(mode)).map((mode): AirConditionerModeCapability => ({
        mode,
        temperature: ranges[mode],
      })),
      fan: FAN_BY_VALUE[value(CAPABILITY.fanSpeeds) ?? 0] ?? DEFAULT_FAN,
      swing: SWING_BY_VALUE[value(CAPABILITY.swing) ?? 2] ??
        SWING_BY_VALUE[2] ?? { vertical: false, horizontal: false },
      presets,
      display: has(CAPABILITY.display),
      temperatures: { room: true, outdoor: state.outdoorTemperature !== null },
      functions: functions.map((each): AirConditionerFunction =>
        each.kind === "on-off"
          ? { id: each.id, name: each.name, kind: each.kind }
          : { id: each.id, name: each.name, kind: each.kind, options: each.options },
      ),
    },
    functions,
    unknown: entries.map(({ id }) => id).filter((id) => !KNOWN.has(id)),
  };
};

/**
 * Each mode's target temperatures, from the unit's temperatures entry: the
 * lowest and highest for cool, auto and heat, in half degrees, then a byte
 * that isn't 0 where it takes half degrees. Dry takes cool's, and fan none.
 * (msmart-ng reads the half degrees so; others don't read them at all.)
 */
const rangesFrom = (value: Buffer | undefined): Readonly<Record<AirConditionerMode, TemperatureRange | null>> => {
  const step = (value?.[6] ?? 0) !== 0 ? 0.5 : 1;
  const range = (at: number): TemperatureRange => {
    const min = value?.[at];
    const max = value?.[at + 1];
    return min === undefined || max === undefined || min >= max
      ? { ...DEFAULT_RANGE, step }
      : { min: min / 2, max: max / 2, step };
  };
  const cool = range(0);
  return { cool, dry: cool, auto: range(2), heat: range(4), fan: null };
};

/** The Appliance's mode for a unit's. Midea's "smart dry", on some units, is dry. */
export const modeFrom = (mode: number): AirConditionerMode => {
  const found = Object.entries(MIDEA_MODE).find(([, each]) => each === mode)?.[0] as AirConditionerMode | undefined;
  return found ?? (mode === 6 ? "dry" : "auto");
};

/** The fan step nearest a unit's fan speed, among those it has, or "auto". */
export const fanSpeedFrom = (speed: number, capabilities: AirConditionerCapabilities): FanSpeed | "auto" => {
  if (speed > MIDEA_FAN.full) return "auto";
  const steps = capabilities.fan.speeds.length > 0 ? capabilities.fan.speeds : DEFAULT_FAN.speeds;
  let nearest: FanSpeed = steps[0] ?? "low";
  for (const step of steps) {
    if (Math.abs(MIDEA_FAN[step] - speed) < Math.abs(MIDEA_FAN[nearest] - speed)) nearest = step;
  }
  return nearest;
};

/** The Appliance's state from a unit's, and the values of its further functions, by id. */
export const stateFrom = (
  state: MideaState,
  read: ReadCapabilities,
  values: ReadonlyMap<number, Buffer>,
): AirConditionerState => {
  const functions: Record<string, boolean | string> = {};
  for (const each of read.functions) {
    const value = values.get(each.capability)?.[0];
    if (value === undefined) continue;
    if (each.kind === "on-off") functions[each.id] = value !== 0;
    else {
      const option = Object.entries(each.values).find(([, optionValue]) => optionValue === value)?.[0];
      if (option !== undefined) functions[each.id] = option;
    }
  }
  return {
    power: state.power,
    mode: modeFrom(state.mode),
    targetTemperature: state.targetTemperature,
    fanSpeed: fanSpeedFrom(state.fanSpeed, read.capabilities),
    swing: {
      vertical: (state.swing & SWING_VERTICAL) === SWING_VERTICAL,
      horizontal: (state.swing & SWING_HORIZONTAL) === SWING_HORIZONTAL,
    },
    preset: state.turbo ? "turbo" : state.eco ? "eco" : state.sleep ? "sleep" : null,
    display: state.display,
    roomTemperature: state.indoorTemperature,
    outdoorTemperature: state.outdoorTemperature,
    functions,
  };
};
