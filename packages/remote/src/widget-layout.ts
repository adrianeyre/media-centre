import type { RemoteStorage } from "./remote-storage.ts";

/**
 * Where a widget sits on a tab's grid, in columns and rows from the top
 * left: `x` and `w` in columns, `y` and `h` in rows.
 */
export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Every shown widget's place, by the widget's id. */
export type Layout = Readonly<Record<string, Placement>>;

/** The columns the grid has at each width, widest first: a desktop, a tablet, then a phone. */
const BREAKPOINTS: readonly (readonly [minWidth: number, columns: number])[] = [
  [1_000, 12],
  [600, 8],
  [0, 4],
];

/** The grid's columns for the width it has, in CSS pixels. */
export const columnsFor = (width: number): number => BREAKPOINTS.find(([minWidth]) => width >= minWidth)?.[1] ?? 4;

const overlaps = (a: Placement, b: Placement): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Kept inside the grid: no wider than it, no further left or right, and at least one cell. */
const clamped = ({ x, y, w, h }: Placement, columns: number): Placement => {
  const width = Math.min(Math.max(1, Math.round(w)), columns);
  return {
    x: Math.min(Math.max(0, Math.round(x)), columns - width),
    y: Math.max(0, Math.round(y)),
    w: width,
    h: Math.max(1, Math.round(h)),
  };
};

/** Top to bottom, then left to right, as a page is read. */
const inReadingOrder = (layout: Layout): string[] =>
  Object.keys(layout).sort((a, b) => {
    const first = layout[a];
    const second = layout[b];
    if (first === undefined || second === undefined) return 0;
    return first.y - second.y || first.x - second.x;
  });

/**
 * Closes up every row no widget covers, so that moving or hiding a widget
 * never leaves a band of nothing across the grid.
 */
export const removeEmptyRows = (layout: Layout): Layout => {
  const covered = new Set<number>();
  for (const { y, h } of Object.values(layout)) for (let row = y; row < y + h; row += 1) covered.add(row);
  const emptyAbove = (row: number): number => {
    let empty = 0;
    for (let above = 0; above < row; above += 1) if (!covered.has(above)) empty += 1;
    return empty;
  };
  return Object.fromEntries(
    Object.entries(layout).map(([id, placement]) => [id, { ...placement, y: placement.y - emptyAbove(placement.y) }]),
  );
};

/**
 * Moves every widget overlapping `moved` down until it no longer does, then
 * any that one now overlaps, and so on. Each only ever goes down, below the
 * one that moved it, so the cascade ends.
 */
const pushedOutOfTheWay = (layout: Record<string, Placement>, moved: string): Record<string, Placement> => {
  const queue = [moved];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const pusher = layout[next];
    if (pusher === undefined) continue;
    for (const id of inReadingOrder(layout)) {
      const other = layout[id];
      if (id === next || id === moved || other === undefined || !overlaps(pusher, other)) continue;
      layout[id] = { ...other, y: pusher.y + pusher.h };
      queue.push(id);
    }
  }
  return layout;
};

/**
 * Puts widget `id` at `placement`, snapped into a grid of `columns`: moved,
 * made bigger or smaller, or both. Moved down onto a widget that was below
 * it, the two swap: that one rises to where it was, if nothing else is in the
 * way there, and it goes beneath that one. Whatever else is in its way is
 * moved down out of it, and any row left empty is removed.
 */
export const placeWidget = (layout: Layout, id: string, placement: Placement, columns: number): Layout => {
  const from = layout[id];
  let place = clamped(placement, columns);
  const next: Record<string, Placement> = { ...layout, [id]: place };
  if (from !== undefined && place.y > from.y) {
    for (const other of inReadingOrder(layout)) {
      const below = next[other];
      if (other === id || below === undefined || below.y <= from.y || !overlaps(place, below)) continue;
      const risen = { ...below, y: from.y };
      const blocked = Object.entries(next).some(
        ([third, placed]) => third !== id && third !== other && overlaps(risen, placed),
      );
      if (blocked) continue;
      next[other] = risen;
      place = { ...place, y: Math.max(place.y, risen.y + risen.h) };
      next[id] = place;
    }
  }
  return removeEmptyRows(pushedOutOfTheWay(next, id));
};

/** Takes widget `id` off the grid, closing up any row it leaves empty. */
export const hideWidget = (layout: Layout, id: string): Layout =>
  removeEmptyRows(Object.fromEntries(Object.entries(layout).filter(([shown]) => shown !== id)));

/** Puts widget `id` back on the grid at `placement`, moving whatever is there out of its way. */
export const showWidget = placeWidget;

/**
 * Fits a layout to a grid of `columns`, e.g. one remembered with more: each
 * widget is narrowed to fit, and, in reading order, moved down below any it
 * would then overlap.
 */
export const fitToColumns = (layout: Layout, columns: number): Layout => {
  const fitted: Record<string, Placement> = {};
  for (const id of inReadingOrder(layout)) {
    const placement = layout[id];
    if (placement === undefined) continue;
    let place = clamped(placement, columns);
    const others = Object.values(fitted);
    for (let blocker = others.find((other) => overlaps(place, other)); blocker !== undefined;) {
      place = { ...place, y: blocker.y + blocker.h };
      blocker = others.find((other) => overlaps(place, other));
    }
    fitted[id] = place;
  }
  return removeEmptyRows(fitted);
};

/** The widgets touching widget `id`: beside, above or below it, or at a corner. */
export const neighboursOf = (layout: Layout, id: string): string[] => {
  const widget = layout[id];
  if (widget === undefined) return [];
  const around = { x: widget.x - 1, y: widget.y - 1, w: widget.w + 2, h: widget.h + 2 };
  return Object.entries(layout)
    .filter(([other, placement]) => other !== id && overlaps(around, placement))
    .map(([other]) => other);
};

/** What a Remote remembers of a tab's widgets: which are hidden, and a layout for each number of columns. */
export interface SavedWidgets {
  readonly hidden: readonly string[];
  /** Each widget's place, hidden ones too, so that each is shown again where it was. */
  readonly layouts: Readonly<Record<number, Layout>>;
}

/**
 * Where a Remote remembers each tab's widgets, under a key of the tab's own:
 * in the browser, as each Remote is laid out its own way.
 */
export const TV_WIDGET_LAYOUT_KEY = "media-centre:tv-widgets";
export const AIRCON_WIDGET_LAYOUT_KEY = "media-centre:aircon-widgets";
export const LIGHTS_WIDGET_LAYOUT_KEY = "media-centre:lights-widgets";
export const HEATING_WIDGET_LAYOUT_KEY = "media-centre:heating-widgets";
export const NETWORK_WIDGET_LAYOUT_KEY = "media-centre:network-widgets";
export const BLUETOOTH_WIDGET_LAYOUT_KEY = "media-centre:bluetooth-widgets";
export const AMAZON_WIDGET_LAYOUT_KEY = "media-centre:amazon-widgets";
export const RING_WIDGET_LAYOUT_KEY = "media-centre:ring-widgets";
/** Each Room on the Rooms tab has widgets of its own, so each is remembered by the Room, or "No room". */
export const roomWidgetLayoutKey = (room: string): string => `media-centre:rooms-widgets:${room}`;

const NOTHING_SAVED: SavedWidgets = { hidden: [], layouts: {} };

const isPlacement = (value: unknown): value is Placement =>
  typeof value === "object" &&
  value !== null &&
  ["x", "y", "w", "h"].every((key) => Number.isSafeInteger((value as Record<string, unknown>)[key]));

const isLayout = (value: unknown): value is Layout =>
  typeof value === "object" && value !== null && Object.values(value).every(isPlacement);

/** The widgets remembered under `key` as this Remote last left them, or nothing, if it remembers nothing it can read. */
export const loadWidgetLayout = (storage: RemoteStorage, key: string): SavedWidgets => {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    if (typeof saved !== "object" || saved === null) return NOTHING_SAVED;
    const { hidden, layouts } = saved as Record<string, unknown>;
    if (!Array.isArray(hidden) || !hidden.every((id) => typeof id === "string")) return NOTHING_SAVED;
    if (typeof layouts !== "object" || layouts === null || !Object.values(layouts).every(isLayout)) {
      return NOTHING_SAVED;
    }
    return { hidden, layouts: layouts as Record<number, Layout> };
  } catch {
    return NOTHING_SAVED;
  }
};

export const saveWidgetLayout = (storage: RemoteStorage, key: string, saved: SavedWidgets): void => {
  try {
    storage.setItem(key, JSON.stringify(saved));
  } catch {
    // A browser that refuses storage, e.g. in private browsing, just forgets.
  }
};
