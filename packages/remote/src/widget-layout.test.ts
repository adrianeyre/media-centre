import { describe, expect, it } from "vitest";

import { memoryStorage, refusingStorage } from "./testing/memory-storage.ts";
import {
  AIRCON_WIDGET_LAYOUT_KEY,
  TV_WIDGET_LAYOUT_KEY,
  columnsFor,
  fitToColumns,
  hideWidget,
  loadWidgetLayout,
  neighboursOf,
  placeWidget,
  removeEmptyRows,
  saveWidgetLayout,
  showWidget,
  type Layout,
} from "./widget-layout.ts";

const at = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("placing a widget", () => {
  it("snaps it into the grid, inside its columns", () => {
    const layout: Layout = { a: at(0, 0, 2, 2) };

    expect(placeWidget(layout, "a", at(5, 3, 2, 2), 4)).toEqual({ a: at(2, 0, 2, 2) });
    expect(placeWidget(layout, "a", at(-3, -1, 9, 0), 4)).toEqual({ a: at(0, 0, 4, 1) });
  });

  it("moves a widget in the way down, out of it, and any that one is then in the way of", () => {
    const layout: Layout = { a: at(0, 0, 2, 2), b: at(2, 0, 2, 2), c: at(2, 2, 2, 3) };

    expect(placeWidget(layout, "a", at(2, 1, 2, 2), 4)).toEqual({
      a: at(2, 0, 2, 2),
      b: at(2, 2, 2, 2),
      c: at(2, 4, 2, 3),
    });
  });

  it("moved down onto the widget below, swaps with it, which rises into the space it leaves", () => {
    const layout: Layout = { a: at(0, 0, 4, 2), b: at(0, 2, 4, 5), c: at(0, 7, 4, 1) };

    expect(placeWidget(layout, "a", at(0, 1, 4, 2), 4)).toEqual({
      a: at(0, 5, 4, 2),
      b: at(0, 0, 4, 5),
      c: at(0, 7, 4, 1),
    });
  });

  it("swaps only with a widget that has room to rise", () => {
    const layout: Layout = { a: at(0, 0, 2, 2), beside: at(2, 0, 2, 2), b: at(0, 2, 4, 2) };

    // b is wider than the space a leaves, so it is moved down out of a's way instead.
    expect(placeWidget(layout, "a", at(0, 1, 2, 2), 4)).toEqual({
      a: at(0, 1, 2, 2),
      beside: at(2, 0, 2, 2),
      b: at(0, 3, 4, 2),
    });
  });

  it("removes a row left with nothing in it", () => {
    const layout: Layout = { a: at(0, 0, 4, 2), b: at(0, 2, 4, 2) };

    // a goes below b, which leaves rows 0 and 1 empty.
    expect(placeWidget(layout, "a", at(0, 6, 4, 2), 4)).toEqual({ a: at(0, 2, 4, 2), b: at(0, 0, 4, 2) });
  });

  it("makes a widget bigger or smaller, moving whatever it grows over", () => {
    const layout: Layout = { a: at(0, 0, 2, 2), b: at(2, 0, 2, 2) };

    expect(placeWidget(layout, "a", at(0, 0, 3, 2), 4)).toEqual({ a: at(0, 0, 3, 2), b: at(2, 2, 2, 2) });
  });
});

describe("removing empty rows", () => {
  it("closes up every row nothing covers, keeping rows a tall widget spans", () => {
    expect(removeEmptyRows({ a: at(0, 1, 1, 3), b: at(1, 6, 1, 1), c: at(2, 2, 1, 1) })).toEqual({
      a: at(0, 0, 1, 3),
      b: at(1, 3, 1, 1),
      c: at(2, 1, 1, 1),
    });
  });
});

describe("fitting a layout to fewer columns", () => {
  it("narrows what is too wide and moves down what then overlaps", () => {
    expect(fitToColumns({ a: at(0, 0, 6, 2), b: at(6, 0, 6, 2) }, 4)).toEqual({
      a: at(0, 0, 4, 2),
      b: at(0, 2, 4, 2),
    });
  });
});

describe("hiding and showing a widget", () => {
  it("closes up the rows a hidden widget leaves, and puts it back where it was", () => {
    const layout: Layout = { a: at(0, 0, 4, 2), b: at(0, 2, 4, 2) };

    const hidden = hideWidget(layout, "a");
    expect(hidden).toEqual({ b: at(0, 0, 4, 2) });
    expect(showWidget(hidden, "a", at(0, 0, 4, 2), 4)).toEqual({ a: at(0, 0, 4, 2), b: at(0, 2, 4, 2) });
  });
});

describe("the widgets around one", () => {
  it("are those touching it, beside, above, below or at a corner", () => {
    const layout: Layout = {
      a: at(1, 1, 1, 1),
      left: at(0, 1, 1, 1),
      corner: at(2, 2, 1, 1),
      apart: at(3, 1, 1, 1),
      below: at(0, 3, 4, 1),
    };

    expect(neighboursOf(layout, "a").sort()).toEqual(["corner", "left"]);
  });
});

describe("columns for a width", () => {
  it("is 12 on a desktop, 8 on a tablet and 4 on a phone", () => {
    expect(columnsFor(1200)).toBe(12);
    expect(columnsFor(800)).toBe(8);
    expect(columnsFor(400)).toBe(4);
  });
});

describe("remembering the layout", () => {
  it("keeps each number of columns' layout, and which widgets are hidden", () => {
    const storage = memoryStorage();
    saveWidgetLayout(storage, TV_WIDGET_LAYOUT_KEY, { hidden: ["a"], layouts: { 4: { a: at(0, 0, 4, 2) } } });

    expect(loadWidgetLayout(storage, TV_WIDGET_LAYOUT_KEY)).toEqual({
      hidden: ["a"],
      layouts: { 4: { a: at(0, 0, 4, 2) } },
    });
  });

  it("forgets what it can't read, or a browser refuses to keep", () => {
    expect(loadWidgetLayout(memoryStorage({ [TV_WIDGET_LAYOUT_KEY]: "{" }), TV_WIDGET_LAYOUT_KEY)).toEqual({
      hidden: [],
      layouts: {},
    });
    expect(
      loadWidgetLayout(
        memoryStorage({ [TV_WIDGET_LAYOUT_KEY]: JSON.stringify({ hidden: [1], layouts: { 4: { a: 1 } } }) }),
        TV_WIDGET_LAYOUT_KEY,
      ),
    ).toEqual({ hidden: [], layouts: {} });
    expect(loadWidgetLayout(refusingStorage, TV_WIDGET_LAYOUT_KEY)).toEqual({ hidden: [], layouts: {} });
    expect(() => {
      saveWidgetLayout(refusingStorage, TV_WIDGET_LAYOUT_KEY, { hidden: [], layouts: {} });
    }).not.toThrow();
  });

  it("keeps each tab's widgets under a key of its own, the TV tab's where it always was", () => {
    expect(TV_WIDGET_LAYOUT_KEY).toBe("media-centre:tv-widgets");
    expect(AIRCON_WIDGET_LAYOUT_KEY).toBe("media-centre:aircon-widgets");
    const storage = memoryStorage();
    saveWidgetLayout(storage, AIRCON_WIDGET_LAYOUT_KEY, { hidden: ["b"], layouts: { 4: { b: at(0, 0, 4, 3) } } });

    expect(loadWidgetLayout(storage, TV_WIDGET_LAYOUT_KEY)).toEqual({ hidden: [], layouts: {} });
    expect(loadWidgetLayout(storage, AIRCON_WIDGET_LAYOUT_KEY)).toEqual({
      hidden: ["b"],
      layouts: { 4: { b: at(0, 0, 4, 3) } },
    });
    expect(Object.keys(storage.items)).toEqual([AIRCON_WIDGET_LAYOUT_KEY]);
  });
});
