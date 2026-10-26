import { describe, expect, it } from "vitest";

import { SELECTED_TV_KEY, loadSelectedTv, saveSelectedTv, selectedTvAmong } from "./selected-tv.ts";
import { aTv } from "./testing/fake-appliances-api.ts";
import { memoryStorage, refusingStorage } from "./testing/memory-storage.ts";

describe("the Selected TV", () => {
  it("is remembered by the Remote", () => {
    const storage = memoryStorage();

    saveSelectedTv(storage, 7);

    expect(storage.items[SELECTED_TV_KEY]).toBe("7");
    expect(loadSelectedTv(storage)).toBe(7);
  });

  it.each([
    ["nothing", {}],
    ["something unreadable", { [SELECTED_TV_KEY]: "lounge" }],
    ["no TV", { [SELECTED_TV_KEY]: "0" }],
  ])("is not remembered from %s", (_, items) => {
    expect(loadSelectedTv(memoryStorage(items))).toBeUndefined();
  });

  it("is just forgotten by a browser that refuses storage", () => {
    expect(() => {
      saveSelectedTv(refusingStorage, 1);
    }).not.toThrow();
    expect(loadSelectedTv(refusingStorage)).toBeUndefined();
  });

  it("is the TV remembered, while there is one", () => {
    const tvs = [aTv(3, "TV", 1), aTv(1, "TV", 2)];

    expect(selectedTvAmong(tvs, 1)?.id).toBe(1);
  });

  it("is the first TV when none is remembered, or the one remembered has been removed", () => {
    const tvs = [aTv(3, "TV", 1), aTv(1, "TV", 2)];

    expect(selectedTvAmong(tvs, undefined)?.id).toBe(3);
    expect(selectedTvAmong(tvs, 2)?.id).toBe(3);
  });

  it("is none when there are no TVs", () => {
    expect(selectedTvAmong([], 1)).toBeUndefined();
  });
});
