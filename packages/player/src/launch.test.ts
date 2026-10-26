import { describe, expect, it } from "vitest";

import { playerLaunchParameter } from "@media-centre/shared";

import { hubAddressIn } from "./hub-address.ts";
import { appControlData, launchedHubAddress } from "./launch.ts";
import type { AppControlData, Tizen } from "./tizen.ts";

const deepLink = (values: string): AppControlData => ({ key: "PAYLOAD", value: [JSON.stringify({ values })] });

const tizenWith = (data: readonly AppControlData[] | null): Tizen => ({
  application: {
    getCurrentApplication: () => ({
      getRequestedAppControl: () => (data === null ? null : { appControl: { data } }),
    }),
  },
});

describe("the Hub's address the Player was launched with", () => {
  it("is in the deep link the Hub launches it with", () => {
    expect(launchedHubAddress([deepLink(playerLaunchParameter("192.168.1.10:8080"))], "")).toBe("192.168.1.10:8080");
  });

  it("is in a launch data entry of its own", () => {
    expect(launchedHubAddress([{ key: "hub", value: ["192.168.1.10:8080"] }], "")).toBe("192.168.1.10:8080");
  });

  it("is in the page's query in a desktop browser", () => {
    expect(launchedHubAddress([], "?hub=127.0.0.1%3A8080")).toBe("127.0.0.1:8080");
  });

  it.each([
    ["no launch data", [], ""],
    ["a deep link that isn't JSON", [{ key: "PAYLOAD", value: ["{"] }], ""],
    ["a deep link without the Hub", [deepLink("film=1")], ""],
    ["a deep link with no values", [{ key: "PAYLOAD", value: [] }], ""],
    ["an address that isn't one", [deepLink("hub=192.168.1.10:8080/../../evil")], "?hub=javascript:alert(1)"],
  ] satisfies [string, AppControlData[], string][])("is none with %s", (_, data, search) => {
    expect(launchedHubAddress(data, search)).toBeNull();
  });

  it("is read from Tizen's own launch data, and is none in a desktop browser or when Tizen has none", () => {
    const data = [deepLink(playerLaunchParameter("192.168.1.10:8080"))];

    expect(appControlData(tizenWith(data))).toEqual(data);
    expect(appControlData(tizenWith(null))).toEqual([]);
    expect(appControlData(undefined)).toEqual([]);
    expect(
      appControlData({
        application: {
          getCurrentApplication: () => {
            throw new Error("Not a Tizen app");
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("a Hub's address", () => {
  it.each(["192.168.1.10:8080", "192.168.1.10", "nas.local:8080", "media-centre:80", " 10.0.0.2:8080 "])(
    "may be %j",
    (address) => {
      expect(hubAddressIn(address)).toBe(address.trim());
    },
  );

  it.each([
    "",
    "192.168.1.256:8080",
    "192.168.1.10:0",
    "192.168.1.10:65536",
    "http://localhost:8080",
    "192.168.1.10:8080/api",
    "user@192.168.1.10",
    "-nas.local",
    "[::1]:8080",
  ])("may not be %j", (address) => {
    expect(hubAddressIn(address)).toBeNull();
  });
});
