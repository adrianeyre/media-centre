import type { Appliance } from "@media-centre/shared";

import type { RemoteStorage } from "./remote-storage.ts";

/** Where a Remote remembers its Selected TV: in the browser, since each Remote has its own (FR-15). */
export const SELECTED_TV_KEY = "media-centre:selected-tv";

/** The id of the TV this Remote last had selected, if it remembers one it can read. */
export const loadSelectedTv = (storage: RemoteStorage): number | undefined => {
  try {
    const id = Number(storage.getItem(SELECTED_TV_KEY) ?? undefined);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
};

export const saveSelectedTv = (storage: RemoteStorage, id: number): void => {
  try {
    storage.setItem(SELECTED_TV_KEY, String(id));
  } catch {
    // A browser that refuses storage, e.g. in private browsing, just forgets.
  }
};

/**
 * The Selected TV among `tvs`, listed as the TV tab lists them: the one
 * remembered, or the first when none is, or when it has been removed (FR-15).
 * Undefined only when there are no TVs.
 */
export const selectedTvAmong = (tvs: readonly Appliance[], remembered: number | undefined): Appliance | undefined =>
  tvs.find(({ id }) => id === remembered) ?? tvs[0];
