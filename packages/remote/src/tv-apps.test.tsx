import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { PowerState } from "@media-centre/shared";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvApps } from "./tv-apps.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

const renderApps = (appliances: FakeAppliancesApi, power: PowerState | undefined = "on", refreshMs = 20) =>
  render(<TvApps appliances={appliances} tv={TV} title="Living room · TV" power={power} refreshMs={refreshMs} />);

const section = () => screen.getByRole("region", { name: "Apps" });

/** The apps listed, as the Remote names them. */
const shownApps = async (): Promise<string[]> => {
  const items = await within(section()).findAllByRole("listitem");
  return items.map((item) => item.getAttribute("aria-label") ?? "");
};

const launch = (name: string) => within(section()).getByRole<HTMLButtonElement>("button", { name: `Launch ${name}` });
const close = (name: string) => within(section()).getByRole<HTMLButtonElement>("button", { name: `Close ${name}` });

describe("the Selected TV's apps (FR-21)", () => {
  it("lists the TV's installed apps by name, in the Hub's order", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances);

    expect(await shownApps()).toEqual(["Internet", "Netflix", "YouTube"]);
    expect(appliances.appsReads.every((id) => id === TV.id)).toBe(true);
  });

  it("shows each app's icon from the Hub where the TV gives one, and its first letter where it doesn't", async () => {
    renderApps(fakeAppliancesApi([TV]));
    await shownApps();

    const icon = launch("YouTube").querySelector("img");
    expect(icon?.getAttribute("src")).toBe("/api/appliances/2/apps/111299001912/icon");
    expect(icon?.getAttribute("alt")).toBe("");
    expect(launch("Internet").querySelector("img")).toBeNull();
    expect(launch("Internet").querySelector(".app-icon-none")?.getAttribute("data-letter")).toBe("I");
  });

  it("shows an app's first letter instead of an icon that doesn't load", async () => {
    renderApps(fakeAppliancesApi([TV]));
    await shownApps();

    const icon = launch("Netflix").querySelector("img");
    if (icon === null) throw new Error("Netflix has an icon");
    fireEvent.error(icon);

    await waitFor(() => {
      expect(launch("Netflix").querySelector("img")).toBeNull();
    });
    expect(launch("Netflix").querySelector(".app-icon-none")?.getAttribute("data-letter")).toBe("N");
  });

  it("launches an app when it is tapped, and says so", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances);
    await shownApps();

    fireEvent.click(launch("YouTube"));

    await waitFor(() => {
      expect(appliances.appsDone).toEqual([{ id: TV.id, appId: "111299001912", what: "launch" }]);
    });
    expect(await within(section()).findByRole("status")).toHaveProperty("textContent", "Launched YouTube.");
  });

  it("closes an app with its Close button, and says so", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances);
    await shownApps();

    fireEvent.click(close("Netflix"));

    await waitFor(() => {
      expect(appliances.appsDone).toEqual([{ id: TV.id, appId: "3201907018807", what: "close" }]);
    });
    await waitFor(() => {
      expect(within(section()).getByRole("status").textContent).toBe("Closed Netflix.");
    });
  });

  it("holds an app's buttons while the Hub launches it, and no other app's", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances);
    await shownApps();
    const release = appliances.holdNextApp();

    fireEvent.click(launch("YouTube"));

    await waitFor(() => {
      expect(launch("YouTube").disabled).toBe(true);
    });
    expect(close("YouTube").disabled).toBe(true);
    expect(launch("Netflix").disabled).toBe(false);
    release();
    await waitFor(() => {
      expect(launch("YouTube").disabled).toBe(false);
    });
  });

  it("says why the Hub couldn't launch an app, and reads the apps again", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances, "on", 60_000);
    await shownApps();
    const reads = appliances.appsReads.length;
    appliances.refuseNextApp("The TV at 192.168.1.22 isn't answering for its apps, as when it is in standby.");
    appliances.setApps(TV.id, { known: false, why: "standby" });

    fireEvent.click(launch("YouTube"));

    expect((await within(section()).findByRole("alert")).textContent).toBe(
      "The TV at 192.168.1.22 isn't answering for its apps, as when it is in standby.",
    );
    await within(section()).findByText("Living room · TV is in standby. Switch it on to see its apps.");
    expect(appliances.appsReads.length).toBeGreaterThan(reads);
    expect(within(section()).getByRole("status").textContent).toBe("");
  });

  it("says a TV in standby is in standby, rather than showing no apps", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setApps(TV.id, { known: false, why: "standby" });
    renderApps(appliances, "standby");

    await within(section()).findByText("Living room · TV is in standby. Switch it on to see its apps.");
    expect(within(section()).queryByRole("list")).toBeNull();
  });

  it("says a TV that isn't answering isn't, rather than showing no apps", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setApps(TV.id, { known: false, why: "unreachable" });
    renderApps(appliances, "unreachable");

    await within(section()).findByText(
      "Living room · TV isn't answering, so its apps can't be listed. Check that it is switched on and on the same network as the Hub.",
    );
    expect(within(section()).queryByRole("list")).toBeNull();
  });

  it("says so when the TV has no apps at all", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setApps(TV.id, { known: true, apps: [] });
    renderApps(appliances);

    await within(section()).findByText("Living room · TV has no apps installed.");
  });

  it("reads the apps again at once when the TV's power state changes", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setApps(TV.id, { known: false, why: "standby" });
    const { rerender } = renderApps(appliances, "standby", 60_000);
    await within(section()).findByText("Living room · TV is in standby. Switch it on to see its apps.");

    appliances.setApps(TV.id, { known: true, apps: [{ id: "a.plex", name: "Plex", icon: false }] });
    rerender(<TvApps appliances={appliances} tv={TV} title="Living room · TV" power="on" refreshMs={60_000} />);

    expect(await shownApps()).toEqual(["Plex"]);
  });

  it("follows the TV's apps as they change, e.g. one installed on it", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances);
    await shownApps();

    appliances.setApps(TV.id, { known: true, apps: [{ id: "a.plex", name: "Plex", icon: true }] });

    await waitFor(async () => {
      expect(await shownApps()).toEqual(["Plex"]);
    });
  });

  it("says why it couldn't read the apps, and keeps those it last read", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderApps(appliances, "on", 60_000);
    await shownApps();
    cleanup();

    const failing = { ...appliances, listApps: () => Promise.reject(new Error("no")) };
    render(<TvApps appliances={failing} tv={TV} title="Living room · TV" power="on" />);

    expect((await within(section()).findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
    expect(within(section()).queryByText("Loading the apps…")).toBeNull();
  });
});
