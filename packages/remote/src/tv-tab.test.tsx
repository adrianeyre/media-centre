import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { MediaSourcesApi } from "./media-sources-api.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { SELECTED_TV_KEY } from "./selected-tv.ts";
import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeHubAddressApi } from "./testing/fake-hub-address-api.ts";
import { aMediaFile, fakeMediaSourcesApi } from "./testing/fake-media-sources-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";
import { TvTab } from "./tv-tab.tsx";

afterEach(cleanup);

/** Rooms 1, 2 and 3, in that order. */
const ROOMS = ["Living room", "Bedroom", "Office"];

/** Quick enough that a test sees the TV tab follow the Hub. */
const REFRESH_MS = 20;

const renderTab = (
  appliances: FakeAppliancesApi,
  {
    rooms = fakeRoomsApi(ROOMS),
    storage = memoryStorage(),
    mediaSources = fakeMediaSourcesApi(),
  }: { rooms?: RoomsApi; storage?: RemoteStorage; mediaSources?: MediaSourcesApi } = {},
) => {
  /** The part of Settings each "Open Settings" opened, oldest first. */
  const openedSettings: string[] = [];
  const rendered = render(
    <TvTab
      appliances={appliances}
      hubAddress={fakeHubAddressApi()}
      mediaSources={mediaSources}
      rooms={rooms}
      storage={storage}
      refreshMs={REFRESH_MS}
      keyboardRefreshMs={REFRESH_MS}
      appsRefreshMs={REFRESH_MS}
      nowShowingRefreshMs={REFRESH_MS}
      nowPlayingRefreshMs={REFRESH_MS}
      developerRefreshMs={REFRESH_MS}
      onOpenSettings={(section) => {
        openedSettings.push(section);
      }}
    />,
  );
  return { ...rendered, openedSettings: () => openedSettings };
};

const tvList = () => screen.findByRole("region", { name: "TVs" });

/** Each Room's heading, with the TVs listed under it as the Remote names them. */
const shownGroups = async (): Promise<[string, string[]][]> => {
  const list = await tvList();
  await within(list).findAllByRole("heading", { level: 3 });
  return [...list.querySelectorAll(".room-group")].map((group) => [
    group.querySelector("h3")?.textContent ?? "",
    [...group.querySelectorAll(".room-name")].map((name) => name.textContent),
  ]);
};

const powerOf = async (title: string): Promise<string | null | undefined> =>
  within(await tvList())
    .getByRole("listitem", { name: title })
    .querySelector(".power")?.textContent;

const pickerToggle = () => screen.findByRole("button", { name: /^Selected TV: / });

/** Opens the TV picker, with one tap, and returns the TVs it offers as it names them. */
const openPicker = async (): Promise<string[]> => {
  fireEvent.click(await pickerToggle());
  const choices = screen.getByRole("list", { name: "Choose a TV" });
  return within(choices)
    .getAllByRole("button")
    .map((choice) => choice.textContent);
};

const choose = async (title: string): Promise<void> => {
  await openPicker();
  fireEvent.click(within(screen.getByRole("list", { name: "Choose a TV" })).getByRole("button", { name: title }));
};

const selectedTitle = async (): Promise<string | null> =>
  (await pickerToggle()).querySelector("strong")?.textContent ?? null;

describe("the TV tab", () => {
  it("shows how to add a TV when there are none", async () => {
    const tab = renderTab(fakeAppliancesApi());

    expect(screen.getByText("Loading the TVs…")).toBeTruthy();
    const empty = await screen.findByRole("region", { name: "No TVs yet" });
    expect(empty.textContent).toContain("Add a TV in Settings: tap Find TVs");
    expect(screen.queryByRole("button", { name: /^Selected TV/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    // On TV, where TVs are added.
    expect(tab.openedSettings()).toEqual(["tv"]);
  });

  it('lists every TV under its Room, in Room order, with "No room" last (FR-10)', async () => {
    renderTab(fakeAppliancesApi([aTv(1, "Spare", null), aTv(2, "TV", 2), aTv(3, "TV", 1), aTv(4, "Old", 99)]), {
      rooms: fakeRoomsApi(["Living room", "Bedroom", "Office"]),
    });

    expect(await shownGroups()).toEqual([
      ["Living room", ["Living room · TV"]],
      ["Bedroom", ["Bedroom · TV"]],
      ["No room", ["Spare", "Old"]],
    ]);
  });

  it("follows the Room order set in Settings", async () => {
    const rooms = fakeRoomsApi(ROOMS);
    renderTab(fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]), { rooms });
    expect((await shownGroups()).map(([heading]) => heading)).toEqual(["Living room", "Bedroom"]);

    await rooms.reorder([2, 3, 1]);

    await waitFor(async () => {
      expect((await shownGroups()).map(([heading]) => heading)).toEqual(["Bedroom", "Living room"]);
    });
  });

  it("shows each TV's power state, and follows it through on, standby and unreachable (FR-16)", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]);
    appliances.setPower(2, "standby");
    renderTab(appliances);

    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("On");
    });
    expect(await powerOf("Bedroom · TV")).toBe("Standby");

    appliances.setPower(1, "standby");
    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("Standby");
    });
    appliances.setPower(1, "unreachable");
    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("Unreachable");
    });
    appliances.setPower(1, "on");
    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("On");
    });
    expect(await powerOf("Bedroom · TV")).toBe("Standby");
  });

  it("says it is still checking a TV's power state until the Hub has answered", async () => {
    renderTab(fakeAppliancesApi([aTv(1, "TV", 1)]));

    expect(await powerOf("Living room · TV")).toBe("Checking…");
  });

  it("stops asking the Hub once it is closed", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
    const tab = renderTab(appliances);
    await waitFor(() => {
      expect(appliances.powerReads.length).toBeGreaterThan(1);
    });

    tab.unmount();
    const asked = appliances.powerReads.length;
    await new Promise((resolve) => setTimeout(resolve, REFRESH_MS * 5));

    expect(appliances.powerReads).toHaveLength(asked);
  });

  it("warns when it can't reach the Hub", async () => {
    const appliances = fakeAppliancesApi();
    renderTab({ ...appliances, list: () => Promise.reject(new Error("offline")) });

    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
  });
});

describe("the Selected TV's Power button (FR-17)", () => {
  const powerButton = async () =>
    within(await screen.findByRole("region", { name: "Power" })).getByRole("button", { name: "Power" });

  it("switches the Selected TV, and the TV list shows its power state change without waiting for the next refresh", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    appliances.setPower(2, "standby");
    // Long enough that only the Power button's own read can show the change.
    render(
      <TvTab
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        rooms={fakeRoomsApi(ROOMS)}
        storage={memoryStorage()}
        refreshMs={60_000}
        onOpenSettings={() => undefined}
      />,
    );
    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("Standby");
    });

    fireEvent.click(await powerButton());

    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("On");
    });
    expect(appliances.powerSwitches).toEqual([2]);
    expect(await powerOf("Bedroom · TV")).toBe("On");

    fireEvent.click(await powerButton());
    await waitFor(async () => {
      expect(await powerOf("Living room · TV")).toBe("Standby");
    });
    expect(appliances.powerSwitches).toEqual([2, 2]);
  });

  it("switches the next TV chosen, not the one before", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    renderTab(appliances);
    await selectedTitle();

    await choose("Bedroom · TV");
    fireEvent.click(await powerButton());

    await waitFor(() => {
      expect(appliances.powerSwitches).toEqual([1]);
    });
  });

  it("isn't shown with no TV to switch", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("region", { name: "Power" })).toBeNull();
  });
});

describe("the Selected TV's volume (FR-19)", () => {
  const volume = () => screen.findByRole("region", { name: "Volume" });
  const level = async () => within(await volume()).getByRole("status", { name: "Volume level" }).textContent;

  it("shows the Selected TV's own volume, and the next one's once it is chosen, and sets only the Selected TV's", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    appliances.setVolume(1, { known: true, volume: 40, muted: false });
    appliances.setVolume(2, { known: true, volume: 12, muted: false });
    renderTab(appliances);
    await waitFor(async () => {
      expect(await level()).toBe("12");
    });

    await choose("Bedroom · TV");
    await waitFor(async () => {
      expect(await level()).toBe("40");
    });
    fireEvent.input(within(await volume()).getByRole("slider", { name: "Volume" }), { target: { value: "18" } });

    await waitFor(() => {
      expect(appliances.volumeChanges).toEqual([{ id: 1, change: { volume: 18 } }]);
    });
  });

  it("follows the Selected TV's volume as its own remote changes it, with the TV tab", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
    renderTab(appliances);
    await waitFor(async () => {
      expect(await level()).toBe("11");
    });

    appliances.setVolume(1, { known: true, volume: 27, muted: false });

    await waitFor(async () => {
      expect(await level()).toBe("27");
    });
  });

  it("isn't shown with no TV", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("region", { name: "Volume" })).toBeNull();
  });
});

describe("the Selected TV's on-screen keyboard (FR-20)", () => {
  const keyboard = () => screen.queryByRole("form", { name: "TV keyboard" });

  it("shows a text field only while the Selected TV's keyboard is open, and sends what is typed to it", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");

    // Another TV's keyboard is no business of this one's.
    appliances.setKeyboard(1, true);
    await waitFor(() => {
      expect(appliances.keyboardReads.filter((id) => id === 2).length).toBeGreaterThan(1);
    });
    expect(keyboard()).toBeNull();

    await choose("Bedroom · TV");
    const form = await screen.findByRole("form", { name: "TV keyboard" });
    fireEvent.input(within(form).getByRole("textbox", { name: "Text for the TV" }), { target: { value: "café" } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(appliances.textsEntered).toEqual([{ id: 1, text: "café" }]);
    });
    await waitFor(() => {
      expect(keyboard()).toBeNull();
    });
  });

  it("isn't shown with no TV", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(keyboard()).toBeNull();
  });
});

describe("the Selected TV's apps (FR-21)", () => {
  const appsSection = () => screen.findByRole("region", { name: "Apps" });
  const shownApps = async (): Promise<string[]> =>
    (await within(await appsSection()).findAllByRole("listitem")).map((item) => item.getAttribute("aria-label") ?? "");

  it("lists the Selected TV's apps, launches them on it, and follows a change of TV", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    appliances.setApps(1, { known: true, apps: [{ id: "a.plex", name: "Plex", icon: false }] });
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");

    expect(await shownApps()).toEqual(["Internet", "Netflix", "YouTube"]);
    fireEvent.click(within(await appsSection()).getByRole("button", { name: "Launch YouTube" }));
    await waitFor(() => {
      expect(appliances.appsDone).toEqual([{ id: 2, appId: "111299001912", what: "launch" }]);
    });

    await choose("Bedroom · TV");
    await waitFor(async () => {
      expect(await shownApps()).toEqual(["Plex"]);
    });
    // The other TV's launch is its own, and not said of this one.
    expect(within(await appsSection()).getByRole("status").textContent).toBe("");
  });

  it("says the Selected TV is in standby, rather than listing no apps, and lists them once it is on", async () => {
    const appliances = fakeAppliancesApi([aTv(2, "TV", 1)]);
    appliances.setPower(2, "standby");
    appliances.setApps(2, { known: false, why: "standby" });
    renderTab(appliances);

    await within(await appsSection()).findByText("Living room · TV is in standby. Switch it on to see its apps.");

    appliances.setApps(2, { known: true, apps: [{ id: "a.plex", name: "Plex", icon: false }] });
    appliances.setPower(2, "on");
    await waitFor(async () => {
      expect(await shownApps()).toEqual(["Plex"]);
    });
  });

  it("isn't shown with no TV", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();
  });
});

describe("the Selected TV's keys", () => {
  const tapKey = async (name: string): Promise<void> => {
    fireEvent.click(within(await screen.findByRole("region", { name: "Keys" })).getByRole("button", { name }));
  };

  it("press each key on the Selected TV, and on the next one chosen (FR-18)", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");

    await tapKey("OK");
    await choose("Bedroom · TV");
    await tapKey("Back");

    await waitFor(() => {
      expect(appliances.keysPressed).toEqual([
        { id: 2, key: "ok" },
        { id: 1, key: "back" },
      ]);
    });
  });

  it("don't carry a problem with one TV over to the next one chosen", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    renderTab(appliances);
    appliances.refuseNextKey(
      "No TV answered at 192.168.1.22. Check that it is switched on and on the same network as the Hub.",
    );
    await tapKey("Up");
    await within(await screen.findByRole("region", { name: "Keys" })).findByRole("alert");

    await choose("Bedroom · TV");

    expect(within(screen.getByRole("region", { name: "Keys" })).queryByRole("alert")).toBeNull();
  });

  it("aren't shown with no TV to press them on", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("region", { name: "Keys" })).toBeNull();
  });
});

describe("TV Menu mode (FR-23)", () => {
  const menuMode = () => screen.queryByRole("dialog", { name: "TV Menu mode" });

  it("opens over the TV tab for the Selected TV, presses its keys and shortcuts there, and closes", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");
    expect(menuMode()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "TV Menu mode" }));
    const opened = menuMode();
    if (opened === null) throw new Error("TV Menu mode didn't open");
    expect(within(opened).getByText("Living room · TV")).toBeTruthy();
    fireEvent.click(within(opened).getByRole("button", { name: "Menu" }));
    fireEvent.click(within(opened).getByRole("button", { name: "Picture mode" }));
    await waitFor(() => {
      expect(appliances.keysPressed).toEqual([{ id: 2, key: "menu" }]);
      expect(appliances.shortcutsPressed).toEqual([{ id: 2, shortcut: "picture-mode" }]);
    });

    fireEvent.click(within(opened).getByRole("button", { name: "Close" }));
    expect(menuMode()).toBeNull();
    expect(document.activeElement?.textContent).toBe("TV Menu mode");
  });

  it("isn't offered with no TV", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("button", { name: "TV Menu mode" })).toBeNull();
  });
});

describe("the now-playing bar (FR-36)", () => {
  const nowPlaying = () => screen.queryAllByRole("region", { name: "Now playing" });

  it("shows what the Selected TV's Player plays, on the TV tab and in TV Menu mode, and none for a TV playing nothing", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    appliances.setNowPlaying(2, {
      name: "Arrival.mkv",
      route: "audio-conversion",
      state: "playing",
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
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");

    await waitFor(() => {
      expect(nowPlaying()).toHaveLength(1);
    });
    expect(nowPlaying()[0]?.textContent).toContain("Arrival.mkv");

    fireEvent.click(screen.getByRole("button", { name: "TV Menu mode" }));
    const opened = screen.getByRole("dialog", { name: "TV Menu mode" });
    const inMenuMode = await within(opened).findByRole("region", { name: "Now playing" });
    fireEvent.click(within(inMenuMode).getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(appliances.playbackControls).toEqual([{ id: 2, control: { action: "pause" } }]);
    });
    fireEvent.click(within(opened).getByRole("button", { name: "Close" }));

    await choose("Bedroom · TV");
    await waitFor(() => {
      expect(nowPlaying()).toHaveLength(0);
    });
  });
});

describe("the Selected TV", () => {
  it("is the first TV listed when the Remote has none, and the Remote remembers it (FR-15)", async () => {
    const storage = memoryStorage();
    renderTab(fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]), { storage });

    expect(await selectedTitle()).toBe("Living room · TV");
    expect(
      within(await tvList())
        .getByRole("listitem", { name: "Living room · TV" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      within(await tvList())
        .getByRole("listitem", { name: "Bedroom · TV" })
        .getAttribute("aria-current"),
    ).toBeNull();
    await waitFor(() => {
      expect(storage.items[SELECTED_TV_KEY]).toBe("2");
    });
  });

  it("is the one the Remote remembers when it opens again", async () => {
    const storage = memoryStorage({ [SELECTED_TV_KEY]: "1" });
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    const first = renderTab(appliances, { storage });
    expect(await selectedTitle()).toBe("Bedroom · TV");

    first.unmount();
    renderTab(appliances, { storage });

    expect(await selectedTitle()).toBe("Bedroom · TV");
    expect(storage.items[SELECTED_TV_KEY]).toBe("1");
  });

  it("falls back to the first TV when the one remembered has been removed, and remembers that one", async () => {
    const storage = memoryStorage({ [SELECTED_TV_KEY]: "2" });
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1), aTv(3, "Spare", null)]);
    renderTab(appliances, { storage });
    expect(await selectedTitle()).toBe("Living room · TV");

    // Removed, e.g. from Settings on another Remote, while this one shows it.
    await appliances.remove(2);

    await waitFor(async () => {
      expect(await selectedTitle()).toBe("Bedroom · TV");
    });
    expect(storage.items[SELECTED_TV_KEY]).toBe("1");
  });

  it("stays the same when a TV is added in an earlier Room", async () => {
    const storage = memoryStorage();
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2)]);
    renderTab(appliances, { storage });
    expect(await selectedTitle()).toBe("Bedroom · TV");

    await appliances.add({ kind: "tv", address: "192.168.1.30", name: "TV", roomId: 1 });

    await waitFor(async () => {
      expect((await shownGroups()).map(([heading]) => heading)).toEqual(["Living room", "Bedroom"]);
    });
    expect(await selectedTitle()).toBe("Bedroom · TV");
  });

  it("can be different on each Remote", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]);
    const phone = memoryStorage();
    const tablet = memoryStorage();
    const onPhone = renderTab(appliances, { storage: phone });
    await choose("Bedroom · TV");
    onPhone.unmount();

    renderTab(appliances, { storage: tablet });

    expect(await selectedTitle()).toBe("Living room · TV");
    expect(phone.items[SELECTED_TV_KEY]).toBe("2");
    expect(tablet.items[SELECTED_TV_KEY]).toBe("1");
  });
});

describe("the TV tab's widgets (FR-58)", () => {
  it("are remembered under the key the TV tab always had, so that no Remote loses its layout", async () => {
    const storage = memoryStorage({
      "media-centre:tv-widgets": JSON.stringify({ hidden: ["developer"], layouts: {} }),
    });
    renderTab(fakeAppliancesApi([aTv(1, "TV", 1)]), { storage });
    await screen.findByRole("region", { name: "Keys" });

    expect(screen.queryByRole("region", { name: "Developer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide Keys" }));

    expect(JSON.parse(storage.items["media-centre:tv-widgets"] ?? "null")).toMatchObject({
      hidden: ["developer", "keys"],
    });
    expect(Object.keys(storage.items).filter((key) => key.endsWith("-widgets"))).toEqual(["media-centre:tv-widgets"]);
  });
});

describe("the TV picker", () => {
  it("opens with one tap, and offers every TV as Room · Name, in the order the TV tab lists them", async () => {
    renderTab(fakeAppliancesApi([aTv(1, "Spare", null), aTv(2, "TV", 2), aTv(3, "TV", 1)]));
    expect(screen.queryByRole("list", { name: "Choose a TV" })).toBeNull();
    expect((await pickerToggle()).getAttribute("aria-expanded")).toBe("false");

    expect(await openPicker()).toEqual(["Living room · TV", "Bedroom · TV", "Spare"]);

    expect((await pickerToggle()).getAttribute("aria-expanded")).toBe("true");
    const choices = screen.getByRole("list", { name: "Choose a TV" });
    expect(within(choices).getByRole("button", { name: "Living room · TV" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(choices).getByRole("button", { name: "Spare" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("selects the TV chosen, closes, and the Remote remembers it", async () => {
    const storage = memoryStorage();
    renderTab(fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]), { storage });

    await choose("Bedroom · TV");

    expect(await selectedTitle()).toBe("Bedroom · TV");
    expect(screen.queryByRole("list", { name: "Choose a TV" })).toBeNull();
    expect(document.activeElement).toBe(await pickerToggle());
    expect(storage.items[SELECTED_TV_KEY]).toBe("2");
    expect(
      within(await tvList())
        .getByRole("listitem", { name: "Bedroom · TV" })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("closes without changing the Selected TV on a second tap, or on Escape", async () => {
    renderTab(fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]));

    await openPicker();
    fireEvent.click(await pickerToggle());
    expect(screen.queryByRole("list", { name: "Choose a TV" })).toBeNull();

    await openPicker();
    fireEvent.keyDown(
      within(screen.getByRole("list", { name: "Choose a TV" })).getByRole("button", { name: "Bedroom · TV" }),
      {
        key: "Escape",
      },
    );
    expect(screen.queryByRole("list", { name: "Choose a TV" })).toBeNull();
    expect(await selectedTitle()).toBe("Living room · TV");
  });
});

describe("the Selected TV's Now Showing (FR-26)", () => {
  const card = () => screen.findByRole("region", { name: "Now Showing" });
  const shown = async (): Promise<string> => (await within(await card()).findByRole("status")).textContent;

  it("shows what the Selected TV is showing, follows a change of TV, and sends nothing to either TV", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "TV", 1)]);
    appliances.setNowShowing(2, { known: true, app: { id: "3201907018807", name: "Netflix", icon: true } });
    appliances.setNowShowing(1, { known: true, app: { id: "111299001912", name: "YouTube", icon: true } });
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");
    await waitFor(async () => {
      expect(await shown()).toBe("Netflix");
    });

    await choose("Bedroom · TV");
    await waitFor(async () => {
      expect(await shown()).toBe("YouTube");
    });
    await choose("Living room · TV");
    await waitFor(async () => {
      expect(await shown()).toBe("Netflix");
    });

    // PRD §5 scenario 3: switching back and forth disturbs neither TV.
    expect(appliances.nowShowingReads).toContain(1);
    expect(appliances.keysPressed).toEqual([]);
    expect(appliances.shortcutsPressed).toEqual([]);
    expect(appliances.appsDone).toEqual([]);
    expect(appliances.powerSwitches).toEqual([]);
    expect(appliances.volumeChanges).toEqual([]);
    expect(appliances.textsEntered).toEqual([]);
  });

  it("follows an app launched from the Selected TV's apps", async () => {
    const appliances = fakeAppliancesApi([aTv(2, "TV", 1)]);
    renderTab(appliances);
    await waitFor(async () => {
      expect(await shown()).toBe("Can't tell what Living room · TV is showing: none of its apps says it is in front.");
    });

    fireEvent.click(
      await within(await screen.findByRole("region", { name: "Apps" })).findByRole("button", {
        name: "Launch YouTube",
      }),
    );

    await waitFor(async () => {
      expect(await shown()).toBe("YouTube");
    });
  });

  it("isn't shown with no TV", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("region", { name: "Now Showing" })).toBeNull();
  });
});

describe("the Selected TV's Developer section (FR-28, FR-29)", () => {
  const section = () => screen.findByRole("region", { name: "Developer" });
  const openSection = async (): Promise<void> => {
    fireEvent.click(within(await section()).getByRole("button", { name: "Developer" }));
  };
  const modelShown = async (): Promise<string | null | undefined> =>
    (await section()).querySelector(".device-info dd")?.textContent;

  it("shows the Selected TV's device info, follows a change of TV, and sends nothing to either TV", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 2, { model: "QE65S95CATXXU" }), aTv(2, "TV", 1)]);
    renderTab(appliances);
    expect(await selectedTitle()).toBe("Living room · TV");
    await openSection();
    await waitFor(async () => {
      expect(await modelShown()).toBe("QE55Q60TAUXXU");
    });

    await choose("Bedroom · TV");
    // Each TV's section is its own, closed until opened.
    await openSection();
    await waitFor(async () => {
      expect(await modelShown()).toBe("QE65S95CATXXU");
    });

    expect(appliances.deviceInfoReads).toContain(2);
    expect(appliances.deviceInfoReads).toContain(1);
    expect(appliances.keysPressed).toEqual([]);
    expect(appliances.shortcutsPressed).toEqual([]);
    expect(appliances.appsDone).toEqual([]);
    expect(appliances.powerSwitches).toEqual([]);
    expect(appliances.volumeChanges).toEqual([]);
    expect(appliances.textsEntered).toEqual([]);
  });

  it("opens Settings on General, where the Hub's IP address is set", async () => {
    const tab = renderTab(fakeAppliancesApi([aTv(2, "TV", 1)]));
    await openSection();

    fireEvent.click(await within(await section()).findByRole("button", { name: "Set it in Settings" }));

    expect(tab.openedSettings()).toEqual(["general"]);
  });

  it("isn't shown with no TV", async () => {
    renderTab(fakeAppliancesApi());

    await screen.findByRole("region", { name: "No TVs yet" });
    expect(screen.queryByRole("region", { name: "Developer" })).toBeNull();
  });
});

describe("Watch & Listen (FR-33)", () => {
  const mediaSources = () =>
    fakeMediaSourcesApi([
      { name: "Films", path: "/media/films", folders: { "": { files: [aMediaFile("Arrival.mkv")] } } },
    ]);

  it("browses the Media Sources below the Selected TV's controls", async () => {
    renderTab(fakeAppliancesApi([aTv(1, "TV", 1)]), { mediaSources: mediaSources() });

    const watchAndListen = await screen.findByRole("region", { name: "Watch & Listen" });
    fireEvent.click(await within(watchAndListen).findByRole("button", { name: "Films" }));

    expect(await within(watchAndListen).findByRole("listitem", { name: "Arrival.mkv" })).toBeTruthy();
  });

  it("browses them with no TV too, listing Media Files without playing them", async () => {
    renderTab(fakeAppliancesApi(), { mediaSources: mediaSources() });
    await screen.findByRole("region", { name: "No TVs yet" });

    const watchAndListen = screen.getByRole("region", { name: "Watch & Listen" });

    fireEvent.click(await within(watchAndListen).findByRole("button", { name: "Films" }));
    expect(await within(watchAndListen).findByRole("listitem", { name: "Arrival.mkv" })).toBeTruthy();
    expect(within(watchAndListen).queryByRole("button", { name: /^Arrival\.mkv ?, / })).toBeNull();
  });

  // FR-35.
  it("plays a Media File chosen on the Selected TV, named as the Remote names it", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]);
    renderTab(appliances, { mediaSources: mediaSources(), storage: memoryStorage({ [SELECTED_TV_KEY]: "2" }) });
    const watchAndListen = await screen.findByRole("region", { name: "Watch & Listen" });
    fireEvent.click(await within(watchAndListen).findByRole("button", { name: "Films" }));

    fireEvent.click(await within(watchAndListen).findByRole("button", { name: /^Arrival\.mkv ?, / }));

    expect(await within(watchAndListen).findByText("Sent to the Player on Bedroom · TV.")).toBeTruthy();
    expect(appliances.plays).toEqual([{ id: 2, request: { mediaSourceId: 1, path: "Arrival.mkv", resume: false } }]);
  });

  it("shows switching the Selected TV on as a step when it is in standby", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
    appliances.setPower(1, "standby");
    renderTab(appliances, { mediaSources: mediaSources() });
    const watchAndListen = await screen.findByRole("region", { name: "Watch & Listen" });
    fireEvent.click(await within(watchAndListen).findByRole("button", { name: "Films" }));

    fireEvent.click(await within(watchAndListen).findByRole("button", { name: /^Arrival\.mkv ?, / }));

    expect(await within(watchAndListen).findByText("Switch the TV on")).toBeTruthy();
    expect(await within(watchAndListen).findByText("Sent to the Player on Living room · TV.")).toBeTruthy();
  });
});
