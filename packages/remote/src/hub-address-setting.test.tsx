import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { HubAddressSetting } from "./hub-address-setting.tsx";
import { fakeHubAddressApi, type FakeHubAddressApi } from "./testing/fake-hub-address-api.ts";

afterEach(cleanup);

const setting = () => screen.getByRole("group", { name: "IP address" });
const field = () => within(setting()).getByRole<HTMLInputElement>("textbox", { name: "IP address to use" });
/** What it says the Hub's IP address is. */
const said = () => setting().querySelector(".hub-address-now")?.textContent;

const renderSetting = (hubAddress: FakeHubAddressApi = fakeHubAddressApi("192.168.1.5")) => {
  render(<HubAddressSetting hubAddress={hubAddress} />);
  return hubAddress;
};

const setTo = (typed: string) => {
  fireEvent.input(field(), { target: { value: typed } });
  fireEvent.click(within(setting()).getByRole("button", { name: "Use this IP address" }));
};

describe("Settings' Hub IP address (FR-29)", () => {
  it("shows the one the Hub found on its network, which TVs are given as their Developer IP", async () => {
    renderSetting();

    await waitFor(() => {
      expect(said()).toBe("The Hub's IP address is 192.168.1.5, which it found on its network.");
    });
    expect(setting().textContent).toContain("Each TV is given it as its Developer IP.");
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("192.168.1.5");
    expect(within(setting()).queryByRole("button", { name: "Use the one found" })).toBeNull();
  });

  it("sets another to use instead, then goes back to the one found", async () => {
    const hubAddress = renderSetting();
    await waitFor(() => {
      expect(said()).toMatch(/192\.168\.1\.5/);
    });

    setTo("10.0.0.2");

    await waitFor(() => {
      expect(said()).toBe(
        "The Hub's IP address is set to 10.0.0.2, rather than 192.168.1.5, which it found on its network.",
      );
    });
    expect((await hubAddress.read()).address).toBe("10.0.0.2");
    expect(field().value).toBe("10.0.0.2");

    fireEvent.click(within(setting()).getByRole("button", { name: "Use the one found" }));

    await waitFor(() => {
      expect(said()).toBe("The Hub's IP address is 192.168.1.5, which it found on its network.");
    });
    expect((await hubAddress.read()).override).toBeNull();
    expect(field().value).toBe("");
  });

  it("keeps what is typed before the Hub has answered with the address, and sets that", async () => {
    const hubAddress = fakeHubAddressApi("192.168.1.5");
    await hubAddress.setOverride("10.0.0.2");
    renderSetting(hubAddress);

    fireEvent.input(field(), { target: { value: "10.0.0.3" } });
    await waitFor(() => {
      expect(said()).toMatch(/set to 10\.0\.0\.2/);
    });
    expect(field().value).toBe("10.0.0.3");

    fireEvent.click(within(setting()).getByRole("button", { name: "Use this IP address" }));
    await waitFor(() => {
      expect(said()).toMatch(/set to 10\.0\.0\.3/);
    });
  });

  it("goes back to the one found when the field is emptied and saved", async () => {
    const hubAddress = fakeHubAddressApi("192.168.1.5");
    await hubAddress.setOverride("10.0.0.2");
    renderSetting(hubAddress);
    await waitFor(() => {
      expect(field().value).toBe("10.0.0.2");
    });

    setTo("  ");

    await waitFor(() => {
      expect(said()).toBe("The Hub's IP address is 192.168.1.5, which it found on its network.");
    });
  });

  it("asks for one when the Hub found none", async () => {
    renderSetting(fakeHubAddressApi(null));

    await waitFor(() => {
      expect(said()).toBe("The Hub couldn't find its IP address on your home network. Set it below.");
    });
    expect(field().placeholder).toBe("e.g. 192.168.1.10");

    setTo("192.168.1.10");
    await waitFor(() => {
      expect(said()).toBe("The Hub's IP address is set to 192.168.1.10.");
    });
  });

  it("shows the Hub's reason when it refuses one, beside the field, keeping what was typed", async () => {
    const hubAddress = renderSetting();
    await waitFor(() => {
      expect(said()).toMatch(/192\.168\.1\.5/);
    });
    hubAddress.refuseNext("Give the Hub's IP address as four numbers with dots, e.g. 192.168.1.10.");

    setTo("hub.local");

    const alert = await within(setting()).findByRole("alert");
    expect(alert.textContent).toBe("Give the Hub's IP address as four numbers with dots, e.g. 192.168.1.10.");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe(alert.id);
    expect(field().value).toBe("hub.local");
    expect(said()).toBe("The Hub's IP address is 192.168.1.5, which it found on its network.");
  });

  it("says why when the Hub can't be asked", async () => {
    const hubAddress = fakeHubAddressApi();
    hubAddress.failNextRead("Can't reach the Hub");
    renderSetting(hubAddress);

    expect((await within(setting()).findByRole("alert")).textContent).toBe("Can't reach the Hub");
    expect(said()).toBe("");
  });
});
