import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { memoryStorage } from "./testing/memory-storage.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { AIRCON_WIDGET_LAYOUT_KEY, TV_WIDGET_LAYOUT_KEY, loadWidgetLayout, type Layout } from "./widget-layout.ts";

afterEach(cleanup);

const WIDGETS: WidgetDefinition[] = [
  { id: "volume", title: "Volume", children: <p>The volume</p> },
  { id: "keys", title: "Keys", children: <p>The keys</p> },
  {
    id: "apps",
    title: "Apps",
    ownHeading: true,
    children: (
      <section aria-labelledby="apps">
        <h2 id="apps">Apps</h2>
      </section>
    ),
  },
];

// The simulated browser lays nothing out, so the board has a phone's 4 columns.
const DEFAULTS: Record<number, Layout> = {
  4: { volume: { x: 0, y: 0, w: 4, h: 4 }, keys: { x: 0, y: 4, w: 4, h: 10 }, apps: { x: 0, y: 14, w: 4, h: 6 } },
};

const renderBoard = (storage = memoryStorage()) => {
  render(
    <WidgetBoard
      widgets={WIDGETS}
      defaults={DEFAULTS}
      storage={storage}
      storageKey={TV_WIDGET_LAYOUT_KEY}
      tab="TV"
      toolbar={<h1>TV</h1>}
    />,
  );
  return storage;
};

const placeOf = (storage: ReturnType<typeof memoryStorage>, id: string) =>
  loadWidgetLayout(storage, TV_WIDGET_LAYOUT_KEY).layouts[4]?.[id];

const announced = () => screen.getAllByRole("status").at(-1)?.textContent;

describe("the widget board", () => {
  it("shows every widget, with a title over each that has no heading of its own", () => {
    renderBoard();

    expect(screen.getByText("The volume")).toBeTruthy();
    expect(screen.getByText("The keys")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Apps" })).toBeTruthy();
    expect([...document.querySelectorAll(".widget-title")].map((title) => title.textContent)).toEqual([
      "Volume",
      "Keys",
    ]);
  });

  it("hides a widget, closing up its rows, and shows it again where it was from the Widgets menu", () => {
    const storage = renderBoard();

    fireEvent.click(screen.getByRole("button", { name: "Hide Volume" }));

    expect(screen.queryByText("The volume")).toBeNull();
    expect(placeOf(storage, "keys")).toEqual({ x: 0, y: 0, w: 4, h: 10 });
    expect(announced()).toBe("Volume hidden. Show it again from the Widgets menu.");
    expect(screen.getByRole("button", { name: /^Widgets/ }).textContent).toContain("1 hidden");

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    expect(screen.getByRole("group", { name: "Show on the TV tab" })).toBeTruthy();
    const volume = screen.getByRole("checkbox", { name: "Volume" });
    expect((volume as HTMLInputElement).checked).toBe(false);
    fireEvent.click(volume);

    expect(screen.getByText("The volume")).toBeTruthy();
    expect(placeOf(storage, "volume")).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(placeOf(storage, "keys")).toEqual({ x: 0, y: 4, w: 4, h: 10 });
    expect(loadWidgetLayout(storage, TV_WIDGET_LAYOUT_KEY).hidden).toEqual([]);
  });

  it("hides a widget from the Widgets menu too", () => {
    const storage = renderBoard();

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keys" }));

    expect(screen.queryByText("The keys")).toBeNull();
    expect(loadWidgetLayout(storage, TV_WIDGET_LAYOUT_KEY).hidden).toEqual(["keys"]);
  });

  it("moves a widget with the arrow keys on its grip, moving whatever is in the way, and says where it went", () => {
    const storage = renderBoard();
    const grip = screen.getByRole("button", { name: "Arrange Volume" });

    fireEvent.keyDown(grip, { key: "ArrowDown" });

    // Volume went down onto Keys, so the two swapped.
    expect(placeOf(storage, "keys")).toEqual({ x: 0, y: 0, w: 4, h: 10 });
    expect(placeOf(storage, "volume")).toEqual({ x: 0, y: 10, w: 4, h: 4 });
    expect(announced()).toBe("Volume: column 1, row 11, 4 wide and 4 tall.");

    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(placeOf(storage, "volume")).toEqual({ x: 0, y: 10, w: 4, h: 4 });
  });

  it("makes a widget bigger or smaller with Shift and the arrow keys, a cell at a time", () => {
    const storage = renderBoard();
    const grip = screen.getByRole("button", { name: "Arrange Volume" });

    fireEvent.keyDown(grip, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(grip, { key: "ArrowDown", shiftKey: true });

    expect(placeOf(storage, "volume")).toEqual({ x: 0, y: 0, w: 3, h: 5 });
    expect(placeOf(storage, "keys")).toEqual({ x: 0, y: 5, w: 4, h: 10 });
  });

  it("moves, resizes and hides a widget from its grip's menu, with no dragging (WCAG 2.5.7)", () => {
    const storage = renderBoard();
    const grip = screen.getByRole("button", { name: "Arrange Keys" });

    // Enter or Space, which click it with no pointer.
    fireEvent.click(grip, { detail: 0 });
    expect(grip.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("group", { name: "Arrange Keys" });
    expect(within(menu).getByRole<HTMLButtonElement>("button", { name: "Move left" }).disabled).toBe(true);
    expect(within(menu).getByRole<HTMLButtonElement>("button", { name: "Wider" }).disabled).toBe(true);

    fireEvent.click(within(menu).getByRole("button", { name: "Move up" }));
    expect(placeOf(storage, "keys")).toEqual({ x: 0, y: 0, w: 4, h: 10 });
    expect(placeOf(storage, "volume")).toEqual({ x: 0, y: 10, w: 4, h: 4 });

    fireEvent.click(within(menu).getByRole("button", { name: "Narrower" }));
    expect(placeOf(storage, "keys")).toEqual({ x: 0, y: 0, w: 3, h: 10 });

    fireEvent.click(within(menu).getByRole("button", { name: "Hide Keys" }));
    expect(screen.queryByText("The keys")).toBeNull();
  });

  it("puts every widget back where it started", () => {
    const storage = renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Hide Volume" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Arrange Keys" }), { key: "ArrowDown", shiftKey: true });

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));

    expect(screen.getByText("The volume")).toBeTruthy();
    expect(storage.items[TV_WIDGET_LAYOUT_KEY]).toBe(JSON.stringify({ hidden: [], layouts: {} }));
  });

  it("is laid out as this Remote last left it", () => {
    const storage = memoryStorage({
      [TV_WIDGET_LAYOUT_KEY]: JSON.stringify({
        hidden: ["apps"],
        layouts: { 4: { keys: { x: 0, y: 0, w: 4, h: 10 }, volume: { x: 0, y: 10, w: 4, h: 4 } } },
      }),
    });
    renderBoard(storage);

    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();
    const shown = [...document.querySelectorAll<HTMLElement>(".widget")].map(({ dataset }) => dataset.widget);
    expect(shown).toEqual(["volume", "keys"]);
    expect(document.querySelector<HTMLElement>('[data-widget="volume"]')?.style.transform).toBe(
      "translate(0px, 360px)",
    );
  });

  it("remembers its layout under its tab's own key, leaving another tab's as it was", () => {
    const tv = JSON.stringify({ hidden: ["keys"], layouts: {} });
    const storage = memoryStorage({ [TV_WIDGET_LAYOUT_KEY]: tv });
    render(
      <WidgetBoard
        widgets={WIDGETS}
        defaults={DEFAULTS}
        storage={storage}
        storageKey={AIRCON_WIDGET_LAYOUT_KEY}
        tab="Aircon"
        toolbar={<h1>Aircon</h1>}
      />,
    );

    // The TV tab's hidden Keys is the TV tab's alone.
    expect(screen.getByText("The keys")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide Volume" }));
    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    expect(screen.getByRole("group", { name: "Show on the Aircon tab" })).toBeTruthy();

    expect(loadWidgetLayout(storage, AIRCON_WIDGET_LAYOUT_KEY).hidden).toEqual(["volume"]);
    expect(storage.items[TV_WIDGET_LAYOUT_KEY]).toBe(tv);
  });
});
