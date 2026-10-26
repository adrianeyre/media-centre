import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MenuShortcut, RemoteKey } from "@media-centre/shared";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvMenuMode } from "./tv-menu-mode.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);
const TITLE = "Living room · TV";

/** The keys of FR-23, by the name the person (and a screen reader) knows each by, in each group. */
const KEYS: readonly (readonly [group: string, name: string, key: RemoteKey])[] = [
  ["Menus", "Back", "back"],
  ["Menus", "Home", "home"],
  ["Menus", "Menu", "menu"],
  ["Menus", "Tools", "tools"],
  ["D-pad", "Up", "up"],
  ["D-pad", "Left", "left"],
  ["D-pad", "OK", "ok"],
  ["D-pad", "Right", "right"],
  ["D-pad", "Down", "down"],
];

/** The shortcuts of FR-24, in the PRD's order, by the names their buttons show. */
const SHORTCUTS: readonly (readonly [name: string, shortcut: MenuShortcut])[] = [
  ["Picture mode", "picture-mode"],
  ["Picture size", "picture-size"],
  ["Sleep timer", "sleep-timer"],
  ["Energy saving", "energy-saving"],
  ["Captions", "captions"],
  ["Audio description", "audio-description"],
  ["Audio track", "audio-track"],
  ["Input source", "input-source"],
];

const renderMenuMode = (appliances: FakeAppliancesApi) => {
  let closed = 0;
  render(
    <TvMenuMode
      appliances={appliances}
      tv={TV}
      title={TITLE}
      onClose={() => {
        closed += 1;
      }}
    />,
  );
  return { closed: () => closed };
};

const menuMode = () => screen.getByRole("dialog", { name: "TV Menu mode" });

const tap = (name: string): void => {
  fireEvent.click(within(menuMode()).getByRole("button", { name }));
};

describe("TV Menu mode (FR-23)", () => {
  it("names the Selected TV, and has its keys and shortcuts, each in its group, and nothing else but Close", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    renderMenuMode(fakeAppliancesApi([TV]));

    // Modal, on the platform's own dialog: nothing behind it can be reached.
    expect(showModal.mock.contexts).toEqual([menuMode()]);
    showModal.mockRestore();
    expect(within(menuMode()).getByText(TITLE)).toBeTruthy();
    const shown = (group: string) =>
      within(within(menuMode()).getByRole("group", { name: group }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    for (const group of ["Menus", "D-pad"]) {
      expect(shown(group)).toEqual(KEYS.filter(([inGroup]) => inGroup === group).map(([, name]) => name));
    }
    expect(shown("Shortcuts")).toEqual(SHORTCUTS.map(([name]) => name));
    expect(within(menuMode()).getAllByRole("button")).toHaveLength(KEYS.length + SHORTCUTS.length + 1);
  });

  it("has the now-playing bar while the Selected TV's Player plays a Media File (FR-36)", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowPlaying(TV.id, {
      name: "Arrival.mkv",
      route: "audio-conversion",
      state: "paused",
      positionMs: 0,
      durationMs: 6_960_000,
      audioTracks: [],
      audioTrack: null,
      subtitleTracks: [],
      subtitleTrack: null,
      preview: null,
      music: null,
      queue: null,
    });
    renderMenuMode(appliances);

    const bar = await within(menuMode()).findByRole("region", { name: "Now playing" });
    fireEvent.click(within(bar).getByRole("button", { name: "Play" }));

    await waitFor(() => {
      expect(appliances.playbackControls).toEqual([{ id: TV.id, control: { action: "play" } }]);
    });
  });

  it("presses each key tapped on the Selected TV, in the order tapped", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderMenuMode(appliances);

    for (const [, name] of KEYS) tap(name);

    await waitFor(() => {
      expect(appliances.keysPressed).toEqual(KEYS.map(([, , key]) => ({ id: TV.id, key })));
    });
  });

  it("closes with Close, or with Escape", () => {
    const menu = renderMenuMode(fakeAppliancesApi([TV]));
    expect(document.activeElement?.textContent).toBe("Close");

    tap("Close");
    fireEvent.keyDown(within(menuMode()).getByRole("button", { name: "OK" }), { key: "Escape" });

    expect(menu.closed()).toBe(2);
  });

  it("reports a key the Hub refused with its reason, until a key is pressed", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderMenuMode(appliances);
    const reason = "No TV answered at 192.168.1.22. Check that it is switched on and on the same network as the Hub.";
    appliances.refuseNextKey(reason);

    tap("Menu");
    expect((await within(menuMode()).findByRole("alert")).textContent).toBe(reason);

    tap("Menu");
    await waitFor(() => {
      expect(within(menuMode()).queryByRole("alert")).toBeNull();
    });
  });
});

describe("TV Menu mode's shortcuts (FR-24)", () => {
  it("presses each shortcut tapped on the Selected TV, in the order tapped", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderMenuMode(appliances);

    for (const [name] of SHORTCUTS) tap(name);

    await waitFor(() => {
      expect(appliances.shortcutsPressed).toEqual(SHORTCUTS.map(([, shortcut]) => ({ id: TV.id, shortcut })));
    });
  });

  it("tells the person when the TV said it ignored a shortcut", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.ignoreShortcuts(TV.id, ["energy-saving"]);
    renderMenuMode(appliances);

    tap("Energy saving");

    expect((await within(menuMode()).findByRole("alert")).textContent).toBe(
      "Living room · TV ignored Energy saving: its model or firmware doesn't take that shortcut. Find the setting with Menu instead.",
    );
  });

  it("doesn't claim a shortcut worked when the TV said nothing, and tells the person what to look for", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderMenuMode(appliances);

    tap("Picture mode");

    await waitFor(() => {
      expect(within(menuMode()).getByRole("status").textContent).toBe(
        "Sent Picture mode to Living room · TV, which doesn't say whether it took it. If nothing changed on the TV, it ignores this shortcut: find the setting with Menu instead.",
      );
    });
    expect(within(menuMode()).queryByRole("alert")).toBeNull();
  });

  it("sends a key tapped after a shortcut without waiting to hear what the TV said of the shortcut (FR-22)", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.ignoreShortcuts(TV.id, ["picture-mode"]);
    renderMenuMode(appliances);
    const release = appliances.holdNextShortcutOutcome();

    tap("Picture mode");
    tap("Down");

    await waitFor(() => {
      expect(appliances.keysPressed).toEqual([{ id: TV.id, key: "down" }]);
    });
    expect(within(menuMode()).queryByRole("alert")).toBeNull();

    release();
    expect((await within(menuMode()).findByRole("alert")).textContent).toContain("ignored Picture mode");
  });

  it("keeps what the TV said of a shortcut while keys move through what it opened", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.ignoreShortcuts(TV.id, ["captions"]);
    renderMenuMode(appliances);

    tap("Captions");
    await within(menuMode()).findByRole("alert");
    tap("Down");
    tap("OK");

    await waitFor(() => {
      expect(appliances.keysPressed).toHaveLength(2);
    });
    expect(within(menuMode()).getByRole("alert").textContent).toContain("ignored Captions");
  });

  it("shows only what the TV said of the last shortcut tapped", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.ignoreShortcuts(TV.id, ["sleep-timer"]);
    renderMenuMode(appliances);
    const release = appliances.holdNextShortcutOutcome();

    tap("Sleep timer");
    tap("Audio track");
    await waitFor(() => {
      expect(within(menuMode()).getByRole("status").textContent).toContain("Sent Audio track");
    });

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(menuMode()).queryByRole("alert")).toBeNull();
    expect(within(menuMode()).getByRole("status").textContent).toContain("Sent Audio track");
  });

  it("reports a shortcut the Hub refused with its reason", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderMenuMode(appliances);
    appliances.refuseNextShortcut("Living room · TV no longer lets the Hub in. Pair it again in Settings.");

    tap("Input source");

    expect((await within(menuMode()).findByRole("alert")).textContent).toBe(
      "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
    );
    expect(appliances.shortcutsPressed).toEqual([]);
  });

  it("shows no setting's value, before or after a shortcut, as the Hub can't read them (FR-25)", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderMenuMode(appliances);

    const settingsNamedOnly = (): void => {
      for (const [name, shortcut] of SHORTCUTS) {
        expect(within(menuMode()).getByRole("button", { name }).textContent, shortcut).toBe(name);
      }
      expect(menuMode().textContent).not.toMatch(SETTING_VALUES);
    };
    settingsNamedOnly();

    for (const [name] of SHORTCUTS) tap(name);
    await waitFor(() => {
      expect(within(menuMode()).getByRole("status").textContent).toContain("Sent Input source");
    });
    settingsNamedOnly();
  });
});

/** Values a TV's settings take, any of which shown would claim to know what the Hub can't read (FR-25). */
const SETTING_VALUES =
  /\b(?:Standard|Dynamic|Movie|Natural|Vivid|Filmmaker|Eco|16:9|4:3|Fit to screen|Zoom|Custom|HDMI ?\d?|Off|On|Low|Medium|High|Auto|\d+ ?min(?:ute)?s?|English|Stereo|Dolby)\b/;
