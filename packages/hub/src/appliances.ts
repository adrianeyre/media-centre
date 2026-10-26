import type { DatabaseSync } from "node:sqlite";

import { APPLIANCE_NAME_MAX_LENGTH, type Appliance, type ApplianceKind, type Room } from "@media-centre/shared";

import { characters, nameKey } from "./names.ts";

/** How the Hub names each kind of Appliance to the person. */
export const KIND_NAMES: Readonly<Record<ApplianceKind, string>> = {
  tv: "TV",
  "air-conditioner": "Air Conditioner",
  light: "Light",
  heating: "Heating",
  "radiator-valve": "Radiator Valve",
  "hot-water": "Hot Water",
};

/** One Appliance of each kind, as the Hub names it to the person: "a TV", "an Air Conditioner". */
export const A_KIND: Readonly<Record<ApplianceKind, string>> = {
  tv: "a TV",
  "air-conditioner": "an Air Conditioner",
  light: "a Light",
  heating: "a Heating",
  "radiator-valve": "a Radiator Valve",
  "hot-water": "the Hot Water",
};

/**
 * Why the Hub refused a change to the Appliances. The message is written for
 * the person using the Remote, which shows it as is.
 */
export class ApplianceRefusal extends Error {
  readonly reason: "invalid" | "taken" | "missing" | "stale";

  constructor(reason: ApplianceRefusal["reason"], message: string) {
    super(message);
    this.name = "ApplianceRefusal";
    this.reason = reason;
  }
}

/** Everything the Hub keeps about a new Appliance, but its credentials. */
export interface NewAppliance {
  readonly kind: ApplianceKind;
  readonly name: string;
  readonly roomId: number | null;
  readonly address: string;
  readonly model: string;
  /** Empty for an Air Conditioner or a Light, which its Driver tells apart by its credentials. */
  readonly macAddress: string;
  /** An Air Conditioner's, which says which unit it is. Left out for a TV or a Light. */
  readonly serialNumber?: string;
}

export interface ApplianceStore {
  /** Every Appliance, in the order they were added. */
  readonly list: () => Appliance[];
  /** Refuses with "missing" when there is no such Appliance. */
  readonly get: (id: number) => Appliance;
  /**
   * Checks that an Appliance of `kind` may be called `name` in the Room, as
   * {@link add} will, so that a refusal comes before the slow work of pairing.
   */
  readonly checkPlace: (kind: ApplianceKind, name: string, roomId: number | null) => void;
  /** The Appliance of `kind` with this MAC address, if the Hub already has it. */
  readonly withMacAddress: (kind: ApplianceKind, macAddress: string) => Appliance | undefined;
  /** The Appliance of `kind` with this serial number, if the Hub already has it. */
  readonly withSerialNumber: (kind: ApplianceKind, serialNumber: string) => Appliance | undefined;
  /**
   * The Appliances of `kind` in the Room, in the order they were added.
   * Refuses with "stale" when the Room no longer exists.
   */
  readonly inRoom: (kind: ApplianceKind, roomId: number) => Appliance[];
  readonly add: (appliance: NewAppliance, credentials: string) => Appliance;
  /**
   * Renames it, or moves it to another Room or to "No room", or, for a TV,
   * sets its film Light Scene, one of its own Room's, or none for null
   * (FR-57). A TV moved to another Room loses one that isn't the new Room's.
   */
  readonly update: (
    id: number,
    change: { readonly name?: string; readonly roomId?: number | null; readonly filmLightSceneId?: number | null },
  ) => Appliance;
  /** Removes it, and its stored credentials with it (FR-11). */
  readonly remove: (id: number) => void;
  /** The credentials it issued, which only its Driver reads and which never leave the Hub (FR-4). */
  readonly credentials: (id: number) => string;
  /** Keeps the credentials it accepted or issued, and marks it paired. */
  readonly paired: (id: number, credentials: string) => Appliance;
  /** Marks it as having refused the Hub's credentials, so the Remote offers "Pair again" (FR-13). */
  readonly refused: (id: number) => Appliance;
  /** "Room · Name", or just the name with no Room, as the Remote writes it (FR-9). */
  readonly title: (appliance: Appliance) => string;
}

interface ApplianceRow {
  readonly id: number;
  readonly kind: ApplianceKind;
  readonly name: string;
  readonly room_id: number | null;
  readonly address: string;
  readonly model: string;
  readonly mac_address: string;
  readonly serial_number: string | null;
  readonly pairing: Appliance["pairing"];
  readonly film_light_scene_id: number | null;
}

const COLUMNS = "id, kind, name, room_id, address, model, mac_address, serial_number, pairing, film_light_scene_id";

const fromRow = (row: ApplianceRow): Appliance => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  roomId: row.room_id,
  address: row.address,
  model: row.model,
  macAddress: row.mac_address,
  ...(row.serial_number === null ? {} : { serialNumber: row.serial_number }),
  pairing: row.pairing,
  ...(row.film_light_scene_id === null ? {} : { filmLightSceneId: row.film_light_scene_id }),
});

/**
 * The Appliances, of every kind, kept in the Hub's database with their
 * credentials so that both survive a restart (NFR-4). Every rule about them is
 * enforced here, whoever asks (FR-8, FR-11).
 */
export const applianceStore = (database: DatabaseSync): ApplianceStore => {
  const find = (id: number): Appliance | undefined => {
    const row = database.prepare(`SELECT ${COLUMNS} FROM appliance WHERE id = ?`).get(id) as ApplianceRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  };

  const get = (id: number): Appliance => {
    const appliance = find(id);
    if (appliance === undefined) throw new ApplianceRefusal("missing", "That Appliance has been removed.");
    return appliance;
  };

  const room = (id: number | null): Room | undefined =>
    id === null ? undefined : (database.prepare("SELECT id, name FROM room WHERE id = ?").get(id) as Room | undefined);

  const title = (appliance: Appliance): string => {
    const where = room(appliance.roomId);
    return where === undefined ? appliance.name : `${where.name} · ${appliance.name}`;
  };

  /** Checks a proposed name and Room, and returns the name as it will be kept, with its key. */
  const checkPlace = (
    kind: ApplianceKind,
    proposed: string,
    roomId: number | null,
    renaming?: number,
  ): { name: string; key: string } => {
    const name = proposed.trim().normalize("NFC");
    const length = characters(name);
    const kindName = KIND_NAMES[kind];
    if (length === 0) throw new ApplianceRefusal("invalid", `Give the ${kindName} a name.`);
    if (length > APPLIANCE_NAME_MAX_LENGTH) {
      const aKind = A_KIND[kind];
      throw new ApplianceRefusal(
        "invalid",
        `${aKind.charAt(0).toUpperCase()}${aKind.slice(1)}'s name can be at most ${String(APPLIANCE_NAME_MAX_LENGTH)} characters; ` +
          `that one has ${String(length)}.`,
      );
    }
    const where = room(roomId);
    if (roomId !== null && where === undefined) throw new ApplianceRefusal("stale", "That Room no longer exists.");

    // With no Room, too: two TVs both shown as "TV" couldn't be told apart.
    const key = nameKey(name);
    const other = database
      .prepare(`SELECT ${COLUMNS} FROM appliance WHERE kind = ? AND room_id IS ? AND name_key = ?`)
      .get(kind, roomId, key) as ApplianceRow | undefined;
    if (other !== undefined && other.id !== renaming) {
      const inRoom = where === undefined ? "with no Room" : `in ${where.name}`;
      throw new ApplianceRefusal("taken", `There is already ${A_KIND[kind]} called "${other.name}" ${inRoom}.`);
    }
    return { name, key };
  };

  /** The Room a Light Scene is of, or undefined once it is deleted. */
  const lightSceneRoom = (lightSceneId: number): number | undefined =>
    (
      database.prepare("SELECT room_id FROM light_scene WHERE id = ?").get(lightSceneId) as
        { room_id: number } | undefined
    )?.room_id;

  /** A TV's film Light Scene, kept as it moves to the Room only if it is that Room's. */
  const filmLightSceneIn = (roomId: number | null, lightSceneId: number | undefined): number | null =>
    lightSceneId !== undefined && roomId !== null && lightSceneRoom(lightSceneId) === roomId ? lightSceneId : null;

  /** Checks a film Light Scene proposed for the Appliance, in the Room it will be in, and returns it as it will be kept. */
  const checkFilmLightScene = (
    appliance: Appliance,
    roomId: number | null,
    lightSceneId: number | null,
  ): number | null => {
    if (lightSceneId === null) return null;
    if (appliance.kind !== "tv") {
      throw new ApplianceRefusal(
        "invalid",
        `Only a TV recalls a Light Scene as a video starts, not ${A_KIND[appliance.kind]}.`,
      );
    }
    const sceneRoom = lightSceneRoom(lightSceneId);
    if (sceneRoom === undefined) throw new ApplianceRefusal("stale", "That Light Scene has been deleted.");
    if (roomId === null) {
      throw new ApplianceRefusal("invalid", "A TV with no Room has no Light Scenes to recall. Give it a Room first.");
    }
    if (sceneRoom !== roomId) {
      throw new ApplianceRefusal(
        "invalid",
        `A TV recalls only a Light Scene of its own Room, ${room(roomId)?.name ?? "which no longer exists"}.`,
      );
    }
    return lightSceneId;
  };

  const withMacAddress = (kind: ApplianceKind, macAddress: string): Appliance | undefined => {
    const row = database
      .prepare(`SELECT ${COLUMNS} FROM appliance WHERE kind = ? AND mac_address = ?`)
      .get(kind, macAddress.toLowerCase()) as ApplianceRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  };

  const withSerialNumber = (kind: ApplianceKind, serialNumber: string): Appliance | undefined => {
    const row = database
      .prepare(`SELECT ${COLUMNS} FROM appliance WHERE kind = ? AND serial_number = ?`)
      .get(kind, serialNumber) as ApplianceRow | undefined;
    return row === undefined ? undefined : fromRow(row);
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

  const setCredentials = (id: number, credentials: string): void => {
    database
      .prepare(
        "INSERT INTO appliance_credentials (appliance_id, credentials) VALUES (?, ?) " +
          "ON CONFLICT (appliance_id) DO UPDATE SET credentials = excluded.credentials",
      )
      .run(id, credentials);
  };

  return {
    list: () =>
      (database.prepare(`SELECT ${COLUMNS} FROM appliance ORDER BY id`).all() as unknown as ApplianceRow[]).map(
        fromRow,
      ),

    get,

    checkPlace: (kind, name, roomId) => {
      checkPlace(kind, name, roomId);
    },

    withMacAddress,

    withSerialNumber,

    inRoom: (kind, roomId) => {
      if (room(roomId) === undefined) throw new ApplianceRefusal("stale", "That Room no longer exists.");
      return (
        database
          .prepare(`SELECT ${COLUMNS} FROM appliance WHERE kind = ? AND room_id = ? ORDER BY id`)
          .all(kind, roomId) as unknown as ApplianceRow[]
      ).map(fromRow);
    },

    add: (appliance, credentials) => {
      const { name, key } = checkPlace(appliance.kind, appliance.name, appliance.roomId);
      const macAddress = appliance.macAddress.toLowerCase();
      const serialNumber = appliance.serialNumber ?? null;
      // A Light has neither, and its Driver tells it apart before it is added.
      const already =
        serialNumber !== null
          ? withSerialNumber(appliance.kind, serialNumber)
          : macAddress === ""
            ? undefined
            : withMacAddress(appliance.kind, macAddress);
      if (already !== undefined) {
        throw new ApplianceRefusal(
          "taken",
          `That ${KIND_NAMES[appliance.kind]} is already added, as ${title(already)}.`,
        );
      }
      const id = inTransaction(() => {
        const row = database
          .prepare(
            "INSERT INTO appliance (kind, name, name_key, room_id, address, model, mac_address, serial_number, pairing) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paired') RETURNING id",
          )
          .get(
            appliance.kind,
            name,
            key,
            appliance.roomId,
            appliance.address,
            appliance.model,
            macAddress,
            serialNumber,
          ) as { id: number };
        setCredentials(row.id, credentials);
        return row.id;
      });
      return get(id);
    },

    update: (id, change) => {
      const current = get(id);
      const roomId = change.roomId === undefined ? current.roomId : change.roomId;
      const { name, key } = checkPlace(current.kind, change.name ?? current.name, roomId, id);
      const filmLightSceneId =
        change.filmLightSceneId === undefined
          ? filmLightSceneIn(roomId, current.filmLightSceneId)
          : checkFilmLightScene(current, roomId, change.filmLightSceneId);
      database
        .prepare("UPDATE appliance SET name = ?, name_key = ?, room_id = ?, film_light_scene_id = ? WHERE id = ?")
        .run(name, key, roomId, filmLightSceneId, id);
      return get(id);
    },

    remove: (id) => {
      get(id);
      database.prepare("DELETE FROM appliance WHERE id = ?").run(id);
    },

    credentials: (id) => {
      get(id);
      const row = database.prepare("SELECT credentials FROM appliance_credentials WHERE appliance_id = ?").get(id) as
        { credentials: string } | undefined;
      if (row === undefined) throw new Error(`Appliance ${String(id)} has no credentials`);
      return row.credentials;
    },

    paired: (id, credentials) => {
      get(id);
      inTransaction(() => {
        setCredentials(id, credentials);
        database.prepare("UPDATE appliance SET pairing = 'paired' WHERE id = ?").run(id);
      });
      return get(id);
    },

    refused: (id) => {
      get(id);
      database.prepare("UPDATE appliance SET pairing = 'pair-again' WHERE id = ?").run(id);
      return get(id);
    },

    title,
  };
};
