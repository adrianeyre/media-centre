import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "./database.ts";
import { mediaSourceStore } from "./media-sources.ts";
import { formatPosition, mediaFileIn, resumePositionStore } from "./resume-positions.ts";

let dir: string;
let database: DatabaseSync;
let sourceId: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-resume-positions-"));
  database = openDatabase(join(dir, "media-centre.sqlite"));
  sourceId = (await mediaSourceStore(database).add("Films", dir)).id;
});

afterEach(async () => {
  database.close();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const ARRIVAL = (): { mediaSourceId: number; path: string } => ({
  mediaSourceId: sourceId,
  path: "Sci-Fi/Arrival.mkv",
});
/** Arrival's length, in milliseconds: 1:56:07. */
const LENGTH_MS = 6_967_000;

describe("Resume Positions (FR-40)", () => {
  it("records how far a Media File has played, and records it again as it plays on", () => {
    const store = resumePositionStore(database);
    expect(store.find(ARRIVAL())).toBeNull();

    expect(store.record(ARRIVAL(), 4_350_000, LENGTH_MS)).toBe("recorded");
    expect(store.find(ARRIVAL())).toBe(4_350_000);

    store.record(ARRIVAL(), 4_351_000, LENGTH_MS);
    expect(store.find(ARRIVAL())).toBe(4_351_000);
  });

  it("keeps one per Media File, not one per Media Source or folder", () => {
    const store = resumePositionStore(database);

    store.record(ARRIVAL(), 60_000, LENGTH_MS);
    store.record({ mediaSourceId: sourceId, path: "Sci-Fi/Contact.mkv" }, 120_000, LENGTH_MS);

    expect(store.find(ARRIVAL())).toBe(60_000);
    expect(store.find({ mediaSourceId: sourceId, path: "Sci-Fi/Contact.mkv" })).toBe(120_000);
    expect(store.find({ mediaSourceId: sourceId, path: "Arrival.mkv" })).toBeNull();
  });

  it("clears it once the Media File has played to within its last 5%, as it is finished", () => {
    const store = resumePositionStore(database);
    store.record(ARRIVAL(), 4_350_000, LENGTH_MS);

    expect(store.record(ARRIVAL(), Math.ceil(LENGTH_MS * 0.95), LENGTH_MS)).toBe("cleared");
    expect(store.find(ARRIVAL())).toBeNull();
    expect(store.record(ARRIVAL(), LENGTH_MS, LENGTH_MS)).toBe("unchanged");
  });

  it("keeps it just short of the last 5%", () => {
    const store = resumePositionStore(database);

    store.record(ARRIVAL(), Math.floor(LENGTH_MS * 0.95) - 1, LENGTH_MS);

    expect(store.find(ARRIVAL())).toBe(Math.floor(LENGTH_MS * 0.95) - 1);
  });

  it("takes the start for no position, leaving what it had, as a Media File loads before it moves to it", () => {
    const store = resumePositionStore(database);
    store.record(ARRIVAL(), 4_350_000, LENGTH_MS);

    expect(store.record(ARRIVAL(), 0, LENGTH_MS)).toBe("unchanged");

    expect(store.find(ARRIVAL())).toBe(4_350_000);
  });

  it("records nothing for a Media Source the Hub hasn't got, and forgets them with their Media Source", () => {
    const store = resumePositionStore(database);

    expect(store.record({ mediaSourceId: sourceId + 1, path: "Arrival.mkv" }, 60_000, LENGTH_MS)).toBe("unchanged");
    store.record(ARRIVAL(), 60_000, LENGTH_MS);
    mediaSourceStore(database).remove(sourceId);

    expect(store.find(ARRIVAL())).toBeNull();
    expect(store.last()).toBeNull();
  });

  it("says which Media File's was recorded last, for the Player to offer (FR-39)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = resumePositionStore(database);
    expect(store.last()).toBeNull();

    store.record(ARRIVAL(), 60_000, LENGTH_MS);
    vi.advanceTimersByTime(1_000);
    store.record({ mediaSourceId: sourceId, path: "Sci-Fi/Contact.mkv" }, 120_000, LENGTH_MS);
    expect(store.last()).toEqual({
      mediaSourceId: sourceId,
      path: "Sci-Fi/Contact.mkv",
      name: "Contact.mkv",
      positionMs: 120_000,
    });

    vi.advanceTimersByTime(1_000);
    store.record(ARRIVAL(), 61_000, LENGTH_MS);
    expect(store.last()).toMatchObject({ name: "Arrival.mkv", positionMs: 61_000 });

    store.record(ARRIVAL(), LENGTH_MS, LENGTH_MS);
    expect(store.last()).toMatchObject({ name: "Contact.mkv", positionMs: 120_000 });
  });

  it("survives the Hub restarting, in its database file (NFR-4)", () => {
    resumePositionStore(database).record(ARRIVAL(), 4_350_000, LENGTH_MS);
    database.close();

    database = openDatabase(join(dir, "media-centre.sqlite"));

    expect(resumePositionStore(database).find(ARRIVAL())).toBe(4_350_000);
    expect(resumePositionStore(database).last()).toMatchObject({ name: "Arrival.mkv", positionMs: 4_350_000 });
  });
});

describe("the Media File at a URL the Hub sent a Player", () => {
  it.each([
    ["http://hub:8080/api/media-sources/3/file/Films/Sci-Fi/Arrival.mkv", 3, "Films/Sci-Fi/Arrival.mkv"],
    ["http://hub:8080/api/media-sources/12/file/Clip.mp4", 12, "Clip.mp4"],
    [
      "http://hub/api/media-sources/1/file/Sci-Fi%20Classics/Arrival%20(2016).mkv",
      1,
      "Sci-Fi Classics/Arrival (2016).mkv",
    ],
  ])("finds it in %s", (url, mediaSourceId, path) => {
    expect(mediaFileIn(url)).toEqual({ mediaSourceId, path });
  });

  it.each([
    ["no URL", null],
    ["not a URL", "Arrival.mkv"],
    ["a folder", "http://hub/api/media-sources/1/folder/Films"],
    ["no Media Source", "http://hub/api/media-sources/0/file/Clip.mp4"],
    ["a broken escape", "http://hub/api/media-sources/1/file/%E0%A4%A"],
  ])("finds none in %s", (_, url) => {
    expect(mediaFileIn(url)).toBeNull();
  });
});

describe("a position, as the Hub logs it", () => {
  it.each([
    [0, "0:00"],
    [30_000, "0:30"],
    [3_599_000, "59:59"],
    [4_350_000, "1:12:30"],
  ])("writes %d ms as %s", (positionMs, written) => {
    expect(formatPosition(positionMs)).toBe(written);
  });
});
