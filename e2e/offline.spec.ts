import { expect, test } from "@playwright/test";
import { openSettingsOn } from "./settings.ts";

// NFR-3: the Remote works with the internet disconnected, so every asset it
// loads must come from the Hub that served it. Anything else is refused here,
// so a stray font or script would both fail this test and break the page.
test("everything the Remote loads is served by the Hub", async ({ page, baseURL }) => {
  const hub = new URL(baseURL ?? "").origin;
  const elsewhere: string[] = [];
  await page.context().route(
    (url) => url.origin !== hub,
    async (route) => {
      elsewhere.push(route.request().url());
      await route.abort("internetdisconnected");
    },
  );
  const requested: string[] = [];
  page.on("request", (request) => {
    requested.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No TVs yet" })).toBeVisible();
  await openSettingsOn(page, "General");
  await expect(page.getByRole("status")).toHaveText("Connected to the Hub");
  await page.waitForLoadState("networkidle");

  expect(elsewhere).toEqual([]);
  expect(requested.length).toBeGreaterThan(2);
  expect(requested.filter((url) => new URL(url).origin !== hub)).toEqual([]);
  // The page itself, its script and its styles at least.
  expect(requested.some((url) => url.endsWith(".js"))).toBe(true);
  expect(requested.some((url) => url.endsWith(".css"))).toBe(true);
});
