import type { DatabaseSync } from "node:sqlite";

/** One step in the schema's history. Once released, a migration is never edited. */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

/**
 * The schema's history, oldest first. Each Hub start applies the ones its
 * database has not had yet, so a database made by any earlier Hub upgrades in
 * place (NFR-4). To change the schema, append a migration; never edit one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "The Hub's own id, chosen once on first start",
    sql: `
      CREATE TABLE hub (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO hub (singleton, id, created_at)
      VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 2,
    description: "Rooms, in the Room order every tab shares",
    // AUTOINCREMENT, so a deleted Room's id is never given to a new one, and a
    // Remote still showing the old Room can't rename or delete the new one.
    // `name_key` is the name with case ignored, and makes names unique (FR-7).
    sql: `
      CREATE TABLE room (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        position INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    description: "Appliances, each in at most one Room, and the credentials they issued",
    // Deleting a Room moves its Appliances to "No room" (FR-11). Names are
    // unique among Appliances of a kind in a Room (FR-8); with no Room,
    // `room_id` is NULL and SQLite lets that through, so a Room deleted never
    // fails, and the Hub checks "No room" itself when it names an Appliance.
    // Credentials are kept apart, and go with their Appliance (FR-4, FR-11).
    sql: `
      CREATE TABLE appliance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        room_id INTEGER REFERENCES room (id) ON DELETE SET NULL,
        address TEXT NOT NULL,
        model TEXT NOT NULL,
        mac_address TEXT NOT NULL,
        pairing TEXT NOT NULL CHECK (pairing IN ('paired', 'pair-again')),
        UNIQUE (kind, room_id, name_key)
      ) STRICT;
      CREATE INDEX appliance_room ON appliance (room_id);
      CREATE TABLE appliance_credentials (
        appliance_id INTEGER PRIMARY KEY REFERENCES appliance (id) ON DELETE CASCADE,
        credentials TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    description: "The IP address set in Settings for the Hub to give TVs instead of the one it finds",
    // NULL until one is set, and again once it is cleared.
    sql: `
      ALTER TABLE hub ADD COLUMN address_override TEXT;
    `,
  },
  {
    version: 5,
    description: "Media Sources, and the duration ffprobe gave each Media File in them",
    // A Media File's duration is kept with the size and modified time it had
    // when probed, and probed again only once either changes. `folder` is its
    // folder's path inside the Media Source, "" for the Media Source's own.
    // `duration` is NULL when ffprobe couldn't tell.
    sql: `
      CREATE TABLE media_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE media_file_probe (
        media_source_id INTEGER NOT NULL REFERENCES media_source (id) ON DELETE CASCADE,
        folder TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified REAL NOT NULL,
        duration REAL,
        PRIMARY KEY (media_source_id, folder, name)
      ) STRICT;
    `,
  },
  {
    version: 6,
    description: "The Resume Position of each Media File, and when it was recorded",
    // One per Media File, not per person or TV (FR-40), going with its Media
    // Source. `path` is the Media File's path inside the Media Source, its
    // names joined by "/". `recorded_at` is in milliseconds since the epoch,
    // and says which Media File the Player's waiting screen offers (FR-39).
    sql: `
      CREATE TABLE resume_position (
        media_source_id INTEGER NOT NULL REFERENCES media_source (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        position_ms INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (media_source_id, path)
      ) STRICT;
      CREATE INDEX resume_position_recorded ON resume_position (recorded_at);
    `,
  },
  {
    version: 7,
    description: "What ffprobe said of each Media File's container and streams, which its Route is chosen by",
    // `probe` is a `MediaProbe` as JSON, NULL when ffprobe couldn't read the
    // file. Media Files probed before kept only a duration, so they are
    // forgotten, and probed again as their folders are next browsed.
    sql: `
      DELETE FROM media_file_probe;
      ALTER TABLE media_file_probe ADD COLUMN probe TEXT;
    `,
  },
  {
    version: 8,
    description: "The owner's signing certificate, which the Player is signed with to install it on a TV",
    // At most one, its two halves each a `.p12` file with its password, kept
    // only here (FR-4). `stored_at` is an ISO 8601 time. Removing it
    // overwrites it, as `secure_delete` does every deleted row.
    sql: `
      CREATE TABLE signing_certificate (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        author BLOB NOT NULL,
        author_password TEXT NOT NULL,
        distributor BLOB NOT NULL,
        distributor_password TEXT NOT NULL,
        stored_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 9,
    description: "The serial number each Air Conditioner says it has, which says which unit it is",
    // NULL for a TV, which is told apart by its MAC address. An Air
    // Conditioner's token and key are its credentials, kept as any
    // Appliance's are (FR-51); the login they were fetched with never is.
    sql: `
      ALTER TABLE appliance ADD COLUMN serial_number TEXT;
      CREATE UNIQUE INDEX appliance_serial_number ON appliance (kind, serial_number) WHERE serial_number IS NOT NULL;
    `,
  },
  {
    version: 10,
    description: "Light Scenes, each a Room's Lights as they were when it was saved",
    // A Light Scene goes with its Room (there is none for "No room"), and a
    // Light's part in it with the Light, once removed. A Light moved to
    // another Room keeps its part, which recalling skips while it is away.
    // Names are unique in a Room, `name_key` being the name with case
    // ignored. A Light's state is kept as `LightState` has it: `brightness`
    // and `colour_temperature` NULL where it hadn't them, `hue` and
    // `saturation` NULL unless it showed a colour.
    sql: `
      CREATE TABLE light_scene (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES room (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        UNIQUE (room_id, name_key)
      ) STRICT;
      CREATE TABLE light_scene_light (
        light_scene_id INTEGER NOT NULL REFERENCES light_scene (id) ON DELETE CASCADE,
        appliance_id INTEGER NOT NULL REFERENCES appliance (id) ON DELETE CASCADE,
        is_on INTEGER NOT NULL CHECK (is_on IN (0, 1)),
        brightness INTEGER,
        colour_temperature INTEGER,
        hue INTEGER,
        saturation INTEGER,
        CHECK ((hue IS NULL) = (saturation IS NULL)),
        PRIMARY KEY (light_scene_id, appliance_id)
      ) STRICT;
      CREATE INDEX light_scene_light_appliance ON light_scene_light (appliance_id);
    `,
  },
  {
    version: 11,
    description: "Each TV's film Light Scene, recalled as the Player starts a video on it",
    // NULL for none, and for any Appliance but a TV. It is one of the TV's
    // own Room's, which the appliance store sees to, and goes, leaving none,
    // with the Light Scene, and so with the Room.
    sql: `
      ALTER TABLE appliance ADD COLUMN film_light_scene_id INTEGER REFERENCES light_scene (id) ON DELETE SET NULL;
    `,
  },
  {
    version: 12,
    description: "The Hub's sign-in to Hive, one for the whole home",
    // At most one: the credentials the Hive Driver hands the Hub, Hive's
    // tokens and the keys of the device Hive trusts the Hub as, kept as
    // text the Hub never reads, and never the password (FR-67, ADR 0010).
    // Each Heating, Radiator Valve and Hot Water on the account is an
    // Appliance, with Hive's id for it as its `serial_number` and no
    // credentials of its own. `signed_in_at` is an ISO 8601 time. Signing
    // out deletes the row, which `secure_delete` overwrites.
    sql: `
      CREATE TABLE hive_account (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        credentials TEXT NOT NULL,
        signed_in_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 13,
    description: "Which Room each place on the home's floor plan is",
    // A place is the Remote's id for an outline on its drawing; the Hub
    // never reads it. A Room is in one place at most, and goes from the
    // plan with the Room.
    sql: `
      CREATE TABLE floor_plan_place (
        place TEXT PRIMARY KEY,
        room_id INTEGER NOT NULL UNIQUE REFERENCES room (id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 14,
    description: "The floor plan's own drawing: its image and the layout drawn on it",
    // One row, there from the start: each part null while the Remote's
    // built-in one is used. The layout is a FloorPlanLayout as JSON; the image
    // is kept as it was given, with its type, and counted each time it is
    // changed so the Remote never shows an old one from a cache.
    sql: `
      CREATE TABLE floor_plan_drawing (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        layout TEXT,
        image BLOB,
        image_type TEXT,
        image_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO floor_plan_drawing (singleton) VALUES (1);
    `,
  },
  {
    version: 15,
    description:
      "What the person named each device on the network, and the ports found open on it by checking every port",
    // `key` is "mac:" and its MAC address, "ip:" and its IP address where the
    // Hub has no MAC address for it, or "bluetooth:" and its Bluetooth
    // address. `open_ports` is a JSON array of port numbers.
    sql: `
      CREATE TABLE network_device (
        key TEXT PRIMARY KEY,
        name TEXT,
        open_ports TEXT NOT NULL DEFAULT '[]'
      ) STRICT;
    `,
  },
  {
    version: 16,
    description: "The Room each device on the network is in, unless it is an Appliance, and what it was last seen as",
    // `room_id` is null for "No room", as deleting the Room leaves it. The
    // rest is what a scan last saw of a device the Hub keeps anything of, for
    // the Rooms tab to show it by between scans: its address, what it is
    // called but for its own name, and who made it.
    sql: `
      ALTER TABLE network_device ADD COLUMN room_id INTEGER REFERENCES room (id) ON DELETE SET NULL;
      ALTER TABLE network_device ADD COLUMN address TEXT;
      ALTER TABLE network_device ADD COLUMN label TEXT;
      ALTER TABLE network_device ADD COLUMN maker TEXT;
    `,
  },
  {
    version: 17,
    description: "The Hub's one sign-in to Amazon, and the last scan of the network and of Bluetooth",
    // `session` is the Alexa app's session, as JSON, which is secret (ADR
    // 0011, FR-4). `scan` is what a scan found, as JSON, kept so that the
    // Network tab shows it after a restart without scanning again.
    sql: `
      CREATE TABLE amazon_account (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        domain TEXT NOT NULL,
        session TEXT NOT NULL,
        signed_in_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE network_scan (
        kind TEXT PRIMARY KEY CHECK (kind IN ('network', 'bluetooth')),
        scan TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 18,
    description: "The Hub's one sign-in to Ring",
    // `token` is the token Ring issued, which is secret (ADR 0014, FR-4).
    // The password it was issued for is never kept.
    sql: `
      CREATE TABLE ring_account (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token TEXT NOT NULL,
        signed_in_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

/**
 * Brings the database up to the latest migration. The version it has reached is
 * SQLite's `user_version`, and each migration commits together with the version
 * it sets, so a failed migration leaves the database as it was.
 */
export const migrate = (database: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void => {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration ${String(index + 1)} is numbered ${String(migration.version)}`);
    }
  });

  const current = schemaVersion(database);
  if (current > migrations.length) {
    throw new Error(
      `The database is at schema version ${String(current)}, but this Hub only knows up to ${String(migrations.length)}. ` +
        "It was written by a newer Hub; run that one instead.",
    );
  }

  for (const migration of migrations.slice(current)) {
    database.exec("BEGIN");
    try {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${String(migration.version)}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Migration ${String(migration.version)} (${migration.description}) failed`, { cause: error });
    }
  }
};

export const schemaVersion = (database: DatabaseSync): number => {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
};
