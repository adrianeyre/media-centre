import { describe, expect, it } from "vitest";

import { rememberedHub } from "./remembered-hub.ts";

const memoryStorage = (): Pick<Storage, "getItem" | "setItem"> => {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
};

describe("the Hub's address the Player remembers", () => {
  it("is none at first", () => {
    expect(rememberedHub(memoryStorage()).address()).toBeNull();
  });

  it("is kept in storage, for when the Player is opened again", () => {
    const storage = memoryStorage();
    rememberedHub(storage).remember("192.168.1.10:8080");

    expect(rememberedHub(storage).address()).toBe("192.168.1.10:8080");
  });

  it("is none when storage holds something that isn't an address", () => {
    const storage = memoryStorage();
    storage.setItem("media-centre.player.hub-address", "elsewhere/api");

    expect(rememberedHub(storage).address()).toBeNull();
  });

  it("is kept until the Player closes when storage refuses it, or there is none", () => {
    const refusing = rememberedHub({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(refusing.address()).toBeNull();
    refusing.remember("192.168.1.10:8080");
    expect(refusing.address()).toBe("192.168.1.10:8080");

    const none = rememberedHub(null);
    none.remember("192.168.1.10:8080");
    expect(none.address()).toBe("192.168.1.10:8080");
  });
});
