import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { HiveSection } from "./hive-section.tsx";
import { HubRequestFailed } from "./hub-request.ts";
import {
  aHiveAppliance,
  aLight,
  anAirConditioner,
  aTv,
  FAKE_CLOUD_LOGIN,
  FAKE_HIVE_CODE,
  FAKE_HIVE_REFUSAL,
  FAKE_HIVE_WRONG_CODE,
  fakeAppliancesApi,
  type FakeAppliancesApi,
} from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";

afterEach(cleanup);

/** Rooms 1 and 2. */
const ROOMS = ["Living room", "Bedroom"];

const renderSection = (appliances: FakeAppliancesApi) =>
  render(<HiveSection appliances={appliances} rooms={fakeRoomsApi(ROOMS)} roomsVersion={0} />);

const section = () => screen.findByRole("region", { name: "Hive" });

/** Each kind's card, by its heading, with Hive's Appliances listed in it as the Remote names them. */
const shownGroups = (): [string, string[]][] =>
  [...document.querySelectorAll(".hive-kind")].map((card) => [
    card.querySelector("h2")?.firstChild?.textContent?.trim() ?? "",
    [...card.querySelectorAll(".device-list > li")].map((row) => row.getAttribute("aria-label") ?? ""),
  ]);

const signInForm = () => screen.findByRole("form", { name: "Sign in to Hive" });

const signIn = async (login: { account: string; password: string } = FAKE_CLOUD_LOGIN): Promise<HTMLElement> => {
  const form = await signInForm();
  fireEvent.input(within(form).getByRole("textbox", { name: "Email" }), { target: { value: login.account } });
  fireEvent.input(within(form).getByLabelText("Password"), { target: { value: login.password } });
  fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));
  return form;
};

const enterCode = async (code: string): Promise<HTMLElement> => {
  const form = await screen.findByRole("form", { name: "Hive's code" });
  fireEvent.input(within(form).getByRole("textbox", { name: "Code" }), { target: { value: code } });
  fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));
  return form;
};

/** The household's Hive, as the fake Hub adds it: each with Hive's name, in "No room". */
const HOUSEHOLD: [string, string[]][] = [
  ["Heating zones", ["Downstairs", "Upstairs"]],
  ["Radiator Valves", ["Bedroom", "Study"]],
  ["Hot Water", ["Hot Water"]],
];

describe("Settings' Hive", () => {
  it("says Hive needs the internet, and offers to sign in while the Hub isn't, leaving out every other Appliance", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), anAirConditioner(2, "Aircon", 1), aLight(3, "Lamp", 1)]);
    renderSection(appliances);
    expect(screen.getByText("Checking Hive…")).toBeTruthy();

    expect((await section()).textContent).toContain(
      "Hive's Heating, Radiator Valves and Hot Water are controlled through Hive's cloud, so they need the internet.",
    );
    const form = await signInForm();
    expect(within(form).getByLabelText<HTMLInputElement>("Password").type).toBe("password");
    expect(shownGroups()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Sign out of Hive" })).toBeNull();
    expect(appliances.hiveReads()).toBe(1);
  });

  it("signs in with the code Hive asks for, then lists every Heating, Radiator Valve and Hot Water by Hive's names", async () => {
    const appliances = fakeAppliancesApi();
    renderSection(appliances);

    const form = await signIn();
    // The password goes once, and leaves its field as it does.
    expect(within(form).getByLabelText<HTMLInputElement>("Password").value).toBe("");
    const codeForm = await enterCode(FAKE_HIVE_CODE);
    await screen.findByText("Signed in to Hive");
    expect(codeForm.isConnected).toBe(false);
    expect(screen.queryByRole("form", { name: "Sign in to Hive" })).toBeNull();
    expect(shownGroups()).toEqual(HOUSEHOLD);
    // In its kind's card, its own name, marked as wanting a Room.
    const valves = screen.getByRole("region", { name: /^Radiator Valves/ });
    expect(within(valves).getByRole("listitem", { name: "Study" }).textContent).toBe("StudyNo roomEdit");
    expect(within(valves).getByText("2 without a Room")).toBeTruthy();
    expect(appliances.hiveSignIns).toEqual([{ login: FAKE_CLOUD_LOGIN }, { code: FAKE_HIVE_CODE }]);
  });

  it("signs in at once where Hive asks for no code", async () => {
    const appliances = fakeAppliancesApi();
    appliances.askHiveCode(false);
    renderSection(appliances);

    await signIn();
    await screen.findByText("Signed in to Hive");
    expect(screen.queryByRole("form", { name: "Hive's code" })).toBeNull();
    expect(shownGroups()).toEqual(HOUSEHOLD);
  });

  it("says why Hive refused the login or the code, to try again", async () => {
    const appliances = fakeAppliancesApi();
    renderSection(appliances);

    const form = await signIn({ ...FAKE_CLOUD_LOGIN, password: "wrong" });
    expect((await within(form).findByRole("alert")).textContent).toBe(FAKE_HIVE_REFUSAL);
    expect(within(form).getByRole("textbox", { name: "Email" }).getAttribute("aria-invalid")).toBe("true");

    await signIn();
    const codeForm = await enterCode("000000");
    expect((await within(codeForm).findByRole("alert")).textContent).toBe(FAKE_HIVE_WRONG_CODE);
    await enterCode(FAKE_HIVE_CODE);
    await screen.findByText("Signed in to Hive");
  });

  it("shows that it is signing in while the Hub waits on Hive", async () => {
    const appliances = fakeAppliancesApi();
    appliances.askHiveCode(false);
    const release = appliances.holdNextHiveSignIn();
    renderSection(appliances);

    const form = await signIn();
    expect((await within(form).findByRole("status")).textContent).toBe("Signing in to Hive…");
    expect(within(form).getByRole<HTMLButtonElement>("button", { name: "Sign in" }).disabled).toBe(true);
    release();
    await screen.findByText("Signed in to Hive");
  });

  it("renames each and gives it a Room, as any Appliance", async () => {
    const appliances = fakeAppliancesApi([
      aHiveAppliance(1, "heating", "Downstairs"),
      aHiveAppliance(2, "radiator-valve", "Bedroom"),
      aHiveAppliance(3, "hot-water", "Hot Water"),
    ]);
    renderSection(appliances);
    await screen.findByText("Signed in to Hive");

    fireEvent.click(await screen.findByRole("button", { name: "Edit Bedroom" }));
    const form = screen.getByRole("form", { name: "Edit Bedroom" });
    fireEvent.input(within(form).getByRole("textbox", { name: "Name" }), { target: { value: "Radiator" } });
    const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
    fireEvent.change(select, {
      target: { value: within(select).getByRole<HTMLOptionElement>("option", { name: "Bedroom" }).value },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(shownGroups()).toEqual([
        ["Heating zones", ["Downstairs"]],
        ["Radiator Valves", ["Bedroom · Radiator"]],
        ["Hot Water", ["Hot Water"]],
      ]);
    });
    expect(appliances.current().find(({ id }) => id === 2)).toMatchObject({ name: "Radiator", roomId: 2 });
  });

  it('says when Hive no longer accepts the tokens, and "Sign in again" restores control, keeping each as it was', async () => {
    const appliances = fakeAppliancesApi([
      aHiveAppliance(1, "heating", "Downstairs", 1),
      // Hive's Bedroom, renamed.
      { ...aHiveAppliance(2, "radiator-valve", "Bedroom", 2), name: "Radiator" },
    ]);
    appliances.setHiveTokens("refused");
    appliances.askHiveCode(false);
    renderSection(appliances);

    const again = await screen.findByRole("button", { name: "Sign in again" });
    expect(screen.getByText(/^Hive no longer accepts the Hub's sign-in/)).toBeTruthy();
    expect(again.getAttribute("aria-describedby")).toBe("hive-sign-in-again");
    expect(screen.queryByRole("form", { name: "Sign in to Hive" })).toBeNull();
    // Still listed, as the Heating tab still shows them.
    expect(shownGroups()).toEqual([
      ["Heating zones", ["Living room · Downstairs"]],
      ["Radiator Valves", ["Bedroom · Radiator"]],
    ]);

    fireEvent.click(again);
    await signIn();
    await screen.findByText("Signed in to Hive");
    expect(screen.queryByText(/^Hive no longer accepts/)).toBeNull();
    // The rest of the household appears, beside those kept as they were, by Hive's ids.
    expect(shownGroups()).toEqual([
      ["Heating zones", ["Living room · Downstairs", "Upstairs"]],
      ["Radiator Valves", ["Bedroom · Radiator", "Study"]],
      ["Hot Water", ["Hot Water"]],
    ]);
  });

  it("says \"Can't reach Hive\" while the Hub can't, with no sign in to offer", async () => {
    const appliances = fakeAppliancesApi([aHiveAppliance(1, "heating", "Downstairs")]);
    appliances.setHiveTokens("unreachable");
    renderSection(appliances);

    expect(await screen.findByText("Can't reach Hive. Check that the Hub is connected to the internet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(shownGroups()).toEqual([["Heating zones", ["Downstairs"]]]);
  });

  it("says that each is renamed and given a Room through its Edit, with an Edit beside every Heating, Radiator Valve and Hot Water", async () => {
    renderSection(
      fakeAppliancesApi([
        aHiveAppliance(1, "heating", "Downstairs"),
        aHiveAppliance(2, "radiator-valve", "Bedroom"),
        aHiveAppliance(3, "hot-water", "Hot Water"),
      ]),
    );

    expect(
      await screen.findByText(/^One on each radiator\. Give each its Room, so that it shows in that Room/),
    ).toBeTruthy();
    for (const title of ["Downstairs", "Bedroom", "Hot Water"]) {
      expect(screen.getByRole("button", { name: `Edit ${title}` })).toBeTruthy();
    }
  });

  it("lists Hive's Appliances, each to be given a Room, even while Hive can't say whether it accepts the tokens", async () => {
    const appliances = fakeAppliancesApi([aHiveAppliance(1, "heating", "Downstairs")]);
    render(
      <HiveSection
        appliances={{
          ...appliances,
          readHive: () => Promise.reject(new HubRequestFailed("Hive took too long to answer.")),
        }}
        rooms={fakeRoomsApi(ROOMS)}
        roomsVersion={0}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe("Hive took too long to answer.");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Downstairs" }));
    const form = screen.getByRole("form", { name: "Edit Downstairs" });
    const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
    fireEvent.change(select, {
      target: { value: within(select).getByRole<HTMLOptionElement>("option", { name: "Living room" }).value },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(shownGroups()).toEqual([["Heating zones", ["Living room · Downstairs"]]]);
    });
    expect(appliances.current()).toMatchObject([{ id: 1, roomId: 1 }]);
  });

  it("signs out, once asked to make sure, removing every one of Hive's Appliances and nothing else", async () => {
    const appliances = fakeAppliancesApi([
      aTv(1, "TV", 1),
      aHiveAppliance(2, "heating", "Downstairs", 1),
      aHiveAppliance(3, "radiator-valve", "Bedroom"),
      aHiveAppliance(4, "hot-water", "Hot Water"),
    ]);
    renderSection(appliances);
    await screen.findByText("Signed in to Hive");

    fireEvent.click(screen.getByRole("button", { name: "Sign out of Hive" }));
    fireEvent.click(screen.getByRole("button", { name: "No, stay signed in" }));
    expect(appliances.current()).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Sign out of Hive" }));
    expect(screen.getByText(/^Sign out of Hive\? The Hub forgets its sign-in/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, sign out" }));

    await signInForm();
    expect(shownGroups()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Sign out of Hive" })).toBeNull();
    expect(appliances.current().map(({ name }) => name)).toEqual(["TV"]);
  });
});
