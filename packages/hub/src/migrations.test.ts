import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS, migrate, schemaVersion, type Migration } from "./migrations.ts";

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});

afterEach(() => {
  database.close();
});

const tables = (): string[] =>
  (
    database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]
  ).map((row) => row.name);

const steps: Migration[] = [
  { version: 1, description: "first", sql: "CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT" },
  { version: 2, description: "second", sql: "CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT" },
];

describe("migrate", () => {
  it("brings a new database up to the latest migration", () => {
    migrate(database);

    expect(schemaVersion(database)).toBe(MIGRATIONS.length);
    expect(tables()).toContain("hub");
  });

  it("does nothing to a database that is already up to date", () => {
    migrate(database);
    const id = database.prepare("SELECT id FROM hub").get();

    migrate(database);

    expect(schemaVersion(database)).toBe(MIGRATIONS.length);
    expect(database.prepare("SELECT id FROM hub").get()).toEqual(id);
  });

  it("applies only the migrations a database has not had", () => {
    migrate(database, steps.slice(0, 1));
    database.prepare("INSERT INTO first (id) VALUES (7)").run();

    migrate(database, steps);

    expect(schemaVersion(database)).toBe(2);
    expect(tables()).toEqual(["first", "second"]);
    expect(database.prepare("SELECT id FROM first").all()).toEqual([{ id: 7 }]);
  });

  it("leaves the database as it was when a migration fails", () => {
    const broken: Migration[] = [
      steps[0] as Migration,
      { version: 2, description: "broken", sql: "CREATE TABLE half (id INTEGER); NOT SQL" },
    ];

    expect(() => {
      migrate(database, broken);
    }).toThrow("Migration 2 (broken) failed");

    expect(schemaVersion(database)).toBe(1);
    expect(tables()).toEqual(["first"]);
  });

  it("refuses a database written by a newer Hub", () => {
    migrate(database, steps);

    expect(() => {
      migrate(database, steps.slice(0, 1));
    }).toThrow("It was written by a newer Hub");
  });

  it("refuses migrations that are out of order", () => {
    expect(() => {
      migrate(database, [steps[1] as Migration]);
    }).toThrow("Migration 1 is numbered 2");
  });
});
