import {
  startFakeLeproLight,
  type FakeLeproLight,
  type FakeLightKind,
} from "../packages/hub/src/fakes/lepro-light/fake-lepro-light.ts";

/**
 * The fake Lepro Lights the end-to-end tests start beside the run's Hub,
 * each at its own loopback address, as Lights on the home network would be:
 * a colour bulb, a smart plug and a white bulb, which the Hub finds, and a
 * fourth it can't, which is added by its device id. They share ports off a
 * real Light's, which the run's Hub is told to use, and the Hub searches
 * each found one's own address, as a broadcast can't be relied on here.
 *
 * Each test starts the ones it needs, in the test's own process, so that
 * it can stop one, as a Light switched off at the wall, and start it again
 * with the same id and key, and reads and changes them in the Appliance's
 * terms, as the tests mayn't know the protocol they speak.
 */
export const FAKE_LIGHT_PORT = 16_668;
/** Where each fake answers searches, which the run's Hub sends to each, not broadcast. */
export const FAKE_LIGHT_DISCOVERY_PORT = 16_667;

export const FAKE_LIGHTS = {
  lamp: { host: "127.0.0.8", kind: "colour" },
  plug: { host: "127.0.0.9", kind: "plug" },
  desk: { host: "127.0.0.10", kind: "white" },
} as const satisfies Record<string, { readonly host: string; readonly kind: FakeLightKind }>;

/** A white bulb the run's Hub doesn't search, so that it can only be added by its address and device id. */
export const HIDDEN_FAKE_LIGHT = { host: "127.0.0.11", kind: "white" } as const;

export type FakeLightName = keyof typeof FAKE_LIGHTS | "hidden";

const placeOf = (name: FakeLightName) => (name === "hidden" ? HIDDEN_FAKE_LIGHT : FAKE_LIGHTS[name]);

/** Ids and keys made up for the run, once for each Light, so that one started again is the same Light. */
const keys = new Map<FakeLightName, { readonly id: string; readonly key: string }>();

/** Starts the fake Light, with the id and key it had before if it ran before. */
export const startFakeLight = async (name: FakeLightName): Promise<FakeLeproLight> => {
  const { host, kind } = placeOf(name);
  const light = await startFakeLeproLight({
    host,
    port: FAKE_LIGHT_PORT,
    // The hidden one answers no search where the Hub sends them.
    discoveryPort: name === "hidden" ? 0 : FAKE_LIGHT_DISCOVERY_PORT,
    kind,
    ...keys.get(name),
  });
  keys.set(name, { id: light.id, key: light.key });
  return light;
};

/** The run's Hub's `LEPRO_SEARCH_TARGETS`: the found fakes' own addresses. */
export const FAKE_LIGHT_SEARCH_TARGETS = Object.values(FAKE_LIGHTS)
  .map(({ host }) => `${host}:${String(FAKE_LIGHT_DISCOVERY_PORT)}`)
  .join(",");
