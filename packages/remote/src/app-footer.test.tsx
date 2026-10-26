import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REMOTE_VERSION, REPOSITORY_URL } from "./about.ts";
import { AppFooter, POLICIES } from "./app-footer.tsx";
import { ChangelogNotes } from "./changelog-notes.tsx";
import { APPEARANCE_KEY } from "./appearance.ts";
import { BLUETOOTH_SCAN_CACHE_KEY, NETWORK_SCAN_CACHE_KEY, NETWORK_VIEW_KEY } from "./network-tab.tsx";
import { ROOMS_TAB_ROOM_KEY } from "./rooms-tab.tsx";
import { SELECTED_TV_KEY } from "./selected-tv.ts";
import { LAST_SETTINGS_SECTION_KEY } from "./settings-sections.ts";
import { LAST_TAB_KEY } from "./tabs.ts";
import {
  AIRCON_WIDGET_LAYOUT_KEY,
  AMAZON_WIDGET_LAYOUT_KEY,
  BLUETOOTH_WIDGET_LAYOUT_KEY,
  HEATING_WIDGET_LAYOUT_KEY,
  LIGHTS_WIDGET_LAYOUT_KEY,
  NETWORK_WIDGET_LAYOUT_KEY,
  RING_WIDGET_LAYOUT_KEY,
  TV_WIDGET_LAYOUT_KEY,
  roomWidgetLayoutKey,
} from "./widget-layout.ts";

// The footer's Changelog shows what semantic-release writes, which CHANGELOG.md
// has only once a version is released: so here, one as it writes it.
vi.mock("./changelog.ts", async (importOriginal) => {
  const { REMOTE_VERSION: version, REPOSITORY_URL: repository } = await import("./about.ts");
  return {
    ...(await importOriginal<typeof import("./changelog.ts")>()),
    CHANGELOG: [
      `# [${version}](${repository}/compare/v0.0.0...v${version}) (2026-10-27)`,
      "",
      "### Features",
      "",
      `* **remote:** a feature ([abc1234](${repository}/commit/abc1234))`,
      "",
    ].join("\n"),
  };
});

afterEach(cleanup);

const footer = () => screen.getByRole("navigation", { name: "About Media Centre" });

describe("the footer", () => {
  it("credits the website's design, gives the version, and offers each policy, in that order", () => {
    render(<AppFooter />);

    expect(
      within(footer())
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Website design (source on GitHub, opens in a new tab)",
      `Version: ${REMOTE_VERSION}`,
      "Privacy Policy",
      "Terms and Conditions",
      "Cookie Policy",
      "Accessibility",
    ]);
    expect(REMOTE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("links to the source in a new tab, and says so", () => {
    render(<AppFooter />);

    const link = within(footer()).getByRole("link", { name: /^Website design/ });
    expect(link.getAttribute("href")).toBe(REPOSITORY_URL);
    expect(REPOSITORY_URL).not.toMatch(/\.git$/);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens the Changelog from the version, newest version first, linking to GitHub in a new tab", () => {
    render(<AppFooter />);

    fireEvent.click(within(footer()).getByRole("button", { name: `Version: ${REMOTE_VERSION}, Changelog` }));

    const dialog = screen.getByRole("dialog", { name: "Changelog" });
    const [newest] = within(dialog).getAllByRole("heading", { level: 3 });
    expect(newest?.textContent.startsWith(`${REMOTE_VERSION} `)).toBe(true);
    expect(within(dialog).getAllByRole("heading", { level: 4 }).length).toBeGreaterThan(0);
    const [link] = within(dialog).getAllByRole("link");
    expect(link?.getAttribute("href")?.startsWith(`${REPOSITORY_URL}/`)).toBe(true);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Changelog" })).toBeNull();
  });

  it("says so in the Changelog when no version has been released yet", () => {
    render(<ChangelogNotes markdown="" />);

    expect(screen.getByText(/^No version has been released yet\./)).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it.each(POLICIES.map(({ title }) => title))("opens the %s in a dialog, closed again with Done", (title) => {
    render(<AppFooter />);

    fireEvent.click(within(footer()).getByRole("button", { name: title }));

    const dialog = screen.getByRole("dialog", { name: title });
    expect(within(dialog).getByRole("heading", { level: 2, name: title })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: `Close ${title}` })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: title })).toBeNull();
  });

  it("lists everything the Remote stores in the Cookie Policy, in a table that scrolls across on its own", () => {
    render(<AppFooter />);
    fireEvent.click(within(footer()).getByRole("button", { name: "Cookie Policy" }));

    const table = screen.getByRole("table");
    const scroller = screen.getByRole("region", { name: /local storage/ });
    expect(scroller.contains(table)).toBe(true);
    expect(scroller.tabIndex).toBe(0);
    expect([...table.querySelectorAll("tbody code")].map((name) => name.textContent)).toEqual([
      LAST_TAB_KEY,
      SELECTED_TV_KEY,
      APPEARANCE_KEY,
      LAST_SETTINGS_SECTION_KEY,
      ROOMS_TAB_ROOM_KEY,
      NETWORK_VIEW_KEY,
      TV_WIDGET_LAYOUT_KEY,
      AIRCON_WIDGET_LAYOUT_KEY,
      LIGHTS_WIDGET_LAYOUT_KEY,
      HEATING_WIDGET_LAYOUT_KEY,
      NETWORK_WIDGET_LAYOUT_KEY,
      BLUETOOTH_WIDGET_LAYOUT_KEY,
      AMAZON_WIDGET_LAYOUT_KEY,
      RING_WIDGET_LAYOUT_KEY,
      roomWidgetLayoutKey("…"),
      NETWORK_SCAN_CACHE_KEY,
      BLUETOOTH_SCAN_CACHE_KEY,
    ]);
  });
});
