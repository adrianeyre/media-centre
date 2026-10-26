import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MEDIA_FOLDER_TV_KEY,
  MEDIA_SOURCES_PATH,
  type MediaResumePosition,
  type MediaSource,
} from "@media-centre/shared";

import { serveCoverArt } from "./cover-art.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import type { PlayableFormats } from "./drivers/driver.ts";
import type { ProbeMedia } from "./ffprobe.ts";
import { findMediaFile, serveMediaFile } from "./media-files.ts";
import { listMediaFolder } from "./media-folders.ts";
import type { MediaProbes } from "./media-probes.ts";
import { MediaSourceRefusal, type MediaSourceStore } from "./media-sources.ts";
import { mediaFilePathOf, type ResumePositionStore } from "./resume-positions.ts";
import { serveSubtitle } from "./subtitles.ts";

const MEDIA_SOURCE_PATH = new RegExp(`^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})$`);

/** A folder of a Media Source (see `mediaFolderPath` in `shared`), by names still to be checked. */
const MEDIA_FOLDER_PATH = new RegExp(`^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})/folder((?:/[^/]*)*)$`);

/** A Media File's Resume Position (see `mediaResumePositionPath` in `shared`), by names still to be checked. */
const MEDIA_RESUME_POSITION_PATH = new RegExp(
  `^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})/resume-position((?:/[^/]*)+)$`,
);

/** A subtitle track of a Media File (see `mediaSubtitlePath` in `shared`), by names still to be checked. */
const MEDIA_SUBTITLE_PATH = new RegExp(`^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})/subtitle((?:/[^/]*)+)$`);

/** The cover art of a Media File (see `mediaCoverArtPath` in `shared`), by names still to be checked. */
const MEDIA_COVER_ART_PATH = new RegExp(`^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})/cover-art((?:/[^/]*)+)$`);

/** A Media File of a Media Source (see `mediaFilePath` in `shared`), by names still to be checked. */
const MEDIA_FILE_PATH = new RegExp(`^${MEDIA_SOURCES_PATH}/([1-9][0-9]{0,15})/file((?:/[^/]*)+)$`);

export const REFUSAL_STATUS: Readonly<Record<MediaSourceRefusal["reason"], number>> = {
  invalid: 400,
  taken: 409,
  missing: 404,
  outside: 403,
  unreadable: 403,
};

/** What the Media Sources' requests need of the rest of the Hub. */
export interface MediaSourcesDependencies {
  readonly sources: MediaSourceStore;
  readonly probes: MediaProbes;
  readonly resumePositions: ResumePositionStore;
  /** How the Hub reads what streams a Media File has, for its subtitle tracks and its cover art. */
  readonly probeMedia: ProbeMedia;
  /** What the Player plays on the TV with this id, or undefined if there is none, or it can't run the Player. */
  readonly playableFormatsOf: (tvId: number) => PlayableFormats | undefined;
}

/**
 * Answers the Remote's requests about Media Sources, their folders, with each
 * Media File's Route to the TV it names (FR-34), and their Media Files'
 * Resume Positions (see `MEDIA_SOURCES_PATH` in `shared`), and the Player's
 * requests for their Media Files, their subtitle tracks and their cover art,
 * or returns false for a path that isn't one of them. A change is logged, as
 * the person made it in Settings.
 *
 * It goes by the path as it was sent, not as `pathname` has it: the URL
 * parser quietly drops a `..`, even an encoded one, and with it part of the
 * path, so a request meant to leave a Media Source would land somewhere else
 * instead of being refused (FR-5).
 */
export const handleMediaSourcesRequest = async (
  { sources, probes, resumePositions, probeMedia, playableFormatsOf }: MediaSourcesDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  const sent = (request.url ?? "").split("?")[0] ?? "";
  const path = sent.startsWith("/") ? sent : pathname;
  try {
    if (path === MEDIA_SOURCES_PATH) {
      await mediaSourcesCollection(sources, request, response);
      return true;
    }
    const id = MEDIA_SOURCE_PATH.exec(path)?.[1];
    if (id !== undefined) {
      await oneMediaSource(sources, Number(id), request, response);
      return true;
    }
    const folder = MEDIA_FOLDER_PATH.exec(path);
    if (folder !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response, ["GET", "HEAD"]);
        return true;
      }
      const source = sources.find(Number(folder[1]));
      const tv = new URL(request.url ?? "", "http://hub").searchParams.get(MEDIA_FOLDER_TV_KEY);
      // A TV removed since the Remote chose it has no Routes, rather than no folder.
      const formats = tv !== null && /^[1-9][0-9]{0,15}$/.test(tv) ? playableFormatsOf(Number(tv)) : undefined;
      sendJson(response, 200, await listMediaFolder(source, namesIn(folder[2] ?? ""), probes, formats));
      return true;
    }
    const resume = MEDIA_RESUME_POSITION_PATH.exec(path);
    if (resume !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response, ["GET", "HEAD"]);
        return true;
      }
      const source = sources.find(Number(resume[1]));
      const file = { mediaSourceId: source.id, path: mediaFilePathOf(namesIn(resume[2] ?? "")) };
      const answer: MediaResumePosition = { positionMs: resumePositions.find(file) };
      sendJson(response, 200, answer);
      return true;
    }
    const subtitle = MEDIA_SUBTITLE_PATH.exec(path);
    if (subtitle !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response, ["GET", "HEAD"]);
        return true;
      }
      const source = sources.find(Number(subtitle[1]));
      const query = new URL(request.url ?? "", "http://hub").searchParams;
      await serveSubtitle({ source, names: namesIn(subtitle[2] ?? ""), query, probeMedia }, request, response);
      return true;
    }
    const coverArt = MEDIA_COVER_ART_PATH.exec(path);
    if (coverArt !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response, ["GET", "HEAD"]);
        return true;
      }
      const source = sources.find(Number(coverArt[1]));
      await serveCoverArt({ source, names: namesIn(coverArt[2] ?? ""), probeMedia }, request, response);
      return true;
    }
    const file = MEDIA_FILE_PATH.exec(path);
    if (file !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response, ["GET", "HEAD"]);
        return true;
      }
      const source = sources.find(Number(file[1]));
      await serveMediaFile(await findMediaFile(source, namesIn(file[2] ?? "")), request, response);
      return true;
    }
    if (path.startsWith(`${MEDIA_SOURCES_PATH}/`)) throw new HttpRefusal(404, "That Media Source no longer exists.");
    return false;
  } catch (error) {
    if (error instanceof MediaSourceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    throw error;
  }
};

const mediaSourcesCollection = async (
  sources: MediaSourceStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "GET":
    case "HEAD":
      sendJson(response, 200, sources.list());
      return;
    case "POST": {
      const { name, path } = addRequestIn(await readJson(request));
      const source: MediaSource = await sources.add(name, path);
      console.log(`Added the Media Source "${source.name}", ${source.path}`);
      sendJson(response, 201, source);
      return;
    }
    default:
      refuseMethod(response, ["GET", "HEAD", "POST"]);
  }
};

const oneMediaSource = async (
  sources: MediaSourceStore,
  id: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "PATCH":
      sendJson(response, 200, sources.rename(id, nameIn(await readJson(request))));
      return;
    case "DELETE": {
      const { name, path } = sources.find(id);
      sources.remove(id);
      console.log(`Removed the Media Source "${name}", ${path}`);
      response.writeHead(204).end();
      return;
    }
    default:
      refuseMethod(response, ["PATCH", "DELETE"]);
  }
};

/**
 * The names in the rest of a folder's or a Media File's path, each decoded on
 * its own, so an encoded "/" stays in its name.
 */
export const namesIn = (rest: string): string[] => {
  try {
    return rest
      .split("/")
      .filter((name) => name !== "")
      .map(decodeURIComponent);
  } catch {
    throw new HttpRefusal(400, "That path is not a valid URL.");
  }
};

const addRequestIn = (body: unknown): { name: string; path: string } => {
  if (typeof body !== "object" || body === null || !("path" in body) || typeof body.path !== "string") {
    throw new HttpRefusal(400, "Give the folder's full path, as the Hub sees it, e.g. /media/films.");
  }
  const name = "name" in body ? body.name : undefined;
  if (name !== undefined && typeof name !== "string") throw new HttpRefusal(400, "Give the Media Source a name.");
  return { name: name ?? "", path: body.path };
};

const nameIn = (body: unknown): string => {
  if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") return body.name;
  throw new HttpRefusal(400, "Give the Media Source a name.");
};
