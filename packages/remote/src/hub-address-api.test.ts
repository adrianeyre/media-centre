import { describe, expect, it } from "vitest";

import { HUB_ADDRESS_PATH } from "@media-centre/shared";

import { createHubAddressApi } from "./hub-address-api.ts";
import { HubRequestFailed } from "./hub-request.ts";

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

describe("the Remote's client for the Hub's address", () => {
  it("reads it, sets it and clears it", async () => {
    const address = { address: "10.0.0.2", found: "192.168.1.5", override: "10.0.0.2" };
    const { sent, fetchFn } = hubAnswering(() => Response.json(address));
    const api = createHubAddressApi(fetchFn);

    expect(await api.read()).toEqual(address);
    expect(await api.setOverride("10.0.0.2")).toEqual(address);
    await api.setOverride(null);

    expect(sent).toEqual([
      { path: HUB_ADDRESS_PATH, method: "GET", body: undefined },
      { path: HUB_ADDRESS_PATH, method: "PUT", body: { override: "10.0.0.2" } },
      { path: HUB_ADDRESS_PATH, method: "PUT", body: { override: null } },
    ]);
  });

  it("fails with the Hub's reason when it refuses", async () => {
    const { fetchFn } = hubAnswering(() =>
      Response.json({ error: "Give the Hub's IP address as four numbers with dots." }, { status: 400 }),
    );

    await expect(createHubAddressApi(fetchFn).setOverride("hub.local")).rejects.toEqual(
      new HubRequestFailed("Give the Hub's IP address as four numbers with dots."),
    );
  });
});
