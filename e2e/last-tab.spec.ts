import { expect, test, type Page } from "@playwright/test";

const selectedTab = (page: Page) => page.getByRole("tab", { selected: true });

// FR-6: the Remote reopens on the last tab used. Each test has a fresh browser
// context, so it starts as a Remote that has never been opened.
test("the Remote reopens on the last tab used", async ({ context }) => {
  const first = await context.newPage();
  await first.goto("/");
  await expect(selectedTab(first)).toHaveText("TV");

  await first.getByRole("button", { name: "General settings" }).click();
  await expect(first.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await first.close();

  // Opened again, e.g. from its home-screen icon.
  const second = await context.newPage();
  await second.goto("/");
  // Settings, which the cog opens, is no tab, so no tab is selected.
  await expect(selectedTab(second)).toHaveCount(0);
  await expect(second.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await second.getByRole("tab", { name: "TV" }).click();
  await second.reload();
  await expect(selectedTab(second)).toHaveText("TV");
  await expect(second.getByRole("heading", { name: "No TVs yet" })).toBeVisible();
});
