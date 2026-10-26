import {
  SIGNING_CERTIFICATE_PATH,
  type SigningCertificateRequest,
  type SigningCertificateStatus,
} from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/**
 * The owner's signing certificate, which the Hub signs the Player with to
 * install it on a TV (FR-31). The Remote only ever sends it; the Hub never
 * sends it, nor its passwords, back (FR-4).
 */
export interface SigningCertificateApi {
  /** Whether the Hub has one, and since when. */
  readonly read: () => Promise<SigningCertificateStatus>;
  /** Has the Hub keep this one, in place of any it had. */
  readonly store: (certificate: SigningCertificateRequest) => Promise<SigningCertificateStatus>;
  /** Has the Hub forget the one it has. */
  readonly remove: () => Promise<SigningCertificateStatus>;
}

/** Talks to the Hub about the signing certificate. A refusal fails with a `HubRequestFailed` giving the Hub's reason. */
export const createSigningCertificateApi = (fetchFn: typeof fetch = fetch): SigningCertificateApi => {
  const request = createHubRequest(fetchFn);
  const status = async (response: Promise<Response>): Promise<SigningCertificateStatus> =>
    (await (await response).json()) as SigningCertificateStatus;

  return {
    read: () => status(request("GET", SIGNING_CERTIFICATE_PATH)),
    store: (certificate) => status(request("PUT", SIGNING_CERTIFICATE_PATH, certificate)),
    remove: () => status(request("DELETE", SIGNING_CERTIFICATE_PATH)),
  };
};
