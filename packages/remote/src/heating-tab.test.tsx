import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeatingTab, heatingWidgetId, WHOLE_HOME_WIDGET_ID } from "./heating-tab.tsx";
import { aHiveAppliance, aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";
import {
  AIRCON_WIDGET_LAYOUT_KEY,
  HEATING_WIDGET_LAYOUT_KEY,
  LIGHTS_WIDGET_LAYOUT_KEY,
  TV_WIDGET_LAYOUT_KEY,
  loadWidgetLayout,
} from "./widget-layout.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BEDROOM = { id: 1, name: "Bedroom" };
const STUDY = { id: 2, name: "Study" };

const DOWNSTAIRS = aHiveAppliance(10, "heating", "Downstairs");
const UPSTAIRS = aHiveAppliance(11, "heating", "Upstairs");
const RADIATOR = aHiveAppliance(12, "radiator-valve", "Radiator", BEDROOM.id);
const WINDOW = aHiveAppliance(13, "radiator-valve", "Window", BEDROOM.id);
const DESK = aHiveAppliance(14, "radiator-valve", "Desk", STUDY.id);
const HALL = aHiveAppliance(15, "radiator-valve", "Hall");
const HOT_WATER = aHiveAppliance(16, "hot-water", "Hot Water");

const HOME = [HALL, DESK, WINDOW, RADIATOR, HOT_WATER, UPSTAIRS, DOWNSTAIRS];

const renderTab = (
  appliances: FakeAppliancesApi,
  options: { refreshMs?: number; storage?: ReturnType<typeof memoryStorage>; onOpenSettings?: () => void } = {},
) =>
  render(
    <HeatingTab
      appliances={appliances}
      rooms={fakeRoomsApi([BEDROOM.name, STUDY.name])}
      storage={options.storage ?? memoryStorage()}
      onOpenSettings={options.onOpenSettings ?? (() => undefined)}
      refreshMs={options.refreshMs ?? 60_000}
    />,
  );

const widget = (title: string) => screen.getByRole("region", { name: title });
const summary = (title: string) => widget(title).querySelector(".aircon-summary")?.textContent;
const targetOf = (title: string, group = "Target temperature") =>
  within(widget(title)).getByRole("status", { name: `${group} set` }).textContent;
const button = (title: string, name: string | RegExp) => within(widget(title)).getByRole("button", { name });
const radio = (title: string, name: string) => within(widget(title)).getByRole<HTMLInputElement>("radio", { name });

/** Waits until the tab has read Hive, as it does as it opens. */
const answered = async (): Promise<void> => {
  await waitFor(() => {
    expect(summary("Downstairs")).toBe("Schedule, 20°");
  });
};

const boost = (title: string, minutes: string, steps = 0): void => {
  fireEvent.click(button(title, "Boost…"));
  const dialog = screen.getByRole("dialog", { name: `Boost ${title}` });
  for (let step = 0; step < steps; step += 1) {
    fireEvent.click(within(dialog).getByRole("button", { name: "Raise the Boost temperature" }));
  }
  fireEvent.change(within(dialog).getByRole("combobox", { name: "For" }), { target: { value: minutes } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Boost" }));
};

describe("the Heating tab (FR-62)", () => {
  it('shows the Whole home first, each Heating, the Hot Water, then each Radiator Valve on its own, by Room, in Room order, "No room" last', async () => {
    renderTab(fakeAppliancesApi([aTv(1, "TV", BEDROOM.id), ...HOME]));

    expect(screen.getByRole("heading", { name: "Heating", level: 1 })).toBeTruthy();
    await answered();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Whole home",
      "Upstairs",
      "Downstairs",
      "Hot Water",
      // A Room with more than one has its Room-wide target first.
      "Bedroom · Radiator Valves",
      "Bedroom · Window",
      "Bedroom · Radiator",
      "Study · Desk",
      "Hall",
    ]);
  });

  it("shows what each reads, whether a Heating is calling for heat, a Radiator Valve's Heating zone and low battery", async () => {
    const appliances = fakeAppliancesApi(HOME);
    appliances.setHeatingState(DOWNSTAIRS.id, { temperature: 18.5, callingForHeat: true });
    appliances.setHeatingState(DESK.id, { lowBattery: true, temperature: 17 });
    renderTab(appliances);
    await answered();

    expect(widget("Downstairs").textContent).toContain("Reads18.5°");
    expect(widget("Downstairs").textContent).toContain("Calling for heat");
    expect(widget("Upstairs").textContent).toContain("Not calling");
    expect(widget("Study · Desk").textContent).toContain("Reads17°");
    // Named as the Hub names the Heating it belongs to.
    expect(widget("Study · Desk").textContent).toContain("Heating zoneUpstairs");
    expect(widget("Study · Desk").textContent).toContain("Low battery");
    expect(widget("Bedroom · Radiator").textContent).not.toContain("Low battery");
    expect(widget("Hot Water").textContent).toContain("Not heating the water");
    expect(targetOf("Downstairs")).toBe("20°");
    expect(radio("Downstairs", "Schedule").checked).toBe(true);
  });

  it("asks the Hub again every so often while it is open, so that a change in Hive's app shows, and never once closed", async () => {
    const appliances = fakeAppliancesApi(HOME);
    const { unmount } = renderTab(appliances, { refreshMs: 20 });
    await answered();

    appliances.setHeatingState(UPSTAIRS.id, { target: 22.5, mode: "manual" });
    await waitFor(() => {
      expect(summary("Upstairs")).toBe("Manual, 22.5°");
    });
    expect(appliances.heatingReads()).toBeGreaterThan(1);

    unmount();
    const reads = appliances.heatingReads();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(appliances.heatingReads()).toBe(reads);
  });

  it("says how to sign in to Hive while the Hub isn't, and opens Settings", async () => {
    const onOpenSettings = vi.fn();
    renderTab(fakeAppliancesApi([aTv(1, "TV", null)]), { onOpenSettings });
    const empty = await screen.findByRole("region", { name: "Not signed in to Hive" });
    fireEvent.click(within(empty).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe("a Heating's controls (FR-63)", () => {
  it("changes its target in half degrees, its mode and its Boost, each reaching the Hub, then shows what Hive reports", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();

    fireEvent.click(button("Downstairs", "Raise Downstairs's target temperature"));
    expect(summary("Downstairs")).toBe("Sending to Hive…");
    await waitFor(() => {
      expect(summary("Downstairs")).toBe("Schedule, 20.5°");
    });
    fireEvent.click(radio("Downstairs", "Manual"));
    await waitFor(() => {
      expect(summary("Downstairs")).toBe("Manual, 20.5°");
    });
    boost("Downstairs", "90", 3);
    await waitFor(() => {
      expect(summary("Downstairs")).toBe("Boost to 23°, 1 h 30 min left");
    });
    fireEvent.click(button("Downstairs", "Cancel Boost"));
    await waitFor(() => {
      expect(summary("Downstairs")).toBe("Manual, 20.5°");
    });

    expect(appliances.heatingChanges).toEqual([
      { to: DOWNSTAIRS.id, change: { target: 20.5 } },
      { to: DOWNSTAIRS.id, change: { mode: "manual" } },
      { to: DOWNSTAIRS.id, change: { boost: { target: 23, minutes: 90 } } },
      { to: DOWNSTAIRS.id, change: { boost: null } },
    ]);
  });

  it("steps on from the target on its way, and sends only the latest once the one before has gone", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();
    const release = appliances.holdNextHeatingChange();

    const raise = button("Upstairs", "Raise Upstairs's target temperature");
    fireEvent.click(raise);
    fireEvent.click(raise);
    fireEvent.click(raise);
    expect(targetOf("Upstairs")).toBe("21.5°");
    release();

    await waitFor(() => {
      expect(summary("Upstairs")).toBe("Schedule, 21.5°");
    });
    expect(appliances.heatingChanges.map(({ change }) => change)).toEqual([{ target: 20.5 }, { target: 21.5 }]);
  });

  it("counts a Boost's time left down between reads of Hive", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const appliances = fakeAppliancesApi(HOME);
    appliances.setHeatingState(UPSTAIRS.id, { target: 22, boost: { target: 22, minutesLeft: 45 } });
    renderTab(appliances, { refreshMs: 3_600_000 });
    await waitFor(() => {
      expect(summary("Upstairs")).toBe("Boost to 22°, 45 min left");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
    });
    expect(summary("Upstairs")).toBe("Boost to 22°, 43 min left");
    expect(within(widget("Upstairs")).getByRole("button", { name: "Cancel Boost" })).toBeTruthy();
  });

  it('shows a change Hive refuses as "Hive refused this", with what Hive reports (FR-68)', async () => {
    const appliances = fakeAppliancesApi(HOME);
    appliances.refuseHeatingChanges(UPSTAIRS.id, true);
    renderTab(appliances);
    await answered();

    fireEvent.click(button("Upstairs", "Raise Upstairs's target temperature"));
    await waitFor(() => {
      expect(within(widget("Upstairs")).getByRole("alert").textContent).toBe(
        "Hive refused this. It shows what Hive reports.",
      );
    });
    expect(targetOf("Upstairs")).toBe("20°");
  });
});

describe("the Hot Water (FR-66)", () => {
  it("changes its mode, Schedule, On or Off, and boosts it by duration alone, with its time left and a cancel", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();

    expect(
      within(widget("Hot Water"))
        .getAllByRole("radio")
        .map((each) => each.parentElement?.textContent),
    ).toEqual(["Schedule", "On", "Off"]);
    expect(within(widget("Hot Water")).queryByRole("group", { name: "Target temperature" })).toBeNull();
    fireEvent.click(radio("Hot Water", "On"));
    await waitFor(() => {
      expect(summary("Hot Water")).toBe("On");
    });

    fireEvent.click(button("Hot Water", "Boost…"));
    const dialog = screen.getByRole("dialog", { name: "Boost Hot Water" });
    expect(within(dialog).queryByRole("group", { name: "Boost temperature" })).toBeNull();
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((each) => each.textContent),
    ).toEqual([
      "15 min",
      "30 min",
      "45 min",
      "1 h",
      "1 h 30 min",
      "2 h",
      "2 h 30 min",
      "3 h",
      "3 h 30 min",
      "4 h",
      "4 h 30 min",
      "5 h",
      "5 h 30 min",
      "6 h",
    ]);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "For" }), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Boost" }));
    await waitFor(() => {
      expect(summary("Hot Water")).toBe("Boost, 30 min left");
    });
    fireEvent.click(button("Hot Water", "Cancel Boost"));
    await waitFor(() => {
      expect(summary("Hot Water")).toBe("On");
    });
    expect(appliances.heatingChanges.map(({ change }) => change)).toEqual([
      { mode: "on" },
      { boost: { minutes: 30 } },
      { boost: null },
    ]);
  });
});

describe("the Whole home (FR-64)", () => {
  it("says, as a Boost is asked for, that every zone and Radiator Valve is boosted with it, as a zone's says of its valves", async () => {
    renderTab(fakeAppliancesApi(HOME));
    await answered();

    fireEvent.click(button("Whole home", "Boost…"));
    expect(screen.getByRole("dialog", { name: "Boost Whole home" }).textContent).toContain(
      "Every Heating zone and every Radiator Valve is boosted",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Boost Whole home" }));

    fireEvent.click(button("Upstairs", "Boost…"));
    expect(screen.getByRole("dialog", { name: "Boost Upstairs" }).textContent).toContain(
      "Every Radiator Valve in this zone is boosted with it",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Boost Upstairs" }));

    // A Radiator Valve's Boost is its own.
    fireEvent.click(button("Study · Desk", "Boost…"));
    expect(screen.getByRole("dialog", { name: "Boost Study · Desk" }).textContent).not.toContain("is boosted with it");
  });

  it("shows the Heatings' value where they agree, and \"Mixed\" where they don't", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances, { refreshMs: 20 });
    await answered();
    expect(summary("Whole home")).toBe("Schedule, 20°");
    expect(targetOf("Whole home")).toBe("20°");
    expect(radio("Whole home", "Schedule").checked).toBe(true);

    appliances.setHeatingState(UPSTAIRS.id, { target: 18, mode: "off" });
    await waitFor(() => {
      expect(summary("Whole home")).toBe("Mixed");
    });
    expect(targetOf("Whole home")).toBe("Mixed");
    expect(within(widget("Whole home")).getByRole("group", { name: "Mode: Mixed" })).toBeTruthy();
    expect(
      within(widget("Whole home"))
        .getAllByRole<HTMLInputElement>("radio")
        .some(({ checked }) => checked),
    ).toBe(false);
  });

  it("sends a target, a mode and a Boost to every Heating, and names one that didn't take it", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();

    fireEvent.click(button("Whole home", "Raise every Heating's target temperature"));
    await waitFor(() => {
      expect(summary("Downstairs")).toBe("Schedule, 20.5°");
    });
    expect(summary("Upstairs")).toBe("Schedule, 20.5°");
    expect(summary("Bedroom · Radiator")).toBe("Schedule, 20°");

    appliances.refuseHeatingChanges(UPSTAIRS.id, true);
    fireEvent.click(radio("Whole home", "Off"));
    await waitFor(() => {
      expect(within(widget("Whole home")).getByRole("alert").textContent).toBe("Hive refused this for Upstairs.");
    });
    expect(summary("Downstairs")).toBe("Off, 20.5°");
    expect(summary("Upstairs")).toBe("Schedule, 20.5°");
    expect(summary("Whole home")).toBe("Mixed");

    appliances.refuseHeatingChanges(UPSTAIRS.id, false);
    boost("Whole home", "60");
    await waitFor(() => {
      expect(summary("Whole home")).toBe("Boost to 21.5°, 1 h left");
    });
    expect(appliances.heatingChanges).toEqual([
      { to: "whole-home", change: { target: 20.5 } },
      { to: "whole-home", change: { mode: "off" } },
      { to: "whole-home", change: { boost: { target: 21.5, minutes: 60 } } },
    ]);
  });
});

describe("the Radiator Valves (FR-65)", () => {
  it("each has a target, a mode and a Boost of its own", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();

    fireEvent.click(button("Study · Desk", "Lower Study · Desk's target temperature"));
    await waitFor(() => {
      expect(summary("Study · Desk")).toBe("Schedule, 19.5°");
    });
    fireEvent.click(radio("Study · Desk", "Manual"));
    await waitFor(() => {
      expect(summary("Study · Desk")).toBe("Manual, 19.5°");
    });
    boost("Study · Desk", "15");
    await waitFor(() => {
      expect(summary("Study · Desk")).toBe("Boost to 20.5°, 15 min left");
    });
    expect(appliances.heatingChanges).toEqual([
      { to: DESK.id, change: { target: 19.5 } },
      { to: DESK.id, change: { mode: "manual" } },
      { to: DESK.id, change: { boost: { target: 20.5, minutes: 15 } } },
    ]);
  });

  it("has a Room-wide target in a Room with more than one, which sets them all, naming one that didn't take it", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();
    // Only for a Room with more than one.
    expect(screen.queryByRole("region", { name: "Study · Radiator Valves" })).toBeNull();
    expect(screen.getAllByRole("group", { name: /^Every Radiator Valve/ })).toHaveLength(1);

    const room = widget("Bedroom · Radiator Valves");
    fireEvent.click(within(room).getByRole("button", { name: "Raise every Radiator Valve's target in Bedroom" }));
    await waitFor(() => {
      expect(summary("Bedroom · Window")).toBe("Schedule, 20.5°");
    });
    expect(summary("Bedroom · Radiator")).toBe("Schedule, 20.5°");
    expect(summary("Study · Desk")).toBe("Schedule, 20°");

    appliances.refuseHeatingChanges(RADIATOR.id, true);
    fireEvent.click(within(room).getByRole("button", { name: "Raise every Radiator Valve's target in Bedroom" }));
    await waitFor(() => {
      expect(
        within(room)
          .getAllByRole("alert")
          .map((each) => each.textContent),
      ).toEqual(["Hive refused this for Bedroom · Radiator."]);
    });
    expect(within(room).getByRole("status", { name: "Every Radiator Valve in Bedroom set" }).textContent).toBe("Mixed");
    expect(appliances.heatingChanges).toEqual([
      { to: { roomId: BEDROOM.id }, change: { target: 20.5 } },
      { to: { roomId: BEDROOM.id }, change: { target: 21 } },
    ]);
  });

  it('says "Can\'t reach this Radiator Valve" for one Hive reports offline, with its controls disabled', async () => {
    const appliances = fakeAppliancesApi(HOME);
    appliances.setHeatingState(WINDOW.id, { online: false });
    renderTab(appliances, { refreshMs: 20 });
    await answered();

    expect(summary("Bedroom · Window")).toBe("Can't reach this Radiator Valve");
    for (const control of within(widget("Bedroom · Window")).getAllByRole<HTMLButtonElement>("button")) {
      expect(control.disabled).toBe(true);
    }
    expect(radio("Bedroom · Window", "Schedule").disabled).toBe(true);
    expect(radio("Bedroom · Radiator", "Schedule").disabled).toBe(false);

    appliances.setHeatingState(WINDOW.id, { online: true });
    await waitFor(() => {
      expect(summary("Bedroom · Window")).toBe("Schedule, 20°");
    });
    expect(radio("Bedroom · Window", "Schedule").disabled).toBe(false);
  });
});

describe('"Can\'t reach Hive" (FR-68)', () => {
  it("disables every control while Hive can't be reached, and comes back by itself", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances, { refreshMs: 20 });
    await answered();

    appliances.setHiveTokens("unreachable");
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/^Can't reach Hive\. Check that the Hub is connected/);
    });
    const controls = [
      ...screen.getAllByRole<HTMLButtonElement>("button").filter((each) => each.closest(".widget-content") !== null),
      ...screen.getAllByRole<HTMLInputElement>("radio"),
    ];
    expect(controls.length).toBeGreaterThan(20);
    for (const control of controls) expect(control.disabled, control.outerHTML).toBe(true);
    expect(targetOf("Downstairs")).toBe("–");

    appliances.setHiveTokens("accepted");
    await answered();
    expect(screen.queryByText(/^Can't reach Hive/)).toBeNull();
    expect(radio("Downstairs", "Off").disabled).toBe(false);
  });

  it("says so where Hive no longer accepts the Hub's sign-in, with the way to Settings to sign in again", async () => {
    const appliances = fakeAppliancesApi(HOME);
    appliances.setHiveTokens("refused");
    const onOpenSettings = vi.fn();
    renderTab(appliances, { onOpenSettings });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Can't reach Hive.");
    expect(alert.textContent).toContain("Hive no longer accepts the Hub's sign-in: sign in again in Settings.");
    fireEvent.click(within(alert).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('says how many of Hive\'s have no Room yet, as each starts in "No room", with the way to Settings to give each one', async () => {
    const onOpenSettings = vi.fn();
    renderTab(fakeAppliancesApi(HOME), { onOpenSettings });

    await answered();
    // Downstairs, Upstairs, Hall and the Hot Water.
    expect(screen.getByText(/^4 of Hive's have no Room yet\./).textContent).toContain(
      "Give each a Room, and rename it, in Settings, under Heating.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Give each a Room" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("says nothing of Rooms once every one of Hive's has one", async () => {
    renderTab(fakeAppliancesApi([{ ...DOWNSTAIRS, roomId: STUDY.id }, RADIATOR]));

    await waitFor(() => {
      expect(summary("Study · Downstairs")).toBe("Schedule, 20°");
    });
    expect(screen.queryByText(/no Room yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Give each a Room" })).toBeNull();
  });

  it("reads Hive again at once after a change the Hub couldn't make", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances);
    await answered();
    const reads = appliances.heatingReads();

    appliances.setHiveTokens("unreachable");
    fireEvent.click(radio("Downstairs", "Off"));
    await waitFor(() => {
      expect(screen.getAllByRole("alert").map((each) => each.textContent)).toContain(
        "Can't reach Hive. Check that the Hub is connected to the internet.",
      );
    });
    await waitFor(() => {
      expect(appliances.heatingReads()).toBe(reads + 1);
    });
    expect(radio("Downstairs", "Off").disabled).toBe(true);
  });
});

describe("the Heating tab's widgets (FR-58)", () => {
  const placeOf = (storage: ReturnType<typeof memoryStorage>, id: string) =>
    loadWidgetLayout(storage, HEATING_WIDGET_LAYOUT_KEY).layouts[4]?.[id];

  it("lists every widget in the Widgets menu, to hide and show again", async () => {
    const storage = memoryStorage();
    renderTab(fakeAppliancesApi(HOME), { storage });
    await answered();

    fireEvent.click(screen.getByRole("button", { name: "Hide Whole home" }));
    expect(screen.queryByRole("region", { name: "Whole home" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    const menu = screen.getByRole("group", { name: "Show on the Heating tab" });
    expect(
      within(menu)
        .getAllByRole("checkbox")
        .map((each) => each.parentElement?.textContent),
    ).toEqual([
      "Whole home",
      "Upstairs",
      "Downstairs",
      "Hot Water",
      "Bedroom · Radiator Valves",
      "Bedroom · Window",
      "Bedroom · Radiator",
      "Study · Desk",
      "Hall",
    ]);
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Whole home" }));
    expect(screen.getByRole("region", { name: "Whole home" })).toBeTruthy();
    expect(placeOf(storage, WHOLE_HOME_WIDGET_ID)).toMatchObject({ x: 0, y: 0, w: 4 });
  });

  it("moves and resizes each with the keyboard on its grip, or its grip's menu, with no dragging (WCAG 2.5.7)", async () => {
    const storage = memoryStorage();
    const appliances = fakeAppliancesApi(HOME);
    renderTab(appliances, { storage });
    await answered();
    const first = placeOf(storage, WHOLE_HOME_WIDGET_ID);
    expect(first).toBeUndefined();

    // Moved down onto Upstairs, the two swap.
    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Whole home" }), { key: "ArrowDown" });
    expect(placeOf(storage, heatingWidgetId(UPSTAIRS.id))?.y).toBe(0);
    expect(placeOf(storage, WHOLE_HOME_WIDGET_ID)?.y).toBeGreaterThan(0);

    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Upstairs" }), { key: "ArrowUp", shiftKey: true });
    const shorter = placeOf(storage, heatingWidgetId(UPSTAIRS.id));

    const grip = screen.getByRole("button", { name: "Arrange Downstairs" });
    fireEvent.click(grip, { detail: 0 });
    const menu = screen.getByRole("group", { name: "Arrange Downstairs" });
    fireEvent.click(within(menu).getByRole("button", { name: "Narrower" }));
    expect(placeOf(storage, heatingWidgetId(DOWNSTAIRS.id))?.w).toBe(3);
    expect(shorter?.h).toBeGreaterThan(0);

    // Its controls still reach Hive wherever it is.
    fireEvent.click(radio("Downstairs", "Off"));
    await waitFor(() => {
      expect(appliances.heatingChanges).toEqual([{ to: DOWNSTAIRS.id, change: { mode: "off" } }]);
    });
  });

  it("is remembered under the Heating tab's own key, never another tab's, and put back where it started", async () => {
    const others = {
      [TV_WIDGET_LAYOUT_KEY]: JSON.stringify({ hidden: ["keys"], layouts: {} }),
      [AIRCON_WIDGET_LAYOUT_KEY]: JSON.stringify({ hidden: [], layouts: {} }),
      [LIGHTS_WIDGET_LAYOUT_KEY]: JSON.stringify({ hidden: ["light-1"], layouts: {} }),
    };
    const storage = memoryStorage(others);
    const appliances = fakeAppliancesApi(HOME);
    const first = renderTab(appliances, { storage });
    await answered();
    expect(HEATING_WIDGET_LAYOUT_KEY).toBe("media-centre:heating-widgets");

    fireEvent.click(screen.getByRole("button", { name: "Hide Hot Water" }));
    expect(loadWidgetLayout(storage, HEATING_WIDGET_LAYOUT_KEY).hidden).toEqual([`hot-water-${String(HOT_WATER.id)}`]);

    first.unmount();
    renderTab(appliances, { storage });
    await answered();
    expect(screen.queryByRole("region", { name: "Hot Water" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(screen.getByRole("region", { name: "Hot Water" })).toBeTruthy();
    expect(storage.items[HEATING_WIDGET_LAYOUT_KEY]).toBe(JSON.stringify({ hidden: [], layouts: {} }));
    for (const [key, saved] of Object.entries(others)) expect(storage.items[key]).toBe(saved);
  });
});
