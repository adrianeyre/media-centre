import type {
  Appliance,
  HeatingChange,
  HeatingHome,
  HeatingOutcome,
  HeatingReading,
  HeatingReport,
  HotWaterChange,
} from "@media-centre/shared";

import type { ApplianceStore } from "./appliances.ts";
import {
  CredentialsRefused,
  DriverFailure,
  type HeatingAccountAppliance,
  type HeatingApplianceState,
  type HeatingDriver,
} from "./drivers/driver.ts";
import { isHiveKind, type HiveAccountStore } from "./hive.ts";
import { HttpRefusal } from "./http.ts";

/**
 * The Heating tab's Heatings, Radiator Valves and Hot Water, read from Hive
 * and changed there through the Hive Driver, which alone knows Hive's API
 * (NFR-6). Nothing is kept between one request and the next: each read is
 * Hive's own answer, read as a Remote with the tab open asks for it, so that
 * nothing is read while no Remote has the tab open (FR-62). Only the
 * credentials the Driver renews are kept, as Hive's sign-in is.
 */

export interface HeatingOptions {
  readonly appliances: ApplianceStore;
  readonly account: HiveAccountStore;
  /** Left out by a Hub run without a Hive Driver, which can't reach Hive. */
  readonly driver: HeatingDriver | undefined;
}

export interface Heating {
  /** Every Heating, Radiator Valve and Hot Water, with what Hive reports of each now (FR-62). */
  readonly read: () => Promise<HeatingHome>;
  /**
   * Makes one change to one of them (FR-63, FR-65, FR-66). A Heating's Boost,
   * or its cancelling, is made of every Radiator Valve Hive reports in its
   * zone too, at the same target and for as long.
   */
  readonly change: (id: number, change: HeatingChange | HotWaterChange) => Promise<HeatingOutcome>;
  /**
   * Makes one change to every Heating, as the Whole home does (FR-64): a
   * Boost, or its cancelling, of every Radiator Valve too.
   */
  readonly changeWholeHome: (change: HeatingChange) => Promise<HeatingOutcome>;
  /** Sets every Radiator Valve in the Room to one target, and none outside it (FR-65). */
  readonly setRoomTarget: (roomId: number, target: number) => Promise<HeatingOutcome>;
}

/** What Hive came to while changing one Appliance: what it then reports, or why it didn't take the change. */
type Changed =
  | { readonly appliance: Appliance; readonly report: HeatingReport }
  | { readonly appliance: Appliance; readonly failure: DriverFailure };

/** The Appliance's report, by its Hub id, from the Driver's, by Hive's. */
const reportOf = (id: number, { kind, state }: HeatingApplianceState): HeatingReport => {
  switch (kind) {
    case "heating":
      return { kind, id, state };
    case "radiator-valve":
      return { kind, id, state };
    case "hot-water":
      return { kind, id, state };
  }
};

const readingOf = (
  appliance: Appliance,
  listed: HeatingAccountAppliance,
  { state, kind }: HeatingApplianceState,
): HeatingReading | undefined => {
  const { id } = appliance;
  if (kind === "hot-water" && listed.kind === "hot-water") {
    return { kind, id, appliance, capabilities: listed.capabilities, state };
  }
  if (kind === "heating" && listed.kind === "heating") {
    return { kind, id, appliance, capabilities: listed.capabilities, state };
  }
  if (kind === "radiator-valve" && listed.kind === "radiator-valve") {
    return { kind, id, appliance, capabilities: listed.capabilities, state };
  }
  return undefined;
};

/** Whether a failure is Hive not being there, or not taking the Hub's tokens, rather than refusing the change. */
const isHiveGone = (failure: DriverFailure): boolean =>
  failure instanceof CredentialsRefused || failure.reason === "unreachable" || failure.reason === "timed-out";

export const heating = ({ appliances, account, driver }: HeatingOptions): Heating => {
  /**
   * Keeps the credentials the Driver handed back, which it may have renewed,
   * unless the Hub has signed out, or in again, since it was given `from`:
   * a read still on its way never signs the Hub back in.
   */
  const keepRenewed = (from: string, renewed: string): void => {
    if (renewed !== from && account.credentials() === from) account.keep(renewed);
  };

  const hiveAppliances = (): Appliance[] => appliances.list().filter(({ kind }) => isHiveKind(kind));

  /** The Hive Driver and the credentials it signed in with, or the refusal of a change while there are none. */
  const signedIn = (): { readonly hive: HeatingDriver; readonly credentials: string } => {
    const credentials = account.credentials();
    if (credentials === undefined) throw new HttpRefusal(409, "The Hub isn't signed in to Hive. Sign in in Settings.");
    if (driver === undefined) throw new HttpRefusal(502, "Can't reach Hive. The Hub has no way to reach it.");
    return { hive: driver, credentials };
  };

  /**
   * Makes `change` of each Appliance at once, and answers once each has
   * taken it or not, with what Hive then reports of each, read once more for
   * those that didn't take it, so that each control shows what Hive reports
   * (FR-68). Where none took it, as when Hive can't be reached, a failure
   * other than Hive refusing the change is thrown, as for one Appliance.
   */
  const changeEach = async (
    targets: readonly Appliance[],
    change: HeatingChange | HotWaterChange,
  ): Promise<HeatingOutcome> => {
    const { hive, credentials } = signedIn();
    const changed = await Promise.all(
      targets.map(async (appliance): Promise<Changed> => {
        try {
          const answer = await hive.setState(credentials, appliance.serialNumber ?? "", change);
          keepRenewed(credentials, answer.credentials);
          return { appliance, report: reportOf(appliance.id, answer.state) };
        } catch (error) {
          if (!(error instanceof DriverFailure)) throw error;
          return { appliance, failure: error };
        }
      }),
    );
    const failed = changed.flatMap((each) => ("failure" in each ? [each] : []));
    const [first] = failed;
    if (first !== undefined && failed.length === changed.length && first.failure.reason !== "refused") {
      throw first.failure;
    }
    for (const { appliance, failure } of failed) {
      console.log(`${appliances.title(appliance)} didn't take the change: ${failure.message}`);
    }

    // What Hive reports of those that didn't take it, read once for them all.
    let again: readonly HeatingApplianceState[] = [];
    if (failed.length > 0 && !failed.every(({ failure }) => isHiveGone(failure))) {
      try {
        const read = await hive.readStates(credentials);
        keepRenewed(credentials, read.credentials);
        again = read.states;
      } catch (error) {
        // The tab reads Hive again at its next refresh.
        if (!(error instanceof DriverFailure)) throw error;
      }
    }
    return {
      appliances: changed.flatMap((each): HeatingReport[] => {
        if ("report" in each) return [each.report];
        const state = again.find(({ id }) => id === each.appliance.serialNumber);
        return state === undefined ? [] : [reportOf(each.appliance.id, state)];
      }),
      refused: failed.map(({ appliance }) => appliance.id),
    };
  };

  /**
   * The Radiator Valves Hive reports in the zones of `zones`, each a Heating,
   * by the zone each valve names, read from Hive as the Boost is asked for.
   * Where Hive can't be read, none: the Heating's own change says why.
   */
  const valvesIn = async (zones: readonly Appliance[]): Promise<Appliance[]> => {
    const { hive, credentials } = signedIn();
    const zoneIds = new Set(zones.flatMap(({ serialNumber }) => (serialNumber === undefined ? [] : [serialNumber])));
    let states: readonly HeatingApplianceState[];
    try {
      const read = await hive.readStates(credentials);
      keepRenewed(credentials, read.credentials);
      states = read.states;
    } catch (error) {
      if (!(error instanceof DriverFailure)) throw error;
      return [];
    }
    const inZone = new Set(
      states.flatMap((state) =>
        state.kind === "radiator-valve" && state.state.zone?.id != null && zoneIds.has(state.state.zone.id)
          ? [state.id]
          : [],
      ),
    );
    return hiveAppliances().filter(
      ({ kind, serialNumber }) => kind === "radiator-valve" && serialNumber !== undefined && inZone.has(serialNumber),
    );
  };

  return {
    read: async () => {
      const credentials = account.credentials();
      if (credentials === undefined) return { signedIn: false };
      if (driver === undefined) return { signedIn: true, hive: "unreachable" };
      try {
        const read = await driver.readStates(credentials);
        keepRenewed(credentials, read.credentials);
        return {
          signedIn: true,
          hive: "reachable",
          appliances: hiveAppliances().flatMap((appliance) => {
            const listed = read.appliances.find(({ id }) => id === appliance.serialNumber);
            const state = read.states.find(({ id }) => id === appliance.serialNumber);
            const reading =
              listed === undefined || state === undefined ? undefined : readingOf(appliance, listed, state);
            return reading === undefined ? [] : [reading];
          }),
        };
      } catch (error) {
        if (error instanceof CredentialsRefused) return { signedIn: true, hive: "tokens-refused" };
        if (error instanceof DriverFailure) return { signedIn: true, hive: "unreachable" };
        throw error;
      }
    },

    change: async (id, change) => {
      const appliance = appliances.get(id);
      if (!isHiveKind(appliance.kind)) {
        throw new HttpRefusal(
          404,
          `${appliances.title(appliance)} isn't a Heating, a Radiator Valve or the Hot Water.`,
        );
      }
      // A zone's Boost is its Radiator Valves' too, as is cancelling it.
      if (appliance.kind === "heating" && "boost" in change) {
        return changeEach([appliance, ...(await valvesIn([appliance]))], change);
      }
      return changeEach([appliance], change);
    },

    changeWholeHome: (change) =>
      changeEach(
        hiveAppliances().filter(({ kind }) => kind === "heating" || (kind === "radiator-valve" && "boost" in change)),
        change,
      ),

    setRoomTarget: async (roomId, target) => changeEach(appliances.inRoom("radiator-valve", roomId), { target }),
  };
};
