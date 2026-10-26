import type { DatabaseSync } from "node:sqlite";

import {
  FLOOR_PLAN_LAYOUT_LIMITS,
  FLOOR_PLAN_PLACE_PATTERN,
  type FloorPlanDrawing,
  type FloorPlanFloor,
  type FloorPlanLayout,
  type FloorPlanPlaceOutline,
} from "@media-centre/shared";

import { characters } from "./names.ts";
import { RoomRefusal } from "./rooms.ts";

/** The image a floor plan was given, as it was given. */
export interface FloorPlanImage {
  readonly type: string;
  readonly bytes: Uint8Array;
  readonly version: number;
}

export interface FloorPlanStore {
  /** The drawing as it is now: each part `null` while the Remote's built-in one is used. */
  readonly drawing: () => FloorPlanDrawing;
  /**
   * Makes `proposed`, checked to be a layout, the plan's, and takes off the
   * plan every place that isn't on it any more.
   */
  readonly setLayout: (proposed: unknown) => FloorPlanDrawing;
  /** The image given, or `undefined` while the built-in one is used. */
  readonly image: () => FloorPlanImage | undefined;
  readonly setImage: (type: string, bytes: Uint8Array) => FloorPlanDrawing;
  /** Goes back to the built-in drawing, image and layout both. */
  readonly reset: () => FloorPlanDrawing;
}

/** A SVG viewBox: four numbers, the last two how wide and high. */
const VIEW_BOX = /^-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){3}$/;
/** An SVG polygon's points, "x,y" pairs. */
const POINT = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;

const invalid = (message: string): never => {
  throw new RoomRefusal("invalid", message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const sizeIn = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > FLOOR_PLAN_LAYOUT_LIMITS.size) {
    return invalid(`The drawing's ${what} must be between 1 and ${String(FLOOR_PLAN_LAYOUT_LIMITS.size)}.`);
  }
  return value;
};

const placeIn = (value: unknown, seen: Set<string>): FloorPlanPlaceOutline => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.points !== "string") {
    return invalid("Each place needs an id and its points.");
  }
  if (!FLOOR_PLAN_PLACE_PATTERN.test(value.id)) return invalid("That isn't a place on the floor plan.");
  if (seen.has(value.id)) return invalid(`Two places have the id "${value.id}".`);
  seen.add(value.id);
  const corners = value.points.split(" ");
  if (corners.length < 3 || corners.length > FLOOR_PLAN_LAYOUT_LIMITS.points || !corners.every((c) => POINT.test(c))) {
    return invalid(`A place's outline has 3 to ${String(FLOOR_PLAN_LAYOUT_LIMITS.points)} corners.`);
  }
  return { id: value.id, points: value.points };
};

const floorIn = (value: unknown, seen: Set<string>): FloorPlanFloor => {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.viewBox !== "string") {
    return invalid("Each floor needs a name and the part of the drawing it is.");
  }
  const name = value.name.trim().normalize("NFC");
  const length = characters(name);
  if (length === 0) invalid("Give each floor a name.");
  if (length > FLOOR_PLAN_LAYOUT_LIMITS.floorNameLength) {
    invalid(`A floor's name can be at most ${String(FLOOR_PLAN_LAYOUT_LIMITS.floorNameLength)} characters.`);
  }
  const [, , width, height] = value.viewBox.split(" ").map(Number);
  if (!VIEW_BOX.test(value.viewBox) || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return invalid(`The part of the drawing "${name}" is must be an SVG viewBox with a width and a height.`);
  }
  if (!Array.isArray(value.places)) return invalid(`"${name}" needs its places, even if there are none yet.`);
  return { name, viewBox: value.viewBox, places: value.places.map((place) => placeIn(place, seen)) };
};

/** Checks that `proposed` is a layout the plan can keep, and returns it as it will be kept. */
export const layoutIn = (proposed: unknown): FloorPlanLayout => {
  if (!isRecord(proposed) || !Array.isArray(proposed.floors)) return invalid("Send the floor plan's layout.");
  const width = sizeIn(proposed.width, "width");
  const height = sizeIn(proposed.height, "height");
  if (proposed.floors.length === 0) return invalid("A floor plan has at least one floor.");
  if (proposed.floors.length > FLOOR_PLAN_LAYOUT_LIMITS.floors) {
    return invalid(`A floor plan has at most ${String(FLOOR_PLAN_LAYOUT_LIMITS.floors)} floors.`);
  }
  const seen = new Set<string>();
  const floors = proposed.floors.map((floor) => floorIn(floor, seen));
  if (seen.size > FLOOR_PLAN_LAYOUT_LIMITS.places) {
    return invalid(`A floor plan has at most ${String(FLOOR_PLAN_LAYOUT_LIMITS.places)} places.`);
  }
  return { width, height, floors };
};

/**
 * The floor plan's own drawing, kept in the Hub's database so that every
 * Remote shows the same plan, with the image and layout given it (NFR-4).
 * Until either is given, the Remote's built-in one is used.
 */
export const floorPlanStore = (database: DatabaseSync): FloorPlanStore => {
  const drawing = (): FloorPlanDrawing => {
    const row = database
      .prepare("SELECT layout, image_type, image_version FROM floor_plan_drawing WHERE singleton = 1")
      .get() as { layout: string | null; image_type: string | null; image_version: number };
    return {
      layout: row.layout === null ? null : (JSON.parse(row.layout) as FloorPlanLayout),
      image: row.image_type === null ? null : { type: row.image_type, version: row.image_version },
    };
  };

  return {
    drawing,
    setLayout: (proposed) => {
      const layout = layoutIn(proposed);
      const ids = layout.floors.flatMap((floor) => floor.places.map((place) => place.id));
      database.exec("BEGIN");
      try {
        database.prepare("UPDATE floor_plan_drawing SET layout = ? WHERE singleton = 1").run(JSON.stringify(layout));
        database
          .prepare(
            `DELETE FROM floor_plan_place WHERE place NOT IN (${ids.length === 0 ? "''" : ids.map(() => "?").join(", ")})`,
          )
          .run(...ids);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return drawing();
    },
    image: () => {
      const row = database
        .prepare("SELECT image, image_type, image_version FROM floor_plan_drawing WHERE singleton = 1")
        .get() as { image: Uint8Array | null; image_type: string | null; image_version: number };
      if (row.image === null || row.image_type === null) return undefined;
      return { type: row.image_type, bytes: row.image, version: row.image_version };
    },
    setImage: (type, bytes) => {
      database
        .prepare(
          "UPDATE floor_plan_drawing SET image = ?, image_type = ?, image_version = image_version + 1 WHERE singleton = 1",
        )
        .run(bytes, type);
      return drawing();
    },
    reset: () => {
      database
        .prepare("UPDATE floor_plan_drawing SET layout = NULL, image = NULL, image_type = NULL WHERE singleton = 1")
        .run();
      return drawing();
    },
  };
};
