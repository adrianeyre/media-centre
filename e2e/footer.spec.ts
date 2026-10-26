import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

const footer = (page: Page) => page.getByRole("contentinfo");

const policy = (page: Page, title: string) => page.getByRole("dialog", { name: title });

test("the footer credits the design, gives the version, and offers each policy, in one slim line along the very bottom", async ({
  page,
}) => {
  await page.goto("/");

  await expect(footer(page).getByRole("listitem")).toHaveText([
    "Website design (source on GitHub, opens in a new tab)",
    /^Version: \d+\.\d+\.\d+$/,
    "Privacy Policy",
    "Terms and Conditions",
    "Cookie Policy",
    "Accessibility",
  ]);
  const link = footer(page).getByRole("link", { name: /^Website design/ });
  await expect(link).toHaveAttribute("href", /^https:\/\/github\.com\/adrianeyre\/media-centre$/);
  await expect(link).toHaveAttribute("target", "_blank");

  // Pinned to the bottom of the screen, under the tab bar, without scrolling, and staying there as the page scrolls.
  const viewport = page.viewportSize();
  const tabBar = page.getByRole("tablist", { name: "Remote" });
  const expectAtTheBottom = async (): Promise<void> => {
    const footerBox = await footer(page).boundingBox();
    const barBox = await tabBar.boundingBox();
    expect(Math.round((footerBox?.y ?? 0) + (footerBox?.height ?? 0))).toBe(viewport?.height);
    // One line: no taller than its 24px targets and a little room round them.
    expect(footerBox?.height ?? 0).toBeLessThanOrEqual(40);
    expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual((footerBox?.y ?? 0) + 1);
  };
  await expectAtTheBottom();
  await page.getByRole("button", { name: "General settings" }).click();
  await page.mouse.wheel(0, 4000);
  await expectAtTheBottom();
});

for (const title of ["Privacy Policy", "Terms and Conditions", "Cookie Policy", "Accessibility"]) {
  test(`the ${title} opens in a modal dialog, with its header and footer kept in view as its body scrolls`, async ({
    page,
  }) => {
    await page.goto("/");
    const opener = footer(page).getByRole("button", { name: title });
    await opener.click();

    const dialog = policy(page, title);
    await expect(dialog).toBeVisible();
    await expect(page.locator("dialog:modal")).toHaveAccessibleName(title);
    const close = dialog.getByRole("button", { name: `Close ${title}` });
    await expect(close).toBeFocused();

    // The × is in the top right corner.
    const dialogBox = await dialog.boundingBox();
    const closeBox = await close.boundingBox();
    expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) - ((closeBox?.x ?? 0) + (closeBox?.width ?? 0))).toBeLessThan(
      24,
    );
    expect((closeBox?.y ?? 0) - (dialogBox?.y ?? 0)).toBeLessThan(24);

    const body = dialog.getByRole("region", { name: title });
    const done = dialog.getByRole("button", { name: "Done" });
    // Once it has finished opening, so neither is still moving.
    await close.click({ trial: true });
    await done.click({ trial: true });
    const before = { close: await close.boundingBox(), done: await done.boundingBox() };
    const last = body.locator("p").last();
    await expect(last).not.toBeInViewport();
    await body.hover();
    await page.mouse.wheel(0, 5000);
    await expect(last).toBeInViewport();
    expect(await close.boundingBox()).toEqual(before.close);
    expect(await done.boundingBox()).toEqual(before.done);
    await expect(close).toBeInViewport();
    await expect(done).toBeInViewport();

    await done.click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

test("a policy closes with its ×, or with Escape, handing focus back to the footer", async ({ page }) => {
  await page.goto("/");
  const opener = footer(page).getByRole("button", { name: "Privacy Policy" });

  await opener.click();
  await policy(page, "Privacy Policy").getByRole("button", { name: "Close Privacy Policy" }).click();
  await expect(policy(page, "Privacy Policy")).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(policy(page, "Privacy Policy")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(policy(page, "Privacy Policy")).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the Cookie Policy's table, too wide for a phone, scrolls across on its own, and the page doesn't", async ({
  page,
}) => {
  await page.goto("/");
  await footer(page).getByRole("button", { name: "Cookie Policy" }).click();

  const dialog = policy(page, "Cookie Policy");
  const scroller = dialog.getByRole("region", { name: /local storage/ });
  const table = scroller.getByRole("table");
  const width = async (box: Promise<{ width: number } | null>): Promise<number> => (await box)?.width ?? 0;
  expect(await width(table.boundingBox())).toBeGreaterThan(await width(scroller.boundingBox()));
  // The dialog, and so the page, stays within the screen.
  expect(await width(dialog.boundingBox())).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);

  // From the keyboard too.
  const left = async (): Promise<number> => (await table.boundingBox())?.x ?? 0;
  const before = await left();
  await scroller.focus();
  for (let press = 0; press < 5; press += 1) await page.keyboard.press("ArrowRight");
  await expect.poll(left).toBeLessThan(before);
});

test("nothing behind an open policy can be reached with Tab", async ({ page }) => {
  await page.goto("/");
  await footer(page).getByRole("button", { name: "Accessibility" }).click();
  await expect(policy(page, "Accessibility")).toBeVisible();

  for (let tab = 0; tab < 12; tab += 1) {
    await page.keyboard.press("Tab");
    // Tab may leave for the browser's own toolbar, but never for the page behind.
    await expect(page.locator(":focus:not(dialog:modal, dialog:modal *)")).toHaveCount(0);
  }
});

test("the version opens the Changelog, the newest version first, or says none is released yet, with its header and footer kept in view", async ({
  page,
}) => {
  await page.goto("/");
  const opener = footer(page).getByRole("button", { name: /^Version: \d+\.\d+\.\d+, Changelog$/ });
  const version = ((await opener.textContent()) ?? "").replace("Version: ", "");
  await opener.click();

  const dialog = policy(page, "Changelog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveAccessibleName("Changelog");
  // CHANGELOG.md is empty until semantic-release makes the first release.
  if ((await readFile("CHANGELOG.md", "utf8")).trim() === "") {
    await expect(dialog).toContainText("No version has been released yet.");
  } else {
    await expect(dialog.getByRole("heading", { level: 3 }).first()).toHaveText(new RegExp(`^${version} `));
    await expect(dialog.getByRole("heading", { name: "Features", level: 4 }).first()).toBeVisible();
    const commit = dialog.getByRole("link").first();
    await expect(commit).toHaveAttribute("href", /^https:\/\/github\.com\/adrianeyre\/media-centre\//);
    await expect(commit).toHaveAttribute("target", "_blank");
  }

  const done = dialog.getByRole("button", { name: "Done" });
  await done.click({ trial: true });
  const before = await done.boundingBox();
  await dialog.getByRole("region", { name: "Changelog" }).hover();
  await page.mouse.wheel(0, 5000);
  expect(await done.boundingBox()).toEqual(before);

  await done.click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
