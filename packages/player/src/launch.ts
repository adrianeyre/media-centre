import { PLAYER_LAUNCH_HUB_KEY } from "@media-centre/shared";

import { hubAddressIn } from "./hub-address.ts";
import type { AppControlData, Tizen } from "./tizen.ts";

/**
 * The key a Samsung TV gives a web app's deep link data under, as JSON whose
 * `values` is the data the app was launched with.
 */
const DEEP_LINK_KEY = "PAYLOAD";

/** The data the Player was launched with on a TV, or none in a desktop browser or when the TV gives none. */
export const appControlData = (tizen: Tizen | undefined): readonly AppControlData[] => {
  try {
    return tizen?.application.getCurrentApplication().getRequestedAppControl()?.appControl.data ?? [];
  } catch {
    return [];
  }
};

/** `hub=<address>`, as `playerLaunchParameter` in `shared` writes it, or null. */
const fromParameter = (parameter: string): string | null => {
  try {
    return new URLSearchParams(parameter).get(PLAYER_LAUNCH_HUB_KEY);
  } catch {
    return null;
  }
};

/** The `values` of a TV's deep link data, or null. */
const fromDeepLink = (payload: string | undefined): string | null => {
  try {
    const { values } = JSON.parse(payload ?? "") as { values?: unknown };
    return typeof values === "string" ? fromParameter(values) : null;
  } catch {
    return null;
  }
};

/**
 * The Hub's address the Player was launched with (FR-35), or null when it was
 * launched without one, e.g. from the TV's own app list. On a TV it is in the
 * launch data: the Hub's deep link, or a `hub` entry of its own. In a desktop
 * browser, it is the page's `?hub=` query.
 */
export const launchedHubAddress = (data: readonly AppControlData[], search: string): string | null => {
  for (const { key, value } of data) {
    const given = key === DEEP_LINK_KEY ? fromDeepLink(value[0]) : key === PLAYER_LAUNCH_HUB_KEY ? value[0] : null;
    const address = hubAddressIn(given);
    if (address !== null) return address;
  }
  return hubAddressIn(fromParameter(search));
};
