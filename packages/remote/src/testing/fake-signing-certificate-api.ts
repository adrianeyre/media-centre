import type { SigningCertificateRequest, SigningCertificateStatus } from "@media-centre/shared";

import { HubRequestFailed } from "../hub-request.ts";
import type { SigningCertificateApi } from "../signing-certificate-api.ts";

export interface FakeSigningCertificateApi extends SigningCertificateApi {
  /** Every certificate the Hub was sent, oldest first. */
  readonly stored: readonly SigningCertificateRequest[];
  /** Makes the next change fail with `message`, as the Hub refusing it would. */
  readonly refuseNext: (message: string) => void;
}

/**
 * The Hub's signing certificate kept in memory, standing in for the Hub,
 * which has none until one is stored. It takes whatever it is sent: the
 * rules are the Hub's, and are tested there.
 */
export const fakeSigningCertificateApi = (
  initially: SigningCertificateStatus = { stored: false, storedAt: null },
): FakeSigningCertificateApi => {
  let status = initially;
  const stored: SigningCertificateRequest[] = [];
  let refusal: string | undefined;

  const refuseIfAsked = (): void => {
    if (refusal === undefined) return;
    const message = refusal;
    refusal = undefined;
    throw new HubRequestFailed(message);
  };

  return {
    stored,
    refuseNext: (message) => {
      refusal = message;
    },
    read: async () => {
      await Promise.resolve();
      return status;
    },
    store: async (certificate) => {
      await Promise.resolve();
      refuseIfAsked();
      stored.push(certificate);
      status = { stored: true, storedAt: "2026-10-21T09:30:00.000Z" };
      return status;
    },
    remove: async () => {
      await Promise.resolve();
      refuseIfAsked();
      status = { stored: false, storedAt: null };
      return status;
    },
  };
};
