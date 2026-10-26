import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { PowerState } from "@media-centre/shared";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvPower } from "./tv-power.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

/** The Power button for {@link TV}, shown with `power`, which a test changes as the TV tab would. */
const renderPower = (appliances: FakeAppliancesApi, power: PowerState | undefined, waitMs?: number) => {
  let switched = 0;
  const props = (state: PowerState | undefined) => (
    <TvPower
      appliances={appliances}
      tv={TV}
      title="Living room · TV"
      power={state}
      onSwitched={() => {
        switched += 1;
      }}
      {...(waitMs === undefined ? {} : { waitMs })}
    />
  );
  const rendered = render(props(power));
  return {
    showPower: (state: PowerState | undefined) => {
      rendered.rerender(props(state));
    },
    switched: () => switched,
  };
};

const region = () => screen.getByRole("region", { name: "Power" });
const button = () => within(region()).getByRole("button", { name: "Power" });
const status = () => within(region()).getByRole("status").textContent;

describe("the Power button", () => {
  it("has the Hub switch the TV, and says it is switching on until the TV says it is on", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setPower(TV.id, "standby");
    const shown = renderPower(appliances, "standby");
    expect(status()).toBe("");

    fireEvent.click(button());

    await waitFor(() => {
      expect(status()).toBe("Switching on…");
    });
    expect(appliances.powerSwitches).toEqual([TV.id]);
    expect(shown.switched()).toBe(1);

    shown.showPower("standby");
    expect(status()).toBe("Switching on…");
    shown.showPower("on");
    await waitFor(() => {
      expect(status()).toBe("");
    });
    expect(within(region()).queryByRole("alert")).toBeNull();
  });

  it("says it is switching off until the TV is no longer on", async () => {
    const appliances = fakeAppliancesApi([TV]);
    const shown = renderPower(appliances, "on");

    fireEvent.click(button());
    await waitFor(() => {
      expect(status()).toBe("Switching off…");
    });

    shown.showPower("standby");
    await waitFor(() => {
      expect(status()).toBe("");
    });
  });

  it("can't be tapped again while the Hub is switching, as holding a Frame's power key takes seconds", async () => {
    const appliances = fakeAppliancesApi([TV]);
    const release = appliances.holdNextPowerSwitch();
    renderPower(appliances, "on");

    fireEvent.click(button());
    await waitFor(() => {
      expect(button().hasAttribute("disabled")).toBe(true);
    });
    expect(status()).toBe("Switching…");
    fireEvent.click(button());

    release();
    await waitFor(() => {
      expect(button().hasAttribute("disabled")).toBe(false);
    });
    expect(appliances.powerSwitches).toEqual([TV.id]);
  });

  it("says so when the TV hasn't switched on in time", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setPower(TV.id, "standby");
    renderPower(appliances, "standby", 50);

    fireEvent.click(button());

    expect((await within(region()).findByRole("alert")).textContent).toBe(
      "Living room · TV hasn't switched on. Check that it is plugged in, and on the same network as the Hub.",
    );
    expect(status()).toBe("");
  });

  it("shows the Hub's reason when it couldn't switch the TV, and can be tapped again", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.refuseNext("Living room · TV no longer lets the Hub in. Pair it again in Settings.");
    const shown = renderPower(appliances, "on");

    fireEvent.click(button());

    expect((await within(region()).findByRole("alert")).textContent).toBe(
      "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
    );
    expect(status()).toBe("");
    expect(shown.switched()).toBe(0);
    expect(button().hasAttribute("disabled")).toBe(false);

    fireEvent.click(button());
    await waitFor(() => {
      expect(within(region()).queryByRole("alert")).toBeNull();
    });
    expect(appliances.powerSwitches).toEqual([TV.id]);
  });
});
