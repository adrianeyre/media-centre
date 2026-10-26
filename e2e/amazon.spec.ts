import { expect, test } from "@playwright/test";

// ADR 0011: the Hub runs against the fake Amazon here (AMAZON_FAKE), whose two
// Echos answer as the Alexa app's API would, and whose sign-in completes as
// though the person had signed in on Amazon's page.
test("the Amazon tab signs in, shows each Echo as a widget, controls one, announces everywhere, and signs out", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Amazon" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Amazon" })).toBeVisible();

  const signIn = page.getByRole("region", { name: "Sign in to Amazon" });
  await signIn.getByRole("combobox", { name: "Amazon site" }).selectOption("amazon.co.uk");
  await signIn.getByRole("button", { name: "Sign in to Amazon" }).click();

  const kitchen = page.getByRole("article", { name: "Kitchen Echo Dot" });
  await expect(kitchen).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".widget").getByRole("article")).toHaveCount(2);
  try {
    await expect(kitchen.getByText("Bohemian Rhapsody")).toBeVisible();
    await expect(kitchen.getByText("Take the bins out", { exact: false })).toBeHidden(); // In its closed section.

    await kitchen.getByRole("button", { name: "Do Not Disturb" }).click();
    await expect(kitchen.getByRole("button", { name: "Do Not Disturb" })).toHaveAttribute("aria-pressed", "true");
    await kitchen.getByRole("button", { name: "Pause" }).click();
    await expect(kitchen.getByRole("button", { name: "Play" })).toBeVisible();

    await kitchen.getByText(/^Alarms, timers and reminders/).click();
    await expect(kitchen.getByText("Reminder: Take the bins out")).toBeVisible();

    const everywhere = page.getByRole("textbox", { name: "Announce to every Echo" });
    await everywhere.fill("Dinner is ready");
    await page.getByRole("button", { name: "Announce everywhere" }).click();
    await expect(everywhere).toHaveValue("");
  } finally {
    await page.getByRole("button", { name: "Sign out" }).click();
  }
  await expect(page.getByRole("region", { name: "Sign in to Amazon" })).toBeVisible();
});
