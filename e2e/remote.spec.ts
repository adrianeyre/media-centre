import { expect, test } from "@playwright/test";
import { openSettingsOn } from "./settings.ts";

test("the Remote, served by the Hub, opens on the TV tab, which explains how to add a TV", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Media Centre");
  await expect(page.getByRole("tab", { name: "TV" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "TV", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "No TVs yet" })).toContainText(
    "Add a TV in Settings: tap Find TVs to look for the Samsung TVs on your home network, or add one by its IP address.",
  );
});

test("the Remote has the TV tab, the Aircon tab, the Lights tab, the Heating tab, Rooms and Settings", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("tab")).toHaveText(["TV", "Aircon", "Lights", "Heating", "Rooms", "Settings"]);
});

test("Settings says the Remote is connected to the Hub, on General, which the cog opens", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "General settings" }).click();

  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Connected to the Hub");
  await expect(page.getByText(/^Version \d+\.\d+\.\d+$/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// From a tablet's width Settings' menu is a side menu, beside the tabs' rail on
// a wide screen: every part is in sight, clear of the rail and the footer, and
// opens on a click that nothing else takes.
for (const [size, viewport] of [
  ["tablet", { width: 820, height: 1180 }],
  ["desktop", { width: 1440, height: 900 }],
] as const) {
  test(`on a ${size}, Settings' menu shows every part, clear of the tabs and the footer`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("banner").getByRole("button", { name: "General settings" }).click();

    const menu = page.getByRole("navigation", { name: "Settings" });
    const tabs = await page.getByRole("tablist", { name: "Remote" }).boundingBox();
    const footer = await page.getByRole("contentinfo").boundingBox();
    const items = menu.getByRole("button");
    expect(await items.count()).toBeGreaterThan(1);
    for (const item of await items.all()) {
      await expect(item).toBeInViewport({ ratio: 1 });
      const box = await item.boundingBox();
      if (size === "desktop") expect(box?.x ?? 0).toBeGreaterThanOrEqual((tabs?.x ?? 0) + (tabs?.width ?? 0));
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(footer?.y ?? 0);
      await item.click();
      await expect(item).toHaveAttribute("aria-current", "page");
    }
  });
}

// The Hub under test is told not to ask GitHub (HUB_LATEST_VERSION_URL is
// empty), so it can't say which version is the latest, and offers no update.
test("Settings gives this Remote's version, and the latest as unknown when the Hub can't find it out", async ({
  page,
}) => {
  await page.goto("/");
  await openSettingsOn(page, "General");

  const version = page.getByRole("region", { name: "Version" });
  await expect(version.locator("dt")).toHaveText(["Current version", "Latest version"]);
  await expect(version.locator("dd")).toHaveText([/^\d+\.\d+\.\d+$/, "Unknown"]);
  await expect(version.getByText(/couldn't reach GitHub/)).toBeVisible();
  await expect(version.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Update available" })).toHaveCount(0);
});

test("the Remote offers the latest version as it opens, when the Hub finds it isn't this one", async ({ page }) => {
  await page.route("**/api/latest-version", (route) => route.fulfill({ json: { version: "99.0.0" } }));
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Update available" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveAccessibleName("Update available");
  await expect(dialog.locator("dd")).toHaveText([/^\d+\.\d+\.\d+$/, "99.0.0"]);
  const release = dialog.getByRole("link", { name: /^Go to the release/ });
  await expect(release).toHaveAttribute("href", "https://github.com/adrianeyre/media-centre/releases/latest");
  await expect(release).toHaveAttribute("target", "_blank");

  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();
  await openSettingsOn(page, "General");
  const version = page.getByRole("region", { name: "Version" });
  await expect(version.locator("dd")).toHaveText([/^\d+\.\d+\.\d+$/, "99.0.0"]);
  await expect(version.getByRole("link", { name: /^Update to 99\.0\.0/ })).toHaveAttribute(
    "href",
    "https://github.com/adrianeyre/media-centre/releases/latest",
  );
});

test("the Remote says so when the Hub stops answering", async ({ page }) => {
  await page.route("**/api/hub", (route) => route.abort());
  await page.goto("/");

  await expect(page.getByRole("alert")).toHaveText("Can't reach the Hub");
  await openSettingsOn(page, "General");
  await expect(page.getByRole("status")).toHaveText("Can't reach the Hub");
});
