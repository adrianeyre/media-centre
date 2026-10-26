import {
  MEDIA_SOURCES_PATH,
  mediaFolderPath,
  mediaResumePositionPath,
  mediaSourcePath,
  type MediaFolder,
  type MediaResumePosition,
  type MediaSource,
} from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/** The Hub's Media Sources, as the Remote asks for, changes and browses them (FR-32, FR-33, FR-40). */
export interface MediaSourcesApi {
  /** Every Media Source, in name order. */
  readonly list: () => Promise<MediaSource[]>;
  /** Adds the folder at `path`, named `name`, or after the folder if that is empty. */
  readonly add: (name: string, path: string) => Promise<MediaSource>;
  readonly rename: (id: number, name: string) => Promise<MediaSource>;
  readonly remove: (id: number) => Promise<void>;
  /**
   * One folder of a Media Source, by its path inside it, `""` for the Media
   * Source's own, with each Media File's Route to the TV with id `tvId`, if
   * one is given (FR-34).
   */
  readonly browse: (id: number, folder: string, tvId?: number) => Promise<MediaFolder>;
  /** A Media File's Resume Position, in milliseconds, by its path inside the Media Source, or null for none. */
  readonly readResumePosition: (id: number, file: string) => Promise<number | null>;
}

/** Talks to the Hub about Media Sources. A refusal fails with a `HubRequestFailed` giving the Hub's reason. */
export const createMediaSourcesApi = (fetchFn: typeof fetch = fetch): MediaSourcesApi => {
  const request = createHubRequest(fetchFn);

  return {
    list: async () => (await (await request("GET", MEDIA_SOURCES_PATH)).json()) as MediaSource[],
    add: async (name, path) =>
      (await (await request("POST", MEDIA_SOURCES_PATH, { name, path })).json()) as MediaSource,
    rename: async (id, name) => (await (await request("PATCH", mediaSourcePath(id), { name })).json()) as MediaSource,
    remove: async (id) => {
      await request("DELETE", mediaSourcePath(id));
    },
    browse: async (id, folder, tvId) =>
      (await (await request("GET", mediaFolderPath(id, folder, tvId))).json()) as MediaFolder,
    readResumePosition: async (id, file) =>
      ((await (await request("GET", mediaResumePositionPath(id, file))).json()) as MediaResumePosition).positionMs,
  };
};
