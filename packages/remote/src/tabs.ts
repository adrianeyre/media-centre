import type { RemoteStorage } from "./remote-storage.ts";

/**
 * The Remote's tabs, along the bottom, in the order FR-6 gives them: one per
 * kind of Appliance whose phase has shipped, then Network, every device on
 * the home network, then Amazon, the owner's Echo devices, Ring, their Ring
 * doorbells, cameras and chimes, and Rooms, every
 * Appliance in one Room, always last. The Heating tab is always there,
 * saying how to sign in to Hive until the Hub is (FR-67). Settings is no tab:
 * the cog in the app bar opens it.
 */
export const TABS = [
  { id: "tv", label: "TV" },
  { id: "aircon", label: "Aircon" },
  { id: "lights", label: "Lights" },
  { id: "heating", label: "Heating" },
  { id: "network", label: "Network" },
  { id: "amazon", label: "Amazon" },
  { id: "ring", label: "Ring" },
  { id: "rooms", label: "Rooms" },
] as const;

export type RemoteTab = (typeof TABS)[number]["id"];

/** What the Remote shows: one of its tabs, or Settings, which the cog opens. */
export type RemoteScreen = RemoteTab | "settings";

/** What a new Remote opens on. */
export const FIRST_TAB: RemoteTab = "tv";

/** Where the Remote remembers its last tab, or Settings: in the browser, since each Remote has its own. */
export const LAST_TAB_KEY = "media-centre:last-tab";

/**
 * The tab, or Settings, the Remote was last left on (FR-6). Anything
 * unreadable, such as a tab this Remote no longer has or storage the browser
 * refuses, opens the first tab.
 */
export const loadLastTab = (storage: RemoteStorage): RemoteScreen => {
  try {
    const saved = storage.getItem(LAST_TAB_KEY);
    if (saved === "settings") return "settings";
    return TABS.find((tab) => tab.id === saved)?.id ?? FIRST_TAB;
  } catch {
    return FIRST_TAB;
  }
};

export const saveLastTab = (storage: RemoteStorage, screen: RemoteScreen): void => {
  try {
    storage.setItem(LAST_TAB_KEY, screen);
  } catch {
    // A browser that refuses storage, e.g. in private browsing, just forgets.
  }
};
