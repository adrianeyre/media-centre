import type { DatabaseSync } from "node:sqlite";

import { FLOOR_PLAN_PLACE_PATTERN, ROOM_NAME_MAX_LENGTH, type FloorPlanPlaces, type Room } from "@media-centre/shared";

import { characters, nameKey } from "./names.ts";

/**
 * Why the Hub refused a change to the Rooms. The message is written for the
 * person using the Remote, which shows it as is.
 */
export class RoomRefusal extends Error {
  readonly reason: "invalid" | "taken" | "missing" | "stale";

  constructor(reason: RoomRefusal["reason"], message: string) {
    super(message);
    this.name = "RoomRefusal";
    this.reason = reason;
  }
}

export interface RoomStore {
  /** Every Room, in Room order. */
  readonly list: () => Room[];
  /** Adds a Room at the end of the Room order. */
  readonly add: (name: string) => Room;
  readonly rename: (id: number, name: string) => Room;
  readonly remove: (id: number) => void;
  /** Sets the Room order: `ids` must name every Room, each once. */
  readonly reorder: (ids: readonly number[]) => Room[];
  /** Which Room each place on the floor plan is. */
  readonly floorPlan: () => FloorPlanPlaces;
  /** Makes `place` that Room, taking it off any other place, as a Room is in one place. */
  readonly place: (place: string, roomId: number) => FloorPlanPlaces;
  /** Leaves `place` no Room. */
  readonly unplace: (place: string) => FloorPlanPlaces;
}

/**
 * The Rooms, kept in the Hub's database so they and their order survive a
 * restart (NFR-4). Every rule about them is enforced here, whoever asks
 * (FR-7, FR-10).
 */
export const roomStore = (database: DatabaseSync): RoomStore => {
  const list = (): Room[] =>
    database.prepare("SELECT id, name FROM room ORDER BY position, id").all() as unknown as Room[];

  const find = (id: number): Room | undefined =>
    database.prepare("SELECT id, name FROM room WHERE id = ?").get(id) as Room | undefined;

  const mustFind = (id: number): Room => {
    const room = find(id);
    if (room === undefined) throw new RoomRefusal("missing", "That Room no longer exists.");
    return room;
  };

  /** Checks a proposed name, and returns it as it will be kept, with its key. */
  const checkName = (proposed: string, renaming?: number): { name: string; key: string } => {
    const name = proposed.trim().normalize("NFC");
    const length = characters(name);
    if (length === 0) throw new RoomRefusal("invalid", "Give the Room a name.");
    if (length > ROOM_NAME_MAX_LENGTH) {
      throw new RoomRefusal(
        "invalid",
        `A Room's name can be at most ${String(ROOM_NAME_MAX_LENGTH)} characters; that one has ${String(length)}.`,
      );
    }
    const key = nameKey(name);
    const other = database.prepare("SELECT id, name FROM room WHERE name_key = ?").get(key) as Room | undefined;
    if (other !== undefined && other.id !== renaming) {
      throw new RoomRefusal("taken", `There is already a Room called "${other.name}".`);
    }
    return { name, key };
  };

  const inTransaction = <T>(work: () => T): T => {
    database.exec("BEGIN");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const setOrder = (ids: readonly number[]): void => {
    const update = database.prepare("UPDATE room SET position = ? WHERE id = ?");
    ids.forEach((id, position) => update.run(position, id));
  };

  const floorPlan = (): FloorPlanPlaces =>
    Object.fromEntries(
      (
        database.prepare("SELECT place, room_id FROM floor_plan_place ORDER BY place").all() as {
          place: string;
          room_id: number;
        }[]
      ).map(({ place, room_id }) => [place, room_id]),
    );
  const checkPlace = (place: string): void => {
    if (!FLOOR_PLAN_PLACE_PATTERN.test(place)) {
      throw new RoomRefusal("invalid", "That isn't a place on the floor plan.");
    }
  };

  return {
    list,
    floorPlan,
    place: (place, roomId) => {
      checkPlace(place);
      mustFind(roomId);
      inTransaction(() => {
        database.prepare("DELETE FROM floor_plan_place WHERE room_id = ? OR place = ?").run(roomId, place);
        database.prepare("INSERT INTO floor_plan_place (place, room_id) VALUES (?, ?)").run(place, roomId);
      });
      return floorPlan();
    },
    unplace: (place) => {
      checkPlace(place);
      database.prepare("DELETE FROM floor_plan_place WHERE place = ?").run(place);
      return floorPlan();
    },

    add: (proposed) => {
      const { name, key } = checkName(proposed);
      const { id } = database
        .prepare(
          "INSERT INTO room (name, name_key, position) VALUES (?, ?, (SELECT coalesce(max(position) + 1, 0) FROM room)) RETURNING id",
        )
        .get(name, key) as { id: number };
      return { id, name };
    },

    rename: (id, proposed) => {
      mustFind(id);
      const { name, key } = checkName(proposed, id);
      database.prepare("UPDATE room SET name = ?, name_key = ? WHERE id = ?").run(name, key, id);
      return { id, name };
    },

    remove: (id) => {
      mustFind(id);
      inTransaction(() => {
        database.prepare("DELETE FROM room WHERE id = ?").run(id);
        setOrder(list().map((room) => room.id));
      });
    },

    reorder: (ids) => {
      const current = list().map((room) => room.id);
      const asked = new Set(ids);
      if (asked.size !== ids.length || asked.size !== current.length || !current.every((id) => asked.has(id))) {
        throw new RoomRefusal("stale", "The Rooms have changed since this list was shown. Try again.");
      }
      inTransaction(() => {
        setOrder(ids);
      });
      return list();
    },
  };
};
