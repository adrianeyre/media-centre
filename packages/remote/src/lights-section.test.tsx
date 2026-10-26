import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { LightsSection } from "./lights-section.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import {
  aFoundLight,
  aLight,
  anAirConditioner,
  aTv,
  FAKE_LIGHT_KEY,
  FAKE_LIGHT_KEY_REFUSAL,
  fakeAppliancesApi,
  type FakeAppliancesApi,
} from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { deviceGroups } from "./testing/device-groups.ts";

afterEach(cleanup);

/** Rooms 1 and 2. */
const ROOMS = ["Living room", "Bedroom"];

const renderSection = (
  appliances: FakeAppliancesApi,
  rooms: RoomsApi = fakeRoomsApi(ROOMS),
): ReturnType<typeof render> => render(<LightsSection appliances={appliances} rooms={rooms} roomsVersion={0} />);

const section = () => screen.findByRole("region", { name: "Lights" });

/** Each Room's heading, with the Lights listed under it as the Remote names them. */
const shownGroups = async (): Promise<[string, string[]][]> => {
  const shown = await section();
  await within(shown).findAllByRole("button", { name: /^Edit / });
  return deviceGroups(shown);
};

const addForm = () => screen.getByRole("form", { name: "Add a Light by address" });
const keyField = () => within(addForm()).getByLabelText<HTMLInputElement>("Local key");

const fillAddForm = (fields: { address?: string; id?: string; key?: string; name?: string; room?: string }): void => {
  const form = addForm();
  if (fields.address !== undefined)
    fireEvent.input(within(form).getByRole("textbox", { name: "IP address" }), { target: { value: fields.address } });
  if (fields.id !== undefined)
    fireEvent.input(within(form).getByRole("textbox", { name: "Device id" }), { target: { value: fields.id } });
  if (fields.key !== undefined) fireEvent.input(keyField(), { target: { value: fields.key } });
  if (fields.name !== undefined)
    fireEvent.input(within(form).getByRole("textbox", { name: "Name" }), { target: { value: fields.name } });
  if (fields.room !== undefined) {
    const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
    const option = within(select).getByRole<HTMLOptionElement>("option", { name: fields.room });
    fireEvent.change(select, { target: { value: option.value } });
  }
};

describe("Settings' Lights", () => {
  it("say how to add one when there are none, leaving out every other kind of Appliance", async () => {
    renderSection(fakeAppliancesApi([aTv(1, "TV", 1), anAirConditioner(2, "Aircon", 1)]));
    expect(
      await within(await section()).findByText(
        "No Lights yet. Find them on the network below, or add one by its address.",
      ),
    ).toBeTruthy();
  });

  it("list each Light under its Room, in Room order, as Room · Name, with No room last", async () => {
    renderSection(
      fakeAppliancesApi([aLight(1, "Strip", null), aLight(2, "Lamp", 2), aLight(3, "Lamp", 1), aLight(4, "Plug", 1)]),
    );
    expect(await shownGroups()).toEqual([
      ["Living room", ["Living room · Lamp", "Living room · Plug"]],
      ["Bedroom", ["Bedroom · Lamp"]],
      ["No room", ["Strip"]],
    ]);
    expect(within(await section()).getByText("Lepro, protocol v3.3, at 192.168.1.63")).toBeTruthy();
  });

  it("find the Lights on the network, say which is added and as what, and add one found with its key alone", async () => {
    const appliances = fakeAppliancesApi([aLight(1, "Lamp", 1)], [], [], [aFoundLight(1), aFoundLight(2)]);
    renderSection(appliances);
    const shown = await section();
    await within(shown).findByRole("listitem", { name: "Living room · Lamp" });

    const release = appliances.holdSearch();
    fireEvent.click(within(shown).getByRole("button", { name: "Find Lights" }));
    expect(await within(shown).findByRole("status")).toHaveProperty(
      "textContent",
      "Looking for Lights on the network…",
    );
    release();
    const found = await within(shown).findByRole("list", { name: "Lights found" });
    const first = within(found).getByRole("listitem", { name: "Lepro Light, at 192.168.1.61" });
    expect(within(first).getByText("Added, as Living room · Lamp")).toBeTruthy();

    // Chosen, it fills in the address and waits for the key.
    fireEvent.click(within(found).getByRole("button", { name: "Add Lepro Light, at 192.168.1.62" }));
    expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "IP address" }).value).toBe("192.168.1.62");
    expect(document.activeElement).toBe(keyField());
    fillAddForm({ key: FAKE_LIGHT_KEY, name: "Desk", room: "Bedroom" });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Light" }));

    expect(await shownGroups()).toEqual([
      ["Living room", ["Living room · Lamp"]],
      ["Bedroom", ["Bedroom · Desk"]],
    ]);
    expect(appliances.lightKeys).toEqual([{ key: FAKE_LIGHT_KEY }]);
    // Found, and now added.
    expect(within(found).getByRole("listitem", { name: "Lepro Light, at 192.168.1.62" }).textContent).toContain(
      "Added, as Bedroom · Desk",
    );
    // The key is gone from the page once it is sent.
    expect(keyField().value).toBe("");
    expect(keyField().type).toBe("password");
  });

  it("add one by its address, device id and key, and say why a key is refused, keeping what was typed", async () => {
    const appliances = fakeAppliancesApi();
    renderSection(appliances);
    await within(await section()).findByText(/No Lights yet/);

    fillAddForm({ address: "192.168.1.70", id: " bf0123456789abcdef01 ", key: "not the key", name: "Hall" });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Light" }));
    const refused = await within(addForm()).findByRole("alert");
    expect(refused.textContent).toBe(FAKE_LIGHT_KEY_REFUSAL);
    expect(within(addForm()).getByRole("textbox", { name: "IP address" }).getAttribute("aria-describedby")).toBe(
      refused.id,
    );
    expect(keyField().value).toBe("not the key");

    fillAddForm({ key: FAKE_LIGHT_KEY });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Light" }));
    expect(await shownGroups()).toEqual([["No room", ["Hall"]]]);
    expect(appliances.lightKeys).toEqual([
      { id: "bf0123456789abcdef01", key: "not the key" },
      { id: "bf0123456789abcdef01", key: FAKE_LIGHT_KEY },
    ]);
    expect(appliances.current()).toMatchObject([{ kind: "light", name: "Hall", address: "192.168.1.70" }]);
  });

  it("rename a Light, move it to another Room, and remove it", async () => {
    const appliances = fakeAppliancesApi([aLight(1, "Lamp", 1)]);
    renderSection(appliances);
    const shown = await section();
    fireEvent.click(await within(shown).findByRole("button", { name: "Edit Living room · Lamp" }));
    const form = within(shown).getByRole("form", { name: "Edit Living room · Lamp" });
    fireEvent.input(within(form).getByRole("textbox", { name: "Light name" }), { target: { value: "Reading lamp" } });
    const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await shownGroups()).toEqual([["Bedroom", ["Bedroom · Reading lamp"]]]);

    fireEvent.click(within(shown).getByRole("button", { name: "Remove Bedroom · Reading lamp" }));
    expect(within(shown).getByText("Remove Bedroom · Reading lamp? The Hub forgets its key too.")).toBeTruthy();
    fireEvent.click(within(shown).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => {
      expect(appliances.current()).toEqual([]);
    });
  });

  it("check each Light's key as Settings opens, and say of one that no longer answers to it what to do", async () => {
    const appliances = fakeAppliancesApi([aLight(1, "Lamp", 1), aLight(2, "Plug", 1)]);
    appliances.revoke(2);
    renderSection(appliances);
    expect(
      await within(await section()).findByText(
        "This Light no longer answers to the Hub's key, as after it is paired again in its maker's app. Remove it, and add it again with its new key.",
      ),
    ).toBeTruthy();
    expect(appliances.connected.toSorted()).toEqual([1, 2]);
  });
});
