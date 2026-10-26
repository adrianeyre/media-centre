import type { HubAddress } from "@media-centre/shared";

import type { HubAddressApi } from "../hub-address-api.ts";
import { HubRequestFailed } from "../hub-request.ts";

export interface FakeHubAddressApi extends HubAddressApi {
  /** Has the Hub find this address from now on, or none, as another network would give it. */
  readonly setFound: (found: string | null) => void;
  /** Makes the next change fail with `message`, as the Hub refusing it would. */
  readonly refuseNext: (message: string) => void;
  /** Makes the next read fail with `message`, as a Hub that can't be reached would. */
  readonly failNextRead: (message: string) => void;
  /** How many times the address was read. */
  readonly reads: () => number;
}

/**
 * The Hub's address kept in memory, standing in for the Hub, which finds
 * `found` until told otherwise. It sets whatever it is asked to: the rules
 * are the Hub's, and are tested there.
 */
export const fakeHubAddressApi = (found: string | null = "192.168.1.5"): FakeHubAddressApi => {
  let current: { found: string | null; override: string | null } = { found, override: null };
  let refusal: string | undefined;
  let readFailure: string | undefined;
  let reads = 0;

  const answer = (): HubAddress => ({ address: current.override ?? current.found, ...current });

  return {
    setFound: (next) => {
      current = { ...current, found: next };
    },
    refuseNext: (message) => {
      refusal = message;
    },
    failNextRead: (message) => {
      readFailure = message;
    },
    reads: () => reads,
    read: async () => {
      reads += 1;
      await Promise.resolve();
      if (readFailure !== undefined) {
        const message = readFailure;
        readFailure = undefined;
        throw new HubRequestFailed(message);
      }
      return answer();
    },
    setOverride: async (override) => {
      await Promise.resolve();
      if (refusal !== undefined) {
        const message = refusal;
        refusal = undefined;
        throw new HubRequestFailed(message);
      }
      current = { ...current, override: override === null || override.trim() === "" ? null : override.trim() };
      return answer();
    },
  };
};
