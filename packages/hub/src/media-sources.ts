import { constants } from "node:fs";
import { access, opendir, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { MEDIA_SOURCE_NAME_MAX_LENGTH, type MediaSource } from "@media-centre/shared";

import { characters, firstCharacters, nameKey } from "./names.ts";

/**
 * Why the Hub refused a request about a Media Source, or a folder in one. The
 * message is written for the person using the Remote, which shows it as is.
 */
export class MediaSourceRefusal extends Error {
  readonly reason: "invalid" | "taken" | "missing" | "outside" | "unreadable";

  constructor(reason: MediaSourceRefusal["reason"], message: string) {
    super(message);
    this.name = "MediaSourceRefusal";
    this.reason = reason;
  }
}

export interface MediaSourceStore {
  /** Every Media Source, in name order. */
  readonly list: () => MediaSource[];
  readonly find: (id: number) => MediaSource;
  /**
   * Adds the folder at `path`, once the Hub has checked it can read it now,
   * named `name`, or the folder's own name if that is empty.
   */
  readonly add: (name: string, path: string) => Promise<MediaSource>;
  readonly rename: (id: number, name: string) => MediaSource;
  /** Removes the Media Source, and what the Hub kept about its files, but never the files. */
  readonly remove: (id: number) => void;
}

/**
 * The Media Sources, kept in the Hub's database so they survive a restart
 * (NFR-4). Every rule about them is enforced here, whoever asks (FR-32).
 */
export const mediaSourceStore = (database: DatabaseSync): MediaSourceStore => {
  const list = (): MediaSource[] =>
    database.prepare("SELECT id, name, path FROM media_source ORDER BY name_key, id").all() as unknown as MediaSource[];

  const find = (id: number): MediaSource => {
    const source = database.prepare("SELECT id, name, path FROM media_source WHERE id = ?").get(id) as
      MediaSource | undefined;
    if (source === undefined) throw new MediaSourceRefusal("missing", "That Media Source no longer exists.");
    return source;
  };

  /** Checks a proposed name, and returns it as it will be kept, with its key. */
  const checkName = (proposed: string, renaming?: number): { name: string; key: string } => {
    const name = proposed.trim().normalize("NFC");
    const length = characters(name);
    if (length === 0) throw new MediaSourceRefusal("invalid", "Give the Media Source a name.");
    if (length > MEDIA_SOURCE_NAME_MAX_LENGTH) {
      throw new MediaSourceRefusal(
        "invalid",
        `A Media Source's name can be at most ${String(MEDIA_SOURCE_NAME_MAX_LENGTH)} characters; that one has ${String(length)}.`,
      );
    }
    const key = nameKey(name);
    const other = database.prepare("SELECT id, name FROM media_source WHERE name_key = ?").get(key) as
      { id: number; name: string } | undefined;
    if (other !== undefined && other.id !== renaming) {
      throw new MediaSourceRefusal("taken", `There is already a Media Source called "${other.name}".`);
    }
    return { name, key };
  };

  return {
    list,
    find,

    add: async (proposedName, proposedPath) => {
      const path = await checkFolder(proposedPath);
      // Checked only once the folder has been, with nothing awaited between
      // here and the insert, so two Remotes adding at once can't both pass.
      const same = database.prepare("SELECT name FROM media_source WHERE path = ?").get(path) as
        { name: string } | undefined;
      if (same !== undefined) {
        throw new MediaSourceRefusal("taken", `"${path}" is already the Media Source "${same.name}".`);
      }
      const given = proposedName.trim();
      const { name, key } = checkName(
        given === "" ? firstCharacters(basename(path) || path, MEDIA_SOURCE_NAME_MAX_LENGTH) : given,
      );
      const { id } = database
        .prepare("INSERT INTO media_source (name, name_key, path) VALUES (?, ?, ?) RETURNING id")
        .get(name, key, path) as { id: number };
      return { id, name, path };
    },

    rename: (id, proposed) => {
      const { path } = find(id);
      const { name, key } = checkName(proposed, id);
      database.prepare("UPDATE media_source SET name = ?, name_key = ? WHERE id = ?").run(name, key, id);
      return { id, name, path };
    },

    remove: (id) => {
      find(id);
      database.prepare("DELETE FROM media_source WHERE id = ?").run(id);
    },
  };
};

/**
 * Checks that `proposed` is a folder the Hub can read now, and returns its
 * full path as it will be kept.
 */
const checkFolder = async (proposed: string): Promise<string> => {
  const trimmed = proposed.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    throw new MediaSourceRefusal("invalid", "Give the folder's full path, as the Hub sees it, e.g. /media/films.");
  }
  const path = resolve(trimmed);
  const unreadable = new MediaSourceRefusal(
    "unreadable",
    `The Hub can't read "${path}". Let the user the Hub runs as read it.`,
  );

  const stats = await stat(path).catch((error: unknown) => {
    if (isCode(error, "EACCES", "EPERM")) throw unreadable;
    throw new MediaSourceRefusal("invalid", `There is no folder at "${path}".`);
  });
  if (!stats.isDirectory()) throw new MediaSourceRefusal("invalid", `"${path}" is a file, not a folder.`);

  // Reading the folder, rather than trusting its permissions alone, as a
  // network share's may not say what its server allows.
  try {
    await access(path, constants.R_OK | constants.X_OK);
    const folder = await opendir(path);
    try {
      await folder.read();
    } finally {
      await folder.close();
    }
  } catch {
    throw unreadable;
  }
  return path;
};

/** Whether `error` is a Node system error with one of these codes, e.g. `ENOENT`. */
export const isCode = (error: unknown, ...codes: readonly string[]): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  codes.includes(error.code);
