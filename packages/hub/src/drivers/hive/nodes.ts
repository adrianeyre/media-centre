/**
 * Hive's products in the Appliance's terms, and the Appliance's changes in
 * Hive's: the Heating zones (`heating`), Radiator Valves (`trvcontrol`) and
 * Hot Water (`hotwater`) that `GET /nodes/all` lists, and the bodies of the
 * `POST /nodes/<type>/<id>` that change them. Only the Hive Driver and the
 * fake Hive cloud know this (NFR-6).
 *
 * It is written from pyhiveapi (`apyhiveapi/heating.py`, `hotwater.py` and
 * `helper/const.py`): each product's `state` holds its `name`, `mode`
 * (`SCHEDULE`, `MANUAL`, `OFF` or `BOOST`), `target` and `boost`, the
 * minutes a Boost has left; its `props` hold the `temperature` it reads,
 * `working`, whether it is calling for heat, `online`, and `previous`, the
 * mode and target a Boost goes back to. What is uncertain, to be corrected
 * in the fake first, then here (ADR 0004):
 *
 * - a valve's `battery`, a percentage, which pyhiveapi reads from the valve's
 *   device rather than its product, and the level the Hive app warns at,
 *   taken here as {@link LOW_BATTERY_PERCENT};
 * - a valve's zone, read as its `props.zone`, the same as its Heating's,
 *   and `props.zoneName`;
 * - the target temperatures each takes, read from `props.min` and
 *   `props.max` where Hive gives them, and otherwise pyhiveapi's 5° to 32°;
 * - whether the Hot Water's `working` says it is heating, as pyhiveapi reads
 *   that from its `state.status`;
 * - the Boost durations Hive's app offers, taken here as
 *   {@link BOOST_MINUTES}, and whether Hive takes any other;
 * - that cancelling a Boost is setting the mode, and for Manual and Off the
 *   target, in `props.previous`, as pyhiveapi does.
 */
import type {
  HeatingCapabilities,
  HeatingChange,
  HeatingMode,
  HotWaterCapabilities,
  HotWaterChange,
  HotWaterMode,
  RadiatorValveState,
} from "@media-centre/shared";

import { DriverFailure, type HeatingAccountAppliance, type HeatingApplianceState } from "../driver.ts";
import type { HiveNode, HiveNodes } from "./beekeeper.ts";

/** Which of Hive's product types is which kind of Appliance. Hive's other products, e.g. its lights, are left out. */
export const PRODUCT_TYPES = {
  heating: "heating",
  "radiator-valve": "trvcontrol",
  "hot-water": "hotwater",
} as const;

type HeatingKind = keyof typeof PRODUCT_TYPES;

const kindOf = (type: string): HeatingKind | undefined =>
  (Object.keys(PRODUCT_TYPES) as HeatingKind[]).find((kind) => PRODUCT_TYPES[kind] === type);

/** Hive's modes, as a product's `state.mode` has them. */
export const HIVE_MODES = { schedule: "SCHEDULE", manual: "MANUAL", off: "OFF", boost: "BOOST" } as const;

/** The Hot Water's modes in Hive's terms, where On is Hive's "MANUAL" (FR-66). */
const HOT_WATER_MODES: Readonly<Record<HotWaterMode, string>> = {
  schedule: HIVE_MODES.schedule,
  on: HIVE_MODES.manual,
  off: HIVE_MODES.off,
};

const HEATING_MODES: Readonly<Record<HeatingMode, string>> = {
  schedule: HIVE_MODES.schedule,
  manual: HIVE_MODES.manual,
  off: HIVE_MODES.off,
};

/**
 * How long a Boost may last, in minutes: every quarter of an hour to an
 * hour, then every half hour to six (FR-63, FR-66).
 */
export const BOOST_MINUTES: readonly number[] = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];

/** A valve's battery, in percent, at or below which the Hub warns that it is low. */
export const LOW_BATTERY_PERCENT = 20;

/** The target temperatures pyhiveapi takes where Hive gives none. */
const DEFAULT_MIN = 5;
const DEFAULT_MAX = 32;

const numberIn = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const stringIn = (value: unknown): string | null => (typeof value === "string" ? value : null);
const recordIn = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const NAMES: Readonly<Record<HeatingKind, string>> = {
  heating: "Heating",
  "radiator-valve": "Radiator Valve",
  "hot-water": "Hot Water",
};

const heatingCapabilities = (product: HiveNode): HeatingCapabilities => ({
  modes: ["schedule", "manual", "off"],
  target: {
    min: numberIn(product.props.min) ?? DEFAULT_MIN,
    max: numberIn(product.props.max) ?? DEFAULT_MAX,
    step: 0.5,
  },
  boostMinutes: BOOST_MINUTES,
});

const hotWaterCapabilities: HotWaterCapabilities = { modes: ["schedule", "on", "off"], boostMinutes: BOOST_MINUTES };

/** The products that are a Heating, a Radiator Valve or the Hot Water, each with its kind. */
const productsIn = (nodes: HiveNodes): { readonly kind: HeatingKind; readonly product: HiveNode }[] =>
  nodes.products.flatMap((product) => {
    const kind = kindOf(product.type);
    return kind === undefined ? [] : [{ kind, product }];
  });

/** Every Heating, Radiator Valve and Hot Water on the account, by Hive's names. */
export const appliancesIn = (nodes: HiveNodes): HeatingAccountAppliance[] =>
  productsIn(nodes).map(({ kind, product }) => {
    const name = stringIn(product.state.name)?.trim() || NAMES[kind];
    return kind === "hot-water"
      ? { kind, id: product.id, name, capabilities: hotWaterCapabilities }
      : { kind, id: product.id, name, capabilities: heatingCapabilities(product) };
  });

/** The mode a product is in, or during a Boost goes back to, in Hive's terms. */
const modeOf = (product: HiveNode): string => {
  const mode = stringIn(product.state.mode) ?? HIVE_MODES.schedule;
  if (mode !== HIVE_MODES.boost) return mode;
  return stringIn(recordIn(product.props.previous).mode) ?? HIVE_MODES.schedule;
};

const heatingModeOf = (product: HiveNode): HeatingMode =>
  (Object.keys(HEATING_MODES) as HeatingMode[]).find((mode) => HEATING_MODES[mode] === modeOf(product)) ?? "schedule";

const hotWaterModeOf = (product: HiveNode): HotWaterMode => {
  const mode = modeOf(product);
  // "ON" too, in case Hive ever says it so.
  if (mode === "ON") return "on";
  return (Object.keys(HOT_WATER_MODES) as HotWaterMode[]).find((each) => HOT_WATER_MODES[each] === mode) ?? "schedule";
};

const boosting = (product: HiveNode): boolean => product.state.mode === HIVE_MODES.boost;

/** What every Heating, Radiator Valve and Hot Water on the account is doing, as Hive reports it. */
export const statesIn = (nodes: HiveNodes): HeatingApplianceState[] => {
  const products = productsIn(nodes);
  return products.map(({ kind, product }): HeatingApplianceState => {
    const online = product.props.online !== false;
    const minutesLeft = Math.max(0, Math.ceil(numberIn(product.state.boost) ?? 0));
    if (kind === "hot-water") {
      return {
        kind,
        id: product.id,
        state: {
          mode: hotWaterModeOf(product),
          boost: boosting(product) ? { minutesLeft } : null,
          on: product.props.working === true,
          online,
        },
      };
    }
    const target = numberIn(product.state.target) ?? heatingCapabilities(product).target.min;
    const heating = {
      mode: heatingModeOf(product),
      target,
      boost: boosting(product) ? { target, minutesLeft } : null,
      temperature: numberIn(product.props.temperature),
      callingForHeat: product.props.working === true,
      online,
    };
    if (kind === "heating") return { kind, id: product.id, state: heating };
    return { kind, id: product.id, state: { ...heating, ...valveOf(product, products) } };
  });
};

/** A valve's battery warning and its zone, which is its Heating's, by Hive's zone id. */
const valveOf = (
  product: HiveNode,
  products: readonly { readonly kind: HeatingKind; readonly product: HiveNode }[],
): Pick<RadiatorValveState, "lowBattery" | "zone"> => {
  const battery = numberIn(product.props.battery);
  const zone = stringIn(product.props.zone);
  const heating =
    zone === null
      ? undefined
      : products.find(({ kind, product: other }) => kind === "heating" && other.props.zone === zone)?.product;
  const name = stringIn(product.props.zoneName) ?? (heating === undefined ? null : stringIn(heating.state.name));
  return {
    lowBattery: battery !== null && battery <= LOW_BATTERY_PERCENT,
    zone: name === null && heating === undefined ? null : { id: heating?.id ?? null, name: name ?? "" },
  };
};

/** The product with this id that is a Heating, a Radiator Valve or the Hot Water, or undefined. */
export const productWithId = (
  nodes: HiveNodes,
  id: string,
): { readonly kind: HeatingKind; readonly product: HiveNode } | undefined =>
  productsIn(nodes).find(({ product }) => product.id === id);

const notSupported = (message: string): DriverFailure => new DriverFailure("not-supported", message);

/** Whether `value` is a target the product takes: within its range, in its half degrees. */
const checkTarget = (product: HiveNode, value: unknown, name: string): number => {
  const { min, max, step } = heatingCapabilities(product).target;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw notSupported(`${name}'s target is from ${String(min)}° to ${String(max)}°.`);
  }
  if (Math.abs(value / step - Math.round(value / step)) > 1e-9) {
    throw notSupported(`${name}'s target is in steps of ${String(step)}°.`);
  }
  return value;
};

const checkMinutes = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !BOOST_MINUTES.includes(value)) {
    throw notSupported(`${name}'s Boost lasts ${BOOST_MINUTES.join(", ")} minutes.`);
  }
  return value;
};

/**
 * The body of the `POST` that makes `change` to `product`, or undefined
 * where there is nothing to send, as cancelling a Boost that isn't on.
 * Throws a {@link DriverFailure} "not-supported" for a change it can't take,
 * which comes from outside the Hub, before anything is sent.
 */
export const changeBody = (
  kind: HeatingKind,
  product: HiveNode,
  change: HeatingChange | HotWaterChange,
): Readonly<Record<string, unknown>> | undefined => {
  const name = stringIn(product.state.name) ?? NAMES[kind];
  const asked = recordIn(change);
  const keys = Object.keys(asked);
  if (keys.length !== 1) throw notSupported(`Change one thing at a time: a target, a mode or a Boost.`);

  if ("boost" in asked && asked.boost === null) {
    if (!boosting(product)) return undefined;
    const previous = recordIn(product.props.previous);
    const mode = stringIn(previous.mode) ?? HIVE_MODES.schedule;
    const target = numberIn(previous.target);
    return kind !== "hot-water" && (mode === HIVE_MODES.manual || mode === HIVE_MODES.off) && target !== null
      ? { mode, target }
      : { mode };
  }

  if (kind === "hot-water") {
    if ("mode" in asked) {
      if (typeof asked.mode !== "string" || !Object.hasOwn(HOT_WATER_MODES, asked.mode)) {
        throw notSupported(`${name}'s mode is Schedule, On or Off.`);
      }
      return { mode: HOT_WATER_MODES[asked.mode as HotWaterMode] };
    }
    if ("boost" in asked) {
      const boost = recordIn(asked.boost);
      if (Object.keys(boost).some((key) => key !== "minutes"))
        throw notSupported(`${name}'s Boost is by duration only.`);
      return { mode: HIVE_MODES.boost, boost: checkMinutes(boost.minutes, name) };
    }
    throw notSupported(`${name} has a mode and a Boost, and no target.`);
  }

  if ("target" in asked) return { target: checkTarget(product, asked.target, name) };
  if ("mode" in asked) {
    if (typeof asked.mode !== "string" || !Object.hasOwn(HEATING_MODES, asked.mode)) {
      throw notSupported(`${name}'s mode is Schedule, Manual or Off.`);
    }
    return { mode: HEATING_MODES[asked.mode as HeatingMode] };
  }
  if ("boost" in asked) {
    const boost = recordIn(asked.boost);
    return {
      mode: HIVE_MODES.boost,
      boost: checkMinutes(boost.minutes, name),
      target: checkTarget(product, boost.target, name),
    };
  }
  throw notSupported(`${name} has a target, a mode and a Boost.`);
};
