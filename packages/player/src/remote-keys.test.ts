import { describe, expect, it } from "vitest";

import { MEDIA_KEYS, registerMediaKeys } from "./remote-keys.ts";

describe("the TV's own remote's media keys (FR-37)", () => {
  it("registers every media key, so that the TV sends them to the Player", () => {
    const registered: string[] = [];

    registerMediaKeys({ registerKey: (name) => registered.push(name) });

    expect(registered).toEqual([
      "MediaPlayPause",
      "MediaPlay",
      "MediaPause",
      "MediaStop",
      "MediaRewind",
      "MediaFastForward",
    ]);
    expect(MEDIA_KEYS.map(({ name }) => name)).toEqual(registered);
  });

  it("registers the rest when the TV refuses a key its model hasn't got", () => {
    const registered: string[] = [];

    registerMediaKeys({
      registerKey: (name) => {
        if (name === "MediaPlayPause") throw new Error("InvalidValuesError");
        registered.push(name);
      },
    });

    expect(registered).toHaveLength(MEDIA_KEYS.length - 1);
  });

  it("registers nothing, and doesn't fail, without Tizen, as in a desktop browser", () => {
    expect(() => {
      registerMediaKeys(undefined);
    }).not.toThrow();
  });
});
