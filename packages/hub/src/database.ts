import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrations.ts";

/**
 * Opens the one SQLite file that holds all the Hub's state (FR-3), creating it
 * and its folder on first start, and brings its schema up to date.
 *
 * It keeps SQLite's default rollback journal rather than WAL, so the state
 * really is one file, safe to copy whenever the Hub is stopped. Deleted rows
 * are overwritten, so a removed Appliance's credentials don't linger in the
 * file (FR-11).
 */
export const openDatabase = (file: string): DatabaseSync => {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA secure_delete = ON");
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
};

/** The id the Hub chose on its first start (see `HubInfo.hubId`). */
export const readHubId = (database: DatabaseSync): string => {
  const row = database.prepare("SELECT id FROM hub").get() as { id: string } | undefined;
  if (row === undefined) throw new Error("The database has no Hub id");
  return row.id;
};
