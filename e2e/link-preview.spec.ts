import { expect, test } from "@playwright/test";

// A link to the Remote, shared, shows its name, description and picture, with
// absolute URLs on the Hub's own address, which only the Hub knows.
test("the Remote's page names itself and has an absolute preview image on the Hub's address", async ({
  page,
  baseURL,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Media Centre");
  const meta = (selector: string) => page.locator(selector).getAttribute("content");
  expect(await meta('meta[name="description"]')).toMatch(/TV/);
  expect(await meta('meta[property="og:title"]')).toBe("Media Centre: one remote for your whole home");
  expect(await meta('meta[property="og:description"]')).toMatch(/TV/);
  expect(await meta('meta[property="og:image"]')).toBe(`${String(baseURL)}/og-image.png`);
  expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image");
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(`${String(baseURL)}/`);
});

test("the Hub serves the preview image, every icon and the web manifest", async ({ request }) => {
  for (const [path, type] of [
    ["/og-image.png", "image/png"],
    ["/favicon.ico", "image/x-icon"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon-16.png", "image/png"],
    ["/favicon-32.png", "image/png"],
    ["/apple-touch-icon.png", "image/png"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
    ["/icon-maskable-192.png", "image/png"],
    ["/icon-maskable-512.png", "image/png"],
    ["/mask-icon.svg", "image/svg+xml"],
    ["/mstile-150x150.png", "image/png"],
    ["/startup/apple-splash-1170x2532.png", "image/png"],
    ["/startup/apple-splash-1170x2532-dark.png", "image/png"],
    ["/screenshots/wide-tv.png", "image/png"],
    ["/screenshots/narrow-tv.png", "image/png"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/robots.txt", "text/plain; charset=utf-8"],
  ] as const) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toBe(type);
  }

  const manifest = (await (await request.get("/site.webmanifest")).json()) as {
    name: string;
    icons: { src: string }[];
    screenshots: { src: string }[];
  };
  expect(manifest.name).toBe("Media Centre");
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  // Every image the manifest names is there, so an install sheet never shows a broken one.
  for (const { src } of [...manifest.icons, ...manifest.screenshots]) {
    expect((await request.get(src)).status(), src).toBe(200);
  }
});
