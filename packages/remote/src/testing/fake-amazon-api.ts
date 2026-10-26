import type { AmazonAction, AmazonDevice, AmazonDeviceState, AmazonHome } from "@media-centre/shared";

import type { AmazonApi } from "../amazon-api.ts";
import { HubRequestFailed } from "../hub-request.ts";

/** An Echo as the Hub would give it, with what isn't given made up. */
export const anEcho = (device: Partial<AmazonDevice> & Pick<AmazonDevice, "serial" | "name">): AmazonDevice => ({
  family: "Echo",
  online: true,
  capabilities: { music: true, volume: true, alarms: true, equaliser: true, bluetooth: true },
  room: null,
  ...device,
});

/** What the Hub would read of an Echo, with what isn't given made up. */
export const anEchoState = (serial: string, state: Partial<AmazonDeviceState> = {}): AmazonDeviceState => ({
  serial,
  player: {
    state: "paused",
    title: "Bohemian Rhapsody",
    subtitle: "Queen",
    provider: "Amazon Music",
    artUrl: null,
    progress: 61,
    length: 354,
  },
  volume: 40,
  doNotDisturb: false,
  equaliser: { bass: 0, midrange: 0, treble: 0 },
  alarmVolume: 50,
  notifications: [],
  bluetooth: [],
  ...state,
});

/** The Hub's address on the home network, where its fake sign-in page is. */
export const FAKE_HUB_ADDRESS = "192.168.1.5";

export const SIGNED_OUT: AmazonHome = {
  status: { state: "signed-out", problem: null },
  devices: [],
  routines: [],
  musicProviders: [],
};

export interface FakeAmazonApi extends AmazonApi {
  readonly setHome: (home: AmazonHome) => void;
  readonly setState: (state: AmazonDeviceState) => void;
  /** Makes the next request fail with `message`, as the Hub, or Amazon through it, refusing it would. */
  readonly failNext: (message: string) => void;
  /** Everything asked, in order. */
  readonly asked: () => readonly unknown[];
}

/**
 * The Hub's Amazon kept in memory, standing in for the Hub: signing in gives
 * a sign-in page, and stays signing in until the test sets it signed in.
 */
export const fakeAmazonApi = (
  initial: AmazonHome = SIGNED_OUT,
  initialStates: readonly AmazonDeviceState[] = [],
): FakeAmazonApi => {
  let home = initial;
  const states = new Map(initialStates.map((state) => [state.serial, state]));
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
  const stateOf = (serial: string): AmazonDeviceState => states.get(serial) ?? anEchoState(serial);

  return {
    setHome: (next) => {
      home = next;
    },
    setState: (state) => {
      states.set(state.serial, state);
    },
    failNext: (message) => {
      failure = message;
    },
    asked: () => asked,
    home: () => answer(() => home),
    signIn: (domain) =>
      answer(() => {
        asked.push(["sign-in", domain]);
        home = {
          ...SIGNED_OUT,
          status: { state: "signing-in", domain, signInUrl: `http://${FAKE_HUB_ADDRESS}:41081/` },
        };
        return home;
      }),
    signOut: () =>
      answer(() => {
        asked.push(["sign-out"]);
        home = SIGNED_OUT;
        return home;
      }),
    state: (serial) => answer(() => stateOf(serial)),
    act: (serial, action: AmazonAction) =>
      answer(() => {
        asked.push([serial, action]);
        const state = stateOf(serial);
        const next: AmazonDeviceState =
          action.kind === "volume"
            ? { ...state, volume: action.level }
            : action.kind === "do-not-disturb"
              ? { ...state, doNotDisturb: action.on }
              : action.kind === "play" && state.player !== null
                ? { ...state, player: { ...state.player, state: "playing" } }
                : action.kind === "pause" && state.player !== null
                  ? { ...state, player: { ...state.player, state: "paused" } }
                  : action.kind === "notification-delete"
                    ? { ...state, notifications: state.notifications.filter(({ id }) => id !== action.id) }
                    : state;
        states.set(serial, next);
        return next;
      }),
    announce: (text) =>
      answer(() => {
        asked.push(["announce-everywhere", text]);
      }),
    setRoom: (serial, roomId) =>
      answer(() => {
        asked.push([serial, { room: roomId }]);
        return home;
      }),
  };
};
