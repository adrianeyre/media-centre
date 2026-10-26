import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteKey } from "@media-centre/shared";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvKeys } from "./tv-keys.tsx";

afterEach(cleanup);

/** Every key of FR-18, by the name the person (and a screen reader) knows it by, in each group of the pad. */
const KEYS: readonly (readonly [group: string, name: string, key: RemoteKey])[] = [
  ["Menus", "Back", "back"],
  ["Menus", "Home", "home"],
  ["Menus", "Source", "source"],
  ["Menus", "Menu", "menu"],
  ["Menus", "Tools", "tools"],
  ["Menus", "Info", "info"],
  ["D-pad", "Up", "up"],
  ["D-pad", "Left", "left"],
  ["D-pad", "OK", "ok"],
  ["D-pad", "Right", "right"],
  ["D-pad", "Down", "down"],
  ["Media", "Rewind", "rewind"],
  ["Media", "Play", "play"],
  ["Media", "Pause", "pause"],
  ["Media", "Stop", "stop"],
  ["Media", "Fast-forward", "fast-forward"],
  ["Colours", "Red", "red"],
  ["Colours", "Green", "green"],
  ["Colours", "Yellow", "yellow"],
  ["Colours", "Blue", "blue"],
  ...(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const).map(
    (digit) => ["Numbers and channels", digit, digit] as const,
  ),
  ["Numbers and channels", "Channel up", "channel-up"],
  ["Numbers and channels", "Channel down", "channel-down"],
];

const TV = aTv(2, "TV", null);

const renderKeys = (appliances: FakeAppliancesApi) => render(<TvKeys appliances={appliances} tv={TV} />);

const keys = () => screen.getByRole("region", { name: "Keys" });

const tap = (name: string): void => {
  fireEvent.click(within(keys()).getByRole("button", { name }));
};

describe("the key pad", () => {
  it("has every key of FR-18, each in its group, and nothing else", () => {
    renderKeys(fakeAppliancesApi([TV]));

    for (const group of new Set(KEYS.map(([name]) => name))) {
      const shown = within(within(keys()).getByRole("group", { name: group }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent);
      expect(shown).toEqual(KEYS.filter(([inGroup]) => inGroup === group).map(([, name]) => name));
    }
    expect(within(keys()).getAllByRole("button")).toHaveLength(KEYS.length);
  });

  it("presses each key tapped on the Selected TV, in the order tapped", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeys(appliances);

    for (const [, name] of KEYS) tap(name);

    await waitFor(() => {
      expect(appliances.keysPressed).toHaveLength(KEYS.length);
    });
    expect(appliances.keysPressed).toEqual(KEYS.map(([, , key]) => ({ id: TV.id, key })));
  });

  it("sends a key only once the one tapped before it has gone, so the TV gets them in order", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeys(appliances);
    const release = appliances.holdNextKey();

    tap("Down");
    tap("Down");
    tap("OK");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(appliances.keysPressed).toEqual([]);

    release();
    await waitFor(() => {
      expect(appliances.keysPressed.map(({ key }) => key)).toEqual(["down", "down", "ok"]);
    });
  });

  it("reports a key the Hub refused with its reason, e.g. one that would open the TV's service menu (FR-30)", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeys(appliances);
    const reason =
      "The Hub didn't send OK: after Mute, 1, 1 and 9 it opens the TV's service menu, which can misconfigure or break the TV. Press another key first.";
    appliances.refuseNextKey(reason);

    tap("OK");

    expect((await within(keys()).findByRole("alert")).textContent).toBe(reason);
    expect(appliances.keysPressed).toEqual([]);

    // Pressing another key goes ahead, and the report goes once one is pressed.
    tap("Back");
    await waitFor(() => {
      expect(within(keys()).queryByRole("alert")).toBeNull();
    });
    expect(appliances.keysPressed).toEqual([{ id: TV.id, key: "back" }]);
  });

  it("carries on with the keys tapped after one that failed", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeys(appliances);
    appliances.refuseNextKey(
      "No TV answered at 192.168.1.22. Check that it is switched on and on the same network as the Hub.",
    );

    tap("Up");
    tap("Left");

    await waitFor(() => {
      expect(appliances.keysPressed).toEqual([{ id: TV.id, key: "left" }]);
    });
  });
});
