import { describe, expect, it } from "vitest";

import { LATEST_VERSION_PATH } from "@media-centre/shared";

import { checkLatestVersion, isUpdate } from "./latest-version.ts";

const answering =
  (respond: () => Response): typeof fetch =>
  (input) => {
    expect(input).toBe(LATEST_VERSION_PATH);
    return Promise.resolve(respond());
  };

describe("checking for the latest version", () => {
  it("asks the Hub, which looked it up on GitHub", async () => {
    expect(await checkLatestVersion(answering(() => Response.json({ version: "2.3.4" })))).toEqual({
      kind: "known",
      version: "2.3.4",
    });
  });

  it.each([
    ["the Hub couldn't find out", () => Response.json({ version: null })],
    ["the Hub refuses", () => Response.json({ error: "Not found" }, { status: 404 })],
    ["the Hub answers with something else", () => new Response("<html>")],
    [
      "the Hub can't be reached",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("doesn't know when %s", async (_, respond) => {
    expect(await checkLatestVersion(answering(respond))).toEqual({ kind: "unknown" });
  });

  it("offers an update only for a version that isn't this one", () => {
    expect(isUpdate({ kind: "known", version: "2.0.0" }, "1.0.0")).toBe(true);
    expect(isUpdate({ kind: "known", version: "1.0.0" }, "1.0.0")).toBe(false);
    expect(isUpdate({ kind: "checking" }, "1.0.0")).toBe(false);
    expect(isUpdate({ kind: "unknown" }, "1.0.0")).toBe(false);
  });
});
