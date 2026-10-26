import { describe, expect, it } from "vitest";

import { APPEARANCE_KEY, DEFAULT_APPEARANCE, applyAppearance, loadAppearance, saveAppearance } from "./appearance.ts";
import { memoryStorage, refusingStorage } from "./testing/memory-storage.ts";

describe("remembering how the Remote looks", () => {
  it("follows the device, in Evergreen, until chosen otherwise", () => {
    expect(loadAppearance(memoryStorage())).toEqual({ mode: "system", theme: "evergreen" });
  });

  it("remembers the mode and theme chosen", () => {
    const storage = memoryStorage();
    saveAppearance(storage, { mode: "dark", theme: "sunset" });

    expect(loadAppearance(storage)).toEqual({ mode: "dark", theme: "sunset" });
  });

  it("takes the default for whatever it can't read, or a browser refuses to keep", () => {
    expect(
      loadAppearance(memoryStorage({ [APPEARANCE_KEY]: JSON.stringify({ mode: "dim", theme: "ocean" }) })),
    ).toEqual({ mode: "system", theme: "ocean" });
    expect(loadAppearance(memoryStorage({ [APPEARANCE_KEY]: "{" }))).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(refusingStorage)).toEqual(DEFAULT_APPEARANCE);
    expect(() => {
      saveAppearance(refusingStorage, DEFAULT_APPEARANCE);
    }).not.toThrow();
  });
});

describe("applying how the Remote looks", () => {
  it("sets the theme, and a mode only when not following the device", () => {
    const root = document.createElement("html");

    applyAppearance(root, { mode: "light", theme: "rose" });
    expect(Object.fromEntries(Object.entries(root.dataset))).toEqual({ mode: "light", theme: "rose" });

    applyAppearance(root, { mode: "system", theme: "graphite" });
    expect(Object.fromEntries(Object.entries(root.dataset))).toEqual({ theme: "graphite" });
  });
});
