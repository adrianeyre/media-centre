import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AirConditionerCapabilities } from "@media-centre/shared";

import { AirconTab, airConditionerWidgetId, airconWidgetLayouts } from "./aircon-tab.tsx";
import { anAirConditioner, aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";
import { AIRCON_WIDGET_LAYOUT_KEY, TV_WIDGET_LAYOUT_KEY, loadWidgetLayout } from "./widget-layout.ts";

afterEach(cleanup);

const LIVING_ROOM = { id: 1, name: "Living room" };
const BEDROOM = { id: 2, name: "Bedroom" };

const LIVING = anAirConditioner(3, "Aircon", LIVING_ROOM.id);
const BEDROOM_UNIT = anAirConditioner(4, "Aircon", BEDROOM.id);
const LOFT = anAirConditioner(5, "Loft", null);

/** A unit with fewer controls, as a small Midea unit reports them: cool and fan, whole degrees, two fan steps. */
const SMALL: AirConditionerCapabilities = {
  power: true,
  modes: [
    { mode: "cool", temperature: { min: 17, max: 30, step: 1 } },
    { mode: "fan", temperature: null },
  ],
  fan: { speeds: ["low", "high"], auto: false },
  swing: { vertical: false, horizontal: false },
  presets: ["sleep"],
  display: false,
  temperatures: { room: true, outdoor: false },
  functions: [],
};

const renderTab = (
  appliances: FakeAppliancesApi,
  onOpenSettings = () => undefined,
  refreshMs = 60_000,
  storage = memoryStorage(),
) =>
  render(
    <AirconTab
      appliances={appliances}
      rooms={fakeRoomsApi([LIVING_ROOM.name, BEDROOM.name])}
      storage={storage}
      onOpenSettings={onOpenSettings}
      refreshMs={refreshMs}
      airConditionerRefreshMs={refreshMs}
    />,
  );

const card = (title: string) => screen.getByRole("region", { name: title });
const group = (title: string, name: string) => within(card(title)).getByRole("group", { name });
const radio = (title: string, groupName: string, name: string) =>
  within(group(title, groupName)).getByRole<HTMLInputElement>("radio", { name });
const toggle = (title: string, name: string) => within(card(title)).getByRole("button", { name });
const slider = (title: string) =>
  within(card(title)).getByRole<HTMLInputElement>("slider", { name: "Target temperature" });
const target = (title: string) =>
  within(card(title)).getByRole("status", { name: "Target temperature set" }).textContent;
const summary = (title: string) => card(title).querySelector(".aircon-summary")?.textContent;

/** Waits until the card has read the unit, as it does as it is first shown. */
const answered = async (title: string): Promise<void> => {
  await waitFor(() => {
    expect(within(card(title)).getByRole("button", { name: "Power" }).hasAttribute("disabled")).toBe(false);
  });
};

describe("the Aircon tab (FR-49)", () => {
  it('lists every Air Conditioner under its Room, in Room order, with "No room" last', async () => {
    const appliances = fakeAppliancesApi([LOFT, aTv(9, "TV", BEDROOM.id), BEDROOM_UNIT, LIVING]);
    renderTab(appliances);

    expect(screen.getByRole("heading", { name: "Aircon", level: 1 })).toBeTruthy();
    await screen.findByRole("region", { name: "Living room · Aircon" });
    // Each is a widget of its own, named Room · Name, in Room order, each Room's starting below the last's.
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Living room · Aircon",
      "Bedroom · Aircon",
      "Loft",
    ]);
    const tops = [LIVING, BEDROOM_UNIT, LOFT].map((each) =>
      document.querySelector<HTMLElement>(`[data-widget="${airConditionerWidgetId(each.id)}"]`),
    );
    expect(tops.map((widget) => widget?.querySelector("h2")?.textContent)).toEqual([
      "Living room · Aircon",
      "Bedroom · Aircon",
      "Loft",
    ]);
    expect(tops.map((widget) => widget?.style.transform)).toEqual([
      "translate(0px, 0px)",
      "translate(0px, 1512px)",
      "translate(0px, 3024px)",
    ]);
    expect(screen.queryByText("TV")).toBeNull();
  });

  it("shows each one's power, mode, target temperature and the room temperature it reports", async () => {
    const appliances = fakeAppliancesApi([LIVING, LOFT]);
    appliances.setAirConditionerState(LIVING.id, {
      power: true,
      mode: "heat",
      targetTemperature: 21.5,
      roomTemperature: 18.3,
      outdoorTemperature: -2,
    });
    renderTab(appliances);
    await answered("Living room · Aircon");
    await answered("Loft");

    expect(summary("Living room · Aircon")).toBe("Heat, set to 21.5°");
    expect(toggle("Living room · Aircon", "Power").getAttribute("aria-pressed")).toBe("true");
    expect(radio("Living room · Aircon", "Mode", "Heat").checked).toBe(true);
    expect(target("Living room · Aircon")).toBe("21.5°");
    const temperatures = card("Living room · Aircon").querySelector(".aircon-temperatures")?.textContent;
    expect(temperatures).toBe("Room18.3°Outdoor-2°");

    expect(summary("Loft")).toBe("Off");
    expect(toggle("Loft", "Power").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows how to add one when there are none, and opens Settings (FR-6)", async () => {
    const onOpenSettings = vi.fn();
    renderTab(fakeAppliancesApi([aTv(1, "TV", null)]), onOpenSettings);

    const empty = await screen.findByRole("region", { name: "No Air Conditioners yet" });
    expect(empty.textContent).toContain("tap Find Air Conditioners");
    fireEvent.click(within(empty).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("says why when it can't ask the Hub", async () => {
    renderTab({ ...fakeAppliancesApi([LIVING]), list: () => Promise.reject(new Error("offline")) });

    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
  });

  it("follows what the unit's own remote changes, and Air Conditioners added on another Remote, while it is open", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    renderTab(appliances, () => undefined, 20);
    await answered("Living room · Aircon");

    appliances.setAirConditionerState(LIVING.id, { power: true, mode: "dry", targetTemperature: 25 });
    await waitFor(() => {
      expect(summary("Living room · Aircon")).toBe("Dry, set to 25°");
    });
    expect(radio("Living room · Aircon", "Mode", "Dry").checked).toBe(true);

    await appliances.add({
      kind: "air-conditioner",
      address: "192.168.1.50",
      name: "Loft",
      roomId: null,
      login: {
        account: "owner@example.com",
        password: "correct horse battery staple",
      },
    });
    await screen.findByRole("region", { name: "Loft" });
  });
});

describe("an Air Conditioner's controls (FR-50)", () => {
  it("has every control the unit reports, each of which changes it", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    renderTab(appliances);
    const title = "Living room · Aircon";
    await answered(title);

    fireEvent.click(toggle(title, "Power"));
    await waitFor(() => {
      expect(toggle(title, "Power").getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(radio(title, "Mode", "Heat"));
    fireEvent.click(within(card(title)).getByRole("button", { name: "Raise the target temperature" }));
    fireEvent.click(radio(title, "Fan speed", "Silent"));
    fireEvent.click(within(group(title, "Swing")).getByRole("button", { name: "Up and down" }));
    fireEvent.click(within(group(title, "Swing")).getByRole("button", { name: "Side to side" }));
    fireEvent.click(within(group(title, "Preset")).getByRole("button", { name: "Eco" }));
    fireEvent.click(within(group(title, "More")).getByRole("button", { name: "Display" }));
    fireEvent.click(within(group(title, "More")).getByRole("button", { name: "Self-clean" }));
    fireEvent.change(within(group(title, "More")).getByRole("combobox", { name: "Breeze" }), {
      target: { value: "mild" },
    });

    await waitFor(() => {
      expect(appliances.airConditionerChanges.at(-1)).toMatchObject({ change: { functions: { breeze: "mild" } } });
    });
    // Sent as they came, one at a time, those made while one was on its way together.
    const sent = appliances.airConditionerChanges.reduce((all, { change }) => ({ ...all, ...change }), {});
    expect(sent).toMatchObject({
      power: true,
      mode: "heat",
      targetTemperature: 22.5,
      fanSpeed: "silent",
      preset: "eco",
      display: false,
    });
    await waitFor(() => {
      expect(summary(title)).toBe("Heat, set to 22.5°");
    });
    expect(radio(title, "Fan speed", "Silent").checked).toBe(true);
    for (const name of ["Up and down", "Side to side", "Eco", "Self-clean"]) {
      expect(toggle(title, name).getAttribute("aria-pressed")).toBe("true");
    }
    expect(toggle(title, "Display").getAttribute("aria-pressed")).toBe("false");
    expect(within(card(title)).getByRole<HTMLSelectElement>("combobox", { name: "Breeze" }).value).toBe("mild");

    // A preset on is switched off by tapping it again, and another takes its place.
    fireEvent.click(toggle(title, "Turbo"));
    await waitFor(() => {
      expect(toggle(title, "Turbo").getAttribute("aria-pressed")).toBe("true");
    });
    expect(toggle(title, "Eco").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle(title, "Turbo"));
    await waitFor(() => {
      expect(appliances.airConditionerChanges.at(-1)?.change).toEqual({ preset: null });
    });
    expect(within(card(title)).queryByRole("alert")).toBeNull();
  });

  it("shows only the controls of a unit with fewer, and none it hasn't", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    appliances.setAirConditionerCapabilities(LIVING.id, SMALL);
    renderTab(appliances);
    const title = "Living room · Aircon";
    await answered(title);

    expect(
      within(group(title, "Mode"))
        .getAllByRole("radio")
        .map((each) => each.getAttribute("value")),
    ).toEqual(["cool", "fan"]);
    expect(
      within(group(title, "Fan speed"))
        .getAllByRole("radio")
        .map((each) => each.getAttribute("value")),
    ).toEqual(["low", "high"]);
    expect(
      within(group(title, "Preset"))
        .getAllByRole("button")
        .map((each) => each.textContent),
    ).toEqual(["Sleep"]);
    expect(within(card(title)).queryByRole("group", { name: "Swing" })).toBeNull();
    expect(within(card(title)).queryByRole("group", { name: "More" })).toBeNull();
    expect(within(card(title)).queryByRole("button", { name: "Display" })).toBeNull();
    expect(card(title).querySelector(".aircon-temperatures")?.textContent).toBe("Room24.5°");
  });

  it("leaves out power and the target temperature for a unit that has neither", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    appliances.setAirConditionerCapabilities(LIVING.id, {
      ...SMALL,
      power: false,
      modes: [{ mode: "fan", temperature: null }],
      temperatures: { room: false, outdoor: false },
    });
    appliances.setAirConditionerState(LIVING.id, { mode: "fan" });
    renderTab(appliances);
    const title = "Living room · Aircon";
    await waitFor(() => {
      expect(radio(title, "Mode", "Fan").checked).toBe(true);
    });

    expect(within(card(title)).queryByRole("button", { name: "Power" })).toBeNull();
    expect(within(card(title)).queryByRole("group", { name: "Target temperature" })).toBeNull();
    expect(card(title).querySelector(".aircon-temperatures")).toBeNull();
  });

  it("takes the target temperature within the current mode's range, in the unit's steps", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    appliances.setAirConditionerState(LIVING.id, { power: true, mode: "heat", targetTemperature: 30.5 });
    renderTab(appliances);
    const title = "Living room · Aircon";
    await answered(title);
    const raise = () => within(card(title)).getByRole("button", { name: "Raise the target temperature" });
    const lower = () => within(card(title)).getByRole("button", { name: "Lower the target temperature" });

    // Heat takes 17° to 31° in half degrees.
    expect([slider(title).min, slider(title).max, slider(title).step]).toEqual(["17", "31", "0.5"]);
    expect(within(card(title)).getByText("17° to 31° in heat mode, in half degrees.")).toBeTruthy();
    fireEvent.click(raise());
    await waitFor(() => {
      expect(target(title)).toBe("31°");
    });
    expect(raise().hasAttribute("disabled")).toBe(true);
    expect(appliances.airConditionerChanges.at(-1)?.change).toEqual({ targetTemperature: 31 });

    // Auto takes 18° to 28°: the unit takes the nearest it has.
    fireEvent.click(radio(title, "Mode", "Auto"));
    await waitFor(() => {
      expect(target(title)).toBe("28°");
    });
    expect([slider(title).min, slider(title).max]).toEqual(["18", "28"]);
    fireEvent.input(slider(title), { target: { value: "19.5" } });
    await waitFor(() => {
      expect(appliances.airConditionerChanges.at(-1)?.change).toEqual({ targetTemperature: 19.5 });
    });
    fireEvent.click(lower());
    fireEvent.click(lower());
    fireEvent.click(lower());
    await waitFor(() => {
      expect(target(title)).toBe("18°");
    });
    expect(lower().hasAttribute("disabled")).toBe(true);

    // Fan mode takes none.
    fireEvent.click(radio(title, "Mode", "Fan"));
    await waitFor(() => {
      expect(slider(title).disabled).toBe(true);
    });
    expect(target(title)).toBe("–");
    expect(within(card(title)).getByText("Fan mode takes no target temperature.")).toBeTruthy();
  });

  it("steps in whole degrees on a unit that takes no half degrees", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    appliances.setAirConditionerCapabilities(LIVING.id, SMALL);
    renderTab(appliances);
    const title = "Living room · Aircon";
    await answered(title);

    expect([slider(title).min, slider(title).max, slider(title).step]).toEqual(["17", "30", "1"]);
    fireEvent.click(within(card(title)).getByRole("button", { name: "Lower the target temperature" }));
    await waitFor(() => {
      expect(appliances.airConditionerChanges).toEqual([{ id: LIVING.id, change: { targetTemperature: 21 } }]);
    });
    expect(target(title)).toBe("21°");
  });

  it("shows each change at once, and sends only the latest once the one before has gone", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    renderTab(appliances);
    const title = "Living room · Aircon";
    await answered(title);
    const raise = within(card(title)).getByRole("button", { name: "Raise the target temperature" });

    const release = appliances.holdNextAirConditionerChange();
    fireEvent.click(raise);
    fireEvent.click(raise);
    fireEvent.click(raise);
    expect(target(title)).toBe("23.5°");
    release();

    await waitFor(() => {
      expect(appliances.airConditionerChanges.map(({ change }) => change)).toEqual([
        { targetTemperature: 22.5 },
        { targetTemperature: 23.5 },
      ]);
    });
    expect(target(title)).toBe("23.5°");
  });

  it("says why the Hub refused a change, and shows what the unit says instead", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    renderTab(appliances);
    const title = "Living room · Aircon";
    await answered(title);

    appliances.refuseNextAirConditionerChange("This Air Conditioner has no heat mode.");
    fireEvent.click(radio(title, "Mode", "Heat"));

    expect((await within(card(title)).findByRole("alert")).textContent).toBe("This Air Conditioner has no heat mode.");
    await waitFor(() => {
      expect(radio(title, "Mode", "Cool").checked).toBe(true);
    });
  });
});

describe("an Air Conditioner that doesn't answer (FR-51a)", () => {
  it('says "Can\'t reach this Air Conditioner" with its controls disabled, until it answers again', async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    renderTab(appliances, () => undefined, 20);
    const title = "Living room · Aircon";
    await answered(title);

    appliances.setAirConditionerAnswering(LIVING.id, "unreachable");
    await waitFor(() => {
      expect(summary(title)).toBe("Can't reach this Air Conditioner");
    });
    const controls = card(title).querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      "button, input, select",
    );
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) expect(control.disabled, control.outerHTML).toBe(true);
    // Never a value it can't read now.
    expect(radio(title, "Mode", "Cool").checked).toBe(false);
    expect(target(title)).toBe("–");
    expect(toggle(title, "Power").hasAttribute("aria-pressed")).toBe(false);

    appliances.setAirConditionerAnswering(LIVING.id, null);
    await answered(title);
    expect(summary(title)).toBe("Off");
    expect(radio(title, "Mode", "Cool").checked).toBe(true);
  });

  it("says so from the first, with no controls, when it has never answered, and shows them once it does", async () => {
    const appliances = fakeAppliancesApi([LIVING]);
    appliances.setAirConditionerAnswering(LIVING.id, "unreachable");
    renderTab(appliances, () => undefined, 20);
    const title = "Living room · Aircon";

    await waitFor(() => {
      expect(summary(title)).toBe("Can't reach this Air Conditioner");
    });
    expect(within(card(title)).queryByRole("button", { name: "Power" })).toBeNull();

    appliances.setAirConditionerAnswering(LIVING.id, null);
    await answered(title);
    expect(appliances.capabilitiesReads.length).toBeGreaterThanOrEqual(2);
    const reads = appliances.capabilitiesReads.length;
    await waitFor(() => {
      expect(appliances.airConditionerReads.length).toBeGreaterThan(reads + 2);
    });
    // Its controls don't change, so they are read no more once it has said them.
    expect(appliances.capabilitiesReads).toHaveLength(reads);
  });

  it("says one that refuses the Hub's token and key needs them fetched again in Settings (FR-51)", async () => {
    const onOpenSettings = vi.fn();
    const appliances = fakeAppliancesApi([LIVING]);
    appliances.setAirConditionerAnswering(LIVING.id, "fetch-again");
    renderTab(appliances, onOpenSettings);
    const title = "Living room · Aircon";

    await waitFor(() => {
      expect(summary(title)).toBe("This Air Conditioner no longer accepts the Hub's token and key.");
    });
    fireEvent.click(within(card(title)).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe("the Aircon tab's widgets (FR-58)", () => {
  const placeOf = (storage: ReturnType<typeof memoryStorage>, id: number) =>
    loadWidgetLayout(storage, AIRCON_WIDGET_LAYOUT_KEY).layouts[4]?.[airConditionerWidgetId(id)];

  it("has a widget for each Air Conditioner, listed in the Widgets menu, to hide and show again", async () => {
    const storage = memoryStorage();
    renderTab(fakeAppliancesApi([LIVING, BEDROOM_UNIT]), () => undefined, 60_000, storage);
    await answered("Bedroom · Aircon");

    fireEvent.click(screen.getByRole("button", { name: "Hide Living room · Aircon" }));
    expect(screen.queryByRole("region", { name: "Living room · Aircon" })).toBeNull();
    expect(placeOf(storage, BEDROOM_UNIT.id)).toEqual({ x: 0, y: 0, w: 4, h: 42 });

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    const menu = screen.getByRole("group", { name: "Show on the Aircon tab" });
    expect(
      within(menu)
        .getAllByRole("checkbox")
        .map((each) => each.parentElement?.textContent),
    ).toEqual(["Living room · Aircon", "Bedroom · Aircon"]);
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Living room · Aircon" }));
    await answered("Living room · Aircon");
    expect(placeOf(storage, LIVING.id)).toEqual({ x: 0, y: 0, w: 4, h: 42 });
    expect(placeOf(storage, BEDROOM_UNIT.id)).toEqual({ x: 0, y: 42, w: 4, h: 42 });
  });

  it("moves and resizes each with the keyboard on its grip, or its grip's menu, with no dragging (WCAG 2.5.7)", async () => {
    const storage = memoryStorage();
    const all = fakeAppliancesApi([LIVING, BEDROOM_UNIT]);
    renderTab(all, () => undefined, 60_000, storage);
    await answered("Bedroom · Aircon");

    // Moved down onto the Bedroom's, the two swap.
    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Living room · Aircon" }), { key: "ArrowDown" });
    expect(placeOf(storage, BEDROOM_UNIT.id)).toEqual({ x: 0, y: 0, w: 4, h: 42 });
    expect(placeOf(storage, LIVING.id)).toEqual({ x: 0, y: 42, w: 4, h: 42 });
    expect(document.querySelector(".widget-board > [role='status']")?.textContent).toBe(
      "Living room · Aircon: column 1, row 43, 4 wide and 42 tall.",
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Bedroom · Aircon" }), {
      key: "ArrowUp",
      shiftKey: true,
    });
    expect(placeOf(storage, BEDROOM_UNIT.id)).toEqual({ x: 0, y: 0, w: 4, h: 41 });

    const grip = screen.getByRole("button", { name: "Arrange Living room · Aircon" });
    fireEvent.click(grip, { detail: 0 });
    const menu = screen.getByRole("group", { name: "Arrange Living room · Aircon" });
    fireEvent.click(within(menu).getByRole("button", { name: "Move up" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Narrower" }));
    expect(placeOf(storage, LIVING.id)).toEqual({ x: 0, y: 0, w: 3, h: 42 });
    // Its controls still reach the Air Conditioner wherever it is.
    fireEvent.click(toggle("Living room · Aircon", "Power"));
    await waitFor(() => {
      expect(all.airConditionerChanges).toEqual([{ id: LIVING.id, change: { power: true } }]);
    });
  });

  it("is remembered under the Aircon tab's own key, never the TV tab's, and put back where it started", async () => {
    const tv = JSON.stringify({ hidden: ["keys"], layouts: {} });
    const storage = memoryStorage({ [TV_WIDGET_LAYOUT_KEY]: tv });
    const all = fakeAppliancesApi([LIVING, BEDROOM_UNIT]);
    const first = renderTab(all, () => undefined, 60_000, storage);
    await answered("Bedroom · Aircon");

    fireEvent.click(screen.getByRole("button", { name: "Hide Bedroom · Aircon" }));
    expect(loadWidgetLayout(storage, AIRCON_WIDGET_LAYOUT_KEY).hidden).toEqual([
      airConditionerWidgetId(BEDROOM_UNIT.id),
    ]);
    expect(storage.items[TV_WIDGET_LAYOUT_KEY]).toBe(tv);

    // Opened again, as this Remote left it.
    first.unmount();
    renderTab(all, () => undefined, 60_000, storage);
    await answered("Living room · Aircon");
    expect(screen.queryByRole("region", { name: "Bedroom · Aircon" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    await answered("Bedroom · Aircon");
    expect(storage.items[AIRCON_WIDGET_LAYOUT_KEY]).toBe(JSON.stringify({ hidden: [], layouts: {} }));
    expect(storage.items[TV_WIDGET_LAYOUT_KEY]).toBe(tv);
  });

  it("fits an Air Conditioner added on another Remote in, leaving the rest where this Remote put them", async () => {
    const storage = memoryStorage();
    const all = fakeAppliancesApi([BEDROOM_UNIT]);
    renderTab(all, () => undefined, 20, storage);
    await answered("Bedroom · Aircon");
    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Bedroom · Aircon" }), {
      key: "ArrowDown",
      shiftKey: true,
    });

    await all.add({
      kind: "air-conditioner",
      address: "192.168.1.50",
      name: "Aircon",
      roomId: LIVING_ROOM.id,
      login: { account: "owner@example.com", password: "correct horse battery staple" },
    });
    await screen.findByRole("region", { name: "Living room · Aircon" });

    const top = (title: string) =>
      screen.getByRole("region", { name: title }).closest<HTMLElement>(".widget")?.style.transform;
    expect(top("Bedroom · Aircon")).toBe("translate(0px, 0px)");
    expect(top("Living room · Aircon")).toBe("translate(0px, 1548px)");
    expect(placeOf(storage, BEDROOM_UNIT.id)).toEqual({ x: 0, y: 0, w: 4, h: 43 });
  });
});

describe("the Aircon tab's widgets, as they start (FR-58)", () => {
  it("are side by side in Room order, as far as the grid has room, whatever Room each is in", () => {
    const layouts = airconWidgetLayouts([
      { heading: LIVING_ROOM.name, appliances: [LIVING] },
      { heading: BEDROOM.name, appliances: [BEDROOM_UNIT] },
      { heading: "No room", appliances: [LOFT] },
    ]);
    const at = (columns: number) =>
      [LIVING, BEDROOM_UNIT, LOFT].map(({ id }) => {
        const { x, y } = layouts[columns]?.[airConditionerWidgetId(id)] ?? { x: -1, y: -1 };
        return [x, y];
      });

    // Three across on a desktop, two on a tablet, one on a phone.
    expect(at(12)).toEqual([
      [0, 0],
      [4, 0],
      [8, 0],
    ]);
    expect(at(8)).toEqual([
      [0, 0],
      [4, 0],
      [0, 42],
    ]);
    expect(at(4)).toEqual([
      [0, 0],
      [0, 42],
      [0, 84],
    ]);
  });
});
