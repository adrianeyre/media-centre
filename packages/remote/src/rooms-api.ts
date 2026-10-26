import {
  FLOOR_PLAN_DRAWING_PATH,
  FLOOR_PLAN_IMAGE_PATH,
  FLOOR_PLAN_PATH,
  floorPlanPlacePath,
  ROOM_ORDER_PATH,
  ROOMS_PATH,
  roomPath,
  type FloorPlanDrawing,
  type FloorPlanLayout,
  type FloorPlanPlaces,
  type Room,
} from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/** The Hub's Rooms, as the Remote asks for and changes them (FR-7, FR-10). */
export interface RoomsApi {
  /** Every Room, in Room order. */
  readonly list: () => Promise<Room[]>;
  readonly add: (name: string) => Promise<Room>;
  readonly rename: (id: number, name: string) => Promise<Room>;
  readonly remove: (id: number) => Promise<void>;
  /** Sets the Room order, and resolves with every Room in it. */
  readonly reorder: (ids: readonly number[]) => Promise<Room[]>;
  /** Which Room each place on the floor plan is. */
  readonly floorPlan: () => Promise<FloorPlanPlaces>;
  /** Makes a place on the floor plan that Room, and resolves with every place as it now is. */
  readonly place: (place: string, roomId: number) => Promise<FloorPlanPlaces>;
  /** Leaves a place on the floor plan no Room, and resolves with every place as it now is. */
  readonly unplace: (place: string) => Promise<FloorPlanPlaces>;
  /** The floor plan's drawing: the layout and image given for this home, each `null` for the built-in one. */
  readonly drawing: () => Promise<FloorPlanDrawing>;
  /** Makes `layout` the plan's, taking off the plan every place no longer on it, and resolves with the drawing as it now is. */
  readonly setLayout: (layout: FloorPlanLayout) => Promise<FloorPlanDrawing>;
  /** Makes `image`, one of `FLOOR_PLAN_IMAGE_TYPES`, the plan's, and resolves with the drawing as it now is. */
  readonly setImage: (image: Blob) => Promise<FloorPlanDrawing>;
  /** Goes back to the built-in drawing, image and layout both. */
  readonly resetDrawing: () => Promise<FloorPlanDrawing>;
}

/** Talks to the Hub about Rooms. A refusal fails with a `HubRequestFailed` giving the Hub's reason. */
export const createRoomsApi = (fetchFn: typeof fetch = fetch): RoomsApi => {
  const request = createHubRequest(fetchFn);

  return {
    list: async () => (await (await request("GET", ROOMS_PATH)).json()) as Room[],
    add: async (name) => (await (await request("POST", ROOMS_PATH, { name })).json()) as Room,
    rename: async (id, name) => (await (await request("PATCH", roomPath(id), { name })).json()) as Room,
    remove: async (id) => {
      await request("DELETE", roomPath(id));
    },
    reorder: async (ids) => (await (await request("PUT", ROOM_ORDER_PATH, { roomIds: ids })).json()) as Room[],
    floorPlan: async () => (await (await request("GET", FLOOR_PLAN_PATH)).json()) as FloorPlanPlaces,
    place: async (place, roomId) =>
      (await (await request("PUT", floorPlanPlacePath(place), { roomId })).json()) as FloorPlanPlaces,
    unplace: async (place) => (await (await request("DELETE", floorPlanPlacePath(place))).json()) as FloorPlanPlaces,
    drawing: async () => (await (await request("GET", FLOOR_PLAN_DRAWING_PATH)).json()) as FloorPlanDrawing,
    setLayout: async (layout) =>
      (await (await request("PUT", FLOOR_PLAN_DRAWING_PATH, layout)).json()) as FloorPlanDrawing,
    setImage: async (image) => (await (await request("PUT", FLOOR_PLAN_IMAGE_PATH, image)).json()) as FloorPlanDrawing,
    resetDrawing: async () => (await (await request("DELETE", FLOOR_PLAN_DRAWING_PATH)).json()) as FloorPlanDrawing,
  };
};
