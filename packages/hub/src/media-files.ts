import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";

import type { MediaKind, MediaSource } from "@media-centre/shared";

import { isHidden, mediaKindOf, resolveInMediaSource } from "./media-folders.ts";
import { MediaSourceRefusal, isCode } from "./media-sources.ts";

/** What each Media File is served as, by its extension, lower case; any other is served by its kind alone. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".3g2", "video/3gpp2"],
  [".3gp", "video/3gpp"],
  [".avi", "video/x-msvideo"],
  [".flv", "video/x-flv"],
  [".m2ts", "video/mp2t"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".mpg", "video/mpeg"],
  [".mts", "video/mp2t"],
  [".ogv", "video/ogg"],
  [".ts", "video/mp2t"],
  [".webm", "video/webm"],
  [".wmv", "video/x-ms-wmv"],
  [".aac", "audio/aac"],
  [".ac3", "audio/ac3"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".m4b", "audio/mp4"],
  [".mka", "audio/x-matroska"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".wma", "audio/x-ms-wma"],
]);

const contentTypeOf = (name: string): string =>
  CONTENT_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream";

const NOT_A_MEDIA_FILE = "That is not a Media File.";

/** A Media File, found inside its Media Source. */
export interface MediaFileFound {
  /** Its real path, symlinks followed. */
  readonly path: string;
  readonly name: string;
  readonly kind: MediaKind;
}

/**
 * The Media File `names` lead to inside `source`, the folders on the way then
 * its file name, as {@link resolveInMediaSource} finds a folder: refusing
 * anything that leads outside the Media Source (FR-5). It refuses too a
 * hidden file or anything that isn't a Media File, as browsing never shows
 * them, so that nothing else in a Media Source is ever served.
 */
export const findMediaFile = async (source: MediaSource, names: readonly string[]): Promise<MediaFileFound> => {
  const name = names.at(-1);
  if (name === undefined) throw new MediaSourceRefusal("missing", NOT_A_MEDIA_FILE);
  const { path } = await resolveInMediaSource(source, names, "file");
  if (names.some(isHidden)) throw new MediaSourceRefusal("missing", NOT_A_MEDIA_FILE);
  // By the name it is listed by, not the one a symlink points at.
  const kind = mediaKindOf(name);
  if (kind === undefined) throw new MediaSourceRefusal("missing", NOT_A_MEDIA_FILE);
  return { path, name, kind };
};

/** The part of a file of `size` bytes a `Range` header asks for, from `start` to `end` inclusive. */
type Range = { readonly start: number; readonly end: number } | "unsatisfiable";

/**
 * The one range of bytes a `Range` header asks for, as RFC 9110 has it, or
 * undefined to serve the whole file: no header, one that isn't a byte range
 * the Hub reads, or several ranges at once, which a server may answer with the
 * whole file and no player is known to ask for.
 */
const rangeIn = (header: string | undefined, size: number): Range | undefined => {
  const match = /^bytes=\s*(\d*)-(\d*)\s*$/.exec(header ?? "");
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "") {
    // The last bytes: "bytes=-500".
    if (last === "") return undefined;
    const length = Number(last);
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
};

/**
 * Serves the Media File unchanged, the Direct Play Route (ADR 0002, FR-41):
 * the whole of it, or the one range of bytes asked for with `206` and its
 * `Content-Range`, as a player seeking asks. A range that starts past the end
 * is answered `416`. `If-Range` with anything but the file's own validators
 * gets the whole file, as it may have changed since the player last asked.
 */
export const serveMediaFile = async (
  file: MediaFileFound,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let handle: FileHandle;
  try {
    handle = await open(file.path, "r");
  } catch (error) {
    if (isCode(error, "EACCES", "EPERM")) throw new MediaSourceRefusal("unreadable", "The Hub can't read that file.");
    if (isCode(error, "EISDIR")) throw new MediaSourceRefusal("missing", NOT_A_MEDIA_FILE);
    throw new MediaSourceRefusal("missing", "That Media File no longer exists.");
  }
  try {
    // Checked on the file opened, so it can't be swapped for another in between.
    const stats = await handle.stat();
    if (!stats.isFile()) throw new MediaSourceRefusal("missing", NOT_A_MEDIA_FILE);
    const { size } = stats;
    const lastModified = stats.mtime.toUTCString();
    const etag = `"${size.toString(36)}-${Math.trunc(stats.mtimeMs).toString(36)}"`;
    const headers = {
      "accept-ranges": "bytes",
      "content-type": contentTypeOf(file.name),
      "last-modified": lastModified,
      etag,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    };

    const ifRange = request.headers["if-range"];
    const range =
      ifRange === undefined || ifRange === etag || ifRange === lastModified
        ? rangeIn(request.headers.range, size)
        : undefined;
    if (range === "unsatisfiable") {
      response.writeHead(416, { ...headers, "content-range": `bytes */${String(size)}` }).end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = end - start + 1;
    response.writeHead(range === undefined ? 200 : 206, {
      ...headers,
      "content-length": String(Math.max(0, length)),
      ...(range === undefined ? {} : { "content-range": `bytes ${String(start)}-${String(end)}/${String(size)}` }),
    });
    if (request.method === "HEAD" || length <= 0) {
      response.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: false });
    // A player that has what it wanted, or seeks elsewhere, hangs up mid-file:
    // that is no failure of the Hub's.
    await pipeline(stream, response).catch(() => undefined);
  } finally {
    await handle.close();
  }
};
