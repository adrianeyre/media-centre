import type { DatabaseSync } from "node:sqlite";

import { NO_TAGS, type MediaProbe, type ProbeMedia } from "./ffprobe.ts";

/** How many ffprobes the Hub runs at once, however many Remotes are browsing, so a big folder doesn't swamp a NAS. */
const PROBES_AT_ONCE = 4;

/** A Media File in a folder being listed, as it is now. */
export interface MediaFileOnDisk {
  readonly name: string;
  /** Its full path, which ffprobe is given. */
  readonly path: string;
  readonly size: number;
  /** Its modified time, in milliseconds. */
  readonly modified: number;
}

export interface MediaProbes {
  /**
   * What ffprobe says of each of the Media Files in one folder of a Media
   * Source, by name, or null for one it can't read: as kept, for a file whose
   * size and modified time are those it had when probed, and from ffprobe now
   * for any other. What was kept for a file no longer in the folder is
   * forgotten.
   */
  readonly of: (
    mediaSourceId: number,
    folder: string,
    files: readonly MediaFileOnDisk[],
  ) => Promise<Map<string, MediaProbe | null>>;
}

/**
 * What ffprobe says of each Media File, its duration (FR-33) and what its
 * Route is chosen by (FR-34), kept in the Hub's database so that browsing a
 * folder again, even after a restart, probes only what has changed.
 */
export const mediaProbes = (database: DatabaseSync, probe: ProbeMedia): MediaProbes => {
  let running = 0;
  const waiting: (() => void)[] = [];
  const oneAtATime = async <T>(task: () => Promise<T>): Promise<T> => {
    while (running >= PROBES_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  // Two Remotes opening the same folder at once share each probe.
  const probing = new Map<string, Promise<MediaProbe | null>>();
  const probeOnce = ({ path, size, modified }: MediaFileOnDisk): Promise<MediaProbe | null> => {
    const key = `${path}\0${String(size)}\0${String(modified)}`;
    let answer = probing.get(key);
    if (answer === undefined) {
      answer = oneAtATime(() => probe(path)).finally(() => probing.delete(key));
      probing.set(key, answer);
    }
    return answer;
  };

  const keep = database.prepare(
    // Not for a Media Source removed while its files were being probed.
    `INSERT OR REPLACE INTO media_file_probe (media_source_id, folder, name, size, modified, duration, probe)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_source WHERE id = ?)`,
  );
  const forget = database.prepare("DELETE FROM media_file_probe WHERE media_source_id = ? AND folder = ? AND name = ?");

  return {
    of: async (mediaSourceId, folder, files) => {
      const kept = new Map(
        (
          database
            .prepare(
              "SELECT name, size, modified, probe FROM media_file_probe WHERE media_source_id = ? AND folder = ?",
            )
            .all(mediaSourceId, folder) as unknown as {
            name: string;
            size: number;
            modified: number;
            probe: string | null;
          }[]
        ).map((row) => [row.name, row]),
      );
      const probes = new Map<string, MediaProbe | null>();
      const failures: unknown[] = [];

      await Promise.all(
        files.map(async (file) => {
          const before = kept.get(file.name);
          if (before !== undefined && before.size === file.size && before.modified === file.modified) {
            probes.set(file.name, before.probe === null ? null : keptProbe(before.probe));
            return;
          }
          try {
            const probed = await probeOnce(file);
            keep.run(
              mediaSourceId,
              folder,
              file.name,
              file.size,
              file.modified,
              probed?.duration ?? null,
              probed === null ? null : JSON.stringify(probed),
              mediaSourceId,
            );
            probes.set(file.name, probed);
          } catch (error) {
            // Not kept, so it is tried again next time.
            failures.push(error);
            probes.set(file.name, null);
          }
        }),
      );

      const names = new Set(files.map((file) => file.name));
      for (const name of kept.keys()) if (!names.has(name)) forget.run(mediaSourceId, folder, name);

      if (failures.length > 0) {
        const [first] = failures;
        console.error(
          `Couldn't run ffprobe for ${String(failures.length)} Media Files in "${folder || "/"}" of Media Source ${String(mediaSourceId)}:`,
          first instanceof Error ? first.message : first,
        );
      }
      return probes;
    },
  };
};

/** A {@link MediaProbe} as kept, as JSON; one kept from before the Hub read tags has none. */
const keptProbe = (json: string): MediaProbe => {
  const probe = JSON.parse(json) as Omit<MediaProbe, "tags"> & Partial<Pick<MediaProbe, "tags">>;
  return { ...probe, tags: probe.tags ?? NO_TAGS };
};
