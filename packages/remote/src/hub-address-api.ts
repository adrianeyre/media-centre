import { HUB_ADDRESS_PATH, type HubAddress, type HubAddressRequest } from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/** The Hub's own IP address on the home network, which a TV is given as its Developer IP (FR-29). */
export interface HubAddressApi {
  /** The address to use, the one the Hub finds, and the one set in Settings, now. */
  readonly read: () => Promise<HubAddress>;
  /** Sets the address to use instead of the one the Hub finds, or with null goes back to that one. */
  readonly setOverride: (override: string | null) => Promise<HubAddress>;
}

/** Talks to the Hub about its address. A refusal fails with a `HubRequestFailed` giving the Hub's reason. */
export const createHubAddressApi = (fetchFn: typeof fetch = fetch): HubAddressApi => {
  const request = createHubRequest(fetchFn);

  return {
    read: async () => (await (await request("GET", HUB_ADDRESS_PATH)).json()) as HubAddress,
    setOverride: async (override) => {
      const body: HubAddressRequest = { override };
      return (await (await request("PUT", HUB_ADDRESS_PATH, body)).json()) as HubAddress;
    },
  };
};
