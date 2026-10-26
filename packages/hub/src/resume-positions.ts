import type { DatabaseSync } from "node:sqlite";

import { MEDIA_SOURCES_PATH, RESUME_FINISHED_FRACTION, type ResumableMediaFile } from "@media-centre/shared";

/** A Media File, by its Media Source and its path inside it, its names joined by "/". */
export interface MediaFileAt {
  readonly mediaSourceId: number;
  readonly path: string;
}

/** What recording a position did to the Media File's Resume Position. */
export type Recorded = "recorded" | "cleared" | "unchanged";

export interface ResumePositionStore {
  /** The Media File's Resume Position, in milliseconds, or null when it has none. */
  readonly find: (file: MediaFileAt) => number | null;
  /**
   * Records how far playback of the Media File has reached, from what a
   * Player reported: its Resume Position from now on, or none once that is
   * within its last 5%, as it is then finished (FR-40). The start is no
   * position, so it changes nothing, as when a Media File loads before it
   * moves to its Resume Position; nor does a Media File in a Media Source
   * the Hub hasn't got.
   */
  readonly record: (file: MediaFileAt, positionMs: number, durationMs: number) => Recorded;
  /** The Media File whose Resume Position was recorded last, or null when none has one (FR-39). */
  readonly last: () => ResumableMediaFile | null;
}

/** A Media File's path inside its Media Source, as the Hub keeps it: its names joined by "/". */
export const mediaFilePathOf = (names: readonly string[]): string => names.join("/");

/** The Media File's file name, the last name in its path. */
export const fileNameOf = (path: string): string => path.split("/").at(-1) ?? path;

/**
 * The Resume Positions, kept in the Hub's database so they survive a restart
 * (NFR-4), one per Media File rather than per person or TV, and gone with
 * their Media Source.
 */
export const resumePositionStore = (database: DatabaseSync): ResumePositionStore => ({
  find: ({ mediaSourceId, path }) => {
    const row = database
      .prepare("SELECT position_ms FROM resume_position WHERE media_source_id = ? AND path = ?")
      .get(mediaSourceId, path) as { position_ms: number } | undefined;
    return row?.position_ms ?? null;
  },

  record: ({ mediaSourceId, path }, positionMs, durationMs) => {
    const position = Math.round(positionMs);
    if (position <= 0 || durationMs <= 0) return "unchanged";
    if (position >= durationMs * RESUME_FINISHED_FRACTION) {
      const { changes } = database
        .prepare("DELETE FROM resume_position WHERE media_source_id = ? AND path = ?")
        .run(mediaSourceId, path);
      return changes > 0 ? "cleared" : "unchanged";
    }
    // Only for a Media Source the Hub has, which a Player can report any URL of.
    const { changes } = database
      .prepare(
        `INSERT INTO resume_position (media_source_id, path, position_ms, recorded_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_source WHERE id = ?)
         ON CONFLICT (media_source_id, path) DO UPDATE
         SET position_ms = excluded.position_ms, recorded_at = excluded.recorded_at`,
      )
      .run(mediaSourceId, path, position, Date.now(), mediaSourceId);
    return changes > 0 ? "recorded" : "unchanged";
  },

  last: () => {
    const row = database
      .prepare(
        `SELECT media_source_id, path, position_ms FROM resume_position
         ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { media_source_id: number; path: string; position_ms: number } | undefined;
    if (row === undefined) return null;
    return {
      mediaSourceId: row.media_source_id,
      path: row.path,
      name: fileNameOf(row.path),
      positionMs: row.position_ms,
    };
  },
});

/** A position as the Remote shows it, to the second, e.g. "0:30" or "1:12:30", for the Hub's log. */
export const formatPosition = (positionMs: number): string => {
  const whole = Math.round(positionMs / 1_000);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const seconds = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${String(minutes)}:${seconds}`;
};

/** A Media File's URL, as the Hub sends it to the Player (see `mediaFilePath` in `shared`). */
const MEDIA_FILE_URL_PATH = new RegExp(`^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})/file((?:/[^/]*)+)$`);

/**
 * The Media File at a URL the Hub sent a Player, as the Player reports it,
 * or null for a URL that isn't one of the Hub's Media Files.
 */
export const mediaFileIn = (url: string | null): MediaFileAt | null => {
  if (url === null) return null;
  try {
    const match = MEDIA_FILE_URL_PATH.exec(new URL(url).pathname);
    if (match === null) return null;
    const names = (match[2] ?? "")
      .split("/")
      .filter((name) => name !== "")
      .map(decodeURIComponent);
    return { mediaSourceId: Number(match[1]), path: mediaFilePathOf(names) };
  } catch {
    return null;
  }
};
