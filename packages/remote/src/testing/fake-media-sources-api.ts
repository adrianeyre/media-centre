import type { MediaFile, MediaFolder, MediaSource } from "@media-centre/shared";

import { HubRequestFailed } from "../hub-request.ts";
import type { MediaSourcesApi } from "../media-sources-api.ts";

/** What a folder holds, by its path inside the Media Source, `""` for its own. */
export type FakeFolders = Readonly<
  Record<string, { readonly folders?: readonly string[]; readonly files?: readonly MediaFile[] }>
>;

export interface FakeMediaSource {
  readonly name: string;
  readonly path: string;
  readonly folders?: FakeFolders;
  /** The Resume Position of each Media File that has one, in milliseconds, by its path inside the Media Source. */
  readonly resumePositions?: Readonly<Record<string, number>>;
}

export interface FakeMediaSourcesApi extends MediaSourcesApi {
  /** The Media Sources the fake Hub has now. */
  readonly current: () => readonly MediaSource[];
  /** Makes the next change or browse fail with `message`, as the Hub refusing it would. */
  readonly refuseNext: (message: string) => void;
  /** Every folder browsed, as "<Media Source id>:<path>", in order. */
  readonly browsed: () => readonly string[];
  /** The TV each folder was browsed for, in the same order, or undefined for none. */
  readonly browsedFor: () => readonly (number | undefined)[];
  /** Gives the Media File this Resume Position, or none with null, as playing it on a TV would. */
  readonly setResumePosition: (id: number, file: string, positionMs: number | null) => void;
}

/**
 * A Media File as the Hub lists it, with `size` and `duration` made up unless
 * given, and its Route to any TV, Direct Play unless given, which the fake
 * Hub says only when a folder is browsed for a TV.
 */
export const aMediaFile = (name: string, file: Partial<MediaFile> = {}): MediaFile => ({
  name,
  kind: /\.(flac|mp3|m4a|ogg|opus|wav)$/i.test(name) ? "audio" : "video",
  size: 1_400_000_000,
  duration: 4_350,
  route: "direct-play",
  ...file,
});

/**
 * Media Sources kept in memory, standing in for the Hub, numbered from 1 in
 * the order given. It makes whatever change it is asked to: the rules are the
 * Hub's, and are tested there.
 */
export const fakeMediaSourcesApi = (given: readonly FakeMediaSource[] = []): FakeMediaSourcesApi => {
  let sources: MediaSource[] = given.map(({ name, path }, index) => ({ id: index + 1, name, path }));
  const trees = new Map<number, FakeFolders>(given.map(({ folders = {} }, index) => [index + 1, folders]));
  const resumePositions = new Map<string, number>(
    given.flatMap(({ resumePositions: positions = {} }, index) =>
      Object.entries(positions).map(([file, positionMs]) => [`${String(index + 1)}:${file}`, positionMs] as const),
    ),
  );
  let nextId = sources.length + 1;
  let refusal: string | undefined;
  const browsed: string[] = [];
  const browsedFor: (number | undefined)[] = [];

  const answering = async <T>(work: () => T): Promise<T> => {
    await Promise.resolve();
    if (refusal !== undefined) {
      const message = refusal;
      refusal = undefined;
      throw new HubRequestFailed(message);
    }
    return work();
  };

  return {
    current: () => sources,
    refuseNext: (message) => {
      refusal = message;
    },
    browsed: () => browsed,
    browsedFor: () => browsedFor,
    setResumePosition: (id, file, positionMs) => {
      if (positionMs === null) resumePositions.delete(`${String(id)}:${file}`);
      else resumePositions.set(`${String(id)}:${file}`, positionMs);
    },
    list: () => Promise.resolve([...sources]),
    add: (name, path) =>
      answering(() => {
        const source = { id: nextId++, name: name.trim() === "" ? (path.split("/").at(-1) ?? path) : name, path };
        sources = [...sources, source];
        return source;
      }),
    rename: (id, name) =>
      answering(() => {
        sources = sources.map((source) => (source.id === id ? { ...source, name } : source));
        const renamed = sources.find((source) => source.id === id);
        if (renamed === undefined) throw new HubRequestFailed("That Media Source no longer exists.");
        return renamed;
      }),
    remove: (id) =>
      answering(() => {
        sources = sources.filter((source) => source.id !== id);
      }),
    browse: (id, path, tvId) =>
      answering((): MediaFolder => {
        browsed.push(`${String(id)}:${path}`);
        browsedFor.push(tvId);
        const folder = sources.some((source) => source.id === id) ? trees.get(id)?.[path] : undefined;
        if (folder === undefined) throw new HubRequestFailed("That folder no longer exists.");
        const files = (folder.files ?? []).map((file) => (tvId === undefined ? { ...file, route: null } : file));
        return { mediaSourceId: id, path, folders: folder.folders ?? [], files };
      }),
    readResumePosition: (id, file) => answering(() => resumePositions.get(`${String(id)}:${file}`) ?? null),
  };
};
