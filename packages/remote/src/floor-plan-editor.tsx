import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";

import {
  FLOOR_PLAN_IMAGE_MAX_BYTES,
  FLOOR_PLAN_IMAGE_TYPES,
  FLOOR_PLAN_LAYOUT_LIMITS,
  type FloorPlanDrawing,
  type FloorPlanLayout,
  type FloorPlanPlaces,
  type Room,
} from "@media-centre/shared";

import { Dialog } from "./dialog.tsx";
import {
  BUILT_IN_FLOOR_PLAN,
  BUILT_IN_FLOOR_PLAN_URL,
  floorAt,
  floorPlanOf,
  formatPoints,
  isBuiltInLayout,
  labelSize,
  middleOf,
  nextPlaceId,
  parsePoints,
  simplifyOutline,
  type Point,
} from "./floor-plan.ts";
import { messageFor } from "./hub-request.ts";
import { Icon, type IconName } from "./icons.tsx";
import type { RoomsApi } from "./rooms-api.ts";

/** How a place or a floor is drawn: with a pointer, by the tool chosen. */
export type Tool = "select" | "rectangle" | "shape" | "draw" | "floor";

const TOOLS: readonly { readonly id: Tool; readonly label: string; readonly icon: IconName; readonly hint: string }[] =
  [
    {
      id: "select",
      label: "Select",
      icon: "mouse-pointer",
      hint: "Tap a place to change it: drag a corner, or the dot on an edge to add one; tap a corner to move or remove it.",
    },
    {
      id: "rectangle",
      label: "Rectangle",
      icon: "square",
      hint: "Drag across a room, or tap one corner and then the opposite one.",
    },
    {
      id: "shape",
      label: "Shape",
      icon: "pentagon",
      hint: "Tap each corner of the room in turn, then tap the first again or Finish shape.",
    },
    {
      id: "draw",
      label: "Draw",
      icon: "pencil",
      hint: "Draw round the room in one line. It is closed and tidied as you let go.",
    },
    {
      id: "floor",
      label: "Floor",
      icon: "layers",
      hint: "Drag across the part of the drawing that is one floor, or tap two opposite corners.",
    },
  ];

/** A drawing in progress: a rectangle from one corner, or a shape or line corner by corner. */
type Pending =
  | {
      readonly tool: "rectangle" | "floor";
      readonly from: Point;
      readonly to: Point | undefined;
      /** Whether the pointer is still down from the first corner, or it was a tap and the next is awaited. */
      readonly dragging: boolean;
    }
  | { readonly tool: "shape" | "draw"; readonly corners: readonly Point[] };

type Box = Extract<Pending, { readonly tool: "rectangle" | "floor" }>;
const isBox = (pending: Pending): pending is Box => pending.tool === "rectangle" || pending.tool === "floor";

/** A corner of the chosen place held by the pointer, and whether it has moved yet: let go unmoved, it is a tap. */
interface Handle {
  readonly index: number;
  readonly moved: boolean;
}

/** How many screen pixels one of the drawing's units is, as the drawing is shown now. */
const useScale = (canvas: RefObject<SVGSVGElement | null>, width: number, height: number): number => {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const svg = canvas.current;
    if (svg === null) return;
    const measure = (): void => {
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setScale(Math.min(rect.width / width, rect.height / height));
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(svg);
      return () => {
        observer.disconnect();
      };
    }
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [canvas, width, height]);
  return scale;
};

/** The image shown: the Hub's or the built-in one by its URL, or a file chosen here, until it is saved. */
interface Picture {
  readonly url: string;
  readonly file: File | undefined;
  readonly builtIn: boolean;
}

/** What Undo goes back to: the layout and the image together, as a new image starts the layout over. */
interface Draft {
  readonly layout: FloorPlanLayout;
  readonly picture: Picture;
}

/** An image file as the editor needs it: where to show it from, and how big it is. */
export type LoadImage = (file: File) => Promise<{ url: string; width: number; height: number }>;

/** Shows the file from the browser's own memory, as big as the image is. */
const loadImageInBrowser: LoadImage = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({ url, width: image.naturalWidth || 1200, height: image.naturalHeight || 800 });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't an image the browser can show."));
    };
    image.src = url;
  });

const IMAGE_TYPES: readonly string[] = FLOOR_PLAN_IMAGE_TYPES;

/** A place's name for the lists and the plan: "place-3" is "Place 3". */
export const placeLabel = (id: string): string => {
  const [first = "", ...rest] = id.split("-");
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
};

const bounds = (from: Point, to: Point) => ({
  x: Math.min(from[0], to[0]),
  y: Math.min(from[1], to[1]),
  width: Math.abs(to[0] - from[0]),
  height: Math.abs(to[1] - from[1]),
});

const rectangleCorners = (from: Point, to: Point): Point[] => {
  const { x, y, width, height } = bounds(from, to);
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
};

export interface FloorPlanEditorProps {
  readonly roomsApi: RoomsApi;
  readonly onClose: () => void;
  /** Called with the drawing as the Hub now has it, once saved. */
  readonly onSaved: (drawing: FloorPlanDrawing) => void;
  /** {@link loadImageInBrowser} but in tests. */
  readonly loadImage?: LoadImage;
}

/**
 * Draws the floor plan: the image it is, the Hub's or one chosen here, and
 * on it each floor, the part of the drawing it is, and each place, as a
 * rectangle, a shape corner by corner, or a line drawn round it by hand,
 * which becomes an outline. Nothing reaches the Hub until Save: the image,
 * if a new one, then the layout, which takes off the plan every place no
 * longer on it. Undo goes back a step at a time, and Escape lets go of a
 * shape half drawn before it closes the editor.
 */
export const FloorPlanEditor = ({
  roomsApi,
  onClose,
  onSaved,
  loadImage = loadImageInBrowser,
}: FloorPlanEditorProps) => {
  const [home, setHome] = useState<
    | { readonly drawing: FloorPlanDrawing; readonly rooms: readonly Room[]; readonly places: FloorPlanPlaces }
    | undefined
  >();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [history, setHistory] = useState<readonly Draft[]>([]);
  const [tool, setTool] = useState<Tool>("rectangle");
  const [pending, setPending] = useState<Pending | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  /** The chosen place's corner being dragged. */
  const [handle, setHandle] = useState<Handle | undefined>();
  /** The chosen place's corner tapped, to be moved by a tap elsewhere, or removed. */
  const [corner, setCorner] = useState<number | undefined>();
  /** The place whose outline the next shape drawn replaces, keeping its id and so its Room. */
  const [redrawing, setRedrawing] = useState<string | undefined>();
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const canvas = useRef<SVGSVGElement>(null);
  const scale = useScale(canvas, draft?.layout.width ?? 1, draft?.layout.height ?? 1);
  const fileId = useId();
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    let current = true;
    Promise.all([roomsApi.drawing(), roomsApi.list(), roomsApi.floorPlan()]).then(
      ([drawing, rooms, places]) => {
        if (!current) return;
        setHome({ drawing, rooms, places });
        setDraft({
          layout: drawing.layout ?? BUILT_IN_FLOOR_PLAN,
          picture: { url: floorPlanOf(drawing).url, file: undefined, builtIn: drawing.image === null },
        });
      },
      (error: unknown) => {
        if (current) setProblem(messageFor(error));
      },
    );
    return () => {
      current = false;
      objectUrls.current.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [roomsApi]);

  const dirty = history.length > 0;

  /** Makes a change that Undo can take back. */
  const edit = (next: (was: Draft) => Draft): void => {
    setDraft((was) => {
      if (was === undefined) return was;
      setHistory((steps) => [...steps, was]);
      return next(was);
    });
  };
  const editLayout = (next: (layout: FloorPlanLayout) => FloorPlanLayout): void => {
    edit((was) => ({ ...was, layout: next(was.layout) }));
  };

  const undo = (): void => {
    const previous = history[history.length - 1];
    if (previous === undefined) return;
    setHistory((steps) => steps.slice(0, -1));
    setDraft(previous);
    setPending(undefined);
    setHandle(undefined);
    setCorner(undefined);
    setStatus("Undone.");
  };

  if (home === undefined || draft === undefined) {
    return (
      <Dialog open wide onClose={onClose} title="Draw the floor plan" closeLabel="Close the floor plan">
        <p role={problem === undefined ? "status" : "alert"}>{problem ?? "Loading…"}</p>
      </Dialog>
    );
  }

  const { layout, picture } = draft;
  /** A little, in the drawing's units: what a tap may wander, and how far a line may bend before it is a corner. */
  const unit = Math.max(layout.width, layout.height) / 400;
  const placeCount = layout.floors.reduce((count, floor) => count + floor.places.length, 0);
  const roomOf = (id: string): Room | undefined => home.rooms.find((room) => room.id === home.places[id]);
  const nameOf = (id: string): string => roomOf(id)?.name ?? placeLabel(id);
  const placeOf = (id: string | undefined) =>
    id === undefined ? undefined : layout.floors.flatMap((floor) => floor.places).find((place) => place.id === id);
  const chosen = tool === "select" ? placeOf(selected) : undefined;
  const chosenCorners = chosen === undefined ? [] : parsePoints(chosen.points);
  /** A handle is a touch target of 24 pixels or more, however big the drawing is, and drawn smaller. */
  const handleReach = 14 / scale;
  const handleSize = 6 / scale;

  const choose = (id: string | undefined): void => {
    setSelected(id);
    setCorner(undefined);
    setHandle(undefined);
  };

  /** Gives a place a new outline: a step to undo, or not while a corner is still being dragged. */
  const setPoints = (id: string, corners: readonly Point[], record: boolean): void => {
    const next = (was: FloorPlanLayout): FloorPlanLayout => ({
      ...was,
      floors: was.floors.map((floor) => ({
        ...floor,
        places: floor.places.map((place) => (place.id === id ? { ...place, points: formatPoints(corners) } : place)),
      })),
    });
    if (record) editLayout(next);
    else setDraft((was) => (was === undefined ? was : { ...was, layout: next(was.layout) }));
  };

  const addPlace = (corners: readonly Point[]): void => {
    if (redrawing !== undefined && placeOf(redrawing) !== undefined) {
      setPoints(redrawing, corners, true);
      setRedrawing(undefined);
      setSelected(redrawing);
      setStatus(`${nameOf(redrawing)} redrawn.`);
      return;
    }
    if (placeCount >= FLOOR_PLAN_LAYOUT_LIMITS.places) {
      setProblem(`A floor plan has at most ${String(FLOOR_PLAN_LAYOUT_LIMITS.places)} places.`);
      return;
    }
    const id = nextPlaceId(layout);
    const at = floorAt(layout, corners[0] ?? [0, 0]);
    editLayout((was) => ({
      ...was,
      floors: was.floors.map((floor, index) =>
        index === at ? { ...floor, places: [...floor.places, { id, points: formatPoints(corners) }] } : floor,
      ),
    }));
    setSelected(id);
    setStatus(`${placeLabel(id)} added${layout.floors.length > 1 ? ` to ${layout.floors[at]?.name ?? ""}` : ""}.`);
  };

  const addFloor = (from: Point, to: Point): void => {
    if (layout.floors.length >= FLOOR_PLAN_LAYOUT_LIMITS.floors) {
      setProblem(`A floor plan has at most ${String(FLOOR_PLAN_LAYOUT_LIMITS.floors)} floors.`);
      return;
    }
    const { x, y, width, height } = bounds(from, to);
    const name = `Floor ${String(layout.floors.length + 1)}`;
    editLayout((was) => ({
      ...was,
      floors: [
        ...was.floors,
        {
          name,
          viewBox:
            formatPoints([[x, y]]).replace(",", " ") + ` ${String(Math.round(width))} ${String(Math.round(height))}`,
          places: [],
        },
      ],
    }));
    setStatus(`${name} added. Name it in the list.`);
  };

  const deletePlace = (id: string): void => {
    editLayout((was) => ({
      ...was,
      floors: was.floors.map((floor) => ({ ...floor, places: floor.places.filter((place) => place.id !== id) })),
    }));
    if (selected === id) setSelected(undefined);
    const room = roomOf(id);
    setStatus(`${nameOf(id)} deleted.${room === undefined ? "" : ` ${room.name} is off the plan once saved.`}`);
  };

  const deleteFloor = (index: number): void => {
    const floor = layout.floors[index];
    if (floor === undefined || layout.floors.length === 1) return;
    editLayout((was) => ({ ...was, floors: was.floors.filter((_, each) => each !== index) }));
    setStatus(`${floor.name} deleted, with its ${String(floor.places.length)} places.`);
  };

  const renameFloor = (index: number, name: string): void => {
    setDraft((was) =>
      was === undefined
        ? was
        : {
            ...was,
            layout: {
              ...was.layout,
              floors: was.layout.floors.map((floor, each) => (each === index ? { ...floor, name } : floor)),
            },
          },
    );
  };

  const pickImage = async (file: File): Promise<void> => {
    setProblem(undefined);
    if (!IMAGE_TYPES.includes(file.type)) {
      setProblem("Choose an SVG, PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > FLOOR_PLAN_IMAGE_MAX_BYTES) {
      setProblem(`That image is too big: at most ${String(FLOOR_PLAN_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
      return;
    }
    try {
      const { url, width, height } = await loadImage(file);
      objectUrls.current.push(url);
      edit(() => ({
        layout: {
          width,
          height,
          floors: [{ name: "Home", viewBox: `0 0 ${String(width)} ${String(height)}`, places: [] }],
        },
        picture: { url, file, builtIn: false },
      }));
      setPending(undefined);
      setSelected(undefined);
      setStatus(`${file.name} is the drawing now. Draw its places, and its floors if it has more than one.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That file isn't an image the browser can show.");
    }
  };

  const useBuiltIn = (): void => {
    edit(() => ({
      layout: BUILT_IN_FLOOR_PLAN,
      picture: { url: BUILT_IN_FLOOR_PLAN_URL, file: undefined, builtIn: true },
    }));
    setPending(undefined);
    setSelected(undefined);
    setStatus("The built-in drawing, with its places, once saved.");
  };

  /** Where the pointer is, in the drawing's units, or nothing while the drawing has no size on screen. */
  const toDrawing = (event: PointerEvent): Point | undefined => {
    const svg = canvas.current;
    if (svg === null) return undefined;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const scale = Math.min(rect.width / layout.width, rect.height / layout.height);
    const left = rect.left + (rect.width - layout.width * scale) / 2;
    const top = rect.top + (rect.height - layout.height * scale) / 2;
    return [
      Math.min(layout.width, Math.max(0, (event.clientX - left) / scale)),
      Math.min(layout.height, Math.max(0, (event.clientY - top) / scale)),
    ];
  };
  const apart = ([x1, y1]: Point, [x2, y2]: Point): number => Math.hypot(x2 - x1, y2 - y1);

  const finishCorners = (from: Point, to: Point): void => {
    if (tool === "floor") addFloor(from, to);
    else addPlace(rectangleCorners(from, to));
  };

  const finishShape = (): void => {
    if (pending?.tool !== "shape") return;
    if (pending.corners.length < 3) {
      setProblem("A shape needs at least three corners.");
      return;
    }
    setPending(undefined);
    addPlace(pending.corners);
  };

  const letGo = (): void => {
    setPending(undefined);
    setStatus("Let go of the shape.");
  };

  const capture = (event: PointerEvent): void => {
    const svg = canvas.current;
    if (svg !== null && typeof svg.setPointerCapture === "function") svg.setPointerCapture(event.pointerId);
  };

  const startRedraw = (id: string): void => {
    setRedrawing(id);
    setCorner(undefined);
    if (tool === "select") setTool("rectangle");
    setStatus(`Draw ${nameOf(id)} again, with Rectangle, Shape or Draw. It keeps its Room.`);
  };

  /** Takes hold of a corner of the chosen place: dragged, it moves; tapped, it is picked to move by a tap, or to remove. */
  const grabCorner = (event: PointerEvent, index: number): void => {
    event.stopPropagation();
    if (chosen === undefined) return;
    capture(event);
    setProblem(undefined);
    edit((was) => was);
    setHandle({ index, moved: false });
  };

  /** Adds a corner in the middle of an edge of the chosen place, and takes hold of it. */
  const grabEdge = (event: PointerEvent, index: number): void => {
    event.stopPropagation();
    if (chosen === undefined) return;
    if (chosenCorners.length >= FLOOR_PLAN_LAYOUT_LIMITS.points) {
      setProblem(`A place has at most ${String(FLOOR_PLAN_LAYOUT_LIMITS.points)} corners.`);
      return;
    }
    capture(event);
    setProblem(undefined);
    const a = chosenCorners[index] ?? [0, 0];
    const b = chosenCorners[(index + 1) % chosenCorners.length] ?? a;
    const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    setPoints(chosen.id, [...chosenCorners.slice(0, index + 1), middle, ...chosenCorners.slice(index + 1)], true);
    setHandle({ index: index + 1, moved: false });
  };

  const moveCorner = (index: number, to: Point, record: boolean): void => {
    if (chosen === undefined) return;
    setPoints(
      chosen.id,
      chosenCorners.map((each, at) => (at === index ? to : each)),
      record,
    );
  };

  const removeCorner = (): void => {
    if (chosen === undefined || corner === undefined) return;
    if (chosenCorners.length <= 3) {
      setProblem("A place has at least three corners.");
      return;
    }
    setPoints(
      chosen.id,
      chosenCorners.filter((_, at) => at !== corner),
      true,
    );
    setCorner(undefined);
    setStatus(`Corner removed: ${nameOf(chosen.id)} has ${String(chosenCorners.length - 1)}.`);
  };

  const onPointerDown = (event: PointerEvent): void => {
    const at = toDrawing(event);
    if (at === undefined) return;
    if (tool === "select") {
      if (corner !== undefined && chosen !== undefined) {
        moveCorner(corner, at, true);
        setCorner(undefined);
        setStatus("Corner moved.");
      } else {
        // A tap on nothing: the chosen place is let go. A tap on a place chooses it, as its click follows.
        choose(undefined);
      }
      return;
    }
    setProblem(undefined);
    capture(event);
    switch (tool) {
      case "rectangle":
      case "floor":
        if (pending?.tool === tool && !pending.dragging) {
          setPending(undefined);
          if (apart(pending.from, at) < 4 * unit) return;
          finishCorners(pending.from, at);
        } else {
          setPending({ tool, from: at, to: undefined, dragging: true });
        }
        return;
      case "draw":
        setPending({ tool, corners: [at] });
        return;
      case "shape": {
        const corners = pending?.tool === "shape" ? pending.corners : [];
        const first = corners[0];
        if (first !== undefined && corners.length >= 3 && apart(first, at) < 6 * unit) {
          setPending(undefined);
          addPlace(corners);
          return;
        }
        if (corners.length >= FLOOR_PLAN_LAYOUT_LIMITS.points) return;
        setPending({ tool, corners: [...corners, at] });
        return;
      }
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const at = toDrawing(event);
    if (at === undefined) return;
    if (handle !== undefined) {
      moveCorner(handle.index, at, false);
      setHandle({ ...handle, moved: true });
      return;
    }
    if (pending === undefined) return;
    if (pending.tool === "draw") {
      const last = pending.corners[pending.corners.length - 1];
      if (last !== undefined && apart(last, at) < unit) return;
      setPending({ tool: "draw", corners: [...pending.corners, at] });
    } else if (isBox(pending) && pending.dragging) {
      setPending({ ...pending, to: at });
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (handle !== undefined) {
      setHandle(undefined);
      if (handle.moved) {
        setStatus("Corner moved.");
      } else {
        setCorner(handle.index);
        setStatus("Tap where the corner goes, or remove it.");
      }
      return;
    }
    if (pending === undefined) return;
    const at = toDrawing(event) ?? (isBox(pending) ? pending.to : undefined);
    if (pending.tool === "draw") {
      setPending(undefined);
      const corners = simplifyOutline(pending.corners, 1.5 * unit);
      if (corners.length < 3) {
        setStatus("Too short to be a place. Draw round the room in one line.");
        return;
      }
      addPlace(corners.slice(0, FLOOR_PLAN_LAYOUT_LIMITS.points));
    } else if (isBox(pending) && pending.dragging) {
      if (at === undefined || apart(pending.from, at) < 4 * unit) {
        // A tap: the first corner. The next tap is the opposite one.
        setPending({ ...pending, to: undefined, dragging: false });
        setStatus("Now tap the opposite corner.");
        return;
      }
      setPending(undefined);
      finishCorners(pending.from, at);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      let drawing = home.drawing;
      if (picture.builtIn && isBuiltInLayout(layout)) {
        drawing = await roomsApi.resetDrawing();
      } else {
        if (picture.builtIn && home.drawing.image !== null) drawing = await roomsApi.resetDrawing();
        if (picture.file !== undefined) drawing = await roomsApi.setImage(picture.file);
        drawing = await roomsApi.setLayout(layout);
      }
      onSaved(drawing);
    } catch (error) {
      setProblem(messageFor(error));
      setBusy(false);
    }
  };

  const close = (): void => {
    if (pending !== undefined) {
      letGo();
      return;
    }
    if (dirty) setLeaving(true);
    else onClose();
  };

  const pendingShape = (() => {
    if (pending === undefined) return null;
    if (!isBox(pending)) {
      const corners = pending.corners;
      return (
        <g class="floor-plan-pending">
          <polyline points={formatPoints(corners)} />
          {pending.tool === "shape" &&
            corners.map(([x, y], index) => (
              <circle key={index} class="floor-plan-pending-corner" cx={x} cy={y} r={2.5 * unit} />
            ))}
        </g>
      );
    }
    const to = pending.to;
    if (to === undefined) {
      return (
        <g class="floor-plan-pending">
          <circle class="floor-plan-pending-corner" cx={pending.from[0]} cy={pending.from[1]} r={2.5 * unit} />
        </g>
      );
    }
    return (
      <g class="floor-plan-pending">
        <rect {...bounds(pending.from, to)} />
      </g>
    );
  })();

  return (
    <Dialog
      open
      wide
      onClose={close}
      title="Draw the floor plan"
      closeLabel="Close the floor plan"
      footer={
        leaving ? (
          <div class="place-actions" role="group" aria-label="Changes not saved">
            <span class="floor-plan-editor-leaving">Leave without saving?</span>
            <button type="button" class="button-danger" onClick={onClose}>
              Leave, and lose them
            </button>
            <button
              type="button"
              onClick={() => {
                setLeaving(false);
              }}
            >
              Keep drawing
            </button>
          </div>
        ) : (
          <div class="place-actions">
            <button type="button" disabled={busy || !dirty} onClick={undo}>
              <Icon name="rotate-ccw" />
              Undo
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button type="button" class="button-primary" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )
      }
    >
      <div class="floor-plan-editor">
        <div class="floor-plan-editor-main">
          <div class="floor-plan-tools" role="group" aria-label="Tools">
            {TOOLS.map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={tool === id}
                onClick={() => {
                  setPending(undefined);
                  setHandle(undefined);
                  setCorner(undefined);
                  if (id === "select") setRedrawing(undefined);
                  setTool(id);
                }}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          <p class="floor-plan-editor-hint">{TOOLS.find((each) => each.id === tool)?.hint}</p>
          <svg
            ref={canvas}
            class={`floor-plan-canvas floor-plan-canvas-${tool}${chosen === undefined ? "" : " floor-plan-canvas-handles"}${corner === undefined ? "" : " floor-plan-canvas-placing"}`}
            viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
            role="img"
            aria-label={`The drawing, ${String(layout.floors.length)} floors and ${String(placeCount)} places on it`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={letGo}
          >
            <image class="floor-plan-art" href={picture.url} width={layout.width} height={layout.height} />
            {layout.floors.length > 1 &&
              layout.floors.map(({ name, viewBox }, index) => {
                const [x = 0, y = 0, width = 0] = viewBox.split(" ").map(Number);
                return (
                  <g key={index} class="floor-plan-editor-floor">
                    <rect x={x} y={y} width={width} height={viewBox.split(" ").map(Number)[3] ?? 0} />
                    <text x={x + 2 * unit} y={y + 5 * unit} font-size={4 * unit}>
                      {name}
                    </text>
                  </g>
                );
              })}
            {layout.floors.flatMap((floor, at) =>
              floor.places.map(({ id, points }) => {
                const { x, y, width } = middleOf(points);
                const label = nameOf(id);
                const [, , floorWidth = layout.width] = floor.viewBox.split(" ").map(Number);
                return (
                  <g
                    key={id}
                    class={`floor-plan-editor-place${selected === id ? " floor-plan-editor-place-selected" : ""}`}
                  >
                    <polygon
                      points={points}
                      onClick={() => {
                        if (tool !== "select" || selected === id) return;
                        choose(id);
                        setStatus(`${label}${layout.floors.length > 1 ? `, ${layout.floors[at]?.name ?? ""}` : ""}.`);
                      }}
                    />
                    <text x={x} y={y} font-size={labelSize(label, width, floorWidth / 29)}>
                      {label}
                    </text>
                  </g>
                );
              }),
            )}
            {pendingShape}
            {chosen !== undefined && (
              <g class="floor-plan-handles">
                {chosenCorners.map(([x, y], index) => {
                  const [nx, ny] = chosenCorners[(index + 1) % chosenCorners.length] ?? [x, y];
                  return (
                    <g key={index}>
                      <circle
                        class="floor-plan-handle-edge"
                        cx={(x + nx) / 2}
                        cy={(y + ny) / 2}
                        r={handleSize * 0.7}
                        onPointerDown={(event) => {
                          grabEdge(event, index);
                        }}
                      />
                      <circle
                        class="floor-plan-handle-reach"
                        cx={x}
                        cy={y}
                        r={handleReach}
                        onPointerDown={(event) => {
                          grabCorner(event, index);
                        }}
                      />
                      <circle
                        class={`floor-plan-handle${corner === index ? " floor-plan-handle-picked" : ""}`}
                        cx={x}
                        cy={y}
                        r={handleSize}
                      />
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
          {chosen !== undefined && redrawing === undefined && (
            <div class="floor-plan-editor-shape-actions" role="group" aria-label={`${nameOf(chosen.id)}, chosen`}>
              <span class="floor-plan-editor-chosen">
                {nameOf(chosen.id)} · {chosenCorners.length} corners
              </span>
              {corner === undefined ? (
                <button
                  type="button"
                  onClick={() => {
                    startRedraw(chosen.id);
                  }}
                >
                  <Icon name="pencil" />
                  Redraw
                </button>
              ) : (
                <>
                  <button type="button" onClick={removeCorner}>
                    <Icon name="trash" />
                    Remove corner
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCorner(undefined);
                      setStatus("The corner stays.");
                    }}
                  >
                    Leave it
                  </button>
                </>
              )}
            </div>
          )}
          {redrawing !== undefined && (
            <div class="floor-plan-editor-shape-actions" role="group" aria-label={`Redrawing ${nameOf(redrawing)}`}>
              <span class="floor-plan-editor-chosen">Drawing {nameOf(redrawing)} again: it keeps its Room.</span>
              <button
                type="button"
                onClick={() => {
                  setRedrawing(undefined);
                  setPending(undefined);
                  setStatus(`${nameOf(redrawing)} stays as it was.`);
                }}
              >
                Keep it as it was
              </button>
            </div>
          )}
          {pending?.tool === "shape" && (
            <div class="floor-plan-editor-shape-actions">
              <button type="button" onClick={finishShape}>
                <Icon name="check" />
                Finish shape
              </button>
              <button type="button" onClick={letGo}>
                Let go
              </button>
            </div>
          )}
          <p class="floor-plan-editor-status" role="status">
            {status}
          </p>
          {problem !== undefined && (
            <p class="problem" role="alert">
              {problem}
            </p>
          )}
        </div>
        <div class="floor-plan-editor-panel">
          <section aria-labelledby={`${fileId}-image`}>
            <h3 id={`${fileId}-image`}>Drawing</h3>
            <label class="floor-plan-editor-file" for={fileId}>
              Image, up to {String(FLOOR_PLAN_IMAGE_MAX_BYTES / 1024 / 1024)} MB
              <input
                id={fileId}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file !== undefined) void pickImage(file);
                }}
              />
            </label>
            <p class="floor-plan-editor-picture">
              {picture.file !== undefined
                ? `${picture.file.name}, once saved`
                : picture.builtIn
                  ? "The built-in drawing"
                  : "The image given before"}
            </p>
            {!picture.builtIn && (
              <button type="button" onClick={useBuiltIn}>
                <Icon name="image" />
                Use the built-in drawing
              </button>
            )}
          </section>
          <section aria-labelledby={`${fileId}-floors`}>
            <h3 id={`${fileId}-floors`}>Floors</h3>
            <ul aria-label="Floors">
              {layout.floors.map(({ name, places }, index) => (
                <li key={index} class="floor-plan-editor-row">
                  <input
                    type="text"
                    value={name}
                    maxLength={FLOOR_PLAN_LAYOUT_LIMITS.floorNameLength}
                    aria-label={`Floor ${String(index + 1)} name`}
                    onInput={(event) => {
                      renameFloor(index, event.currentTarget.value);
                    }}
                  />
                  <span class="count" aria-label={`${String(places.length)} places`}>
                    {places.length}
                  </span>
                  <button
                    type="button"
                    class="button-icon"
                    aria-label={`Delete ${name}`}
                    disabled={layout.floors.length === 1}
                    onClick={() => {
                      deleteFloor(index);
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby={`${fileId}-places`}>
            <h3 id={`${fileId}-places`}>Places</h3>
            {placeCount === 0 ? (
              <p>None yet. Draw each room with Rectangle, Shape or Draw.</p>
            ) : (
              <ul aria-label="Places">
                {layout.floors.flatMap((floor) =>
                  floor.places.map(({ id }) => (
                    <li key={id} class="floor-plan-editor-row">
                      <button
                        type="button"
                        aria-pressed={selected === id}
                        onClick={() => {
                          choose(id);
                        }}
                      >
                        {nameOf(id)}
                        {roomOf(id) !== undefined && <span class="floor-plan-editor-place-id">{placeLabel(id)}</span>}
                      </button>
                      <button
                        type="button"
                        class="button-icon"
                        aria-label={`Delete ${nameOf(id)}`}
                        onClick={() => {
                          deletePlace(id);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </li>
                  )),
                )}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Dialog>
  );
};
