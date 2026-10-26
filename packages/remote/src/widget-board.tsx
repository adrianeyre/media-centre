import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import { Icon, type IconName } from "./icons.tsx";
import type { RemoteStorage } from "./remote-storage.ts";
import {
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
  type Placement,
  type SavedWidgets,
} from "./widget-layout.ts";

/** The height of one row of the grid, and the gap between rows and columns, in CSS pixels. */
export const ROW_PX = 24;
export const GAP_PX = 12;

/** How far a pointer moves before a press becomes a drag, so that a tap is still a tap. */
const DRAG_THRESHOLD_PX = 4;

/** How long the widgets around one dropped shake. */
const SHAKE_MS = 450;

export interface WidgetDefinition {
  readonly id: string;
  /** Its name in the Widgets menu, and over it, unless it has a heading of its own. */
  readonly title: string;
  /** Its content starts with its own heading, so the frame shows no title over it. */
  readonly ownHeading?: boolean;
  readonly children: ComponentChildren;
}

export interface WidgetBoardProps {
  readonly widgets: readonly WidgetDefinition[];
  /** Where each widget starts, for each number of columns the grid can have. */
  readonly defaults: Readonly<Record<number, Layout>>;
  /** Where this Remote remembers its layout. */
  readonly storage: RemoteStorage;
  /** The key it remembers it under, the tab's own, so that each tab is laid out on its own. */
  readonly storageKey: string;
  /** The tab's name, as the Widgets menu says it, e.g. "TV". */
  readonly tab: string;
  /** Beside the Widgets menu, above the grid: e.g. the TV picker. */
  readonly toolbar?: ComponentChildren;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A press on a widget, a drag once it moves far enough. */
interface Drag {
  readonly id: string;
  readonly kind: "move" | "resize";
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly start: Box;
  readonly startLayout: Layout;
  /** Once it has moved far enough to be a drag. */
  readonly moving: boolean;
  /** Where the widget is drawn under the pointer, in pixels from the grid's top left. */
  readonly box: Box;
  /** The layout it would land in: itself snapped into the grid, and the others out of its way. */
  readonly preview: Layout;
  /** Whether the press began on the widget's grip, which a tap opens its menu from. */
  readonly onGrip: boolean;
}

/** What a press on a widget's content shouldn't start dragging: its controls, and what is read or chosen. */
const INTERACTIVE =
  "button, a, input, select, textarea, label, summary, dialog, [role='slider'], [tabindex]:not([tabindex='-1'])";

/**
 * The layout for `columns` columns: the one remembered, or else the default,
 * with every widget in it once, any new one where the default puts it, then
 * fitted into the grid.
 */
const layoutFor = (
  saved: SavedWidgets,
  defaults: Readonly<Record<number, Layout>>,
  ids: readonly string[],
  columns: number,
): Layout => {
  const fallback = defaults[columns] ?? {};
  const remembered = saved.layouts[columns] ?? fallback;
  let layout: Layout = Object.fromEntries(Object.entries(remembered).filter(([id]) => ids.includes(id)));
  for (const id of ids) {
    if (layout[id] !== undefined) continue;
    const place = fallback[id] ?? { x: 0, y: Number.MAX_SAFE_INTEGER, w: columns, h: 6 };
    layout = { ...layout, [id]: place };
  }
  return fitToColumns(layout, columns);
};

const only = (layout: Layout, ids: readonly string[]): Layout =>
  Object.fromEntries(Object.entries(layout).filter(([id]) => ids.includes(id)));

/**
 * A grid of widgets, each of which can be dragged by its grip, or, with a
 * mouse, by any part of it that isn't a control, and dropped into the grid,
 * moving whatever is in the way down out of it. It tilts as it is dragged,
 * and the widgets around it shake as it lands. Its corner makes it bigger or
 * smaller, a cell at a time. Any row left with nothing in it is removed.
 *
 * Nothing needs a drag (WCAG 2.5.7): a widget's grip opens a menu that moves
 * it, makes it bigger or smaller and hides it, and the arrow keys on the grip
 * move it, or, with Shift, make it bigger or smaller. The Widgets menu shows
 * or hides each one, and puts every one back where it started.
 *
 * Each number of columns has a layout of its own, and the Remote remembers
 * each, and which widgets are hidden.
 */
export const WidgetBoard = ({ widgets, defaults, storage, storageKey, tab, toolbar }: WidgetBoardProps) => {
  const ids = widgets.map(({ id }) => id);
  const grid = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** Set once drawn at its measured width: until then, widgets jump to their places rather than glide. */
  const [settled, setSettled] = useState(false);
  const [saved, setSaved] = useState<SavedWidgets>(() => loadWidgetLayout(storage, storageKey));
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [shaking, setShaking] = useState<readonly string[]>([]);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (width === 0 || settled) return;
    const frame = requestAnimationFrame(() => {
      setSettled(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [width, settled]);

  useEffect(
    () => () => {
      clearTimeout(shakeTimer.current);
    },
    [],
  );

  const columns = columnsFor(width);
  const hidden = saved.hidden.filter((id) => ids.includes(id));
  const shownIds = ids.filter((id) => !hidden.includes(id));
  const everyPlace = layoutFor(saved, defaults, ids, columns);
  const layout = removeEmptyRows(only(everyPlace, shownIds));
  const shown = drag?.moving === true ? drag.preview : layout;

  const columnWidth = Math.max(0, (width - (columns - 1) * GAP_PX) / columns);
  const boxOf = ({ x, y, w, h }: Placement): Box => ({
    left: x * (columnWidth + GAP_PX),
    top: y * (ROW_PX + GAP_PX),
    width: w * columnWidth + (w - 1) * GAP_PX,
    height: h * ROW_PX + (h - 1) * GAP_PX,
  });
  const rows = Math.max(0, ...Object.values(shown).map(({ y, h }) => y + h));
  const gridHeight = Math.max(0, rows * (ROW_PX + GAP_PX) - GAP_PX);

  const titleOf = (id: string): string => widgets.find((widget) => widget.id === id)?.title ?? id;

  /** Remembers `next` as the layout of the shown widgets, and every hidden one where it was. */
  const commit = (next: Layout, nextHidden: readonly string[] = hidden): void => {
    const updated: SavedWidgets = {
      hidden: nextHidden,
      layouts: { ...saved.layouts, [columns]: { ...everyPlace, ...next } },
    };
    setSaved(updated);
    saveWidgetLayout(storage, storageKey, updated);
  };

  const shake = (around: Layout, id: string): void => {
    clearTimeout(shakeTimer.current);
    setShaking(neighboursOf(around, id));
    shakeTimer.current = setTimeout(() => {
      setShaking([]);
    }, SHAKE_MS);
  };

  /** Moves widget `id` to `place`, as a drop does, and says where it went. */
  const arrange = (id: string, place: Placement): void => {
    const next = placeWidget(layout, id, place, columns);
    commit(next);
    shake(next, id);
    const landed = next[id];
    if (landed !== undefined) {
      setAnnouncement(
        `${titleOf(id)}: column ${String(landed.x + 1)}, row ${String(landed.y + 1)}, ` +
          `${String(landed.w)} wide and ${String(landed.h)} tall.`,
      );
    }
  };

  const hide = (id: string): void => {
    setMenuFor(undefined);
    commit(hideWidget(layout, id), [...hidden, id]);
    setAnnouncement(`${titleOf(id)} hidden. Show it again from the Widgets menu.`);
  };

  const show = (id: string): void => {
    const place = everyPlace[id];
    if (place === undefined) return;
    const next = showWidget(layout, id, place, columns);
    commit(
      next,
      hidden.filter((other) => other !== id),
    );
    shake(next, id);
    setAnnouncement(`${titleOf(id)} shown.`);
  };

  const reset = (): void => {
    const updated: SavedWidgets = { hidden: [], layouts: {} };
    setSaved(updated);
    saveWidgetLayout(storage, storageKey, updated);
    setAnnouncement("Every widget is shown, where it started.");
  };

  const begin = (event: PointerEvent, id: string, kind: Drag["kind"], onGrip: boolean): void => {
    const place = layout[id];
    if (place === undefined || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const start = boxOf(place);
    setDrag({
      id,
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start,
      startLayout: layout,
      moving: false,
      box: start,
      preview: layout,
      onGrip,
    });
  };

  const follow = (event: PointerEvent): void => {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moving && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!drag.moving) setMenuFor(undefined);
    keepInView(event.clientY);
    const place = drag.startLayout[drag.id];
    if (place === undefined) return;
    const cellWidth = columnWidth + GAP_PX;
    const cellHeight = ROW_PX + GAP_PX;
    if (drag.kind === "move") {
      const box = { ...drag.start, left: drag.start.left + dx, top: drag.start.top + dy };
      const target = { ...place, x: Math.round(box.left / cellWidth), y: Math.round(box.top / cellHeight) };
      setDrag({ ...drag, moving: true, box, preview: placeWidget(drag.startLayout, drag.id, target, columns) });
    } else {
      const box = {
        ...drag.start,
        width: Math.max(columnWidth, drag.start.width + dx),
        height: Math.max(ROW_PX * 2, drag.start.height + dy),
      };
      const target = {
        ...place,
        w: Math.max(1, Math.round((box.width + GAP_PX) / cellWidth)),
        h: Math.max(2, Math.round((box.height + GAP_PX) / cellHeight)),
      };
      setDrag({ ...drag, moving: true, box, preview: placeWidget(drag.startLayout, drag.id, target, columns) });
    }
  };

  const end = (event: PointerEvent): void => {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    setDrag(undefined);
    if (drag.moving) {
      commit(drag.preview);
      shake(drag.preview, drag.id);
    } else if (drag.onGrip) {
      setMenuFor((open) => (open === drag.id ? undefined : drag.id));
    }
  };

  const cancel = (event: PointerEvent): void => {
    if (drag?.pointerId === event.pointerId) setDrag(undefined);
  };

  /** The arrow keys on a grip move its widget a cell, or, with Shift, make it bigger or smaller. */
  const onGripKey = (event: KeyboardEvent, id: string): void => {
    const place = layout[id];
    if (place === undefined) return;
    const step = (
      {
        ArrowLeft: event.shiftKey ? { w: -1 } : { x: -1 },
        ArrowRight: event.shiftKey ? { w: 1 } : { x: 1 },
        ArrowUp: event.shiftKey ? { h: -1 } : { y: -1 },
        ArrowDown: event.shiftKey ? { h: 1 } : { y: 1 },
      } as Record<string, Partial<Placement> | undefined>
    )[event.key];
    if (step === undefined) {
      if (event.key === "Escape") setMenuFor(undefined);
      return;
    }
    event.preventDefault();
    arrange(id, {
      x: place.x + (step.x ?? 0),
      y: place.y + (step.y ?? 0),
      w: place.w + (step.w ?? 0),
      h: Math.max(2, place.h + (step.h ?? 0)),
    });
  };

  return (
    <div
      class={["widget-board", settled && "widget-board-settled", drag?.moving === true && "widget-board-dragging"]
        .filter(Boolean)
        .join(" ")}
    >
      <div class="widget-toolbar">
        {toolbar}
        <WidgetsMenu widgets={widgets} tab={tab} hidden={hidden} onShow={show} onHide={hide} onReset={reset} />
      </div>
      <p class="visually-hidden" role="status">
        {announcement}
      </p>
      <div ref={grid} class="widget-grid" style={{ height: `${String(gridHeight)}px` }}>
        {drag?.moving === true && drag.preview[drag.id] !== undefined && (
          <div class="widget-placeholder" style={boxStyle(boxOf(drag.preview[drag.id] as Placement))} />
        )}
        {widgets.map(({ id, title, ownHeading, children }) => {
          const place = shown[id];
          if (place === undefined) return null;
          const dragged = drag?.moving === true && drag.id === id;
          const box = dragged ? drag.box : boxOf(place);
          const classes = ["widget", `widget-${id}`];
          if (dragged) classes.push(drag.kind === "move" ? "widget-dragging" : "widget-resizing");
          if (shaking.includes(id)) classes.push("widget-shake");
          if (menuFor === id) classes.push("widget-menu-open");
          return (
            <div
              key={id}
              class={classes.join(" ")}
              style={boxStyle(box)}
              data-widget={id}
              onPointerDown={(event) => {
                // With a mouse, anything but a control picks a widget up; a finger scrolls the page.
                const target = event.target as HTMLElement;
                const control = target.closest(INTERACTIVE);
                if (event.pointerType !== "mouse" || (control !== null && event.currentTarget.contains(control)))
                  return;
                // Nor its scroll bar, where a press lands on the scrolled element itself.
                if (target.scrollHeight > target.clientHeight && event.offsetX >= target.clientWidth) return;
                event.preventDefault();
                begin(event, id, "move", false);
              }}
              onPointerMove={follow}
              onPointerUp={end}
              onPointerCancel={cancel}
            >
              <WidgetControls
                id={id}
                title={title}
                place={layout[id] ?? place}
                columns={columns}
                menuOpen={menuFor === id}
                onGripDown={(event) => {
                  event.stopPropagation();
                  begin(event, id, "move", true);
                }}
                onGripKey={(event) => {
                  onGripKey(event, id);
                }}
                onToggleMenu={() => {
                  setMenuFor((open) => (open === id ? undefined : id));
                }}
                onCloseMenu={() => {
                  setMenuFor(undefined);
                }}
                onArrange={(next) => {
                  arrange(id, next);
                }}
                onHide={() => {
                  hide(id);
                }}
              />
              <div class="widget-body">
                {!ownHeading && (
                  <p class="widget-title" aria-hidden="true">
                    {title}
                  </p>
                )}
                {children}
              </div>
              <div
                class="widget-resize"
                aria-hidden="true"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  begin(event, id, "resize", false);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

const boxStyle = ({ left, top, width, height }: Box) => ({
  transform: `translate(${String(left)}px, ${String(top)}px)`,
  width: `${String(width)}px`,
  height: `${String(height)}px`,
});

/** Scrolls the page while a widget is dragged near its top or bottom, clear of the app bar and the dock. */
const keepInView = (clientY: number): void => {
  const style = getComputedStyle(document.documentElement);
  const top = Number.parseFloat(style.getPropertyValue("--app-bar-height")) || 0;
  const bottom = window.innerHeight - (Number.parseFloat(style.getPropertyValue("--dock-height")) || 0);
  const edge = 48;
  if (clientY < top + edge) window.scrollBy(0, -12);
  else if (clientY > bottom - edge) window.scrollBy(0, 12);
};

interface WidgetControlsProps {
  readonly id: string;
  readonly title: string;
  readonly place: Placement;
  readonly columns: number;
  readonly menuOpen: boolean;
  readonly onGripDown: (event: PointerEvent) => void;
  readonly onGripKey: (event: KeyboardEvent) => void;
  readonly onToggleMenu: () => void;
  readonly onCloseMenu: () => void;
  readonly onArrange: (place: Placement) => void;
  readonly onHide: () => void;
}

/** A widget's grip, which drags it and opens its menu, and its Hide button. */
const WidgetControls = ({
  id,
  title,
  place,
  columns,
  menuOpen,
  onGripDown,
  onGripKey,
  onToggleMenu,
  onCloseMenu,
  onArrange,
  onHide,
}: WidgetControlsProps) => {
  const menuId = useId();
  const controls = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: PointerEvent): void => {
      if (!controls.current?.contains(event.target as Node)) onCloseMenu();
    };
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("pointerdown", away);
    };
  }, [menuOpen]);

  const moves: readonly (readonly [IconName, string, Placement, boolean])[] = [
    ["arrow-up", "Move up", { ...place, y: place.y - 1 }, place.y > 0],
    ["arrow-down", "Move down", { ...place, y: place.y + 1 }, true],
    ["arrow-left", "Move left", { ...place, x: place.x - 1 }, place.x > 0],
    ["arrow-right", "Move right", { ...place, x: place.x + 1 }, place.x + place.w < columns],
    ["plus", "Wider", { ...place, w: place.w + 1 }, place.w < columns],
    ["minus", "Narrower", { ...place, w: place.w - 1 }, place.w > 1],
    ["plus", "Taller", { ...place, h: place.h + 1 }, true],
    ["minus", "Shorter", { ...place, h: place.h - 1 }, place.h > 2],
  ];

  return (
    <div ref={controls} class="widget-controls">
      <button
        type="button"
        class="widget-grip"
        aria-label={`Arrange ${title}`}
        aria-expanded={menuOpen}
        aria-controls={menuId}
        aria-describedby={`${menuId}-hint`}
        onPointerDown={onGripDown}
        onKeyDown={onGripKey}
        onClick={(event) => {
          // A pointer's tap opens the menu as it lifts, so this is only for Enter and Space.
          if (event.detail === 0) onToggleMenu();
        }}
      >
        <Icon name="grip" />
      </button>
      <span id={`${menuId}-hint`} class="visually-hidden">
        Drag to move. Arrow keys move it; with Shift, they make it bigger or smaller.
      </span>
      <button type="button" class="widget-hide" aria-label={`Hide ${title}`} onClick={onHide}>
        <Icon name="eye-off" />
      </button>
      {menuOpen && (
        <div id={menuId} class="widget-menu" role="group" aria-label={`Arrange ${title}`} data-widget-menu={id}>
          <div class="widget-menu-grid">
            {moves.map(([icon, label, next, possible]) => (
              <button
                key={label}
                type="button"
                disabled={!possible}
                onClick={() => {
                  onArrange(next);
                }}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          <button type="button" class="widget-menu-hide" onClick={onHide}>
            <Icon name="eye-off" />
            Hide {title}
          </button>
        </div>
      )}
    </div>
  );
};

interface WidgetsMenuProps {
  readonly widgets: readonly WidgetDefinition[];
  readonly tab: string;
  readonly hidden: readonly string[];
  readonly onShow: (id: string) => void;
  readonly onHide: (id: string) => void;
  readonly onReset: () => void;
}

/** Every widget by name, to show or hide each, and a way to put every one back where it started. */
const WidgetsMenu = ({ widgets, tab, hidden, onShow, onHide, onReset }: WidgetsMenuProps) => {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menu.current?.querySelector<HTMLElement>(".widgets-menu-toggle")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const hiddenCount = widgets.filter(({ id }) => hidden.includes(id)).length;

  return (
    <div ref={menu} class="widgets-menu">
      <button
        type="button"
        class="widgets-menu-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="layout-grid" />
        Widgets
        {hiddenCount > 0 && (
          <span class="widgets-menu-count">
            {hiddenCount}
            <span class="visually-hidden"> hidden</span>
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} class="widgets-menu-panel">
          <fieldset>
            <legend>Show on the {tab} tab</legend>
            <ul class="widgets-menu-list">
              {widgets.map(({ id, title }) => {
                const isShown = !hidden.includes(id);
                return (
                  <li key={id}>
                    <label class="widgets-menu-item">
                      <input
                        type="checkbox"
                        checked={isShown}
                        onChange={() => {
                          if (isShown) onHide(id);
                          else onShow(id);
                        }}
                      />
                      <Icon name={isShown ? "eye" : "eye-off"} />
                      <span>{title}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <button
            type="button"
            class="widgets-menu-reset"
            onClick={() => {
              onReset();
            }}
          >
            <Icon name="rotate-ccw" />
            Reset layout
          </button>
        </div>
      )}
    </div>
  );
};
