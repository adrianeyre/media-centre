/**
 * Where a Remote remembers what is its own, such as its last tab and its
 * Selected TV: `localStorage` in a browser, so each browser is its own Remote.
 */
export type RemoteStorage = Pick<Storage, "getItem" | "setItem">;
