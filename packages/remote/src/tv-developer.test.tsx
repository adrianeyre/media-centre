import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { PowerState } from "@media-centre/shared";

import { aTv, aTvDeviceInfo, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeHubAddressApi, type FakeHubAddressApi } from "./testing/fake-hub-address-api.ts";
import { TvDeveloper } from "./tv-developer.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

/** What the TV reports unless told otherwise: Developer Mode off, with no Developer IP. */
const { info: REPORTED } = aTvDeviceInfo(TV);

const renderSection = (
  appliances: FakeAppliancesApi,
  {
    hubAddress = fakeHubAddressApi(),
    power = "on",
    refreshMs = 20,
  }: { hubAddress?: FakeHubAddressApi; power?: PowerState | undefined; refreshMs?: number } = {},
) => {
  let openedSettings = 0;
  const rendered = render(
    <TvDeveloper
      appliances={appliances}
      hubAddress={hubAddress}
      tv={TV}
      title="Living room · TV"
      power={power}
      onOpenSettings={() => {
        openedSettings += 1;
      }}
      refreshMs={refreshMs}
    />,
  );
  return { ...rendered, openedSettings: () => openedSettings };
};

const section = () => screen.getByRole("region", { name: "Developer" });
const toggle = () => within(section()).getByRole("button", { name: "Developer" });
const open = () => {
  fireEvent.click(toggle());
};

/** The device info shown, as label and value. */
const deviceInfoShown = (): [string, string][] =>
  [...section().querySelectorAll(".device-info dt")].map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent ?? "",
  ]);

/** The steps to switch Developer Mode on, as the person reads them. */
const steps = () =>
  within(section())
    .getAllByRole("listitem")
    .map((step) => step.textContent);

describe("the Selected TV's Developer section (FR-28, FR-29)", () => {
  it("is closed, and asks nothing of the TV, until it is opened", async () => {
    const appliances = fakeAppliancesApi([TV]);
    const hubAddress = fakeHubAddressApi();
    renderSection(appliances, { hubAddress });

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(section().querySelector("#tv-developer-body")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(appliances.deviceInfoReads).toEqual([]);
    expect(hubAddress.reads()).toBe(0);

    open();

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-controls")).toBe("tv-developer-body");
    await waitFor(() => {
      expect(deviceInfoShown()).not.toEqual([]);
    });
  });

  it("shows each field of the TV's device info, with Developer Mode and the Developer IP it reports", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setDeviceInfo(TV.id, {
      known: true,
      info: {
        name: "[TV] Samsung Q60 Series (55)",
        model: "QE55Q60TAUXXU",
        macAddress: "02:00:00:00:00:02",
        networkType: "wireless",
        frame: false,
        developer: { mode: "on", ip: "192.168.1.5" },
      },
    });
    renderSection(appliances);
    open();

    await waitFor(() => {
      expect(deviceInfoShown()).toEqual([
        ["Model", "QE55Q60TAUXXU"],
        ["Name", "[TV] Samsung Q60 Series (55)"],
        ["MAC address", "02:00:00:00:00:02"],
        ["Network", "Wi-Fi"],
        ["Frame TV", "No"],
        ["Developer Mode", "On"],
        ["Developer IP", "192.168.1.5"],
      ]);
    });
    expect(within(section()).queryByText(/doesn't report/)).toBeNull();
    expect(appliances.deviceInfoReads.every((id) => id === TV.id)).toBe(true);
  });

  it("shows a Frame TV on a cable, with Developer Mode off and no Developer IP set, and a network type it isn't told", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setDeviceInfo(TV.id, { known: true, info: { ...REPORTED, networkType: "wired", frame: true } });
    renderSection(appliances);
    open();

    await waitFor(() => {
      expect(deviceInfoShown()).toEqual(
        expect.arrayContaining([
          ["Network", "Wired"],
          ["Frame TV", "Yes"],
          ["Developer Mode", "Off"],
          ["Developer IP", "None set"],
        ]),
      );
    });

    appliances.setDeviceInfo(TV.id, { known: true, info: { ...REPORTED, networkType: null } });
    await waitFor(() => {
      expect(deviceInfoShown()).toContainEqual(["Network", "Not reported"]);
    });
  });

  it("says the TV doesn't report Developer Mode and the Developer IP when it doesn't, still showing the rest", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setDeviceInfo(TV.id, { known: true, info: { ...REPORTED, developer: null } });
    renderSection(appliances);
    open();

    await waitFor(() => {
      expect(
        within(section()).getByText(
          "Living room · TV doesn't report whether Developer Mode is on, nor its Developer IP.",
        ),
      ).toBeTruthy();
    });
    expect(deviceInfoShown().map(([label]) => label)).toEqual(["Model", "Name", "MAC address", "Network", "Frame TV"]);
  });

  it("follows the TV as Developer Mode is switched on at it, without being opened again", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderSection(appliances);
    open();
    await waitFor(() => {
      expect(deviceInfoShown()).toContainEqual(["Developer Mode", "Off"]);
    });

    appliances.setDeviceInfo(TV.id, {
      known: true,
      info: { ...REPORTED, developer: { mode: "on", ip: "192.168.1.5" } },
    });

    await waitFor(() => {
      expect(deviceInfoShown()).toContainEqual(["Developer IP", "192.168.1.5"]);
    });
  });

  it("says a TV that isn't answering can't be read, and still shows the steps", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setDeviceInfo(TV.id, { known: false, why: "unreachable" });
    renderSection(appliances);
    open();

    await waitFor(() => {
      expect(
        within(section()).getByText("Living room · TV isn't answering, so its device info can't be read."),
      ).toBeTruthy();
    });
    expect(deviceInfoShown()).toEqual([]);
    expect(steps()).toHaveLength(6);
  });

  it("says why when the Hub can't be asked, showing none of what it last read", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderSection(appliances);
    open();
    await waitFor(() => {
      expect(deviceInfoShown()).not.toEqual([]);
    });

    appliances.remove(TV.id).catch(() => undefined);

    await waitFor(() => {
      expect(within(section()).getByRole("alert").textContent).toBe("That Appliance has been removed.");
    });
    expect(deviceInfoShown()).toEqual([]);
  });

  it("gives the steps to switch Developer Mode on with the TV's physical remote, with the Hub's IP as the Developer IP", async () => {
    renderSection(fakeAppliancesApi([TV]), { hubAddress: fakeHubAddressApi("192.168.1.5") });
    open();

    await waitFor(() => {
      expect(within(section()).getByText("192.168.1.5").className).toBe("hub-ip");
    });
    expect(within(section()).getByRole("heading", { name: "Turn on Developer Mode" })).toBeTruthy();
    expect(section().textContent).toContain(
      "Samsung only lets it be switched on at the TV itself, with the TV's physical remote",
    );
    expect(steps()).toEqual([
      "Press Home on the physical remote, and open Apps.",
      "In Apps, press 1 2 3 4 5 on the physical remote's number keys, or on the number pad the TV shows if the remote has none. The Developer Mode window opens.",
      "Switch Developer mode to On.",
      "Where it asks for an IP address, enter the Hub's IP, 192.168.1.5, then choose OK.",
      "Restart the TV: hold the physical remote's power button until the TV switches off and on again.",
      "Once it is back on, Developer Mode is on, with the Hub's IP as its Developer IP.",
    ]);
  });

  it("gives the IP address set for the Hub in Settings, following it as it changes", async () => {
    const hubAddress = fakeHubAddressApi("192.168.1.5");
    await hubAddress.setOverride("10.0.0.2");
    renderSection(fakeAppliancesApi([TV]), { hubAddress });
    open();

    await waitFor(() => {
      expect(steps()[3]).toBe("Where it asks for an IP address, enter the Hub's IP, 10.0.0.2, then choose OK.");
    });

    await hubAddress.setOverride(null);
    await waitFor(() => {
      expect(steps()[3]).toBe("Where it asks for an IP address, enter the Hub's IP, 192.168.1.5, then choose OK.");
    });
  });

  it("says to set the Hub's IP in Settings when the Hub couldn't find it, and opens Settings", async () => {
    const { openedSettings } = renderSection(fakeAppliancesApi([TV]), { hubAddress: fakeHubAddressApi(null) });
    open();

    await waitFor(() => {
      expect(steps()[3]).toBe(
        "Where it asks for an IP address, enter the Hub's IP, then choose OK. " +
          "The Hub couldn't find its own IP address on your home network, so set it in Settings first.",
      );
    });

    fireEvent.click(within(section()).getByRole("button", { name: "Set it in Settings" }));
    expect(openedSettings()).toBe(1);
  });

  it("says why when the Hub's IP can't be read, giving none", async () => {
    const hubAddress = fakeHubAddressApi("192.168.1.5");
    hubAddress.failNextRead("Can't reach the Hub");
    renderSection(fakeAppliancesApi([TV]), { hubAddress, refreshMs: 60_000 });
    open();

    await waitFor(() => {
      expect(within(section()).getByRole("alert").textContent).toBe("Can't reach the Hub");
    });
    expect(steps()[3]).toBe("Where it asks for an IP address, enter the Hub's IP, then choose OK.");
    expect(section().querySelector(".hub-ip")).toBeNull();
  });

  it("reads again at once when the TV's power state changes, as it does on restarting", async () => {
    const appliances = fakeAppliancesApi([TV]);
    const { rerender } = renderSection(appliances, { refreshMs: 60_000 });
    open();
    await waitFor(() => {
      expect(appliances.deviceInfoReads).toHaveLength(1);
    });

    rerender(
      <TvDeveloper
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        tv={TV}
        title="Living room · TV"
        power="standby"
        onOpenSettings={() => undefined}
        refreshMs={60_000}
      />,
    );

    await waitFor(() => {
      expect(appliances.deviceInfoReads).toHaveLength(2);
    });
  });

  it("stops asking once closed, and shows nothing it read before when opened again until it reads afresh", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderSection(appliances);
    open();
    await waitFor(() => {
      expect(deviceInfoShown()).not.toEqual([]);
    });

    open();
    expect(section().querySelector("#tv-developer-body")).toBeNull();
    const reads = appliances.deviceInfoReads.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(appliances.deviceInfoReads).toHaveLength(reads);

    open();
    expect(within(section()).getByText("Reading Living room · TV's device info…")).toBeTruthy();
    expect(deviceInfoShown()).toEqual([]);
    await waitFor(() => {
      expect(deviceInfoShown()).not.toEqual([]);
    });
  });
});
