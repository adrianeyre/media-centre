import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, readHubId } from "./database.ts";
import { MIGRATIONS, schemaVersion } from "./migrations.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-database-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates the file, and any folders above it, on first open", () => {
    const file = join(dir, "not", "yet", "there.sqlite");

    const database = openDatabase(file);
    database.close();

    expect(existsSync(file)).toBe(true);
  });

  it("leaves the database at the latest schema version", () => {
    const database = openDatabase(join(dir, "hub.sqlite"));

    expect(schemaVersion(database)).toBe(MIGRATIONS.length);
    database.close();
  });

  it("keeps the Hub's id from one open to the next", () => {
    const file = join(dir, "hub.sqlite");

    const first = openDatabase(file);
    const id = readHubId(first);
    first.close();
    const second = openDatabase(file);

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(readHubId(second)).toBe(id);
    second.close();
  });

  it("gives a new database a new id", () => {
    const one = openDatabase(join(dir, "one.sqlite"));
    const two = openDatabase(join(dir, "two.sqlite"));

    expect(readHubId(one)).not.toBe(readHubId(two));
    one.close();
    two.close();
  });
});
