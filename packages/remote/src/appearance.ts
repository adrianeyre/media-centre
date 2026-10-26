import type { RemoteStorage } from "./remote-storage.ts";

/** Light or dark whatever the device is set to, or "system", following it. */
export type ColourMode = "system" | "light" | "dark";

export const COLOUR_MODES: readonly { readonly id: ColourMode; readonly label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** The Remote's themes: each its own accent, which tints its backgrounds, in a light and a dark version. */
export type Theme = "evergreen" | "ocean" | "violet" | "sunset" | "rose" | "graphite";

export const THEMES: readonly { readonly id: Theme; readonly label: string }[] = [
  { id: "evergreen", label: "Evergreen" },
  { id: "ocean", label: "Ocean" },
  { id: "violet", label: "Violet" },
  { id: "sunset", label: "Sunset" },
  { id: "rose", label: "Rose" },
  { id: "graphite", label: "Graphite" },
];

export interface Appearance {
  readonly mode: ColourMode;
  readonly theme: Theme;
}

/** As the Remote first looks: the device's light or dark, in green. */
export const DEFAULT_APPEARANCE: Appearance = { mode: "system", theme: "evergreen" };

/**
 * Where a Remote remembers how it looks: in the browser, as each Remote is its
 * own. `index.html` reads it too, before the page is first drawn, so that it
 * never flashes in the default look first.
 */
export const APPEARANCE_KEY = "media-centre:appearance";

/** How this Remote last looked, or the default for whatever it can't read. */
export const loadAppearance = (storage: RemoteStorage): Appearance => {
  try {
    const saved = JSON.parse(storage.getItem(APPEARANCE_KEY) ?? "null") as Partial<Record<string, unknown>> | null;
    return {
      mode: COLOUR_MODES.find(({ id }) => id === saved?.mode)?.id ?? DEFAULT_APPEARANCE.mode,
      theme: THEMES.find(({ id }) => id === saved?.theme)?.id ?? DEFAULT_APPEARANCE.theme,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
};

export const saveAppearance = (storage: RemoteStorage, appearance: Appearance): void => {
  try {
    storage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
  } catch {
    // A browser that refuses storage, e.g. in private browsing, just forgets.
  }
};

/**
 * Has the page take on `appearance`: `style.css` draws each theme, light or
 * dark, from these attributes. "System" sets no mode, so the device's own
 * setting decides, and goes on deciding as it changes.
 */
export const applyAppearance = (root: HTMLElement, { mode, theme }: Appearance): void => {
  if (mode === "system") delete root.dataset.mode;
  else root.dataset.mode = mode;
  root.dataset.theme = theme;
};
