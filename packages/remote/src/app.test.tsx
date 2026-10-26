import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { REMOTE_VERSION, REPOSITORY_URL } from "./about.ts";
import { App } from "./app.tsx";
import type { HubStatus } from "./hub-status.ts";
import type { LatestVersionStatus } from "./latest-version.ts";
import { SELECTED_TV_KEY } from "./selected-tv.ts";
import { LAST_SETTINGS_SECTION_KEY } from "./settings-sections.ts";
import { LAST_TAB_KEY } from "./tabs.ts";
import { aHiveAppliance, aLight, anAirConditioner, aTv, fakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeHubAddressApi } from "./testing/fake-hub-address-api.ts";
import { fakeMediaSourcesApi } from "./testing/fake-media-sources-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { fakeSigningCertificateApi } from "./testing/fake-signing-certificate-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";
import { fakeNetworkApi } from "./testing/fake-network-api.ts";
import { fakeAmazonApi } from "./testing/fake-amazon-api.ts";
import { fakeRingApi } from "./testing/fake-ring-api.ts";

/** Opens this part of Settings from its menu. */
const openSettingsSection = (label: string): void => {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("button", { name: label }));
};

/** The part of Settings its menu marks as shown. */
const shownSettingsSection = (): string | null | undefined =>
  within(screen.getByRole("navigation", { name: "Settings" })).getByRole("button", { current: "page" }).textContent;

afterEach(cleanup);

const connected = (): Promise<HubStatus> =>
  Promise.resolve({ kind: "connected", info: { product: "media-centre", version: "1.2.3", hubId: "abc" } });

const upToDate = (): Promise<LatestVersionStatus> => Promise.resolve({ kind: "known", version: REMOTE_VERSION });

describe("the Remote", () => {
  it("opens on the TV tab, which explains how to add a TV when there are none", async () => {
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    expect(screen.getByRole("tab", { name: "TV" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "TV", level: 1 })).toBeTruthy();
    const empty = await screen.findByRole("region", { name: "No TVs yet" });
    expect(empty.textContent).toContain("Add a TV in Settings: tap Find TVs");
    expect(empty.textContent).toContain("or add one by its IP address");
  });

  it("has a TV tab, an Aircon tab, a Lights tab, a Heating tab, Network, Amazon, Ring and Rooms last, and no Settings tab", () => {
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
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

  it("goes to Settings from the cog in the app bar, and remembers it", () => {
    const storage = memoryStorage();
    render(
      <App
        storage={storage}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "General settings" }));

    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "TV" }).getAttribute("aria-selected")).toBe("false");
    expect(storage.items[LAST_TAB_KEY]).toBe("settings");
  });

  it("goes to Settings from the TV tab's empty state", async () => {
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));

    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  });

  it("lists the Air Conditioners in the Aircon tab by Room, and goes to Settings from its empty state", async () => {
    const appliances = fakeAppliancesApi([anAirConditioner(2, "Aircon", 1)]);
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi(["Bedroom"])}
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Aircon" }));
    expect(screen.getByRole("heading", { name: "Aircon", level: 1 })).toBeTruthy();
    const bedroom = await screen.findByRole("region", { name: "Bedroom · Aircon" });
    expect(within(bedroom).getByRole("heading", { name: "Bedroom · Aircon", level: 2 })).toBeTruthy();

    await appliances.remove(2);
    cleanup();
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "aircon" })}
        rooms={fakeRoomsApi()}
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );
    const empty = await screen.findByRole("region", { name: "No Air Conditioners yet" });
    fireEvent.click(within(empty).getByRole("button", { name: "Open Settings" }));
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    // On Aircon's own settings, where they are added.
    expect(shownSettingsSection()).toBe("Aircon");
    expect(screen.getByRole("region", { name: "Air Conditioners" })).toBeTruthy();
  });

  it("lists the Lights in the Lights tab by Room, and goes to Settings from its empty state", async () => {
    const appliances = fakeAppliancesApi([aLight(2, "Lamp", 1)]);
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi(["Bedroom"])}
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Lights" }));
    expect(screen.getByRole("heading", { name: "Lights", level: 1 })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Bedroom Lights" })).toBeTruthy();
    const lamp = await screen.findByRole("region", { name: "Bedroom · Lamp" });
    expect(within(lamp).getByRole("heading", { name: "Bedroom · Lamp", level: 2 })).toBeTruthy();

    await appliances.remove(2);
    cleanup();
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "lights" })}
        rooms={fakeRoomsApi()}
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );
    const empty = await screen.findByRole("region", { name: "No Lights yet" });
    fireEvent.click(within(empty).getByRole("button", { name: "Open Settings" }));
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  });

  it("reopens on the tab it was left on", () => {
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "settings" })}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  });

  it("shows in Settings that it is connected to the Hub, and the Hub's version", async () => {
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "settings" })}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Connecting to the Hub…");
    expect((await screen.findByText("Connected to the Hub")).getAttribute("role")).toBe("status");
    expect(screen.getByText("Version 1.2.3")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one part of Settings at a time, chosen from its menu, and remembers it", () => {
    const storage = memoryStorage({ [LAST_TAB_KEY]: "settings" });
    const renderApp = () =>
      render(
        <App
          storage={storage}
          rooms={fakeRoomsApi()}
          appliances={fakeAppliancesApi()}
          hubAddress={fakeHubAddressApi()}
          mediaSources={fakeMediaSourcesApi()}
          signingCertificate={fakeSigningCertificateApi()}
          network={fakeNetworkApi()}
          amazon={fakeAmazonApi()}
          ring={fakeRingApi()}
          loadHubStatus={connected}
          loadLatestVersion={upToDate}
        />,
      );
    renderApp();

    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(menu)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["General", "Rooms", "TV", "Aircon", "Lights", "Heating"]);
    // Each with an icon beside its name.
    for (const item of within(menu).getAllByRole("button")) expect(item.querySelector("svg")).not.toBeNull();
    // General first: how the Remote looks, the Hub and the version, and nothing else.
    expect(shownSettingsSection()).toBe("General");
    expect(screen.getByRole("region", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Hub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Rooms" })).toBeNull();

    openSettingsSection("Lights");

    expect(shownSettingsSection()).toBe("Lights");
    expect(screen.getByRole("region", { name: "Lights settings" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Appearance" })).toBeNull();
    expect(storage.items[LAST_SETTINGS_SECTION_KEY]).toBe("lights");

    cleanup();
    renderApp();
    expect(shownSettingsSection()).toBe("Lights");
  });

  it("puts the TVs, the Media Sources and the signing certificate under TV, and Hive under Heating", () => {
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "settings", [LAST_SETTINGS_SECTION_KEY]: "tv" })}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    const tv = screen.getByRole("region", { name: "TV settings" });
    expect(
      within(tv)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["TVs", "Media Sources", "Signing certificate"]);

    openSettingsSection("Heating");

    expect(
      within(screen.getByRole("region", { name: "Heating settings" })).getByRole("heading", { level: 2, name: "Hive" }),
    ).toBeTruthy();
  });

  it("manages the Rooms in Settings", async () => {
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "settings" })}
        rooms={fakeRoomsApi(["Living room", "Bedroom"])}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );
    openSettingsSection("Rooms");

    const rooms = screen.getByRole("region", { name: "Rooms" });
    expect(within(rooms).getByRole("heading", { name: "Rooms", level: 2 })).toBeTruthy();
    expect((await within(rooms).findByRole("list", { name: "Room order" })).textContent).toContain("Living room");
    expect(within(rooms).getByRole("button", { name: "Add Room" })).toBeTruthy();
  });

  it("lists the TVs in the TV tab by Room, with the Selected TV it remembers in the TV picker", async () => {
    const storage = memoryStorage({ [SELECTED_TV_KEY]: "2" });
    render(
      <App
        storage={storage}
        rooms={fakeRoomsApi(["Living room", "Bedroom"])}
        appliances={fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)])}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

    const tvs = await screen.findByRole("region", { name: "TVs" });
    expect(
      within(tvs)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Living room", "Bedroom"]);
    expect(screen.getByRole("button", { name: "Selected TV: Bedroom · TV" })).toBeTruthy();
  });

  it("lists the TVs in Settings as Room · Name, and adds them by IP", async () => {
    render(
      <App
        storage={memoryStorage({ [LAST_TAB_KEY]: "settings" })}
        rooms={fakeRoomsApi(["Living room", "Bedroom"])}
        appliances={fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2), aTv(3, "Spare", null)])}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );
    openSettingsSection("TV");

    const tvs = screen.getByRole("region", { name: "TVs" });
    expect(within(tvs).getByRole("heading", { name: "TVs", level: 2 })).toBeTruthy();
    expect(await within(tvs).findByRole("listitem", { name: "Living room · TV" })).toBeTruthy();
    expect(within(tvs).getByRole("listitem", { name: "Bedroom · TV" })).toBeTruthy();
    // A TV with no Room says so beside it.
    expect(within(tvs).getByRole("listitem", { name: "Spare" }).textContent).toContain("No room");
    expect(within(tvs).getByRole("form", { name: "Add TV by IP" })).toBeTruthy();
  });

  it("gives the TV tab's Developer steps the Hub's IP address as set in Settings", async () => {
    const hubAddress = fakeHubAddressApi("192.168.1.5");
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi(["Living room"])}
        appliances={fakeAppliancesApi([aTv(1, "TV", 1)])}
        hubAddress={hubAddress}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );
    const hubIpShown = async (): Promise<string | null | undefined> => {
      const developer = await screen.findByRole("region", { name: "Developer" });
      if (within(developer).getByRole("button", { name: "Developer" }).getAttribute("aria-expanded") === "false") {
        fireEvent.click(within(developer).getByRole("button", { name: "Developer" }));
      }
      return (await within(developer).findByText(/^\d+\.\d+\.\d+\.\d+$/, { selector: ".hub-ip" })).textContent;
    };
    expect(await hubIpShown()).toBe("192.168.1.5");

    fireEvent.click(screen.getByRole("button", { name: "General settings" }));
    const setting = await screen.findByRole("group", { name: "IP address" });
    fireEvent.input(within(setting).getByRole("textbox", { name: "IP address to use" }), {
      target: { value: "10.0.0.2" },
    });
    fireEvent.click(within(setting).getByRole("button", { name: "Use this IP address" }));
    await within(setting).findByText(/set to 10\.0\.0\.2/);

    fireEvent.click(screen.getByRole("tab", { name: "TV" }));
    expect(await hubIpShown()).toBe("10.0.0.2");
  });

  it("warns on every tab when it can't reach the Hub", async () => {
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={() => Promise.resolve({ kind: "unreachable" })}
        loadLatestVersion={upToDate}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe("Can't reach the Hub");
  });
});

describe("the Remote's frame", () => {
  const renderApp = () =>
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

  it("starts with a link that skips to the screen", () => {
    renderApp();

    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(screen.getByRole("main").id).toBe("main");
  });

  it("has the footer at the page's end, after the screen, and the dock the tab bar alone", () => {
    renderApp();

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("button", { name: "Accessibility" })).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.contains(footer)).toBe(false);
    expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Remote" }).parentElement?.contains(footer)).toBe(false);
  });

  it("moves between tabs with the arrow keys, Home and End, taking focus with it", () => {
    renderApp();
    const names = ["TV", "Aircon", "Lights", "Heating", "Network", "Amazon", "Ring", "Rooms"];
    const tabs = names.map((name) => screen.getByRole("tab", { name }));
    const [tv, aircon] = tabs;
    const rooms = tabs.at(-1);
    // Only the open tab is in the Tab order; the arrow keys reach the rest.
    expect(tabs.map((each) => each.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);

    // Right, through every tab, Rooms last, and round to the first.
    tabs.forEach((each, index) => {
      fireEvent.keyDown(each, { key: "ArrowRight" });
      const next = tabs[(index + 1) % tabs.length];
      expect(next?.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(next);
    });

    fireEvent.keyDown(tv as HTMLElement, { key: "ArrowLeft" });
    expect(rooms?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(rooms as HTMLElement, { key: "Home" });
    expect(tv?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tv as HTMLElement, { key: "End" });
    expect(rooms?.getAttribute("aria-selected")).toBe("true");
    expect(aircon?.getAttribute("aria-selected")).toBe("false");
  });
});

describe("the Remote's appearance", () => {
  afterEach(() => {
    delete document.documentElement.dataset.mode;
    delete document.documentElement.dataset.theme;
  });

  const renderApp = (storage = memoryStorage()) => {
    render(
      <App
        storage={storage}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );
    return storage;
  };

  it("follows the device in Evergreen, until set otherwise from the cog in the app bar, and remembers it", () => {
    const storage = renderApp();
    expect(document.documentElement.dataset.mode).toBeUndefined();
    expect(document.documentElement.dataset.theme).toBe("evergreen");

    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "General settings" }));
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    expect(shownSettingsSection()).toBe("General");
    const appearance = screen.getByRole("region", { name: "Appearance" });
    expect(within(appearance).getByRole<HTMLInputElement>("radio", { name: "System" }).checked).toBe(true);
    expect(
      within(within(appearance).getByRole("group", { name: "Theme" }))
        .getAllByRole("radio")
        .map((theme) => theme.parentElement?.textContent),
    ).toEqual(["Evergreen", "Ocean", "Violet", "Sunset", "Rose", "Graphite"]);

    fireEvent.click(within(appearance).getByRole("radio", { name: "Dark" }));
    fireEvent.click(within(appearance).getByRole("radio", { name: "Violet" }));

    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("violet");
    expect(JSON.parse(storage.items["media-centre:appearance"] ?? "null")).toEqual({ mode: "dark", theme: "violet" });
  });

  it("opens looking as it was left", () => {
    renderApp(memoryStorage({ "media-centre:appearance": JSON.stringify({ mode: "light", theme: "rose" }) }));

    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("rose");
  });
});

describe("the update check (FR-61)", () => {
  const renderApp = (latest: LatestVersionStatus) =>
    render(
      <App
        storage={memoryStorage()}
        rooms={fakeRoomsApi()}
        appliances={fakeAppliancesApi()}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={() => Promise.resolve(latest)}
      />,
    );

  /** Each term, then what it is, of the versions listed in `element`. */
  const versionsIn = (element: HTMLElement): string[] =>
    [...element.querySelectorAll(".version-list dt, .version-list dd")].map((item) => item.textContent);

  it("offers the latest version as the Remote opens, when it isn't this one, with the way to its release", async () => {
    renderApp({ kind: "known", version: "99.0.0" });

    const dialog = await screen.findByRole("dialog", { name: "Update available" });
    expect(versionsIn(dialog)).toEqual(["Current version", REMOTE_VERSION, "Latest version", "99.0.0"]);
    const release = within(dialog).getByRole("link", { name: /^Go to the release/ });
    expect(release.getAttribute("href")).toBe(`${REPOSITORY_URL}/releases/latest`);
    expect(release.getAttribute("target")).toBe("_blank");
    expect(release.getAttribute("rel")).toBe("noopener noreferrer");

    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog", { name: "Update available" })).toBeNull();
  });

  it.each<[string, LatestVersionStatus]>([
    ["is this one", { kind: "known", version: REMOTE_VERSION }],
    ["can't be found out", { kind: "unknown" }],
  ])("offers nothing when the latest version %s", async (_, latest) => {
    renderApp(latest);
    await screen.findByRole("region", { name: "No TVs yet" });

    expect(screen.queryByRole("dialog", { name: "Update available" })).toBeNull();
  });

  it("gives both versions in Settings, with Update to the release when the latest isn't this one", async () => {
    renderApp({ kind: "known", version: "99.0.0" });
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "General settings" }));

    const section = screen.getByRole("region", { name: "Version" });
    expect(versionsIn(section)).toEqual(["Current version", REMOTE_VERSION, "Latest version", "99.0.0"]);
    const update = within(section).getByRole("link", { name: /^Update to 99\.0\.0/ });
    expect(update.getAttribute("href")).toBe(`${REPOSITORY_URL}/releases/latest`);
    expect(update.getAttribute("target")).toBe("_blank");
  });

  it("says in Settings when this is the latest version", async () => {
    renderApp({ kind: "known", version: REMOTE_VERSION });
    fireEvent.click(screen.getByRole("button", { name: "General settings" }));

    const section = screen.getByRole("region", { name: "Version" });
    await within(section).findByText("You're up to date.");
    expect(versionsIn(section)).toEqual(["Current version", REMOTE_VERSION, "Latest version", REMOTE_VERSION]);
    expect(within(section).queryByRole("link")).toBeNull();
  });

  it("says in Settings when the latest version couldn't be found out", async () => {
    renderApp({ kind: "unknown" });
    fireEvent.click(screen.getByRole("button", { name: "General settings" }));

    const section = screen.getByRole("region", { name: "Version" });
    await within(section).findByText(/couldn't reach GitHub/);
    expect(versionsIn(section)).toEqual(["Current version", REMOTE_VERSION, "Latest version", "Unknown"]);
    expect(within(section).queryByRole("link")).toBeNull();
  });
});

describe("the Heating tab (FR-62, FR-67)", () => {
  const renderApp = (appliances: ReturnType<typeof fakeAppliancesApi>, storage = memoryStorage()) =>
    render(
      <App
        storage={storage}
        rooms={fakeRoomsApi()}
        appliances={appliances}
        hubAddress={fakeHubAddressApi()}
        mediaSources={fakeMediaSourcesApi()}
        signingCertificate={fakeSigningCertificateApi()}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        loadHubStatus={connected}
        loadLatestVersion={upToDate}
      />,
    );

  const tabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

  it("is after the Lights tab, and asks nothing of Hive until it is open", async () => {
    const appliances = fakeAppliancesApi([aHiveAppliance(1, "heating", "Downstairs")]);
    renderApp(appliances);

    expect(tabs()).toEqual(["TV", "Aircon", "Lights", "Heating", "Network", "Amazon", "Ring", "Rooms"]);
    expect(appliances.heatingReads()).toBe(0);
    expect(appliances.hiveReads()).toBe(0);

    fireEvent.click(screen.getByRole("tab", { name: "Heating" }));
    expect(screen.getByRole("heading", { name: "Heating", level: 1 })).toBeTruthy();
    await screen.findByRole("region", { name: "Whole home" });
    expect(appliances.heatingReads()).toBe(1);
  });

  it("is there before the Hub is signed in to Hive, saying how, and opens Settings on Heating", async () => {
    renderApp(fakeAppliancesApi([aTv(1, "TV", null)]));
    expect(tabs()).toEqual(["TV", "Aircon", "Lights", "Heating", "Network", "Amazon", "Ring", "Rooms"]);

    fireEvent.click(screen.getByRole("tab", { name: "Heating" }));
    const empty = await screen.findByRole("region", { name: "Not signed in to Hive" });
    fireEvent.click(within(empty).getByRole("button", { name: "Open Settings" }));

    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    expect(shownSettingsSection()).toBe("Heating");
    await screen.findByRole("form", { name: "Sign in to Hive" });
  });

  it("stays as Settings signs out of Hive", async () => {
    const appliances = fakeAppliancesApi([aHiveAppliance(1, "heating", "Downstairs")]);
    appliances.askHiveCode(false);
    renderApp(appliances);

    fireEvent.click(screen.getByRole("button", { name: "General settings" }));
    openSettingsSection("Heating");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of Hive" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, sign out" }));
    await screen.findByRole("form", { name: "Sign in to Hive" });

    expect(tabs()).toEqual(["TV", "Aircon", "Lights", "Heating", "Network", "Amazon", "Ring", "Rooms"]);
  });
});
