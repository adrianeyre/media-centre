import type { IconName } from "./icons.tsx";
import type { RemoteStorage } from "./remote-storage.ts";

/**
 * The parts of Settings, each opened on its own from the menu down its left
 * side, so that a screen shows one thing to read at a time: General, which
 * the cog in the app bar opens, then one per thing the home has, in the
 * order of the tabs. Heating is where the Hub signs in to Hive.
 */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: "cog" },
  { id: "rooms", label: "Rooms", icon: "home" },
  { id: "tv", label: "TV", icon: "tv" },
  { id: "aircon", label: "Aircon", icon: "air-vent" },
  { id: "lights", label: "Lights", icon: "lightbulb" },
  { id: "heating", label: "Heating", icon: "flame" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** What Settings opens on, the first time, and from the cog. */
export const FIRST_SETTINGS_SECTION: SettingsSection = "general";

/** Where the Remote remembers the part of Settings it was last on: in the browser, as its last tab. */
export const LAST_SETTINGS_SECTION_KEY = "media-centre:last-settings-section";

/** The part of Settings the Remote was last on. Anything unreadable opens General. */
export const loadLastSettingsSection = (storage: RemoteStorage): SettingsSection => {
  try {
    const saved = storage.getItem(LAST_SETTINGS_SECTION_KEY);
    return SETTINGS_SECTIONS.find((section) => section.id === saved)?.id ?? FIRST_SETTINGS_SECTION;
  } catch {
    return FIRST_SETTINGS_SECTION;
  }
};

export const saveLastSettingsSection = (storage: RemoteStorage, section: SettingsSection): void => {
  try {
    storage.setItem(LAST_SETTINGS_SECTION_KEY, section);
  } catch {
    // A browser that refuses storage, e.g. in private browsing, just forgets.
  }
};
