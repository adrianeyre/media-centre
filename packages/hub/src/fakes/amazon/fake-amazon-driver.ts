/**
 * Stands in for the Amazon Driver, for tests and for the Hub run against the
 * fakes, with `AMAZON_FAKE` set: two Echos on an account, each answering as
 * the Alexa app's API would, keeping what it is asked in memory. Signing in
 * afresh gives a sign-in page's address, then signs in as though the person
 * had, after `signInMs`; with a session from before, it signs in at once.
 */
import type {
  AmazonAction,
  AmazonDeviceState,
  AmazonMusicProvider,
  AmazonNotification,
  AmazonRoutine,
} from "@media-centre/shared";

import { AmazonFailure, type AmazonDeviceInfo, type AmazonDriver } from "../../drivers/amazon/amazon-driver.ts";

export const FAKE_ECHOS: readonly AmazonDeviceInfo[] = [
  {
    serial: "G0911W0000000001",
    name: "Kitchen Echo Dot",
    family: "Echo",
    online: true,
    capabilities: { music: true, volume: true, alarms: true, equaliser: true, bluetooth: true },
  },
  {
    serial: "G0911W0000000002",
    name: "Lounge Echo Show",
    family: "Echo Show",
    online: true,
    capabilities: { music: true, volume: true, alarms: true, equaliser: false, bluetooth: false },
  },
];

export const FAKE_ROUTINES: readonly AmazonRoutine[] = [
  { id: "amzn1.alexa.automation.good-night", name: "Good night" },
  { id: "amzn1.alexa.automation.movie", name: "Movie time" },
];

export const FAKE_MUSIC_PROVIDERS: readonly AmazonMusicProvider[] = [
  { id: "AMAZON_MUSIC", name: "Amazon Music" },
  { id: "TUNEIN", name: "TuneIn" },
];

export interface FakeAmazonDriver extends AmazonDriver {
  /** Everything each device was asked, by its serial, in order. */
  readonly asked: () => readonly (readonly [string, AmazonAction | { kind: "announce-everywhere"; text: string }])[];
  /** Makes the next call to Amazon fail with `message`, as Amazon refusing it would. */
  readonly refuseNext: (message: string) => void;
  /** Whether it is signed in. */
  readonly signedIn: () => boolean;
}

const notificationsAt = (): AmazonNotification[] => [
  {
    id: "alarm-1",
    type: "alarm",
    label: null,
    on: true,
    at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    remaining: null,
  },
  {
    id: "reminder-1",
    type: "reminder",
    label: "Take the bins out",
    on: true,
    at: new Date(Date.now() + 3_600_000).toISOString(),
    remaining: null,
  },
];

export const fakeAmazonDriver = ({
  signInMs = 300,
  session = "fake-session",
}: { readonly signInMs?: number; readonly session?: string } = {}): FakeAmazonDriver => {
  let signedIn = false;
  let refusal: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked: [string, AmazonAction | { kind: "announce-everywhere"; text: string }][] = [];
  const states = new Map<string, AmazonDeviceState>(
    FAKE_ECHOS.map(({ serial }, index) => [
      serial,
      {
        serial,
        player:
          index === 0
            ? {
                state: "playing",
                title: "Bohemian Rhapsody",
                subtitle: "Queen",
                provider: "Amazon Music",
                artUrl: null,
                progress: 61,
                length: 354,
              }
            : {
                state: "idle",
                title: null,
                subtitle: null,
                provider: null,
                artUrl: null,
                progress: null,
                length: null,
              },
        volume: index === 0 ? 40 : 25,
        doNotDisturb: false,
        equaliser: index === 0 ? { bass: 0, midrange: 0, treble: 0 } : null,
        alarmVolume: 50,
        notifications: index === 0 ? notificationsAt() : [],
        bluetooth: index === 0 ? [{ address: "AA:BB:CC:DD:EE:01", name: "Phone", connected: false }] : [],
      },
    ]),
  );

  const amazon = (): void => {
    if (refusal !== undefined) {
      const message = refusal;
      refusal = undefined;
      throw new AmazonFailure(`Amazon refused: ${message}`);
    }
    if (!signedIn) throw new AmazonFailure("The Hub isn't signed in to Amazon.");
  };
  const stateOf = (serial: string): AmazonDeviceState => {
    const state = states.get(serial);
    if (state === undefined) throw new AmazonFailure("Amazon refused: Unknown Device or Serial number");
    return state;
  };
  const change = (serial: string, next: Partial<AmazonDeviceState>): void => {
    states.set(serial, { ...stateOf(serial), ...next });
  };

  return {
    asked: () => asked,
    refuseNext: (message) => {
      refusal = message;
    },
    signedIn: () => signedIn,

    signIn: ({ host, port, session: kept, onSignInUrl, onSession }) =>
      new Promise((resolve) => {
        clearTimeout(timer);
        const done = (): void => {
          signedIn = true;
          onSession(session);
          resolve();
        };
        if (kept !== undefined) {
          done();
          return;
        }
        onSignInUrl(`http://${host}:${String(port)}/`);
        timer = setTimeout(done, signInMs);
      }),

    signOut: () => {
      clearTimeout(timer);
      signedIn = false;
    },

    devices: () => {
      amazon();
      return Promise.resolve([...FAKE_ECHOS]);
    },
    routines: () => {
      amazon();
      return Promise.resolve([...FAKE_ROUTINES]);
    },
    musicProviders: () => {
      amazon();
      return Promise.resolve([...FAKE_MUSIC_PROVIDERS]);
    },
    state: (serial) => {
      amazon();
      return Promise.resolve(stateOf(serial));
    },

    act: (serial, action) => {
      amazon();
      const state = stateOf(serial);
      asked.push([serial, action]);
      const player = state.player;
      switch (action.kind) {
        case "play":
        case "pause":
          if (player !== null)
            change(serial, { player: { ...player, state: action.kind === "play" ? "playing" : "paused" } });
          break;
        case "volume":
          change(serial, { volume: action.level });
          break;
        case "do-not-disturb":
          change(serial, { doNotDisturb: action.on });
          break;
        case "equaliser":
          change(serial, { equaliser: { bass: action.bass, midrange: action.midrange, treble: action.treble } });
          break;
        case "alarm-volume":
          change(serial, { alarmVolume: action.level });
          break;
        case "notification-on":
          change(serial, {
            notifications: state.notifications.map((each) =>
              each.id === action.id ? { ...each, on: action.on } : each,
            ),
          });
          break;
        case "notification-delete":
          change(serial, { notifications: state.notifications.filter(({ id }) => id !== action.id) });
          break;
        case "bluetooth":
          change(serial, {
            bluetooth: state.bluetooth.map((each) =>
              each.address === action.address ? { ...each, connected: action.connect } : each,
            ),
          });
          break;
        case "music":
          change(serial, {
            player: {
              state: "playing",
              title: action.search,
              subtitle: null,
              provider: FAKE_MUSIC_PROVIDERS.find(({ id }) => id === action.providerId)?.name ?? null,
              artUrl: null,
              progress: 0,
              length: null,
            },
          });
          break;
        default:
          break;
      }
      return Promise.resolve();
    },

    announceEverywhere: (text) => {
      amazon();
      asked.push(["*", { kind: "announce-everywhere", text }]);
      return Promise.resolve();
    },
  };
};
