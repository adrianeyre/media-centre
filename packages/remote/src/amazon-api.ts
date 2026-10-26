import {
  AMAZON_ANNOUNCE_PATH,
  AMAZON_PATH,
  AMAZON_SIGN_IN_PATH,
  amazonDeviceActionsPath,
  amazonDevicePath,
  amazonDeviceRoomPath,
  type AmazonAction,
  type AmazonAnnouncement,
  type AmazonDeviceState,
  type AmazonDomain,
  type AmazonHome,
  type AmazonSignInRequest,
  type NetworkDeviceRoomRequest,
} from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/** The owner's Echo devices, through the Hub's sign-in to Amazon (ADR 0011), for the Amazon tab. */
export interface AmazonApi {
  readonly home: () => Promise<AmazonHome>;
  /** Starts signing in; the status then gives the page to sign in to Amazon on. */
  readonly signIn: (domain: AmazonDomain) => Promise<AmazonHome>;
  readonly signOut: () => Promise<AmazonHome>;
  readonly state: (serial: string) => Promise<AmazonDeviceState>;
  readonly act: (serial: string, action: AmazonAction) => Promise<AmazonDeviceState>;
  /** Announces the text on every Echo that is online. */
  readonly announce: (text: string) => Promise<void>;
  readonly setRoom: (serial: string, roomId: number | null) => Promise<AmazonHome>;
}

/** Talks to the Hub about Amazon. A refusal, Amazon's too, fails with a `HubRequestFailed` giving why. */
export const createAmazonApi = (fetchFn: typeof fetch = fetch): AmazonApi => {
  const request = createHubRequest(fetchFn);
  const answer = async <T>(response: Promise<Response>): Promise<T> => (await (await response).json()) as T;

  return {
    home: () => answer(request("GET", AMAZON_PATH)),
    signIn: (domain) => {
      const body: AmazonSignInRequest = { domain };
      return answer(request("POST", AMAZON_SIGN_IN_PATH, body));
    },
    signOut: () => answer(request("DELETE", AMAZON_SIGN_IN_PATH)),
    state: (serial) => answer(request("GET", amazonDevicePath(serial))),
    act: (serial, action) => answer(request("POST", amazonDeviceActionsPath(serial), action)),
    announce: async (text) => {
      const body: AmazonAnnouncement = { text };
      await request("POST", AMAZON_ANNOUNCE_PATH, body);
    },
    setRoom: (serial, roomId) => {
      const body: NetworkDeviceRoomRequest = { roomId };
      return answer(request("PUT", amazonDeviceRoomPath(serial), body));
    },
  };
};
