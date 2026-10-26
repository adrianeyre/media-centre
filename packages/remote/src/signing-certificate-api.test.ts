import { describe, expect, it } from "vitest";

import { SIGNING_CERTIFICATE_PATH } from "@media-centre/shared";

import { HubRequestFailed } from "./hub-request.ts";
import { createSigningCertificateApi } from "./signing-certificate-api.ts";

const hubAnswering = (response: () => Response) => {
  const sent: { path: string; method: string | undefined; body: unknown }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    sent.push({
      path: input instanceof Request ? input.url : input.toString(),
      method: init?.method,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(response());
  };
  return { sent, fetchFn };
};

describe("the Remote's client for the signing certificate", () => {
  it("reads whether the Hub has one, stores one and removes it", async () => {
    const status = { stored: true, storedAt: "2026-10-21T09:30:00.000Z" };
    const { sent, fetchFn } = hubAnswering(() => Response.json(status));
    const api = createSigningCertificateApi(fetchFn);
    const certificate = { author: "MIIB", authorPassword: "pass", distributor: "MIIC", distributorPassword: null };

    expect(await api.read()).toEqual(status);
    expect(await api.store(certificate)).toEqual(status);
    expect(await api.remove()).toEqual(status);

    expect(sent).toEqual([
      { path: SIGNING_CERTIFICATE_PATH, method: "GET", body: undefined },
      { path: SIGNING_CERTIFICATE_PATH, method: "PUT", body: certificate },
      { path: SIGNING_CERTIFICATE_PATH, method: "DELETE", body: undefined },
    ]);
  });

  it("fails with the Hub's reason when it refuses", async () => {
    const { fetchFn } = hubAnswering(() =>
      Response.json({ error: "Give the author certificate's password." }, { status: 400 }),
    );

    await expect(
      createSigningCertificateApi(fetchFn).store({ author: "MIIB", authorPassword: "", distributor: "MIIC" }),
    ).rejects.toEqual(new HubRequestFailed("Give the author certificate's password."));
  });
});
