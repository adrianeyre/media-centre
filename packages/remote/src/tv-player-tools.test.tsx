import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { DeveloperSettings } from "@media-centre/shared";

import { aTv, aTvDeviceInfo, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeHubAddressApi, type FakeHubAddressApi } from "./testing/fake-hub-address-api.ts";
import { TvDeveloper } from "./tv-developer.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);
const HUB_IP = "192.168.1.5";

/** The TV, reporting these Developer settings, or none with null. */
const reporting = (developer: DeveloperSettings | null, appliances = fakeAppliancesApi([TV])): FakeAppliancesApi => {
  const { info } = aTvDeviceInfo(TV);
  appliances.setDeviceInfo(TV.id, { known: true, info: { ...info, developer } });
  return appliances;
};

const renderSection = (appliances: FakeAppliancesApi, hubAddress: FakeHubAddressApi = fakeHubAddressApi(HUB_IP)) => {
  render(
    <TvDeveloper
      appliances={appliances}
      hubAddress={hubAddress}
      tv={TV}
      title="Living room · TV"
      power="on"
      onOpenSettings={() => undefined}
      refreshMs={20}
    />,
  );
  fireEvent.click(within(section()).getByRole("button", { name: "Developer" }));
};

const section = () => screen.getByRole("region", { name: "Developer" });
const button = (name: string) => within(section()).queryByRole("button", { name });
const installButton = () => button("Install / update Player");

/** Waits until the section has read the TV's device info and the Hub's address. */
const read = async (): Promise<void> => {
  await waitFor(() => {
    expect(section().querySelector(".device-info")).not.toBeNull();
    expect(section().textContent).toContain(HUB_IP);
  });
};

/** The steps of the action shown, each with its state. */
const progressSteps = (heading: string) =>
  within(screen.getByRole("region", { name: heading }))
    .getAllByRole("listitem")
    .map((step) => step.textContent);

describe("the Developer section's Player (FR-31)", () => {
  it("has Install / update, Launch and Uninstall once the TV reports Developer Mode on with the Hub's IP", async () => {
    renderSection(reporting({ mode: "on", ip: HUB_IP }));
    await read();

    await waitFor(() => {
      expect(installButton()).not.toBeNull();
    });
    expect(button("Launch Player")).not.toBeNull();
    expect(button("Uninstall Player")).not.toBeNull();
  });

  for (const [why, developer] of [
    ["Developer Mode is off", { mode: "off", ip: null }],
    ["Developer Mode is off, even with the Hub's IP", { mode: "off", ip: HUB_IP }],
    ["the Developer IP is another computer's", { mode: "on", ip: "192.168.1.99" }],
    ["Developer Mode is on with no Developer IP", { mode: "on", ip: null }],
    ["the TV doesn't report Developer Mode", null],
  ] as const) {
    it(`has none of them when ${why}, saying when it would`, async () => {
      renderSection(reporting(developer));
      await read();

      expect(installButton()).toBeNull();
      expect(button("Launch Player")).toBeNull();
      expect(button("Uninstall Player")).toBeNull();
      expect(section().textContent).toContain(
        "Once Developer Mode is on with the Hub's IP as Living room · TV's Developer IP, the Hub can install the Player",
      );
    });
  }

  it("has none of them when the Hub doesn't know its own IP", async () => {
    const appliances = reporting({ mode: "on", ip: HUB_IP });
    const hubAddress = fakeHubAddressApi(null);
    renderSection(appliances, hubAddress);
    await waitFor(() => {
      expect(section().querySelector(".device-info")).not.toBeNull();
    });

    expect(installButton()).toBeNull();
  });

  it("follows the TV as Developer Mode is switched on with the Hub's IP, and restarted", async () => {
    const appliances = reporting({ mode: "off", ip: null });
    renderSection(appliances);
    await read();
    expect(installButton()).toBeNull();

    reporting({ mode: "on", ip: HUB_IP }, appliances);

    await waitFor(() => {
      expect(installButton()).not.toBeNull();
    });
  });

  it("installs the Player, showing each step as the Hub takes it", async () => {
    const appliances = reporting({ mode: "on", ip: HUB_IP });
    renderSection(appliances);
    await waitFor(() => {
      expect(installButton()).not.toBeNull();
    });
    const held = appliances.holdNextPlayerAction();

    fireEvent.click(installButton() as HTMLElement);

    const heading = "Install / update the Player on Living room · TV";
    await waitFor(() => {
      expect(progressSteps(heading)).toEqual([
        "Connect to the TV (to do)",
        "Sign the Player with your certificate (to do)",
        "Install it on the TV (to do)",
      ]);
    });
    expect(appliances.playerActions).toEqual([{ id: TV.id, action: "install" }]);
    expect((installButton() as HTMLButtonElement).disabled).toBe(true);
    expect((button("Launch Player") as HTMLButtonElement).disabled).toBe(true);

    held.step("connecting");
    held.step("signing");
    await waitFor(() => {
      expect(progressSteps(heading)).toEqual([
        "Connect to the TV (done)",
        "Sign the Player with your certificate (in progress)",
        "Install it on the TV (to do)",
      ]);
    });
    expect(within(section()).getByRole("status").textContent).toBe("Signing the Player with your signing certificate…");

    held.step("installing");
    held.done();
    await waitFor(() => {
      expect(within(section()).getByRole("status").textContent).toBe("The Player is installed on Living room · TV.");
    });
    expect(progressSteps(heading)).toEqual([
      "Connect to the TV (done)",
      "Sign the Player with your certificate (done)",
      "Install it on the TV (done)",
    ]);
    expect((installButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows why a step failed", async () => {
    const appliances = reporting({ mode: "on", ip: HUB_IP });
    renderSection(appliances);
    await waitFor(() => {
      expect(installButton()).not.toBeNull();
    });
    const held = appliances.holdNextPlayerAction();

    fireEvent.click(installButton() as HTMLElement);
    held.step("connecting");
    held.step("signing");
    held.step("installing");
    held.fail("The TV didn't install the Player. (install failed[118, -12], reason: Author certificate not match)");

    await waitFor(() => {
      expect(within(section()).getByRole("alert").textContent).toBe(
        "The TV didn't install the Player. (install failed[118, -12], reason: Author certificate not match)",
      );
    });
    expect(within(section()).getByRole("status").textContent).toBe("Couldn't install the Player on Living room · TV.");
    expect(progressSteps("Install / update the Player on Living room · TV").at(-1)).toBe(
      "Install it on the TV (failed)",
    );
  });

  it("shows why the Hub refused, e.g. without a signing certificate", async () => {
    const appliances = reporting({ mode: "on", ip: HUB_IP });
    renderSection(appliances);
    await waitFor(() => {
      expect(installButton()).not.toBeNull();
    });
    appliances.refuseNextPlayerAction(
      "The Hub has no signing certificate to sign the Player with. Add yours in Settings, under Signing certificate.",
    );

    fireEvent.click(installButton() as HTMLElement);

    await waitFor(() => {
      expect(within(section()).getByRole("alert").textContent).toContain("Add yours in Settings");
    });
  });

  it("launches the Player", async () => {
    const appliances = reporting({ mode: "on", ip: HUB_IP });
    renderSection(appliances);
    await waitFor(() => {
      expect(button("Launch Player")).not.toBeNull();
    });

    fireEvent.click(button("Launch Player") as HTMLElement);

    await waitFor(() => {
      expect(within(section()).getByRole("status").textContent).toBe("The Player is launched on Living room · TV.");
    });
    expect(appliances.playerActions).toEqual([{ id: TV.id, action: "launch" }]);
    expect(progressSteps("Launch the Player on Living room · TV")).toEqual([
      "Connect to the TV (done)",
      "Launch the Player (done)",
    ]);
  });

  it("asks before it uninstalls the Player", async () => {
    const appliances = reporting({ mode: "on", ip: HUB_IP });
    renderSection(appliances);
    await waitFor(() => {
      expect(button("Uninstall Player")).not.toBeNull();
    });

    fireEvent.click(button("Uninstall Player") as HTMLElement);
    expect(section().textContent).toContain("Uninstall the Player from Living room · TV?");
    fireEvent.click(button("No, keep it") as HTMLElement);
    expect(appliances.playerActions).toEqual([]);

    fireEvent.click(button("Uninstall Player") as HTMLElement);
    fireEvent.click(button("Yes, uninstall") as HTMLElement);

    await waitFor(() => {
      expect(within(section()).getByRole("status").textContent).toBe(
        "The Player is uninstalled from Living room · TV.",
      );
    });
    expect(appliances.playerActions).toEqual([{ id: TV.id, action: "uninstall" }]);
  });
});
