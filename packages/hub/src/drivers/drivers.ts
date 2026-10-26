import type { Drivers } from "./driver.ts";
import { hiveDriverFromEnvironment } from "./hive/hive-driver.ts";
import { leproDriverFromEnvironment } from "./lepro/lepro-driver.ts";
import { mideaDriverFromEnvironment } from "./midea/midea-driver.ts";
import { samsungTvDriverFromEnvironment } from "./samsung-tv/samsung-tv-driver.ts";

/**
 * The Driver for each kind of Appliance, as the Hub runs them: Samsung TVs,
 * Midea Air Conditioners, Lepro Lights, and Hive's Heating, Radiator Valves
 * and Hot Water.
 */
export const driversFromEnvironment = (env: Readonly<Record<string, string | undefined>>): Drivers => ({
  tv: samsungTvDriverFromEnvironment(env),
  "air-conditioner": mideaDriverFromEnvironment(env),
  light: leproDriverFromEnvironment(env),
  heating: hiveDriverFromEnvironment(env),
});
