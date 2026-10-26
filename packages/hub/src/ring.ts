import type { DatabaseSync } from "node:sqlite";

import type { RingAction, RingDevice, RingDeviceState, RingHome, RingLiveView, RingStatus } from "@media-centre/shared";

import { RingFailure, type RingDriver, type RingSignInStep } from "./drivers/ring/ring-driver.ts";
import type { NetworkDeviceStore } from "./network-devices.ts";
import type { RoomStore } from "./rooms.ts";

/** The Hub's one sign-in to Ring: the token Ring issued, which is secret (FR-4). */
export interface RingAccountStore {
  readonly read: () => string | undefined;
  readonly keep: (token: string) => void;
  readonly forget: () => void;
}

/** The Hub's sign-in to Ring, in its database, so it survives a restart (NFR-4). */
export const ringAccountStore = (database: DatabaseSync): RingAccountStore => ({
  read: () => (database.prepare("SELECT token FROM ring_account").get() as { token: string } | undefined)?.token,
  keep: (token) => {
    database
      .prepare(
        `INSERT INTO ring_account (singleton, token, signed_in_at) VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET token = excluded.token`,
      )
      .run(token, new Date().toISOString());
  },
  forget: () => {
    database.prepare("DELETE FROM ring_account").run();
  },
});

export interface RingOptions {
  readonly log?: (line: string) => void;
}

export interface Ring {
  /** Signs in with the token kept from before, if any, as the Hub starts. */
  readonly resume: () => void;
  readonly home: () => Promise<RingHome>;
  readonly signIn: (email: string, password: string) => Promise<RingHome>;
  readonly enterCode: (code: string) => Promise<RingHome>;
  readonly signOut: () => Promise<RingHome>;
  readonly state: (id: string) => Promise<RingDeviceState>;
  readonly act: (id: string, action: RingAction) => Promise<RingDeviceState>;
  readonly snapshot: (id: string) => Promise<Uint8Array>;
  readonly startLiveView: (id: string, sdp: string) => Promise<RingLiveView>;
  readonly endLiveView: (sessionId: string) => Promise<void>;
  readonly recordingUrl: (id: string, eventId: string) => Promise<string>;
  readonly setRoom: (id: string, roomId: number | null) => Promise<RingHome>;
  /** Resolves once a sign-in under way, with the token kept, has ended. For tests. */
  readonly settled: () => Promise<void>;
}

/**
 * The owner's Ring doorbells, cameras and chimes, through the Ring Driver,
 * for the Ring tab: the Hub's one sign-in to Ring, kept in its database and
 * refreshed as the Driver refreshes it, each device with the Room it was put
 * in, and what each can be asked to do. It logs what it did, never the
 * token, the password, nor the code.
 */
export const ring = (
  {
    driver,
    account,
    devices,
    rooms,
  }: {
    readonly driver: RingDriver;
    readonly account: RingAccountStore;
    readonly devices: NetworkDeviceStore;
    readonly rooms: RoomStore;
  },
  { log = console.log }: RingOptions = {},
): Ring => {
  let status: RingStatus = { state: "signed-out", problem: null };
  let resuming: Promise<void> | undefined;

  const keep = (token: string): void => {
    account.keep(token);
  };

  /** Where signing in got to, as the status, or Ring's refusal as the problem. */
  const step = async (email: string, work: () => Promise<RingSignInStep>): Promise<void> => {
    try {
      const next = await work();
      if (next.kind === "signed-in") {
        status = { state: "signed-in", problem: null };
        log("Signed in to Ring");
      } else {
        status = { state: "code-needed", email, prompt: next.prompt, problem: null };
        log("Ring sent a two-step code");
      }
    } catch (error) {
      const problem = error instanceof RingFailure ? error.message : "Signing in to Ring failed.";
      status = status.state === "code-needed" ? { ...status, problem } : { state: "signed-out", problem };
      log(problem);
    }
  };

  const devicesNow = async (): Promise<RingDevice[]> => {
    const allRooms = rooms.list();
    return (await driver.devices()).map((device) => {
      const room = allRooms.find(({ id }) => id === devices.roomOf(`ring:${device.id}`));
      return { ...device, room: room === undefined ? null : { id: room.id, name: room.name } };
    });
  };

  const home = async (): Promise<RingHome> => {
    if (status.state !== "signed-in") return { status, devices: [] };
    try {
      const found = await devicesNow();
      status = { ...status, problem: null };
      return { status, devices: found };
    } catch (error) {
      const problem = error instanceof RingFailure ? error.message : "Ring couldn't be reached.";
      return { status: { ...status, problem }, devices: [] };
    }
  };

  const signedIn = (): void => {
    if (status.state !== "signed-in") throw new RingFailure("The Hub isn't signed in to Ring.");
  };

  return {
    resume: () => {
      const kept = account.read();
      if (kept === undefined) return;
      log("Signing in to Ring again");
      resuming = step("", async () => {
        await driver.resume(kept, keep);
        return { kind: "signed-in" };
      });
    },

    home,

    signIn: async (email, password) => {
      driver.signOut();
      status = { state: "signed-out", problem: null };
      log("Signing in to Ring");
      await step(email, () => driver.signIn(email, password, keep));
      return home();
    },

    enterCode: async (code) => {
      if (status.state !== "code-needed") throw new RingFailure("Sign in to Ring first: no code is awaited.");
      const { email } = status;
      await step(email, () => driver.enterCode(code));
      return home();
    },

    signOut: async () => {
      driver.signOut();
      account.forget();
      status = { state: "signed-out", problem: null };
      log("Signed out of Ring");
      return home();
    },

    state: async (id) => {
      signedIn();
      return driver.state(id);
    },

    act: async (id, action) => {
      signedIn();
      await driver.act(id, action);
      log(`Asked the Ring device ${id} to change its ${action.kind}`);
      return driver.state(id);
    },

    snapshot: async (id) => {
      signedIn();
      return driver.snapshot(id);
    },

    startLiveView: async (id, sdp) => {
      signedIn();
      const live = await driver.startLiveView(id, sdp);
      log(`Started live view of the Ring camera ${id}`);
      return live;
    },

    endLiveView: async (sessionId) => {
      await driver.endLiveView(sessionId);
    },

    recordingUrl: async (id, eventId) => {
      signedIn();
      return driver.recordingUrl(id, eventId);
    },

    setRoom: async (id, roomId) => {
      signedIn();
      const device = (await driver.devices()).find((each) => each.id === id);
      if (device === undefined) throw new RingFailure("That device is no longer on the Ring account.");
      devices.setRoom(`ring:${id}`, roomId);
      devices.saw(`ring:${id}`, { address: null, label: device.name, maker: "Ring" });
      return home();
    },

    settled: async () => {
      await resuming;
    },
  };
};
