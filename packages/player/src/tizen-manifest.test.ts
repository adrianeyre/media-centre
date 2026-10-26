import { describe, expect, it } from "vitest";

import { PLAYER_APP_ID } from "@media-centre/shared";

import { INPUT_DEVICE_PRIVILEGE, INTERNET_PRIVILEGE, tizenManifest } from "./tizen-manifest.ts";

const parse = (xml: string): Document => new DOMParser().parseFromString(xml, "application/xml");

describe("the Player's Tizen manifest", () => {
  const manifest = parse(tizenManifest("1.2.3"));
  const application = manifest.getElementsByTagName("tizen:application")[0];

  it("declares the app id the Hub launches the Player by, from shared", () => {
    expect(application?.getAttribute("id")).toBe(PLAYER_APP_ID);
    expect(PLAYER_APP_ID).toMatch(/^[A-Za-z0-9]{10}\.[A-Za-z0-9]{1,52}$/);
    expect(application?.getAttribute("package")).toBe(PLAYER_APP_ID.split(".")[0]);
  });

  it("installs on Samsung TVs with Tizen 4, the 2018 ones, or later", () => {
    expect(application?.getAttribute("required_version")).toBe("4.0");
    expect(manifest.getElementsByTagName("tizen:profile")[0]?.getAttribute("name")).toBe("tv-samsung");
  });

  it("is the Player's version, and opens its page", () => {
    expect(manifest.documentElement.getAttribute("version")).toBe("1.2.3");
    expect(manifest.getElementsByTagName("content")[0]?.getAttribute("src")).toBe("index.html");
  });

  it("may reach the Hub at any address on the home network", () => {
    const privileges = [...manifest.getElementsByTagName("tizen:privilege")].map((p) => p.getAttribute("name"));
    expect(privileges).toContain(INTERNET_PRIVILEGE);
    expect(manifest.getElementsByTagName("access")[0]?.getAttribute("origin")).toBe("*");
  });

  it("may register the media keys of the TV's own remote (FR-37)", () => {
    const privileges = [...manifest.getElementsByTagName("tizen:privilege")].map((p) => p.getAttribute("name"));
    expect(privileges).toContain(INPUT_DEVICE_PRIVILEGE);
  });
});
