import type { FloorPlanDrawing, FloorPlanPlaces, Room } from "@media-centre/shared";

import { HubRequestFailed } from "../hub-request.ts";
import type { RoomsApi } from "../rooms-api.ts";

export interface FakeRoomsApi extends RoomsApi {
  /** The Rooms the fake Hub has now, in Room order. */
  readonly current: () => readonly Room[];
  /** Makes the next change fail with `message`, as the Hub refusing it would. */
  readonly refuseNext: (message: string) => void;
  /** Which Room each place on the floor plan is, as the fake Hub has it now. */
  readonly places: () => FloorPlanPlaces;
  /** The floor plan's drawing, as the fake Hub has it now. */
  readonly currentDrawing: () => FloorPlanDrawing;
  /** The images given for the floor plan, in order. */
  readonly images: () => readonly Blob[];
}

/**
 * Rooms kept in memory, standing in for the Hub. It makes whatever change it is
 * asked to: the rules are the Hub's, and are tested there.
 */
export const fakeRoomsApi = (
  names: readonly string[] = [],
  initialPlaces: FloorPlanPlaces = {},
  initialDrawing: FloorPlanDrawing = { layout: null, image: null },
): FakeRoomsApi => {
  let rooms: Room[] = names.map((name, index) => ({ id: index + 1, name }));
  let places: Record<string, number> = { ...initialPlaces };
  let drawing: FloorPlanDrawing = initialDrawing;
  const images: Blob[] = [];
  let nextId = rooms.length + 1;
  let refusal: string | undefined;

  const changing = async <T>(work: () => T): Promise<T> => {
    await Promise.resolve();
    if (refusal !== undefined) {
      const message = refusal;
      refusal = undefined;
      throw new HubRequestFailed(message);
    }
    return work();
  };

  return {
    current: () => rooms,
    places: () => places,
    currentDrawing: () => drawing,
    images: () => images,
    refuseNext: (message) => {
      refusal = message;
    },
    list: () => Promise.resolve([...rooms]),
    add: (name) =>
      changing(() => {
        const room = { id: nextId++, name };
        rooms = [...rooms, room];
        return room;
      }),
    rename: (id, name) =>
      changing(() => {
        rooms = rooms.map((room) => (room.id === id ? { id, name } : room));
        return { id, name };
      }),
    remove: (id) =>
      changing(() => {
        rooms = rooms.filter((room) => room.id !== id);
        places = Object.fromEntries(Object.entries(places).filter(([, roomId]) => roomId !== id));
      }),
    reorder: (ids) =>
      changing(() => {
        rooms = ids.map((id) => rooms.find((room) => room.id === id)).filter((room) => room !== undefined);
        return [...rooms];
      }),
    floorPlan: () => Promise.resolve({ ...places }),
    place: (place, roomId) =>
      changing(() => {
        // A Room is in one place, and a place is one Room, as the Hub keeps them.
        places = { ...Object.fromEntries(Object.entries(places).filter(([, id]) => id !== roomId)), [place]: roomId };
        return { ...places };
      }),
    unplace: (place) =>
      changing(() => {
        places = Object.fromEntries(Object.entries(places).filter(([at]) => at !== place));
        return { ...places };
      }),
    drawing: () => Promise.resolve(drawing),
    setLayout: (layout) =>
      changing(() => {
        // A place no longer on the plan is no Room, as the Hub keeps it.
        const ids = new Set(layout.floors.flatMap((floor) => floor.places.map((place) => place.id)));
        places = Object.fromEntries(Object.entries(places).filter(([at]) => ids.has(at)));
        drawing = { ...drawing, layout };
        return drawing;
      }),
    setImage: (image) =>
      changing(() => {
        images.push(image);
        drawing = { ...drawing, image: { type: image.type, version: images.length } };
        return drawing;
      }),
    resetDrawing: () =>
      changing(() => {
        drawing = { layout: null, image: null };
        return drawing;
      }),
  };
};
