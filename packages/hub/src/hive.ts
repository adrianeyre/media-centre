import type { DatabaseSync } from "node:sqlite";

import {
  APPLIANCE_NAME_MAX_LENGTH,
  type Appliance,
  type ApplianceKind,
  type CloudLogin,
  type HiveAccount,
  type HiveSignedIn,
  type HiveSignInOutcome,
} from "@media-centre/shared";

import { ApplianceRefusal, KIND_NAMES, type ApplianceStore } from "./appliances.ts";
import {
  CredentialsRefused,
  DriverFailure,
  type HeatingAccountAppliance,
  type HeatingDriver,
} from "./drivers/driver.ts";
import { HttpRefusal } from "./http.ts";
import { firstCharacters } from "./names.ts";

/**
 * Hive as the Hub signs in to it, keeps its sign-in, and adds and removes
 * its Appliances (FR-67), through the Hive Driver, which alone knows Hive's
 * API (NFR-6). Hive is one sign-in for the whole home, not a credential per
 * Appliance: the Driver's credentials, Hive's tokens and the keys of the
 * device Hive trusts the Hub as, are kept once, for the account, and never
 * logged or sent back (FR-67a). The password and the code are used for
 * signing in alone, and never kept or logged, nor is the account's email.
 */

/** The kinds of Appliance that are Hive's, which the Heating tab shows. */
export const HIVE_KINDS: readonly ApplianceKind[] = ["heating", "radiator-valve", "hot-water"];

/** Whether an Appliance is one of Hive's, which goes only as the Hub signs out of Hive. */
export const isHiveKind = (kind: ApplianceKind): boolean => HIVE_KINDS.includes(kind);

/** What a Hive Appliance is, as the Hub keeps its model. */
const MODELS: Readonly<Record<HeatingAccountAppliance["kind"], string>> = {
  heating: "Hive Heating",
  "radiator-valve": "Hive Radiator Valve",
  "hot-water": "Hive Hot Water",
};

export interface HiveAccountStore {
  /** The Driver's credentials for the account, or undefined while the Hub isn't signed in. */
  readonly credentials: () => string | undefined;
  /** Keeps the Driver's credentials, as it signs in or renews them, in place of any before. */
  readonly keep: (credentials: string) => void;
  /**
   * Forgets the credentials, overwriting them in the database, and removes
   * every Hive Appliance with them, and so their places in Rooms. Resolves
   * with how many it removed.
   */
  readonly signOut: () => number;
}

/** The Hub's sign-in to Hive, kept in its database so that it survives a restart (NFR-4). */
export const hiveAccountStore = (database: DatabaseSync): HiveAccountStore => ({
  credentials: () =>
    (database.prepare("SELECT credentials FROM hive_account").get() as { credentials: string } | undefined)
      ?.credentials,

  keep: (credentials) => {
    database
      .prepare(
        "INSERT INTO hive_account (singleton, credentials, signed_in_at) VALUES (1, ?, ?) " +
          "ON CONFLICT (singleton) DO UPDATE SET credentials = excluded.credentials",
      )
      .run(credentials, new Date().toISOString());
  },

  signOut: () => {
    const kinds = HIVE_KINDS.map(() => "?").join(", ");
    database.exec("BEGIN");
    try {
      const { changes } = database.prepare(`DELETE FROM appliance WHERE kind IN (${kinds})`).run(...HIVE_KINDS);
      database.prepare("DELETE FROM hive_account").run();
      database.exec("COMMIT");
      return Number(changes);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

export interface HiveOptions {
  readonly appliances: ApplianceStore;
  readonly account: HiveAccountStore;
  /** Left out by a Hub run without a Hive Driver, which can't sign in. */
  readonly driver: HeatingDriver | undefined;
  /** The time, in milliseconds since the epoch; the clock, but for tests. */
  readonly now?: () => number;
}

export interface Hive {
  /** Whether the Hub is signed in, asking Hive whether it still accepts the tokens (FR-67b). */
  readonly check: () => Promise<HiveAccount>;
  readonly signIn: (login: CloudLogin) => Promise<HiveSignInOutcome>;
  readonly enterCode: (code: string) => Promise<HiveSignedIn>;
  readonly signOut: () => void;
}

/**
 * How long the Hub holds Hive's sign-in session while it waits for the
 * code, a little longer than the 3 minutes Hive allows, so that Hive, not
 * the Hub, says a code came too late.
 */
const CODE_WAIT_MS = 5 * 60_000;

/**
 * Signs in to Hive, once, with the code Hive texts if it asks for one, and
 * adds every Heating, Radiator Valve and Hot Water on the account, each with
 * Hive's name and no Room (FR-67). Hive's sign-in session, between asking
 * for the code and being given it, is held only here, in memory, and never
 * sent to the Remote nor logged: it is as secret as the tokens.
 */
export const hive = ({ appliances, account, driver, now = Date.now }: HiveOptions): Hive => {
  /** Hive's session while it waits for the code, and until when the Hub holds it. */
  let pending: { readonly session: string; readonly until: number } | undefined;

  const driverOrRefuse = (): HeatingDriver => {
    if (driver === undefined) throw new HttpRefusal(400, "The Hub can't sign in to Hive.");
    return driver;
  };

  /**
   * Hive's name for the Appliance, as the Hub keeps it: no longer than any
   * name may be, and numbered where another of its kind with no Room has
   * it already, as two of Hive's Radiator Valves may.
   */
  const nameFor = (kind: ApplianceKind, given: string): string => {
    const name = firstCharacters(given.trim(), APPLIANCE_NAME_MAX_LENGTH) || KIND_NAMES[kind];
    for (let number = 1; ; number += 1) {
      const suffix = number === 1 ? "" : ` ${String(number)}`;
      const candidate = `${firstCharacters(name, APPLIANCE_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
      try {
        appliances.checkPlace(kind, candidate, null);
        return candidate;
      } catch (error) {
        if (!(error instanceof ApplianceRefusal && error.reason === "taken")) throw error;
      }
    }
  };

  /**
   * Lists the account's Appliances, keeping the credentials the Driver may
   * have renewed, and adds each the Hub hasn't yet, by Hive's id for it, so
   * that one added before keeps its name and Room.
   */
  const addAppliances = async (heating: HeatingDriver, credentials: string): Promise<Appliance[]> => {
    const listed = await heating.listAppliances(credentials);
    account.keep(listed.credentials);
    const added = listed.appliances
      .filter(({ kind, id }) => appliances.withSerialNumber(kind, id) === undefined)
      .map(({ kind, id, name }) =>
        appliances.add(
          {
            kind,
            name: nameFor(kind, name),
            roomId: null,
            address: "",
            model: MODELS[kind],
            macAddress: "",
            serialNumber: id,
          },
          "",
        ),
      );
    if (added.length > 0) {
      console.log(`Added ${String(added.length)} of Hive's Appliances: ${added.map(({ name }) => name).join(", ")}`);
    }
    return added;
  };

  const signedIn = async (heating: HeatingDriver, credentials: string): Promise<HiveSignedIn> => {
    pending = undefined;
    account.keep(credentials);
    console.log("The Hub is signed in to Hive, and keeps only Hive's tokens and its device's keys");
    return { signedIn: true, added: await addAppliances(heating, credentials) };
  };

  return {
    check: async () => {
      const credentials = account.credentials();
      if (credentials === undefined) return { signedIn: false };
      if (driver === undefined) return { signedIn: true, tokens: "unreachable" };
      try {
        await addAppliances(driver, credentials);
        return { signedIn: true, tokens: "accepted" };
      } catch (error) {
        if (error instanceof CredentialsRefused) {
          console.log("Hive no longer accepts the Hub's tokens, so Settings offers to sign in again");
          return { signedIn: true, tokens: "refused" };
        }
        if (error instanceof DriverFailure && (error.reason === "unreachable" || error.reason === "timed-out")) {
          return { signedIn: true, tokens: "unreachable" };
        }
        throw error;
      }
    },

    signIn: async (login) => {
      const heating = driverOrRefuse();
      pending = undefined;
      // Given the credentials kept from before, the Driver signs in as the
      // device Hive already trusts, so that Hive doesn't ask for a code again.
      const answer = await heating.signIn(login, account.credentials());
      if (answer.signedIn) return signedIn(heating, answer.credentials);
      pending = { session: answer.pending, until: now() + CODE_WAIT_MS };
      return { signedIn: false, needs: "code" };
    },

    enterCode: async (code) => {
      const heating = driverOrRefuse();
      if (pending === undefined || now() > pending.until) {
        pending = undefined;
        throw new HttpRefusal(409, "Hive's code has expired. Sign in again for a new one.");
      }
      return signedIn(heating, await heating.enterCode(pending.session, code));
    },

    signOut: () => {
      pending = undefined;
      const removed = account.signOut();
      console.log(`Signed out of Hive: the Hub forgot its tokens, and removed Hive's ${String(removed)} Appliances`);
    },
  };
};
