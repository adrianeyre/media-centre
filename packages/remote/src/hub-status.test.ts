import { describe, expect, it } from "vitest";

import { HUB_INFO_PATH } from "@media-centre/shared";

import { checkHub, describeHubStatus } from "./hub-status.ts";

const answering =
  (response: Response): typeof fetch =>
  (input) => {
    expect(input).toBe(HUB_INFO_PATH);
    return Promise.resolve(response);
  };

describe("checkHub", () => {
  it("says it is connecting while it waits for the Hub", () => {
    expect(describeHubStatus({ kind: "checking" })).toBe("Connecting to the Hub…");
  });

  it("is connected when the Hub says who it is", async () => {
    const info = { product: "media-centre", version: "1.2.3", hubId: "abc" };
    const status = await checkHub(answering(Response.json(info)));

    expect(status).toEqual({ kind: "connected", info });
    expect(describeHubStatus(status)).toBe("Connected to the Hub");
  });

  it("is unreachable when the request fails", async () => {
    const status = await checkHub(() => Promise.reject(new TypeError("fetch failed")));

    expect(status).toEqual({ kind: "unreachable" });
    expect(describeHubStatus(status)).toBe("Can't reach the Hub");
  });

  it("is unreachable when the Hub answers with an error", async () => {
    expect(await checkHub(answering(new Response("oops", { status: 502 })))).toEqual({ kind: "unreachable" });
  });

  it("is unreachable when the answer is not the Hub's", async () => {
    expect(await checkHub(answering(Response.json({ product: "something-else", version: "1", hubId: "a" })))).toEqual({
      kind: "unreachable",
    });
    expect(await checkHub(answering(Response.json({ product: "media-centre", version: "1" })))).toEqual({
      kind: "unreachable",
    });
    expect(await checkHub(answering(new Response("<html>")))).toEqual({ kind: "unreachable" });
  });
});
