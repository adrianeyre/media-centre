import { describe, expect, it } from "vitest";

import { LAST_TAB_KEY, TABS, loadLastTab, saveLastTab } from "./tabs.ts";
import { memoryStorage, refusingStorage } from "./testing/memory-storage.ts";

describe("the Remote's tabs", () => {
  it("are the TV tab, the Aircon tab, the Lights tab, the Heating tab, Network, Amazon, Ring and then Rooms, always last", () => {
    expect(TABS.map((tab) => tab.label)).toEqual([
      "TV",
      "Aircon",
      "Lights",
      "Heating",
      "Network",
      "Amazon",
      "Ring",
      "Rooms",
    ]);
  });

  it("open on the TV tab the first time", () => {
    expect(loadLastTab(memoryStorage())).toBe("tv");
  });

  it("reopen on the tab saved last", () => {
    const storage = memoryStorage();

    saveLastTab(storage, "settings");

    expect(storage.items[LAST_TAB_KEY]).toBe("settings");
    expect(loadLastTab(storage)).toBe("settings");
  });

  it("open on the TV tab when the saved tab is not one the Remote has", () => {
    expect(loadLastTab(memoryStorage({ [LAST_TAB_KEY]: "scenes" }))).toBe("tv");
  });

  it("cope with a browser that refuses storage", () => {
    expect(() => {
      saveLastTab(refusingStorage, "settings");
    }).not.toThrow();
    expect(loadLastTab(refusingStorage)).toBe("tv");
  });
});
