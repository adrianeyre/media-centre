import { hubAddressIn } from "./hub-address.ts";

/** Where the Player keeps the Hub's address on the TV. */
const KEY = "media-centre.player.hub-address";

/** The Hub's address the Player remembers (FR-39), across being closed and opened again. */
export interface RememberedHub {
  readonly address: () => string | null;
  readonly remember: (address: string) => void;
}

/**
 * The Hub's address, kept in the TV's local storage for the Player. Storage
 * that refuses, as it may when full, leaves the Player to remember it only
 * until it closes.
 */
export const rememberedHub = (storage: Pick<Storage, "getItem" | "setItem"> | null): RememberedHub => {
  let kept: string | null = null;
  return {
    address: () => {
      if (kept !== null) return kept;
      try {
        return hubAddressIn(storage?.getItem(KEY));
      } catch {
        return null;
      }
    },
    remember: (address) => {
      kept = address;
      try {
        storage?.setItem(KEY, address);
      } catch {
        // Kept for now, as above.
      }
    },
  };
};
