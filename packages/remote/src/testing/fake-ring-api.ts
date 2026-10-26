import type { RingAction, RingDevice, RingDeviceState, RingHome } from "@media-centre/shared";

import { HubRequestFailed } from "../hub-request.ts";
import type { RingApi } from "../ring-api.ts";

/** A Ring device as the Hub would give it, with what isn't given made up. */
export const aRingDevice = (device: Partial<RingDevice> & Pick<RingDevice, "id" | "name">): RingDevice => ({
  kind: "doorbell",
  model: "Video Doorbell 4",
  location: "Home",
  online: true,
  battery: 82,
  capabilities: { light: false, siren: false, video: true },
  room: null,
  ...device,
});

/** What the Hub would read of a Ring device, with what isn't given made up. */
export const aRingState = (id: string, state: Partial<RingDeviceState> = {}): RingDeviceState => ({
  id,
  online: true,
  battery: 82,
  charging: false,
  wifi: { rssi: -52, quality: "good" },
  light: null,
  siren: null,
  motionDetection: true,
  lastDing: null,
  lastMotion: null,
  events: [],
  volume: null,
  ...state,
});

export const RING_SIGNED_OUT: RingHome = { status: { state: "signed-out", problem: null }, devices: [] };

export interface FakeRingApi extends RingApi {
  readonly setHome: (home: RingHome) => void;
  readonly setState: (state: RingDeviceState) => void;
  /** Makes the next request fail with `message`, as the Hub, or Ring through it, refusing it would. */
  readonly failNext: (message: string) => void;
  /** Everything asked, in order. */
  readonly asked: () => readonly unknown[];
}

/**
 * The Hub's Ring kept in memory, standing in for the Hub: signing in asks for
 * a code, and the code `123456` signs in with `devices`.
 */
export const fakeRingApi = (
  initial: RingHome = RING_SIGNED_OUT,
  initialStates: readonly RingDeviceState[] = [],
  devices: readonly RingDevice[] = [],
): FakeRingApi => {
  let home = initial;
  const states = new Map(initialStates.map((state) => [state.id, state]));
  let failure: string | undefined;
  const asked: unknown[] = [];

  const answer = <T>(value: () => T): Promise<T> => {
    if (failure !== undefined) {
      const message = failure;
      failure = undefined;
      return Promise.reject(new HubRequestFailed(message));
    }
    return Promise.resolve(value());
  };
  const stateOf = (id: string): RingDeviceState => states.get(id) ?? aRingState(id);

  return {
    setHome: (next) => {
      home = next;
    },
    setState: (state) => {
      states.set(state.id, state);
    },
    failNext: (message) => {
      failure = message;
    },
    asked: () => asked,
    home: () => answer(() => home),
    signIn: (email, password) =>
      answer(() => {
        asked.push(["sign-in", email, password]);
        home = {
          devices: [],
          status: { state: "code-needed", email, prompt: "sent to +44•••••123 via sms", problem: null },
        };
        return home;
      }),
    enterCode: (code) =>
      answer(() => {
        asked.push(["code", code]);
        if (home.status.state === "code-needed" && code !== "123456") {
          home = { ...home, status: { ...home.status, problem: "Ring didn't accept that code." } };
        } else {
          home = { status: { state: "signed-in", problem: null }, devices };
        }
        return home;
      }),
    signOut: () =>
      answer(() => {
        asked.push(["sign-out"]);
        home = RING_SIGNED_OUT;
        return home;
      }),
    state: (id) => answer(() => stateOf(id)),
    act: (id, action: RingAction) =>
      answer(() => {
        asked.push([id, action]);
        const state = stateOf(id);
        const next: RingDeviceState =
          action.kind === "light"
            ? { ...state, light: action.on }
            : action.kind === "siren"
              ? { ...state, siren: action.on }
              : action.kind === "motion-detection"
                ? { ...state, motionDetection: action.on }
                : action.kind === "chime-volume"
                  ? { ...state, volume: action.level }
                  : state;
        states.set(id, next);
        return next;
      }),
    snapshotUrl: (id) => `/api/ring/devices/${id}/snapshot`,
    startLiveView: (id, sdp) =>
      answer(() => {
        asked.push([id, { live: sdp }]);
        return { sessionId: "session-1", sdp: "v=0 answer" };
      }),
    endLiveView: (id, sessionId) =>
      answer(() => {
        asked.push([id, { end: sessionId }]);
      }),
    recording: (id, eventId) =>
      answer(() => {
        asked.push([id, { recording: eventId }]);
        return { url: `http://localhost/ring-recordings/${eventId}.mp4` };
      }),
    setRoom: (id, roomId) =>
      answer(() => {
        asked.push([id, { room: roomId }]);
        return home;
      }),
  };
};
