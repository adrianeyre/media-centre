import type { RemoteStorage } from "../remote-storage.ts";

/** A Remote's storage kept in memory, standing in for `localStorage`, with what it holds to look at. */
export const memoryStorage = (
  initial: Record<string, string> = {},
): RemoteStorage & { readonly items: Record<string, string> } => {
  const items = { ...initial };
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
    },
  };
};

/** Storage the browser refuses, as in some private browsing. */
export const refusingStorage: RemoteStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};
