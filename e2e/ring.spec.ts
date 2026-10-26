import { expect, test } from "@playwright/test";

// ADR 0014: the Hub runs against the fake Ring here (RING_FAKE), whose
// doorbell, floodlight camera and chime answer as the Ring app's API would,
// and which asks for the two-step code 123456.
test("the Ring tab signs in with a code, shows each device as a widget, controls them, and signs out", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Ring" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ring" })).toBeVisible();

  const signIn = page.getByRole("region", { name: "Sign in to Ring" });
  await signIn.getByLabel("Email address").fill("owner@example.com");
  await signIn.getByLabel("Password").fill("fake-password");
  await signIn.getByRole("button", { name: "Sign in to Ring" }).click();

  const code = page.getByRole("region", { name: "Enter Ring's code" });
  await code.getByLabel("Code").fill("123456");
  await code.getByRole("button", { name: "Sign in" }).click();

  const door = page.getByRole("article", { name: "Front Door" });
  await expect(door).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".widget").getByRole("article")).toHaveCount(3);
  try {
    await expect(door.getByText("Battery 82%")).toBeVisible();
    // The Hub's snapshot of the fake camera, a JPEG the browser shows.
    await expect(door.getByRole("img", { name: "The latest snapshot from Front Door" })).toHaveJSProperty(
      "naturalWidth",
      1,
    );

    const garden = page.getByRole("article", { name: "Garden" });
    await garden.getByRole("button", { name: "Light" }).click();
    await expect(garden.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");

    await door.getByText(/^Recent events/).click();
    await expect(door.getByText("Doorbell pressed", { exact: true })).toBeVisible();

    const chime = page.getByRole("article", { name: "Hallway Chime" });
    await chime.getByRole("button", { name: "Play the doorbell sound" }).click();
    await expect(chime.getByRole("button", { name: "Play the doorbell sound" })).toBeEnabled();
  } finally {
    await page.getByRole("button", { name: "Sign out" }).click();
  }
  await expect(page.getByRole("region", { name: "Sign in to Ring" })).toBeVisible();
});
