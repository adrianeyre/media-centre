import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LightCapabilities } from "@media-centre/shared";

import {
  LightsTab,
  lightScenesWidgetId,
  lightsWidgetLayouts,
  lightWidgetId,
  roomLightsWidgetId,
} from "./lights-tab.tsx";
import {
  aLight,
  anAirConditioner,
  aTv,
  fakeAppliancesApi,
  FAKE_LIGHT_KEY,
  PLUG_CAPABILITIES,
  type FakeAppliancesApi,
} from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";
import {
  AIRCON_WIDGET_LAYOUT_KEY,
  LIGHTS_WIDGET_LAYOUT_KEY,
  TV_WIDGET_LAYOUT_KEY,
  loadWidgetLayout,
} from "./widget-layout.ts";

afterEach(cleanup);

const LIVING_ROOM = { id: 1, name: "Living room" };
const BEDROOM = { id: 2, name: "Bedroom" };

const LAMP = aLight(3, "Lamp", LIVING_ROOM.id);
const PLUG = aLight(4, "Plug", LIVING_ROOM.id);
const BEDSIDE = aLight(5, "Lamp", BEDROOM.id);
const STRIP = aLight(6, "Strip", null);

/** A white bulb: on/off, brightness and colour temperature, but no colours. */
const WHITE: LightCapabilities = {
  onOff: true,
  brightness: true,
  colourTemperature: { min: 2_700, max: 6_500 },
  colour: false,
};

/** The Living room's Lamp and Plug, which is a smart plug, the Bedroom's Lamp, and a Strip in no Room. */
const home = (): FakeAppliancesApi => {
  // In the order they were added, as the Hub lists them.
  const appliances = fakeAppliancesApi([LAMP, PLUG, BEDSIDE, STRIP, aTv(9, "TV", LIVING_ROOM.id)]);
  appliances.setLightCapabilities(PLUG.id, PLUG_CAPABILITIES);
  return appliances;
};

const renderTab = (
  appliances: FakeAppliancesApi,
  { onOpenSettings = () => undefined, refreshMs = 60_000, storage = memoryStorage() } = {},
) =>
  render(
    <LightsTab
      appliances={appliances}
      rooms={fakeRoomsApi([LIVING_ROOM.name, BEDROOM.name])}
      storage={storage}
      onOpenSettings={onOpenSettings}
      refreshMs={refreshMs}
      lightRefreshMs={refreshMs}
    />,
  );

const card = (title: string) => screen.getByRole("region", { name: title });
const button = (title: string, name: string) => within(card(title)).getByRole<HTMLButtonElement>("button", { name });
const slider = (title: string, name: string) => within(card(title)).getByRole<HTMLInputElement>("slider", { name });
const shown = (title: string, name: string) =>
  within(card(title)).getByRole("status", { name: `${name} set` }).textContent;
const radio = (title: string, name: string) =>
  within(within(card(title)).getByRole("group", { name: "Shows" })).getByRole<HTMLInputElement>("radio", { name });
const summary = (title: string) => card(title).querySelector(".light-summary")?.textContent;

/** Waits until the Light's widget has read it, as it does as it is first shown. */
const answered = async (title: string): Promise<void> => {
  await waitFor(() => {
    expect(button(title, "Power").disabled).toBe(false);
  });
};

/** Waits until every Light in the home has been read. */
const allAnswered = async (): Promise<void> => {
  for (const title of ["Living room · Lamp", "Living room · Plug", "Bedroom · Lamp", "Strip"]) await answered(title);
};

const changeSlider = (input: HTMLInputElement, value: number): void => {
  fireEvent.input(input, { target: { value: String(value) } });
};

describe("the Lights tab (FR-52)", () => {
  it('lists every Light under its Room, in Room order, each Room\'s Room-wide control and Light Scenes first, with "No room" last', async () => {
    renderTab(home());

    expect(screen.getByRole("heading", { name: "Lights", level: 1 })).toBeTruthy();
    await screen.findByRole("region", { name: "Living room · Lamp" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Living room Lights",
      "Living room Light Scenes",
      "Living room · Lamp",
      "Living room · Plug",
      "Bedroom Lights",
      "Bedroom Light Scenes",
      "Bedroom · Lamp",
      "Strip",
    ]);
    expect(screen.queryByRole("region", { name: "Living room · TV" })).toBeNull();
    await allAnswered();
    expect(summary("Living room · Lamp")).toBe("On, 100%, 4,600 K");
    expect(summary("Living room · Plug")).toBe("On");
    expect(summary("Living room Lights")).toBe("2 on");
  });

  it("shows how to add one when there are none, and opens Settings (FR-6)", async () => {
    const onOpenSettings = vi.fn();
    renderTab(fakeAppliancesApi([aTv(1, "TV", null), anAirConditioner(2, "Aircon", null)]), { onOpenSettings });

    const empty = await screen.findByRole("region", { name: "No Lights yet" });
    expect(empty.textContent).toContain("tap Find Lights");
    fireEvent.click(within(empty).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("says why when it can't ask the Hub", async () => {
    renderTab({ ...home(), list: () => Promise.reject(new Error("offline")) });

    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
  });

  it("follows what the Light's maker's app changes, and Lights added on another Remote, while it is open", async () => {
    const appliances = home();
    renderTab(appliances, { refreshMs: 20 });
    await answered("Living room · Lamp");

    appliances.setLightState(LAMP.id, {
      on: true,
      brightness: 30,
      colourTemperature: null,
      colour: { hue: 240, saturation: 100 },
    });
    await waitFor(() => {
      expect(summary("Living room · Lamp")).toBe("On, 30%, blue colour");
    });
    expect(radio("Living room · Lamp", "Colour").checked).toBe(true);
    expect(shown("Living room · Lamp", "Hue")).toBe("240°");

    await appliances.add({
      kind: "light",
      address: "192.168.1.90",
      name: "Hall",
      roomId: null,
      light: { id: "bf0123456789abcdef01", key: FAKE_LIGHT_KEY },
    });
    await screen.findByRole("region", { name: "Hall" });
  });
});

describe("a Light's controls (FR-52)", () => {
  it("has on/off, brightness, white at a colour temperature and colour, each of which changes it", async () => {
    const appliances = home();
    renderTab(appliances);
    const title = "Living room · Lamp";
    await answered(title);
    const sent = () => appliances.lightChanges.filter(({ id }) => id === LAMP.id).map(({ change }) => change);
    /** Waits for the change to reach the Light, as each is sent once the one before has gone. */
    const reaches = async (change: unknown): Promise<void> => {
      await waitFor(() => {
        expect(sent().at(-1)).toEqual(change);
      });
    };

    fireEvent.click(button(title, "Power"));
    await reaches({ on: false });
    expect(summary(title)).toBe("Off");
    expect(button(title, "Power").getAttribute("aria-pressed")).toBe("false");
    changeSlider(slider(title, "Brightness"), 30);
    await reaches({ brightness: 30 });
    expect(shown(title, "Brightness")).toBe("30%");
    expect(slider(title, "Colour temperature").getAttribute("aria-valuetext")).toBe("4,600 K, neutral");
    changeSlider(slider(title, "Colour temperature"), 2_700);
    await reaches({ colourTemperature: 2_700 });
    expect(shown(title, "Colour temperature")).toBe("2,700 K");
    expect(slider(title, "Colour temperature").getAttribute("aria-valuetext")).toBe("2,700 K, warm");
    expect(within(card(title)).queryByRole("slider", { name: "Hue" })).toBeNull();

    // Colour, from where it was, then its hue and saturation.
    fireEvent.click(radio(title, "Colour"));
    await reaches({ colour: { hue: 0, saturation: 100 } });
    expect(shown(title, "Hue")).toBe("0°");
    expect(within(card(title)).queryByRole("slider", { name: "Colour temperature" })).toBeNull();
    changeSlider(slider(title, "Hue"), 120);
    await reaches({ colour: { hue: 120, saturation: 100 } });
    expect(slider(title, "Hue").getAttribute("aria-valuetext")).toBe("120°, green");
    changeSlider(slider(title, "Saturation"), 40);
    await reaches({ colour: { hue: 120, saturation: 40 } });
    expect(shown(title, "Saturation")).toBe("40%");
    expect(summary(title)).toBe("Off");
    // And white again, at the colour temperature it had.
    fireEvent.click(radio(title, "White"));
    await reaches({ colourTemperature: 2_700 });
    expect(sent()).toHaveLength(7);
    expect(within(card(title)).queryByRole("alert")).toBeNull();
  });

  it("shows a smart plug's on/off alone, and a white bulb's no colours", async () => {
    const appliances = home();
    appliances.setLightCapabilities(BEDSIDE.id, WHITE);
    renderTab(appliances);
    await answered("Living room · Plug");
    await answered("Bedroom · Lamp");

    const plug = card("Living room · Plug");
    expect(
      within(plug)
        .getAllByRole("button")
        .map((each) => each.textContent),
    ).toEqual(["Power"]);
    expect(within(plug).queryAllByRole("slider")).toEqual([]);
    expect(within(plug).queryAllByRole("radio")).toEqual([]);

    const white = card("Bedroom · Lamp");
    expect(
      within(white)
        .getAllByRole("slider")
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual(["Brightness", "Colour temperature"]);
    expect(within(white).queryAllByRole("radio")).toEqual([]);
  });

  it("has no Room-wide brightness in a Room whose Lights don't dim", async () => {
    const appliances = home();
    appliances.setLightCapabilities(BEDSIDE.id, PLUG_CAPABILITIES);
    renderTab(appliances);
    await answered("Bedroom · Lamp");
    expect(within(card("Bedroom Lights")).queryByRole("slider")).toBeNull();
    expect(within(card("Living room Lights")).getByRole("slider", { name: "Brightness" })).toBeTruthy();
  });

  it("shows each change at once, and sends only the latest once the one before has gone", async () => {
    const appliances = home();
    renderTab(appliances);
    const title = "Living room · Lamp";
    await answered(title);

    const release = appliances.holdNextLightChange();
    for (const value of [80, 60, 40]) changeSlider(slider(title, "Brightness"), value);
    expect(shown(title, "Brightness")).toBe("40%");
    release();

    await waitFor(() => {
      expect(appliances.lightChanges.map(({ change }) => change)).toEqual([{ brightness: 80 }, { brightness: 40 }]);
    });
    expect(shown(title, "Brightness")).toBe("40%");
  });

  it("says why the Hub refused a change, and shows what the Light says instead", async () => {
    const appliances = home();
    renderTab(appliances);
    const title = "Living room · Lamp";
    await answered(title);

    appliances.refuseNextLightChange("This Light doesn't dim.");
    changeSlider(slider(title, "Brightness"), 20);

    expect((await within(card(title)).findByRole("alert")).textContent).toBe("This Light doesn't dim.");
    await waitFor(() => {
      expect(shown(title, "Brightness")).toBe("100%");
    });
  });
});

describe("a Light that doesn't answer (FR-57b)", () => {
  it('says "Can\'t reach this Light" with its controls disabled, until it answers again', async () => {
    const appliances = home();
    renderTab(appliances, { refreshMs: 20 });
    const title = "Living room · Lamp";
    await answered(title);

    appliances.setLightAnswering(LAMP.id, "unreachable");
    await waitFor(() => {
      expect(summary(title)).toBe("Can't reach this Light");
    });
    const controls = card(title).querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input");
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const control of controls) expect(control.disabled, control.outerHTML).toBe(true);
    // Never a value it can't read now.
    expect(shown(title, "Brightness")).toBe("–");
    expect(radio(title, "White").checked).toBe(false);
    expect(button(title, "Power").hasAttribute("aria-pressed")).toBe(false);
    expect(summary("Living room Lights")).toBe("1 on, 1 can't be reached");

    appliances.setLightAnswering(LAMP.id, null);
    await answered(title);
    expect(summary(title)).toBe("On, 100%, 4,600 K");
  });

  it("says one that no longer answers to the Hub's key needs adding again", async () => {
    const appliances = home();
    appliances.setLightAnswering(LAMP.id, "key-refused");
    renderTab(appliances);
    const title = "Living room · Lamp";

    await waitFor(() => {
      expect(summary(title)).toBe("This Light no longer answers to the Hub's key.");
    });
    expect(card(title).textContent).toContain("Remove it in Settings, and add it again with its new key.");
  });
});

describe("Room-wide control and All off (FR-53)", () => {
  it("switches every Light in the Room off and on with one request, and none outside it", async () => {
    const appliances = home();
    renderTab(appliances);
    await allAnswered();
    const room = within(card("Living room Lights")).getByRole("group", { name: "Every Light in Living room" });

    fireEvent.click(within(room).getByRole("button", { name: "Off" }));
    await waitFor(() => {
      expect(summary("Living room Lights")).toBe("2 off");
    });
    expect(appliances.lightsChanges).toEqual([{ roomId: LIVING_ROOM.id, change: { on: false } }]);
    expect(summary("Living room · Lamp")).toBe("Off");
    expect(summary("Living room · Plug")).toBe("Off");
    expect(summary("Bedroom · Lamp")).toBe("On, 100%, 4,600 K");
    expect(within(card("Living room Lights")).queryByRole("alert")).toBeNull();

    fireEvent.click(within(room).getByRole("button", { name: "On" }));
    await waitFor(() => {
      expect(summary("Living room Lights")).toBe("2 on");
    });
  });

  it("sets the brightness of every Light in the Room that dims, which its slider shows, and leaves a plug as it is", async () => {
    const appliances = home();
    renderTab(appliances);
    await allAnswered();
    const title = "Living room Lights";
    expect(shown(title, "Brightness")).toBe("100%");

    changeSlider(slider(title, "Brightness"), 30);
    await waitFor(() => {
      expect(shown("Living room · Lamp", "Brightness")).toBe("30%");
    });
    expect(appliances.lightsChanges).toEqual([{ roomId: LIVING_ROOM.id, change: { brightness: 30 } }]);
    expect(shown(title, "Brightness")).toBe("30%");
    expect(summary("Living room · Plug")).toBe("On");
    expect(shown("Bedroom · Lamp", "Brightness")).toBe("100%");
  });

  it("reaches every Light that answers, and names the one that didn't", async () => {
    const appliances = home();
    renderTab(appliances);
    await allAnswered();
    appliances.setLightAnswering(PLUG.id, "unreachable");

    fireEvent.click(
      within(within(card("Living room Lights")).getByRole("group", { name: "Every Light in Living room" })).getByRole(
        "button",
        { name: "Off" },
      ),
    );
    expect((await within(card("Living room Lights")).findByRole("alert")).textContent).toBe(
      "Couldn't reach Living room · Plug.",
    );
    expect(summary("Living room · Lamp")).toBe("Off");
    expect(summary("Living room · Plug")).toBe("Can't reach this Light");
    expect(summary("Living room Lights")).toBe("1 off, 1 can't be reached");
  });

  it("All off switches every Light in the home off, and says so, or which it couldn't reach", async () => {
    const appliances = home();
    renderTab(appliances);
    await allAnswered();

    fireEvent.click(screen.getByRole("button", { name: "All off" }));
    expect((await screen.findByText("Every Light is off.")).getAttribute("role")).toBe("status");
    expect(appliances.lightsChanges).toEqual([{ roomId: undefined, change: { on: false } }]);
    for (const title of ["Living room · Lamp", "Living room · Plug", "Bedroom · Lamp", "Strip"]) {
      expect(summary(title)).toBe("Off");
    }

    appliances.setLightAnswering(BEDSIDE.id, "unreachable");
    fireEvent.click(screen.getByRole("button", { name: "All off" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't reach Bedroom · Lamp. Every other Light is off.",
    );
    expect(summary("Bedroom · Lamp")).toBe("Can't reach this Light");
  });

  it("says why the Hub refused a Room-wide change", async () => {
    const appliances = home();
    renderTab(appliances);
    await allAnswered();

    appliances.refuseNextLightChange("That Room no longer exists.");
    fireEvent.click(within(card("Bedroom Lights")).getByRole("button", { name: "On" }));
    expect((await within(card("Bedroom Lights")).findByRole("alert")).textContent).toBe("That Room no longer exists.");
  });
});

describe("the Lights tab's widgets (FR-58)", () => {
  const placeOf = (storage: ReturnType<typeof memoryStorage>, id: string, columns = 4) =>
    loadWidgetLayout(storage, LIGHTS_WIDGET_LAYOUT_KEY).layouts[columns]?.[id];

  it("has a widget for each Room's Room-wide control, its Light Scenes and each Light, listed in the Widgets menu, to hide and show again", async () => {
    const storage = memoryStorage();
    renderTab(home(), { storage });
    await allAnswered();

    fireEvent.click(screen.getByRole("button", { name: "Hide Living room · Plug" }));
    expect(screen.queryByRole("region", { name: "Living room · Plug" })).toBeNull();
    expect(placeOf(storage, roomLightsWidgetId(LIVING_ROOM.id))).toEqual({ x: 0, y: 0, w: 4, h: 9 });
    expect(placeOf(storage, lightScenesWidgetId(LIVING_ROOM.id))).toEqual({ x: 0, y: 9, w: 4, h: 9 });
    expect(placeOf(storage, lightWidgetId(LAMP.id))).toEqual({ x: 0, y: 18, w: 4, h: 13 });
    expect(placeOf(storage, roomLightsWidgetId(BEDROOM.id))).toEqual({ x: 0, y: 31, w: 4, h: 9 });

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    const menu = screen.getByRole("group", { name: "Show on the Lights tab" });
    expect(
      within(menu)
        .getAllByRole("checkbox")
        .map((each) => each.parentElement?.textContent),
    ).toEqual([
      "Living room Lights",
      "Living room Light Scenes",
      "Living room · Lamp",
      "Living room · Plug",
      "Bedroom Lights",
      "Bedroom Light Scenes",
      "Bedroom · Lamp",
      "Strip",
    ]);
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Living room · Plug" }));
    await answered("Living room · Plug");
    expect(placeOf(storage, lightWidgetId(PLUG.id))).toEqual({ x: 0, y: 31, w: 4, h: 13 });
  });

  it("start with three Lights side by side on a desktop and two on a tablet, below their Room's control and Light Scenes side by side", () => {
    const layouts = lightsWidgetLayouts([
      { room: LIVING_ROOM, lights: [LAMP, PLUG, aLight(7, "Spot", LIVING_ROOM.id)] },
      { room: BEDROOM, lights: [BEDSIDE] },
      { room: undefined, lights: [STRIP] },
    ]);
    expect(layouts[12]).toEqual({
      [roomLightsWidgetId(LIVING_ROOM.id)]: { x: 0, y: 0, w: 6, h: 9 },
      [lightScenesWidgetId(LIVING_ROOM.id)]: { x: 6, y: 0, w: 6, h: 9 },
      [lightWidgetId(LAMP.id)]: { x: 0, y: 9, w: 4, h: 13 },
      [lightWidgetId(PLUG.id)]: { x: 4, y: 9, w: 4, h: 13 },
      [lightWidgetId(7)]: { x: 8, y: 9, w: 4, h: 13 },
      [roomLightsWidgetId(BEDROOM.id)]: { x: 0, y: 22, w: 6, h: 9 },
      [lightScenesWidgetId(BEDROOM.id)]: { x: 6, y: 22, w: 6, h: 9 },
      [lightWidgetId(BEDSIDE.id)]: { x: 0, y: 31, w: 4, h: 13 },
      [lightWidgetId(STRIP.id)]: { x: 0, y: 44, w: 4, h: 13 },
    });
    expect(layouts[8]?.[lightWidgetId(7)]).toEqual({ x: 0, y: 22, w: 4, h: 13 });
    expect(layouts[8]?.[roomLightsWidgetId(BEDROOM.id)]).toEqual({ x: 0, y: 35, w: 4, h: 9 });
    expect(layouts[8]?.[lightScenesWidgetId(BEDROOM.id)]).toEqual({ x: 4, y: 35, w: 4, h: 9 });
    // On a phone, one above the other, then the Room's Lights.
    expect(layouts[4]?.[lightScenesWidgetId(LIVING_ROOM.id)]).toEqual({ x: 0, y: 9, w: 4, h: 9 });
    expect(layouts[4]?.[lightWidgetId(PLUG.id)]).toEqual({ x: 0, y: 31, w: 4, h: 13 });
    // "No room" has no Light Scenes, as a Light Scene is a Room's.
    expect(Object.keys(layouts[4] ?? {}).filter((id) => id.startsWith("light-scenes-"))).toEqual([
      lightScenesWidgetId(LIVING_ROOM.id),
      lightScenesWidgetId(BEDROOM.id),
    ]);
  });

  it("moves and resizes each with the keyboard on its grip, or its grip's menu, with no dragging (WCAG 2.5.7)", async () => {
    const storage = memoryStorage();
    const appliances = home();
    renderTab(appliances, { storage });
    await allAnswered();

    // Moved down onto the Plug's, the two swap.
    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Living room · Lamp" }), { key: "ArrowDown" });
    expect(placeOf(storage, lightWidgetId(PLUG.id))).toEqual({ x: 0, y: 18, w: 4, h: 13 });
    expect(placeOf(storage, lightWidgetId(LAMP.id))).toEqual({ x: 0, y: 31, w: 4, h: 13 });
    expect(document.querySelector(".widget-board > [role='status']")?.textContent).toBe(
      "Living room · Lamp: column 1, row 32, 4 wide and 13 tall.",
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Living room Lights" }), {
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(placeOf(storage, roomLightsWidgetId(LIVING_ROOM.id))).toEqual({ x: 0, y: 0, w: 4, h: 10 });

    const grip = screen.getByRole("button", { name: "Arrange Living room · Lamp" });
    fireEvent.click(grip, { detail: 0 });
    const menu = screen.getByRole("group", { name: "Arrange Living room · Lamp" });
    fireEvent.click(within(menu).getByRole("button", { name: "Move up" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Narrower" }));
    expect(placeOf(storage, lightWidgetId(LAMP.id))).toEqual({ x: 0, y: 19, w: 3, h: 13 });
    // Its controls still reach the Light wherever it is.
    fireEvent.click(button("Living room · Lamp", "Power"));
    await waitFor(() => {
      expect(appliances.lightChanges).toEqual([{ id: LAMP.id, change: { on: false } }]);
    });
  });

  it("is remembered under the Lights tab's own key, never another tab's, and put back where it started", async () => {
    const tv = JSON.stringify({ hidden: ["keys"], layouts: {} });
    const aircon = JSON.stringify({ hidden: ["air-conditioner-1"], layouts: {} });
    const storage = memoryStorage({ [TV_WIDGET_LAYOUT_KEY]: tv, [AIRCON_WIDGET_LAYOUT_KEY]: aircon });
    const appliances = home();
    const first = renderTab(appliances, { storage });
    await allAnswered();

    fireEvent.click(screen.getByRole("button", { name: "Hide Bedroom Lights" }));
    expect(loadWidgetLayout(storage, LIGHTS_WIDGET_LAYOUT_KEY).hidden).toEqual([roomLightsWidgetId(BEDROOM.id)]);
    expect(storage.items[TV_WIDGET_LAYOUT_KEY]).toBe(tv);
    expect(storage.items[AIRCON_WIDGET_LAYOUT_KEY]).toBe(aircon);

    // Opened again, as this Remote left it.
    first.unmount();
    renderTab(appliances, { storage });
    await answered("Bedroom · Lamp");
    expect(screen.queryByRole("region", { name: "Bedroom Lights" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    await screen.findByRole("region", { name: "Bedroom Lights" });
    expect(storage.items[LIGHTS_WIDGET_LAYOUT_KEY]).toBe(JSON.stringify({ hidden: [], layouts: {} }));
    expect(storage.items[TV_WIDGET_LAYOUT_KEY]).toBe(tv);
  });
});

describe("the Lights tab's Light Scenes (FR-56)", () => {
  const scenes = (room: string) => card(`${room} Light Scenes`);
  const sceneNames = (room: string) =>
    within(scenes(room))
      .queryAllByRole("listitem")
      .map((item) => item.querySelector(".room-name")?.firstChild?.textContent);

  const saveAs = async (room: string, name: string): Promise<void> => {
    fireEvent.click(within(scenes(room)).getByRole("button", { name: "Save as Light Scene" }));
    const form = within(scenes(room)).getByRole("form", { name: `Save ${room}'s Lights as a Light Scene` });
    fireEvent.input(within(form).getByRole("textbox", { name: "Light Scene name" }), { target: { value: name } });
    fireEvent.submit(form);
    // Listed once the Hub has it, as the tab asks again at once.
    await within(scenes(room)).findByRole("button", { name: `Recall ${name}` });
  };

  it("has a widget for each Room's Light Scenes, saying how to make one while it has none", async () => {
    renderTab(home());
    await allAnswered();
    expect(within(scenes("Living room")).getByText(/^No Light Scenes yet\./)).toBeTruthy();
    expect(within(scenes("Bedroom")).getByRole("button", { name: "Save as Light Scene" })).toBeTruthy();
    // "No room" has none.
    expect(screen.queryByRole("region", { name: "No room Light Scenes" })).toBeNull();
  });

  it("saves each of the Room's Lights as it is under the name given, and lists it", async () => {
    const appliances = home();
    appliances.setLightState(LAMP.id, {
      brightness: 30,
      colourTemperature: null,
      colour: { hue: 240, saturation: 100 },
    });
    renderTab(appliances);
    await allAnswered();

    await saveAs("Living room", "Film");
    expect(within(scenes("Living room")).getByRole("status").textContent).toBe('Saved "Film".');
    expect(sceneNames("Living room")).toEqual(["Film"]);
    expect(within(scenes("Living room")).getByRole("listitem").textContent).toContain("2 Lights");
    expect(sceneNames("Bedroom")).toEqual([]);
    expect(await appliances.lightScenes()).toEqual([
      {
        id: 1,
        roomId: LIVING_ROOM.id,
        name: "Film",
        lights: [
          {
            id: LAMP.id,
            state: { on: true, brightness: 30, colourTemperature: null, colour: { hue: 240, saturation: 100 } },
          },
          { id: PLUG.id, state: { on: true, brightness: null, colourTemperature: null, colour: null } },
        ],
      },
    ]);
  });

  it("recalls one, showing each Light's answer in its own widget at once", async () => {
    const appliances = home();
    appliances.setLightState(LAMP.id, {
      brightness: 30,
      colourTemperature: null,
      colour: { hue: 240, saturation: 100 },
    });
    appliances.setLightState(PLUG.id, { on: false });
    const { lightScene } = await appliances.saveLightScene(LIVING_ROOM.id, "Film");
    appliances.setLightState(LAMP.id, { on: false });
    appliances.setLightState(PLUG.id, { on: true });
    renderTab(appliances);
    await allAnswered();
    expect(summary("Living room · Lamp")).toBe("Off");

    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "Recall Film" }));
    await waitFor(() => {
      expect(summary("Living room · Lamp")).toBe("On, 30%, blue colour");
    });
    expect(summary("Living room · Plug")).toBe("Off");
    expect(summary("Living room Lights")).toBe("1 on, 1 off");
    expect(appliances.lightSceneRecalls).toEqual([lightScene.id]);
    expect(within(scenes("Living room")).getByRole("status").textContent).toBe('Recalled "Film".');
  });

  it("names the Lights that didn't answer, saving and recalling (FR-57b)", async () => {
    const appliances = home();
    await appliances.saveLightScene(BEDROOM.id, "Night");
    renderTab(appliances);
    await allAnswered();
    appliances.setLightAnswering(PLUG.id, "unreachable");
    appliances.setLightAnswering(BEDSIDE.id, "unreachable");

    await saveAs("Living room", "Film");
    expect(within(scenes("Living room")).getByRole("alert").textContent).toBe(
      'Saved "Film" without Living room · Plug, which didn\'t answer.',
    );
    expect(within(scenes("Living room")).getByRole("listitem").textContent).toContain("1 Light");

    fireEvent.click(within(scenes("Bedroom")).getByRole("button", { name: "Recall Night" }));
    expect((await within(scenes("Bedroom")).findByRole("alert")).textContent).toBe(
      'Recalled "Night", but couldn\'t reach Bedroom · Lamp.',
    );
    expect(summary("Bedroom · Lamp")).toContain("Can't reach this Light");
  });

  it("renames one, and deletes one once asked to make sure", async () => {
    const appliances = home();
    await appliances.saveLightScene(LIVING_ROOM.id, "Film");
    await appliances.saveLightScene(LIVING_ROOM.id, "Bright");
    renderTab(appliances);
    await allAnswered();
    expect(sceneNames("Living room")).toEqual(["Film", "Bright"]);

    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "Rename Film" }));
    const form = within(scenes("Living room")).getByRole("form", { name: "Rename Film" });
    const name = within(form).getByRole<HTMLInputElement>("textbox", { name: "Light Scene name" });
    expect(name.value).toBe("Film");
    expect(document.activeElement).toBe(name);
    fireEvent.input(name, { target: { value: "Cinema" } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(sceneNames("Living room")).toEqual(["Cinema", "Bright"]);
    });

    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "Delete Bright" }));
    expect(within(scenes("Living room")).getByText("Delete Bright?")).toBeTruthy();
    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "No, keep it" }));
    expect(sceneNames("Living room")).toEqual(["Cinema", "Bright"]);
    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "Delete Bright" }));
    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => {
      expect(sceneNames("Living room")).toEqual(["Cinema"]);
    });
    expect((await appliances.lightScenes()).map(({ name: each }) => each)).toEqual(["Cinema"]);
  });

  it("shows why the Hub refused a name, beside it, keeping what was typed", async () => {
    const appliances = home();
    renderTab(appliances);
    await allAnswered();
    appliances.refuseNextLightScene('There is already a Light Scene called "Film" in Living room.');

    fireEvent.click(within(scenes("Living room")).getByRole("button", { name: "Save as Light Scene" }));
    const form = within(scenes("Living room")).getByRole("form", {
      name: "Save Living room's Lights as a Light Scene",
    });
    const name = within(form).getByRole<HTMLInputElement>("textbox", { name: "Light Scene name" });
    expect(document.activeElement).toBe(name);
    fireEvent.input(name, { target: { value: "film" } });
    fireEvent.submit(form);

    expect((await within(form).findByRole("alert")).textContent).toBe(
      'There is already a Light Scene called "Film" in Living room.',
    );
    expect(name.value).toBe("film");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(name.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      'There is already a Light Scene called "Film" in Living room.',
    );
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(within(scenes("Living room")).queryByRole("alert")).toBeNull();
    expect(await appliances.lightScenes()).toEqual([]);
  });

  it("follows Light Scenes saved, renamed and deleted on another Remote, while it is open", async () => {
    const appliances = home();
    renderTab(appliances, { refreshMs: 20 });
    await answered("Living room · Lamp");

    // Another Remote, through the same Hub.
    const { lightScene } = await appliances.saveLightScene(LIVING_ROOM.id, "Film");
    await within(scenes("Living room")).findByRole("button", { name: "Recall Film" });
    await appliances.renameLightScene(lightScene.id, "Cinema");
    await within(scenes("Living room")).findByRole("button", { name: "Recall Cinema" });
    await appliances.deleteLightScene(lightScene.id);
    await waitFor(() => {
      expect(sceneNames("Living room")).toEqual([]);
    });
  });

  it("is a widget moved, resized and hidden with its grip's keys and menu, and the Widgets menu (WCAG 2.5.7)", async () => {
    const storage = memoryStorage();
    renderTab(home(), { storage });
    await allAnswered();
    const placeOf = (id: string) => loadWidgetLayout(storage, LIGHTS_WIDGET_LAYOUT_KEY).layouts[4]?.[id];

    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Living room Light Scenes" }), {
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(placeOf(lightScenesWidgetId(LIVING_ROOM.id))).toEqual({ x: 0, y: 9, w: 4, h: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Arrange Living room Light Scenes" }), { detail: 0 });
    const menu = screen.getByRole("group", { name: "Arrange Living room Light Scenes" });
    fireEvent.click(within(menu).getByRole("button", { name: "Move up" }));
    expect(placeOf(lightScenesWidgetId(LIVING_ROOM.id))).toEqual({ x: 0, y: 0, w: 4, h: 10 });
    expect(placeOf(roomLightsWidgetId(LIVING_ROOM.id))).toEqual({ x: 0, y: 10, w: 4, h: 9 });

    fireEvent.click(within(menu).getByRole("button", { name: /^Hide/ }));
    expect(screen.queryByRole("region", { name: "Living room Light Scenes" })).toBeNull();
    expect(loadWidgetLayout(storage, LIGHTS_WIDGET_LAYOUT_KEY).hidden).toEqual([lightScenesWidgetId(LIVING_ROOM.id)]);
    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Show on the Lights tab" })).getByRole("checkbox", {
        name: "Living room Light Scenes",
      }),
    );
    await screen.findByRole("region", { name: "Living room Light Scenes" });
  });
});
