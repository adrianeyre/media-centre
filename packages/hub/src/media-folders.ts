import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

import type { MediaFile, MediaFolder, MediaKind, MediaSource } from "@media-centre/shared";

import type { PlayableFormats } from "./drivers/driver.ts";
import type { MediaFileOnDisk, MediaProbes } from "./media-probes.ts";
import { MediaSourceRefusal, isCode } from "./media-sources.ts";
import { chooseRoute } from "./routes.ts";

/**
 * Media Files by their file name's extension, lower case. A file is shown
 * by its name alone, so a big folder isn't probed just to list it.
 */
const MEDIA_KINDS: ReadonlyMap<string, MediaKind> = new Map([
  ...[
    ".3g2",
    ".3gp",
    ".asf",
    ".avi",
    ".divx",
    ".f4v",
    ".flv",
    ".m2ts",
    ".m2v",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".ogv",
    ".rm",
    ".rmvb",
    ".ts",
    ".webm",
    ".wmv",
  ].map((extension) => [extension, "video"] as const),
  ...[
    ".aac",
    ".ac3",
    ".aif",
    ".aiff",
    ".alac",
    ".amr",
    ".ape",
    ".au",
    ".caf",
    ".dsf",
    ".dts",
    ".eac3",
    ".flac",
    ".m4a",
    ".m4b",
    ".mka",
    ".mp2",
    ".mp3",
    ".mpc",
    ".oga",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".wv",
  ].map((extension) => [extension, "audio"] as const),
]);

/** Whether a file is a Media File, and which kind, or undefined for any other file. */
export const mediaKindOf = (name: string): MediaKind | undefined => MEDIA_KINDS.get(extname(name).toLowerCase());

/** Folders a NAS keeps for itself in every shared folder, e.g. Synology's thumbnails. */
const NAS_FOLDERS: ReadonlySet<string> = new Set(["@eaDir", "#recycle", "#snapshot", "@Recycle", ".@__thumb"]);

/** Whether a file or folder is one browsing never shows: hidden, or a NAS's own. */
export const isHidden = (name: string): boolean => name.startsWith(".") || NAS_FOLDERS.has(name);

const OUTSIDE = "That path is outside the Media Source.";

/**
 * The real path of the folder `names` lead to inside `source`, one name per
 * folder, with the real path of the Media Source's own folder. It refuses
 * anything that leads outside the Media Source (FR-5): a `..`, a name with a
 * separator in it, or a symlink, anywhere on the way, that points out. The
 * last name may be a file's, which `what` says, for the refusals to name it.
 */
export const resolveInMediaSource = async (
  source: MediaSource,
  names: readonly string[],
  what: "folder" | "file" = "folder",
): Promise<{ readonly root: string; readonly path: string }> => {
  for (const name of names) {
    if (
      name === "" ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes(sep) ||
      name.includes("\0")
    ) {
      throw new MediaSourceRefusal("outside", OUTSIDE);
    }
  }

  let root: string;
  try {
    root = await realpath(source.path);
  } catch {
    throw new MediaSourceRefusal(
      "missing",
      `The Hub can't find "${source.path}", the folder of the Media Source "${source.name}". If it's a network share, check it is mounted.`,
    );
  }

  let path: string;
  try {
    path = await realpath(join(root, ...names));
  } catch (error) {
    if (isCode(error, "EACCES", "EPERM"))
      throw new MediaSourceRefusal("unreadable", `The Hub can't read that ${what}.`);
    throw new MediaSourceRefusal(
      "missing",
      what === "file" ? "That Media File no longer exists." : "That folder no longer exists.",
    );
  }
  // The symlinks on the way are followed first, so where it really is is checked.
  if (!isInside(root, path)) throw new MediaSourceRefusal("outside", OUTSIDE);
  return { root, path };
};

const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * One folder of a Media Source, by the names of the folders that lead to it
 * from the Media Source's own (FR-33): its folders and Media Files, with each
 * file's size and duration, and its Route to a TV that plays `formats`, if
 * one is given (FR-34). Hidden files and folders, other files, and symlinks
 * that point outside the Media Source are left out.
 */
export const listMediaFolder = async (
  source: MediaSource,
  names: readonly string[],
  probes: MediaProbes,
  formats?: PlayableFormats,
): Promise<MediaFolder> => {
  const { folders, onDisk } = await readMediaFolder(source, names);
  const folderPath = names.join("/");
  const probed = await probes.of(source.id, folderPath, onDisk);
  const files: MediaFile[] = onDisk
    .toSorted((a, b) => byName(a.name, b.name))
    .map(({ name, kind, size }) => {
      const probe = probed.get(name) ?? null;
      return {
        name,
        kind,
        size,
        duration: probe?.duration ?? null,
        route: probe === null || formats === undefined ? null : chooseRoute(probe, formats),
      };
    });
  return { mediaSourceId: source.id, path: folderPath, folders: folders.toSorted(byName), files };
};

/**
 * The file names of the audio Media Files directly in one folder of a Media
 * Source, by the names of the folders that lead to it, in file-name order,
 * as {@link listMediaFolder} lists them, for it to be played as a Queue
 * (FR-46). It refuses as {@link listMediaFolder} does.
 */
export const audioFilesIn = async (source: MediaSource, names: readonly string[]): Promise<string[]> =>
  (await readMediaFolder(source, names)).onDisk
    .filter(({ kind }) => kind === "audio")
    .map(({ name }) => name)
    .toSorted(byName);

/** The folders and Media Files in one folder of a Media Source, unsorted, as {@link listMediaFolder} finds them. */
const readMediaFolder = async (
  source: MediaSource,
  names: readonly string[],
): Promise<{
  readonly folders: readonly string[];
  readonly onDisk: readonly (MediaFileOnDisk & { readonly kind: MediaKind })[];
}> => {
  const { root, path } = await resolveInMediaSource(source, names);

  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOTDIR")) throw new MediaSourceRefusal("missing", "That is a file, not a folder.");
    if (isCode(error, "EACCES", "EPERM")) throw new MediaSourceRefusal("unreadable", "The Hub can't read that folder.");
    throw new MediaSourceRefusal("missing", "That folder no longer exists.");
  }

  const folders: string[] = [];
  const onDisk: (MediaFileOnDisk & { readonly kind: MediaKind })[] = [];
  await Promise.all(
    entries
      .filter(({ name }) => !isHidden(name))
      .map(async (entry) => {
        const entryPath = join(path, entry.name);
        let isFolder = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          // Shown only if it points inside the Media Source, and as what it points at.
          const target = await realpath(entryPath).catch(() => undefined);
          if (target === undefined || !isInside(root, target)) return;
          const targetStats = await stat(target).catch(() => undefined);
          isFolder = targetStats?.isDirectory() ?? false;
          isFile = targetStats?.isFile() ?? false;
        }
        if (isFolder) {
          folders.push(entry.name);
          return;
        }
        const kind = mediaKindOf(entry.name);
        if (!isFile || kind === undefined) return;
        const stats = await stat(entryPath).catch(() => undefined);
        if (stats === undefined) return;
        onDisk.push({ name: entry.name, path: entryPath, size: stats.size, modified: stats.mtimeMs, kind });
      }),
  );

  return { folders, onDisk };
};

/** As a person would sort them: "Episode 2" before "Episode 10", case ignored. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
