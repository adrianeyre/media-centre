/* eslint-disable media-centre/no-internet-urls -- GitHub's addresses are what is under test, and nothing is fetched from them */
import { describe, expect, it } from "vitest";

import { latestPackageJsonUrl, latestVersionFrom } from "./latest-version.ts";

const URL_ = "http://github.test/package.json";

/** A fetch that answers each request with the next of `answers`, counting them. */
const answering = (...answers: (() => Response)[]) => {
  const fetchFn = ((input: Parameters<typeof fetch>[0]) => {
    expect(input).toBe(URL_);
    fetchFn.calls += 1;
    const answer = answers.shift();
    if (answer === undefined) throw new Error("Asked once too often");
    return Promise.resolve(answer());
  }) as typeof fetch & { calls: number };
  fetchFn.calls = 0;
  return fetchFn;
};

describe("the latest version of media-centre", () => {
  it("is read from the package.json on GitHub's main, for the repository in media-centre's own", () => {
    expect(latestPackageJsonUrl("git+https://github.com/adrianeyre/media-centre.git")).toBe(
      "https://raw.githubusercontent.com/adrianeyre/media-centre/main/package.json",
    );
    expect(latestPackageJsonUrl("https://github.com/adrianeyre/media-centre")).toBe(
      "https://raw.githubusercontent.com/adrianeyre/media-centre/main/package.json",
    );
  });

  it("is the version in that package.json, kept for an hour", async () => {
    let now = 0;
    const fetchFn = answering(
      () => Response.json({ name: "media-centre", version: "1.2.0" }),
      () => Response.json({ name: "media-centre", version: "1.3.0" }),
    );
    const latest = latestVersionFrom(URL_, { fetchFn, now: () => now });

    expect(await latest()).toBe("1.2.0");
    now = 59 * 60 * 1000;
    expect(await latest()).toBe("1.2.0");
    expect(fetchFn.calls).toBe(1);
    now = 60 * 60 * 1000;
    expect(await latest()).toBe("1.3.0");
    expect(fetchFn.calls).toBe(2);
  });

  it.each([
    ["GitHub refuses", () => new Response("404: Not Found", { status: 404 })],
    ["the file isn't JSON", () => new Response("<html>")],
    ["the file has no version", () => Response.json({ name: "media-centre" })],
    [
      "the internet is disconnected",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("isn't known when %s, and is asked for again next time", async (_, failure) => {
    const fetchFn = answering(failure, () => Response.json({ version: "1.2.0" }));
    const latest = latestVersionFrom(URL_, { fetchFn });

    expect(await latest()).toBeUndefined();
    expect(await latest()).toBe("1.2.0");
  });
});
