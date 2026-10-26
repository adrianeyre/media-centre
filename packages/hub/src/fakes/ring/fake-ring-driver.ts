/**
 * Stands in for the Ring Driver, for tests and for the Hub run against the
 * fakes, with `RING_FAKE` set: a doorbell, a floodlight camera and a chime on
 * an account, each answering as the Ring app's API would, keeping what it is
 * asked in memory. Signing in asks for a two-step code, {@link FAKE_RING_CODE},
 * unless the password is {@link FAKE_RING_NO_CODE_PASSWORD}; the password
 * {@link FAKE_RING_WRONG_PASSWORD} is refused. It has no live video to give.
 */
import type { RingAction, RingDeviceState, RingEvent, RingLiveView } from "@media-centre/shared";

import {
  RingFailure,
  type RingDeviceInfo,
  type RingDriver,
  type RingSignInStep,
} from "../../drivers/ring/ring-driver.ts";

export const FAKE_RING_CODE = "123456";
export const FAKE_RING_NO_CODE_PASSWORD = "no-code";
export const FAKE_RING_WRONG_PASSWORD = "wrong";

export const FAKE_RING_DEVICES: readonly RingDeviceInfo[] = [
  {
    id: "100001",
    name: "Front Door",
    kind: "doorbell",
    model: "Video Doorbell 4",
    location: "Home",
    online: true,
    battery: 82,
    capabilities: { light: false, siren: false, video: true },
  },
  {
    id: "100002",
    name: "Garden",
    kind: "camera",
    model: "Floodlight Cam Wired Pro",
    location: "Home",
    online: true,
    battery: null,
    capabilities: { light: true, siren: true, video: true },
  },
  {
    id: "100003",
    name: "Hallway Chime",
    kind: "chime",
    model: "Chime Pro",
    location: "Home",
    online: true,
    battery: null,
    capabilities: { light: false, siren: false, video: false },
  },
];

/** A 1×1 grey JPEG, as every fake camera's snapshot. */
const SNAPSHOT = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

export interface FakeRingDriver extends RingDriver {
  /** Everything each device was asked, by its id, in order. */
  readonly asked: () => readonly (readonly [string, RingAction])[];
  /** Makes the next call to Ring fail with `message`, as Ring refusing it would. */
  readonly refuseNext: (message: string) => void;
  /** Whether it is signed in. */
  readonly signedIn: () => boolean;
  /** Rings the doorbell, as someone at the door would. */
  readonly ding: (id: string) => void;
}

const eventsOf = (id: string): RingEvent[] => {
  const now = Date.now();
  return [
    { id: `${id}-3`, kind: "motion", at: new Date(now - 20 * 60_000).toISOString(), recorded: true },
    { id: `${id}-2`, kind: "ding", at: new Date(now - 3 * 3_600_000).toISOString(), recorded: true },
    { id: `${id}-1`, kind: "live-view", at: new Date(now - 26 * 3_600_000).toISOString(), recorded: false },
  ];
};

/** Answers with what `work` gives, or its throw as a refusal, as the Driver's promises do. */
const settle = <T>(work: () => T): Promise<T> => {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
};

export const fakeRingDriver = ({ token = "fake-ring-token" }: { readonly token?: string } = {}): FakeRingDriver => {
  let signedIn = false;
  let pending: ((token: string) => void) | undefined;
  let refusal: string | undefined;
  const asked: [string, RingAction][] = [];
  const light = new Map<string, boolean>([["100002", false]]);
  const siren = new Map<string, boolean>([["100002", false]]);
  const motion = new Map<string, boolean>([
    ["100001", true],
    ["100002", true],
  ]);
  const volume = new Map<string, number>([["100003", 8]]);
  const dings = new Map<string, string>();

  const check = (): void => {
    if (refusal !== undefined) {
      const message = refusal;
      refusal = undefined;
      throw new RingFailure(message);
    }
    if (!signedIn) throw new RingFailure("The Hub isn't signed in to Ring.");
  };

  const find = (id: string): RingDeviceInfo => {
    const device = FAKE_RING_DEVICES.find((each) => each.id === id);
    if (device === undefined) throw new RingFailure("That device is no longer on the Ring account.");
    return device;
  };

  const camera = (id: string): RingDeviceInfo => {
    const device = find(id);
    if (!device.capabilities.video) throw new RingFailure("That is a chime, which has no camera.");
    return device;
  };

  const done = (onToken: (token: string) => void): RingSignInStep => {
    signedIn = true;
    pending = undefined;
    onToken(token);
    return { kind: "signed-in" };
  };

  return {
    signIn: (_email, password, onToken) =>
      settle(() => {
        if (password === FAKE_RING_WRONG_PASSWORD) {
          throw new RingFailure("Signing in to Ring failed: Verify that your email and password are correct.");
        }
        if (password === FAKE_RING_NO_CODE_PASSWORD) return done(onToken);
        pending = onToken;
        return { kind: "code-needed", prompt: "sent to +44•••••123 via sms" };
      }),

    enterCode: (code) =>
      settle(() => {
        if (pending === undefined) throw new RingFailure("Sign in to Ring again: the code was for a sign-in now over.");
        if (code !== FAKE_RING_CODE) throw new RingFailure("Ring didn't accept that code. Check it, and try again.");
        return done(pending);
      }),

    resume: (kept, onToken) =>
      settle(() => {
        if (kept !== token) throw new RingFailure("Ring no longer accepts the Hub's sign-in. Sign in again.");
        signedIn = true;
        onToken(token);
      }),

    signOut: () => {
      signedIn = false;
      pending = undefined;
    },

    devices: () =>
      settle(() => {
        check();
        return [...FAKE_RING_DEVICES].toSorted((a, b) => a.name.localeCompare(b.name));
      }),

    state: (id): Promise<RingDeviceState> =>
      settle(() => {
        check();
        const device = find(id);
        const video = device.capabilities.video;
        return {
          id,
          online: device.online,
          battery: device.battery,
          charging: device.battery === null ? null : false,
          wifi: { rssi: -52, quality: "good" },
          light: light.get(id) ?? null,
          siren: siren.get(id) ?? null,
          motionDetection: motion.get(id) ?? null,
          lastDing: dings.get(id) ?? null,
          lastMotion: null,
          events: video ? eventsOf(id) : [],
          volume: volume.get(id) ?? null,
        };
      }),

    act: (id, action) =>
      settle(() => {
        check();
        const device = find(id);
        asked.push([id, action]);
        switch (action.kind) {
          case "light":
            if (!device.capabilities.light) throw new RingFailure("That camera has no light.");
            light.set(id, action.on);
            return;
          case "siren":
            if (!device.capabilities.siren) throw new RingFailure("That camera has no siren.");
            siren.set(id, action.on);
            return;
          case "motion-detection":
            camera(id);
            motion.set(id, action.on);
            return;
          case "chime-volume":
            if (device.kind !== "chime") throw new RingFailure("That isn't a chime.");
            volume.set(id, action.level);
            return;
          case "chime-test":
            if (device.kind !== "chime") throw new RingFailure("That isn't a chime.");
            return;
        }
      }),

    snapshot: (id) =>
      settle(() => {
        check();
        camera(id);
        return new Uint8Array(SNAPSHOT);
      }),

    startLiveView: (id): Promise<RingLiveView> =>
      settle(() => {
        check();
        camera(id);
        throw new RingFailure("The fake Ring has no live video to give.");
      }),

    endLiveView: () => Promise.resolve(),

    recordingUrl: (id, eventId) =>
      settle(() => {
        check();
        camera(id);
        return `http://localhost/ring-recordings/${encodeURIComponent(eventId)}.mp4`;
      }),

    asked: () => asked,
    refuseNext: (message) => {
      refusal = message;
    },
    signedIn: () => signedIn,
    ding: (id) => {
      dings.set(id, new Date().toISOString());
    },
  };
};
