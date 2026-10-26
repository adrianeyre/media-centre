import type { DatabaseSync } from "node:sqlite";

import {
  LIGHT_SCENE_NAME_MAX_LENGTH,
  type LightChange,
  type LightScene,
  type LightSceneSaved,
  type LightsOutcome,
  type LightState,
  type SaveLightSceneRequest,
} from "@media-centre/shared";

import type { ApplianceStore } from "./appliances.ts";
import { DriverFailure, type LightDriver } from "./drivers/driver.ts";
import { HttpRefusal } from "./http.ts";
import { changeEach, readLight } from "./lights.ts";
import { characters, nameKey } from "./names.ts";

/**
 * Why the Hub refused a change to the Light Scenes. The message is written
 * for the person using the Remote, which shows it as is.
 */
export class LightSceneRefusal extends Error {
  readonly reason: "invalid" | "taken" | "missing" | "stale";

  constructor(reason: LightSceneRefusal["reason"], message: string) {
    super(message);
    this.name = "LightSceneRefusal";
    this.reason = reason;
  }
}

export interface LightSceneStore {
  /** Every Light Scene, by Room, in Room order, each Room's in the order they were saved. */
  readonly list: () => LightScene[];
  /** Refuses with "missing" when there is no such Light Scene. */
  readonly get: (id: number) => LightScene;
  /**
   * Checks that the Room may have a Light Scene called `name`, as
   * {@link save} will, so that a refusal comes before the Lights are read.
   */
  readonly checkName: (roomId: number, name: string) => void;
  /** Keeps the Room's Lights, as they are, under `name`, leaving out any Light since removed. */
  readonly save: (
    roomId: number,
    name: string,
    lights: readonly { readonly id: number; readonly state: LightState }[],
  ) => LightScene;
  readonly rename: (id: number, name: string) => LightScene;
  readonly remove: (id: number) => void;
}

interface LightSceneRow {
  readonly id: number;
  readonly room_id: number;
  readonly name: string;
}

interface LightSceneLightRow {
  readonly light_scene_id: number;
  readonly appliance_id: number;
  readonly is_on: number;
  readonly brightness: number | null;
  readonly colour_temperature: number | null;
  readonly hue: number | null;
  readonly saturation: number | null;
}

const stateFrom = (row: LightSceneLightRow): LightState => ({
  on: row.is_on === 1,
  brightness: row.brightness,
  colourTemperature: row.colour_temperature,
  colour: row.hue === null || row.saturation === null ? null : { hue: row.hue, saturation: row.saturation },
});

/**
 * The Light Scenes, kept in the Hub's database so that they survive a
 * restart (FR-56, NFR-4), not in a brand's app. Every rule about them is
 * enforced here, whoever asks: each is of a Room, and goes with it, and its
 * name is unique in the Room, ignoring case.
 */
export const lightSceneStore = (database: DatabaseSync): LightSceneStore => {
  const lightsOf = (ids: readonly number[]): Map<number, { id: number; state: LightState }[]> => {
    const all = new Map<number, { id: number; state: LightState }[]>(ids.map((id) => [id, []]));
    const rows = database
      .prepare(
        "SELECT light_scene_id, appliance_id, is_on, brightness, colour_temperature, hue, saturation " +
          "FROM light_scene_light ORDER BY appliance_id",
      )
      .all() as unknown as LightSceneLightRow[];
    for (const row of rows) all.get(row.light_scene_id)?.push({ id: row.appliance_id, state: stateFrom(row) });
    return all;
  };

  const withLights = (rows: readonly LightSceneRow[]): LightScene[] => {
    const lights = lightsOf(rows.map(({ id }) => id));
    return rows.map(({ id, room_id, name }) => ({ id, roomId: room_id, name, lights: lights.get(id) ?? [] }));
  };

  const find = (id: number): LightScene | undefined => {
    const row = database.prepare("SELECT id, room_id, name FROM light_scene WHERE id = ?").get(id) as
      LightSceneRow | undefined;
    return row === undefined ? undefined : withLights([row])[0];
  };

  const get = (id: number): LightScene => {
    const scene = find(id);
    if (scene === undefined) throw new LightSceneRefusal("missing", "That Light Scene has been deleted.");
    return scene;
  };

  /** Checks a proposed name in the Room, and returns it as it will be kept, with its key. */
  const checkName = (roomId: number, proposed: string, renaming?: number): { name: string; key: string } => {
    const name = proposed.trim().normalize("NFC");
    const length = characters(name);
    if (length === 0) throw new LightSceneRefusal("invalid", "Give the Light Scene a name.");
    if (length > LIGHT_SCENE_NAME_MAX_LENGTH) {
      throw new LightSceneRefusal(
        "invalid",
        `A Light Scene's name can be at most ${String(LIGHT_SCENE_NAME_MAX_LENGTH)} characters; that one has ${String(length)}.`,
      );
    }
    const room = database.prepare("SELECT name FROM room WHERE id = ?").get(roomId) as { name: string } | undefined;
    if (room === undefined) throw new LightSceneRefusal("stale", "That Room no longer exists.");
    const key = nameKey(name);
    const other = database
      .prepare("SELECT id, room_id, name FROM light_scene WHERE room_id = ? AND name_key = ?")
      .get(roomId, key) as LightSceneRow | undefined;
    if (other !== undefined && other.id !== renaming) {
      throw new LightSceneRefusal("taken", `There is already a Light Scene called "${other.name}" in ${room.name}.`);
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

  return {
    list: () =>
      withLights(
        database
          .prepare(
            "SELECT light_scene.id, light_scene.room_id, light_scene.name FROM light_scene " +
              "JOIN room ON room.id = light_scene.room_id ORDER BY room.position, room.id, light_scene.id",
          )
          .all() as unknown as LightSceneRow[],
      ),

    get,

    checkName: (roomId, name) => {
      checkName(roomId, name);
    },

    save: (roomId, proposed, lights) => {
      const id = inTransaction(() => {
        const { name, key } = checkName(roomId, proposed);
        const row = database
          .prepare("INSERT INTO light_scene (room_id, name, name_key) VALUES (?, ?, ?) RETURNING id")
          .get(roomId, name, key) as { id: number };
        // A Light removed while it was read is left out.
        const insert = database.prepare(
          "INSERT INTO light_scene_light (light_scene_id, appliance_id, is_on, brightness, colour_temperature, hue, saturation) " +
            "SELECT ?, id, ?, ?, ?, ?, ? FROM appliance WHERE id = ?",
        );
        for (const { id: lightId, state } of lights) {
          insert.run(
            row.id,
            state.on ? 1 : 0,
            state.brightness,
            state.colourTemperature,
            state.colour?.hue ?? null,
            state.colour?.saturation ?? null,
            lightId,
          );
        }
        return row.id;
      });
      return get(id);
    },

    rename: (id, proposed) => {
      const { roomId } = get(id);
      const { name, key } = checkName(roomId, proposed, id);
      database.prepare("UPDATE light_scene SET name = ?, name_key = ? WHERE id = ?").run(name, key, id);
      return get(id);
    },

    remove: (id) => {
      get(id);
      database.prepare("DELETE FROM light_scene WHERE id = ?").run(id);
    },
  };
};

/**
 * "Save as Light Scene" (FR-56): reads each Light in the Room now, through
 * its Driver, and keeps its on/off, brightness, colour temperature and
 * colour as it says them. A Light that doesn't answer is left out, and
 * named, as a Room-wide control names those it didn't reach (FR-57b). The
 * name and Room are checked first, so a refusal doesn't wait on the Lights.
 */
export const saveLightScene = async (
  appliances: ApplianceStore,
  scenes: LightSceneStore,
  driver: LightDriver,
  { roomId, name }: SaveLightSceneRequest,
): Promise<LightSceneSaved> => {
  scenes.checkName(roomId, name);
  const lights = appliances.inRoom("light", roomId);
  if (lights.length === 0) throw new HttpRefusal(409, "There are no Lights in that Room to save.");

  const read = await Promise.all(
    lights.map(async (light) => {
      try {
        const reading = await readLight(appliances, driver, light);
        return { id: light.id, state: reading.known ? reading.state : undefined };
      } catch (error) {
        if (!(error instanceof DriverFailure)) throw error;
        return { id: light.id, state: undefined };
      }
    }),
  );
  const answered = read.flatMap(({ id, state }) => (state === undefined ? [] : [{ id, state }]));
  if (answered.length === 0) {
    throw new HttpRefusal(
      502,
      "None of the Room's Lights answered, so there is nothing to save. Check they are switched on, then try again.",
    );
  }
  return {
    lightScene: scenes.save(roomId, name, answered),
    unreached: read.filter(({ state }) => state === undefined).map(({ id }) => id),
  };
};

/** What sets a Light back to `state`: each part of it the Light had, with white at its colour temperature or its colour. */
export const changeTo = (state: LightState): LightChange => ({
  on: state.on,
  ...(state.brightness === null ? {} : { brightness: state.brightness }),
  ...(state.colour !== null
    ? { colour: state.colour }
    : state.colourTemperature === null
      ? {}
      : { colourTemperature: state.colourTemperature }),
});

/**
 * Recalls a Light Scene (FR-56): sets each Light still in its Room, and in
 * it, back to how it was saved, at once, through each one's Driver, and
 * answers once each has answered or not, saying which didn't (FR-57b). A
 * Light added to the Room since is left as it is; one moved out of it, or
 * removed, is skipped.
 */
export const recallLightScene = async (
  appliances: ApplianceStore,
  scenes: LightSceneStore,
  driver: LightDriver,
  id: number,
): Promise<LightsOutcome> => {
  const { roomId, lights } = scenes.get(id);
  const saved = new Map(lights.map((light) => [light.id, light.state]));
  const inRoom = appliances.inRoom("light", roomId).filter((light) => saved.has(light.id));
  return changeEach(appliances, driver, inRoom, (light) => {
    const state = saved.get(light.id);
    return Promise.resolve(state === undefined ? undefined : changeTo(state));
  });
};
