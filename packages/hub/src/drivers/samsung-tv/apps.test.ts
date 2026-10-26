import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeAppIcon } from "../../fakes/samsung-tv/icons.ts";
import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { imageTypeOf } from "../images.ts";
import { installedAppsIn, type SamsungAppStatus } from "./applications.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";

let tv: FakeSamsungTv;
let driver: Driver;
let token: string;

beforeEach(async () => {
  tv = await startFakeSamsungTv();
  driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort, appsTimeoutMs: 1_000 });
  token = await driver.pair(tv.host);
});

afterEach(async () => {
  driver.disconnect?.(tv.host);
  await tv.stop();
});

const listApps = (credentials = token) => {
  if (driver.listApps === undefined) throw new Error("The Samsung TV Driver lists apps");
  return driver.listApps(tv.host, credentials);
};

const readAppIcon = (appId: string, credentials = token) => {
  if (driver.readAppIcon === undefined) throw new Error("The Samsung TV Driver reads app icons");
  return driver.readAppIcon(tv.host, credentials, appId);
};

const launchApp = (appId: string) => {
  if (driver.launchApp === undefined) throw new Error("The Samsung TV Driver launches apps");
  return driver.launchApp(tv.host, appId);
};

const closeApp = (appId: string) => {
  if (driver.closeApp === undefined) throw new Error("The Samsung TV Driver closes apps");
  return driver.closeApp(tv.host, appId);
};

/** What the TV's own app status says about the app. */
const statusOf = async (appId: string): Promise<Pick<SamsungAppStatus, "running" | "visible">> => {
  const response = await fetch(`http://${tv.host}:${String(tv.restPort)}/api/v2/applications/${appId}`);
  const { running, visible } = (await response.json()) as SamsungAppStatus;
  return { running, visible };
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

/** The connections the TV let the Driver in on with its token. */
const keptSockets = () => tv.connections.filter(({ outcome }) => outcome === "accepted");

describe("the Samsung TV Driver's apps, against the fake Samsung TV (FR-21)", () => {
  it("lists the TV's installed apps, with their names, and whether the TV gives an icon for each", async () => {
    expect(await listApps()).toEqual({
      accepted: true,
      credentials: token,
      apps: [
        { id: "111299001912", name: "YouTube", icon: true },
        { id: "3201907018807", name: "Netflix", icon: true },
        { id: "3201910019365", name: "Prime Video", icon: true },
        { id: "org.tizen.browser", name: "Internet", icon: false },
      ],
    });
  });

  it("lists them on the control socket that keys are sent on, kept open, and they don't hold up keys", async () => {
    await Promise.all([listApps(), driver.pressKey?.(tv.host, token, "ok"), listApps()]);

    await expect.poll(() => tv.keys.length).toBe(1);
    expect(keptSockets()).toHaveLength(1);
  });

  it("lists the apps as the TV has them now", async () => {
    await listApps();
    tv.setApps([{ id: "a.plex", name: "  Plex  " }]);

    expect(await listApps()).toMatchObject({ apps: [{ id: "a.plex", name: "Plex", icon: true }] });
  });

  it("reads each app's icon as the image the TV gives, once, and none for an app the TV gives none for", async () => {
    await listApps();
    const asked = (): number =>
      keptSockets()
        .flatMap(({ messages }) => messages)
        .filter((message) => message.includes("ed.apps.icon")).length;

    const [youTube, netflix] = await Promise.all([readAppIcon("111299001912"), readAppIcon("3201907018807")]);

    expect(youTube).toEqual({
      accepted: true,
      credentials: token,
      icon: { type: "image/png", bytes: fakeAppIcon("111299001912") },
    });
    expect(netflix).toMatchObject({ icon: { type: "image/png", bytes: fakeAppIcon("3201907018807") } });
    expect(asked()).toBe(2);

    await readAppIcon("111299001912");
    expect(asked()).toBe(2);

    expect(await readAppIcon("org.tizen.browser")).toEqual({ accepted: true, credentials: token, icon: undefined });
    expect(await readAppIcon("not.installed")).toEqual({ accepted: true, credentials: token, icon: undefined });
    expect(asked()).toBe(2);
  });

  it("lists the apps first to find an icon, when they haven't been", async () => {
    expect(await readAppIcon("3201910019365")).toMatchObject({ icon: { bytes: fakeAppIcon("3201910019365") } });
  });

  it("launches an app, which the TV then says is running and visible", async () => {
    await launchApp("111299001912");

    expect(await statusOf("111299001912")).toEqual({ running: true, visible: true });
    expect(await statusOf("3201907018807")).toEqual({ running: false, visible: false });
  });

  it("closes an app, which the TV then says is no longer running", async () => {
    await launchApp("111299001912");

    await closeApp("111299001912");

    expect(await statusOf("111299001912")).toEqual({ running: false, visible: false });
  });

  it("launches and closes apps without pairing, as the TV's REST API needs none", async () => {
    const connections = tv.connections.length;

    await launchApp("org.tizen.browser");
    await closeApp("org.tizen.browser");

    expect(tv.connections).toHaveLength(connections);
  });

  it("says the TV has no such app, for one it hasn't got", async () => {
    for (const work of [launchApp("no.such.app"), closeApp("no.such.app")]) {
      const error = await failure(work);
      expect(error.reason).toBe("not-supported");
      expect(error.message).toBe("The TV has no such app.");
    }
  });

  it("says a TV in standby isn't answering for its apps, and launches nothing", async () => {
    tv.setPowerState("standby");

    const error = await failure(launchApp("111299001912"));

    expect(error.reason).toBe("unreachable");
    expect(error.message).toBe("The TV at 127.0.0.1 isn't answering for its apps, as when it is in standby.");
    expect(tv.apps().some(({ running }) => running)).toBe(false);
  });

  it("says the TV didn't answer when it lets the Hub in but doesn't list its apps, as in standby", async () => {
    tv.setPowerState("standby");

    const error = await failure(listApps());

    expect(error.reason).toBe("timed-out");
    expect(error.message).not.toContain(token);
  });

  it("lists the apps on a socket opened afresh when the TV has closed the one kept open", async () => {
    await listApps();

    await tv.dropConnections();

    expect(await listApps()).toMatchObject({ accepted: true });
    expect(keptSockets()).toHaveLength(2);
  });

  it("reports a token the TV refuses once access is revoked on it", async () => {
    await listApps();
    tv.revokeAccess();
    await tv.dropConnections();

    expect(await listApps()).toEqual({ accepted: false });
    driver.disconnect?.(tv.host);
    expect(await readAppIcon("111299001912")).toEqual({ accepted: false });
  });

  it("says no TV answered when nothing is listening at the address, without quoting the token", async () => {
    const nowhere = samsungTvDriver({ restPort: await freePort(), controlPort: await freePort() });

    for (const work of [
      nowhere.listApps?.("127.0.0.1", token),
      nowhere.readAppIcon?.("127.0.0.1", token, "111299001912"),
      nowhere.launchApp?.("127.0.0.1", "111299001912"),
      nowhere.closeApp?.("127.0.0.1", "111299001912"),
    ]) {
      const error = await failure(work ?? Promise.resolve());
      expect(error.reason).toBe("unreachable");
      expect(error.message).not.toContain(token);
    }
  });
});

describe("reading a TV's list of apps", () => {
  it("leaves out an app without an id or a name, and lists each app once", () => {
    expect(
      installedAppsIn({
        data: [
          { appId: "a.one", name: "One", icon: "/one.png" },
          { appId: "a.one", name: "One again", icon: "" },
          { appId: "", name: "No id" },
          { appId: "a.blank", name: "   " },
          { name: "No id at all" },
          "not an app",
          null,
          { appId: "a.two", name: "Two" },
        ],
      }),
    ).toEqual([
      { id: "a.one", name: "One", iconPath: "/one.png" },
      { id: "a.two", name: "Two", iconPath: undefined },
    ]);
  });

  it.each([undefined, null, "apps", {}, { data: "apps" }])("reads %j as no list at all", (data) => {
    expect(installedAppsIn(data)).toBeUndefined();
  });
});

describe("an image's type, from its first bytes", () => {
  it.each([
    [fakeAppIcon("x"), "image/png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [Buffer.from("GIF89a", "latin1"), "image/gif"],
    [Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), "image/webp"],
    [Buffer.from("<svg onload=alert(1)>", "latin1"), undefined],
    [Buffer.from("RIFF\0\0\0\0WAVE", "latin1"), undefined],
    [Buffer.alloc(0), undefined],
  ])("is known only for an image the Hub may pass on (%#)", (bytes, type) => {
    expect(imageTypeOf(bytes)).toBe(type);
  });
});
