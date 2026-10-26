/**
 * The Ring Driver: reaches the owner's Ring doorbells, cameras and chimes
 * through the Ring app's private cloud API (ADR 0014), by `ring-client-api`,
 * which this module alone imports. Ring neither documents nor supports that
 * API, so any of it may stop working; each failure is a {@link RingFailure}
 * saying so.
 *
 * It signs in with the account's email and password, then the two-step code
 * Ring sends, and keeps only the token Ring issues, which the library
 * refreshes. The password is held only until signed in. The library's own log
 * is silenced, so that nothing it writes can carry the token (FR-4).
 *
 * Live video never passes through the Hub: the Remote's browser makes a
 * WebRTC offer, which the Driver hands Ring, and Ring's answer goes back, so
 * the browser receives the video from Ring itself.
 */
import { RingApi, type RingCamera, type RingChime } from "ring-client-api";
import { RingRestClient } from "ring-client-api/rest-client";
import { useLogger } from "ring-client-api/util";
import type { RingAction, RingDeviceState } from "@media-centre/shared";

import {
  RingFailure,
  cameraIn,
  cameraStateIn,
  chimeIn,
  chimeStateIn,
  eventsIn,
  type RingDeviceInfo,
  type RingDriver,
  type RingSignInStep,
} from "./ring-driver.ts";

/** What the Ring app shows the Hub as, among the account's signed-in devices. */
const DISPLAY_NAME = "media-centre Hub";

/** How often the library reads every device's state again, so a widget shows the light or battery as it is now. */
const POLL_SECONDS = 20;

/** How many of a camera's events the widget lists. */
const EVENTS = 10;

useLogger({ logInfo: () => undefined, logError: () => undefined });

const failure = (what: string, error: unknown): RingFailure =>
  new RingFailure(`${what}: ${error instanceof Error ? error.message : "Ring refused."}`, { cause: error });

/** Runs `work`, with anything Ring refuses as a {@link RingFailure}. */
const ringSays = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw error instanceof RingFailure ? error : failure(what, error);
  }
};

interface Device {
  readonly info: RingDeviceInfo;
  readonly camera?: RingCamera;
  readonly chime?: RingChime;
}

/** The Driver for Ring's devices, through the Ring app's cloud API. */
export const ringDriver = (): RingDriver => {
  let api: RingApi | undefined;
  let pending: { readonly client: RingRestClient; readonly onToken: (token: string) => void } | undefined;
  /** When each camera last rang, and saw motion, since signing in, as the library hears it pushed. */
  const lastDing = new Map<string, string>();
  const lastMotion = new Map<string, string>();
  const heard = new Set<string>();
  const sessions = new Map<string, { end: () => Promise<unknown> }>();

  const connect = async (token: string, onToken: (token: string) => void): Promise<void> => {
    api?.disconnect();
    heard.clear();
    const ring = new RingApi({
      refreshToken: token,
      controlCenterDisplayName: DISPLAY_NAME,
      cameraStatusPollingSeconds: POLL_SECONDS,
    });
    api = ring;
    ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
      onToken(newRefreshToken);
    });
    onToken(token);
    // Reading the locations proves the token, and starts the library listening for dings.
    await ringSays("Ring couldn't be reached", () => ring.getLocations());
  };

  const signedIn = (): RingApi => {
    if (api === undefined) throw new RingFailure("The Hub isn't signed in to Ring.");
    return api;
  };

  const all = async (): Promise<Device[]> => {
    const locations = await ringSays("Ring couldn't be reached", () => signedIn().getLocations());
    const found: Device[] = [];
    for (const location of locations) {
      for (const camera of location.cameras) {
        const info = cameraIn(camera.data, camera.isDoorbot, camera.model, location.name);
        if (info === null) continue;
        found.push({ info, camera });
        if (!heard.has(info.id)) {
          heard.add(info.id);
          camera.onDoorbellPressed.subscribe(() => {
            lastDing.set(info.id, new Date().toISOString());
          });
          camera.onMotionStarted.subscribe(() => {
            lastMotion.set(info.id, new Date().toISOString());
          });
        }
      }
      for (const chime of location.chimes) {
        const info = chimeIn(chime.data, chime.model, location.name);
        if (info !== null) found.push({ info, chime });
      }
    }
    return found.toSorted((a, b) => a.info.name.localeCompare(b.info.name));
  };

  const find = async (id: string): Promise<Device> => {
    const device = (await all()).find(({ info }) => info.id === id);
    if (device === undefined) throw new RingFailure("That device is no longer on the Ring account.");
    return device;
  };

  const camera = async (id: string): Promise<RingCamera> => {
    const { camera: found } = await find(id);
    if (found === undefined) throw new RingFailure("That is a chime, which has no camera.");
    return found;
  };

  const chime = async (id: string): Promise<RingChime> => {
    const { chime: found } = await find(id);
    if (found === undefined) throw new RingFailure("That isn't a chime.");
    return found;
  };

  /** Signs in with what Ring's sign-in gave, or says Ring wants the code it has sent. */
  const finish = async (
    client: RingRestClient,
    onToken: (token: string) => void,
    signIn: () => Promise<{ refresh_token: string }>,
  ): Promise<RingSignInStep> => {
    try {
      const { refresh_token: token } = await signIn();
      pending = undefined;
      await connect(token, onToken);
      return { kind: "signed-in" };
    } catch (error) {
      if (error instanceof RingFailure) throw error;
      if (client.promptFor2fa !== undefined) {
        pending = { client, onToken };
        if (client.promptFor2fa.startsWith("Invalid")) {
          throw new RingFailure("Ring didn't accept that code. Check it, and try again.", { cause: error });
        }
        return { kind: "code-needed", prompt: client.promptFor2fa.replace(/^Please enter the code /, "") };
      }
      pending = undefined;
      throw failure("Signing in to Ring failed", error);
    }
  };

  return {
    signIn: (email, password, onToken) => {
      const client = new RingRestClient({ email, password, controlCenterDisplayName: DISPLAY_NAME });
      return finish(client, onToken, () => client.getCurrentAuth());
    },

    enterCode: (code) => {
      if (pending === undefined) throw new RingFailure("Sign in to Ring again: the code was for a sign-in now over.");
      const { client, onToken } = pending;
      return finish(client, onToken, () => client.getAuth(code));
    },

    resume: (token, onToken) => connect(token, onToken),

    signOut: () => {
      pending = undefined;
      api?.disconnect();
      api = undefined;
      heard.clear();
      sessions.clear();
    },

    devices: async () => (await all()).map(({ info }) => info),

    state: async (id) => {
      const device = await find(id);
      const base: RingDeviceState = {
        id,
        online: device.info.online,
        battery: null,
        charging: null,
        wifi: null,
        light: null,
        siren: null,
        motionDetection: null,
        lastDing: lastDing.get(id) ?? null,
        lastMotion: lastMotion.get(id) ?? null,
        events: [],
        volume: null,
      };
      if (device.chime !== undefined) return { ...base, ...chimeStateIn(device.chime.data) };
      if (device.camera === undefined) return base;
      // The events are left out where Ring refuses them, as the rest is still worth showing.
      const events = await device.camera.getEvents({ limit: EVENTS }).catch(() => null);
      return { ...base, ...cameraStateIn(device.camera.data), events: eventsIn(events) };
    },

    act: async (id, action: RingAction) => {
      switch (action.kind) {
        case "light": {
          const found = await camera(id);
          if (!found.hasLight) throw new RingFailure("That camera has no light.");
          await ringSays("Ring refused the light", () => found.setLight(action.on));
          found.requestUpdate();
          return;
        }
        case "siren": {
          const found = await camera(id);
          if (!found.hasSiren) throw new RingFailure("That camera has no siren.");
          await ringSays("Ring refused the siren", () => found.setSiren(action.on));
          found.requestUpdate();
          return;
        }
        case "motion-detection": {
          const found = await camera(id);
          await ringSays("Ring refused motion detection", () =>
            found.setDeviceSettings({ motion_settings: { motion_detection_enabled: action.on } }),
          );
          found.requestUpdate();
          return;
        }
        case "chime-volume": {
          const found = await chime(id);
          await ringSays("Ring refused the volume", () => found.setVolume(action.level));
          found.requestUpdate();
          return;
        }
        case "chime-test": {
          const found = await chime(id);
          await ringSays("Ring refused to play it", () => found.playSound(action.sound));
          return;
        }
      }
    },

    snapshot: async (id) => {
      const found = await camera(id);
      return ringSays("Ring gave no snapshot", () => found.getSnapshot());
    },

    startLiveView: async (id, sdp) => {
      const found = await camera(id);
      const session = found.createSimpleWebRtcSession();
      const answer = await ringSays("Ring refused live view", () => session.start(sdp));
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, sdp: answer };
    },

    endLiveView: async (sessionId) => {
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      await session?.end().catch(() => undefined);
    },

    recordingUrl: async (id, eventId) => {
      const found = await camera(id);
      return ringSays("Ring has no recording of that", () => found.getRecordingUrl(eventId, { transcoded: true }));
    },
  };
};
