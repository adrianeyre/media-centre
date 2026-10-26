import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { AirConditionersSection } from "./air-conditioners-section.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import {
  aFoundAirConditioner,
  anAirConditioner,
  aTv,
  FAKE_CLOUD_LOGIN,
  FAKE_CLOUD_REFUSAL,
  fakeAppliancesApi,
  type FakeAppliancesApi,
} from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { deviceGroups } from "./testing/device-groups.ts";

afterEach(cleanup);

/** Rooms 1 and 2. */
const ROOMS = ["Living room", "Bedroom"];

const renderSection = (appliances: FakeAppliancesApi, rooms: RoomsApi = fakeRoomsApi(ROOMS)) =>
  render(<AirConditionersSection appliances={appliances} rooms={rooms} roomsVersion={0} />);

const section = () => screen.findByRole("region", { name: "Air Conditioners" });

/** Each Room's heading, with the Air Conditioners listed under it as the Remote names them. */
const shownGroups = async (): Promise<[string, string[]][]> => {
  const shown = await section();
  await within(shown).findAllByRole("button", { name: /^Edit / });
  return deviceGroups(shown);
};

const addForm = () => screen.getByRole("form", { name: "Add Air Conditioner by IP" });

const fillAddForm = (address: string, name: string, room: string): void => {
  const form = addForm();
  fireEvent.input(within(form).getByRole("textbox", { name: "IP address" }), { target: { value: address } });
  fireEvent.input(within(form).getByRole("textbox", { name: "Name" }), { target: { value: name } });
  const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
  const option = within(select).getByRole<HTMLOptionElement>("option", { name: room });
  fireEvent.change(select, { target: { value: option.value } });
};

const loginDialog = () => screen.findByRole("dialog", { name: "Sign in to MSmartHome" });

const signIn = async (login: { account: string; password: string }, button: string): Promise<HTMLElement> => {
  const dialog = await loginDialog();
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Email" }), { target: { value: login.account } });
  fireEvent.input(within(dialog).getByLabelText("Password"), { target: { value: login.password } });
  fireEvent.click(within(dialog).getByRole("button", { name: button }));
  return dialog;
};

describe("Settings' Air Conditioners", () => {
  it("say how to add one when there are none, leaving out the TVs", async () => {
    renderSection(fakeAppliancesApi([aTv(1, "TV", 1)]));

    expect(screen.getByText("Loading the Air Conditioners…")).toBeTruthy();
    expect(await screen.findByText(/^No Air Conditioners yet\. Find them on the network below/)).toBeTruthy();
  });

  it('name each "Room · Name", under its Room in Room order, as TVs are', async () => {
    renderSection(
      fakeAppliancesApi([anAirConditioner(1, "Aircon", 2), anAirConditioner(2, "Spare", null), aTv(3, "TV", 2)]),
    );

    expect(await shownGroups()).toEqual([
      ["Bedroom", ["Bedroom · Aircon"]],
      ["No room", ["Spare"]],
    ]);
    expect(screen.getByRole("listitem", { name: "Bedroom · Aircon" }).textContent).toContain(
      "Midea, protocol v3, at 192.168.1.41",
    );
  });

  it("add a v2 unit by IP with no login, named and in its Room", async () => {
    const appliances = fakeAppliancesApi([], [], [aFoundAirConditioner(5, "Unit 0005", false)]);
    renderSection(appliances);
    await screen.findByText(/^No Air Conditioners yet/);

    fillAddForm("192.168.1.45", "Aircon", "Bedroom");
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Air Conditioner" }));

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["Bedroom", ["Bedroom · Aircon"]]]);
    });
    expect(appliances.current()).toEqual([
      expect.objectContaining({ kind: "air-conditioner", address: "192.168.1.45", name: "Aircon", roomId: 2 }),
    ]);
    expect(appliances.logins).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ask for the MSmartHome login once in a dialog, for a v3 unit added by IP, and add it with it", async () => {
    const appliances = fakeAppliancesApi();
    renderSection(appliances);
    await screen.findByText(/^No Air Conditioners yet/);

    fillAddForm("192.168.1.46", "Aircon", "Living room");
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Air Conditioner" }));

    const dialog = await loginDialog();
    expect(dialog.textContent).toContain("keeps only them, and forgets your email and password");
    expect(appliances.current()).toEqual([]);
    expect(within(addForm()).queryByRole("alert")).toBeNull();

    // A wrong password is said in the dialog, which stays open to try again.
    await signIn({ ...FAKE_CLOUD_LOGIN, password: "wrong" }, "Sign in and add");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(FAKE_CLOUD_REFUSAL);
    expect(screen.getByRole("dialog", { name: "Sign in to MSmartHome" })).toBeTruthy();

    await signIn(FAKE_CLOUD_LOGIN, "Sign in and add");

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["Living room", ["Living room · Aircon"]]]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(appliances.logins.map(({ login }) => login)).toEqual([
      { ...FAKE_CLOUD_LOGIN, password: "wrong" },
      FAKE_CLOUD_LOGIN,
    ]);
    // The login goes with the dialog: nothing of it stays on the page.
    expect(document.body.innerHTML).not.toContain(FAKE_CLOUD_LOGIN.password);
    expect(document.body.innerHTML).not.toContain(FAKE_CLOUD_LOGIN.account);
  });

  it("forget what was typed in the dialog when it is cancelled", async () => {
    const appliances = fakeAppliancesApi();
    renderSection(appliances);
    await screen.findByText(/^No Air Conditioners yet/);
    fillAddForm("192.168.1.46", "Aircon", "Living room");
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Air Conditioner" }));
    const dialog = await loginDialog();
    fireEvent.input(within(dialog).getByLabelText("Password"), { target: { value: "half-typed" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain("half-typed");
    expect(appliances.current()).toEqual([]);
    expect(appliances.logins).toEqual([]);
  });

  describe('"Find Air Conditioners"', () => {
    it("lists each unit found, says which are added already, and asks at once for the login of one that needs it", async () => {
      const appliances = fakeAppliancesApi(
        [anAirConditioner(1, "Aircon", 2)],
        [],
        [aFoundAirConditioner(1, "Unit 0001"), aFoundAirConditioner(2, "Unit 0002")],
      );
      renderSection(appliances);
      await shownGroups();

      fireEvent.click(screen.getByRole("button", { name: "Find Air Conditioners" }));

      const found = await screen.findByRole("list", { name: "Air Conditioners found" });
      expect(within(found).getByRole("listitem", { name: "Unit 0001, at 192.168.1.41" }).textContent).toContain(
        "Added, as Bedroom · Aircon",
      );
      fireEvent.click(within(found).getByRole("button", { name: "Add Unit 0002, at 192.168.1.42" }));
      expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "IP address" }).value).toBe(
        "192.168.1.42",
      );
      fireEvent.click(within(addForm()).getByRole("button", { name: "Add Air Conditioner" }));

      await signIn(FAKE_CLOUD_LOGIN, "Sign in and add");

      await waitFor(async () => {
        expect(await shownGroups()).toEqual([
          ["Bedroom", ["Bedroom · Aircon"]],
          ["No room", ["Unit 0002"]],
        ]);
      });
      // Asked once, with the login: never first without it.
      expect(appliances.logins).toEqual([{ login: FAKE_CLOUD_LOGIN }]);
      expect(
        within(screen.getByRole("list", { name: "Air Conditioners found" })).getByRole("listitem", {
          name: "Unit 0002, at 192.168.1.42",
        }).textContent,
      ).toContain("Added, as Unit 0002");
    });

    it("says when none were found", async () => {
      renderSection(fakeAppliancesApi());
      await screen.findByText(/^No Air Conditioners yet/);

      fireEvent.click(screen.getByRole("button", { name: "Find Air Conditioners" }));

      expect((await screen.findByText(/^No Air Conditioners found\./)).textContent).toContain(
        'add it by its IP address under "Add Air Conditioner by IP" below',
      );
    });
  });

  it('check each unit\'s token and key once on opening, and "Fetch again" with the login for one that refused them', async () => {
    const appliances = fakeAppliancesApi([anAirConditioner(1, "Aircon", 2), anAirConditioner(2, "Study", null)]);
    appliances.revoke(1);
    renderSection(appliances);

    const item = await screen.findByRole("listitem", { name: "Bedroom · Aircon" });
    const fetchAgain = await within(item).findByRole("button", { name: "Fetch again" });
    expect(within(item).getByText(/no longer accepts the Hub's token and key/)).toBeTruthy();
    expect(appliances.connected).toEqual([1, 2]);
    expect(
      within(screen.getByRole("listitem", { name: "Study" })).queryByRole("button", { name: "Fetch again" }),
    ).toBeNull();

    fireEvent.click(fetchAgain);
    const dialog = await loginDialog();
    expect(dialog.textContent).toContain("Bedroom · Aircon no longer accepts its token and key");
    await signIn(FAKE_CLOUD_LOGIN, "Sign in and fetch again");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Fetch again" })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(appliances.logins).toEqual([{ id: 1, login: FAKE_CLOUD_LOGIN }]);
    expect(appliances.current()[0]?.pairing).toBe("paired");
  });

  it("rename a unit and move it to another Room, and remove one once confirmed", async () => {
    const appliances = fakeAppliancesApi([anAirConditioner(1, "Aircon", 2)]);
    renderSection(appliances);
    await shownGroups();

    fireEvent.click(screen.getByRole("button", { name: "Edit Bedroom · Aircon" }));
    const form = screen.getByRole("form", { name: "Edit Bedroom · Aircon" });
    fireEvent.input(within(form).getByRole("textbox", { name: "Air Conditioner name" }), {
      target: { value: "Aircon 2" },
    });
    const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["Living room", ["Living room · Aircon 2"]]]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove Living room · Aircon 2" }));
    expect(screen.getByText(/The Hub forgets its token and key too\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));

    expect(await screen.findByText(/^No Air Conditioners yet/)).toBeTruthy();
    expect(appliances.current()).toEqual([]);
  });

  it("show the Hub's reason for refusing a unit beside the form", async () => {
    const appliances = fakeAppliancesApi([], [], [aFoundAirConditioner(5, "Unit 0005", false)]);
    renderSection(appliances);
    await screen.findByText(/^No Air Conditioners yet/);

    appliances.refuseNext('There is already an Air Conditioner called "Aircon" in Bedroom.');
    fillAddForm("192.168.1.45", "Aircon", "Bedroom");
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add Air Conditioner" }));

    expect((await within(addForm()).findByRole("alert")).textContent).toBe(
      'There is already an Air Conditioner called "Aircon" in Bedroom.',
    );
    expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Aircon");
  });
});
