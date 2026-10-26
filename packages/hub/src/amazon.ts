import type { DatabaseSync } from "node:sqlite";

import type {
  AmazonAction,
  AmazonDevice,
  AmazonDeviceState,
  AmazonDomain,
  AmazonHome,
  AmazonStatus,
} from "@media-centre/shared";

import { AmazonFailure, type AmazonDriver } from "./drivers/amazon/amazon-driver.ts";
import type { HubAddressStore } from "./hub-address.ts";
import type { NetworkDeviceStore } from "./network-devices.ts";
import type { RoomStore } from "./rooms.ts";

/** The Hub's one sign-in to Amazon: the site and the session, which is secret (FR-4). */
export interface AmazonAccountStore {
  readonly read: () => { readonly domain: AmazonDomain; readonly session: string } | undefined;
  readonly keep: (domain: AmazonDomain, session: string) => void;
  readonly forget: () => void;
}

/** The Hub's sign-in to Amazon, in its database, so it survives a restart (NFR-4). */
export const amazonAccountStore = (database: DatabaseSync): AmazonAccountStore => ({
  read: () =>
    database.prepare("SELECT domain, session FROM amazon_account").get() as
      { domain: AmazonDomain; session: string } | undefined,
  keep: (domain, session) => {
    database
      .prepare(
        `INSERT INTO amazon_account (singleton, domain, session, signed_in_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET domain = excluded.domain, session = excluded.session`,
      )
      .run(domain, session, new Date().toISOString());
  },
  forget: () => {
    database.prepare("DELETE FROM amazon_account").run();
  },
});

export interface AmazonOptions {
  /** Where the sign-in page listens, on every interface. By default, 41081, beside the Hub's own 41080. */
  readonly signInPort?: number;
  readonly log?: (line: string) => void;
}

export interface Amazon {
  /** Signs in with the session kept from before, if any, as the Hub starts. */
  readonly resume: () => void;
  readonly home: () => Promise<AmazonHome>;
  /**
   * Starts signing in. `onHubPc` is whether the person is at the Hub's PC,
   * having opened the Remote there at `localhost`, where Amazon's sign-in page
   * is served at `localhost` too: the only address a browser lets it encrypt
   * the password on, as Amazon's page now does, for it isn't HTTPS.
   */
  readonly signIn: (domain: AmazonDomain, onHubPc?: boolean) => Promise<AmazonHome>;
  readonly signOut: () => Promise<AmazonHome>;
  readonly state: (serial: string) => Promise<AmazonDeviceState>;
  readonly act: (serial: string, action: AmazonAction) => Promise<AmazonDeviceState>;
  readonly announce: (text: string) => Promise<void>;
  readonly setRoom: (serial: string, roomId: number | null) => Promise<AmazonHome>;
  /** Resolves once a sign-in under way has ended. For tests. */
  readonly settled: () => Promise<void>;
}

/**
 * The owner's Echo devices, through the Amazon Driver, for the Amazon tab:
 * the Hub's one sign-in to Amazon, kept in its database and refreshed as the
 * Driver refreshes it, each device with the Room it was put in, and what
 * each can be asked to do. It logs what it did, never the session.
 */
export const amazon = (
  {
    driver,
    account,
    hubAddress,
    devices,
    rooms,
  }: {
    readonly driver: AmazonDriver;
    readonly account: AmazonAccountStore;
    readonly hubAddress: HubAddressStore;
    readonly devices: NetworkDeviceStore;
    readonly rooms: RoomStore;
  },
  { signInPort = 41_081, log = console.log }: AmazonOptions = {},
): Amazon => {
  let status: AmazonStatus = { state: "signed-out", problem: null };
  let signingIn: Promise<void> | undefined;

  const start = (domain: AmazonDomain, session: string | undefined, onHubPc = false): void => {
    driver.signOut();
    status = { state: "signing-in", domain, signInUrl: null };
    const host = onHubPc ? "localhost" : (hubAddress.read().address ?? "localhost");
    log(session === undefined ? `Signing in to Amazon at ${domain}` : `Signing in to Amazon at ${domain} again`);
    signingIn = driver
      .signIn({
        domain,
        host,
        port: signInPort,
        ...(session === undefined ? {} : { session }),
        onSignInUrl: (url) => {
          if (status.state === "signing-in") status = { ...status, signInUrl: url };
          log(`Amazon's sign-in page is at ${url}`);
        },
        onSession: (kept) => {
          account.keep(domain, kept);
        },
      })
      .then(
        () => {
          status = { state: "signed-in", domain, problem: null };
          log(`Signed in to Amazon at ${domain}`);
        },
        (error: unknown) => {
          const problem = error instanceof AmazonFailure ? error.message : "Signing in to Amazon failed.";
          status = { state: "signed-out", problem };
          log(problem);
        },
      );
  };

  const devicesNow = async (): Promise<AmazonDevice[]> => {
    const allRooms = rooms.list();
    return (await driver.devices()).map((device) => {
      const room = allRooms.find(({ id }) => id === devices.roomOf(`amazon:${device.serial}`));
      return { ...device, room: room === undefined ? null : { id: room.id, name: room.name } };
    });
  };

  const home = async (): Promise<AmazonHome> => {
    if (status.state !== "signed-in") return { status, devices: [], routines: [], musicProviders: [] };
    try {
      const [found, routines, musicProviders] = await Promise.all([
        devicesNow(),
        driver.routines().catch(() => []),
        driver.musicProviders().catch(() => []),
      ]);
      status = { ...status, problem: null };
      return { status, devices: found, routines, musicProviders };
    } catch (error) {
      const problem = error instanceof AmazonFailure ? error.message : "Amazon couldn't be reached.";
      return { status: { ...status, problem }, devices: [], routines: [], musicProviders: [] };
    }
  };

  const signedIn = (): void => {
    if (status.state !== "signed-in") throw new AmazonFailure("The Hub isn't signed in to Amazon.");
  };

  return {
    resume: () => {
      const kept = account.read();
      if (kept !== undefined) start(kept.domain, kept.session);
    },

    home,

    signIn: async (domain, onHubPc = false) => {
      start(domain, undefined, onHubPc);
      // Long enough for the sign-in page to start listening, so its address is in the answer.
      await Promise.race([signingIn, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      return home();
    },

    signOut: async () => {
      driver.signOut();
      account.forget();
      status = { state: "signed-out", problem: null };
      log("Signed out of Amazon");
      return home();
    },

    state: async (serial) => {
      signedIn();
      return driver.state(serial);
    },

    act: async (serial, action) => {
      signedIn();
      await driver.act(serial, action);
      log(`Asked the Echo ${serial} to ${action.kind}`);
      return driver.state(serial);
    },

    announce: async (text) => {
      signedIn();
      await driver.announceEverywhere(text);
      log("Announced on every Echo");
    },

    setRoom: async (serial, roomId) => {
      signedIn();
      const device = (await driver.devices()).find((each) => each.serial === serial);
      if (device === undefined) throw new AmazonFailure("That Echo is no longer on the Amazon account.");
      devices.setRoom(`amazon:${serial}`, roomId);
      devices.saw(`amazon:${serial}`, { address: null, label: device.name, maker: "Amazon" });
      return home();
    },

    settled: async () => {
      await signingIn;
    },
  };
};
