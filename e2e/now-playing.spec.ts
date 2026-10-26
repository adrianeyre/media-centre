import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-36, ADR 0003: while a Media File plays on the Selected TV, every TV
// screen of the Remote shows a now-playing bar, whose controls reach the
// fake TV's fake Player through the run's real Hub, and which follows what
// that Player reports back, on every Remote on the TV. The fake Player plays
// every Media File in real time, as a minute long.

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-now-playing-"));
  await makeTestMediaSource(dir);
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;

const installApps = async (request: APIRequestContext, apps: readonly FakeApp[]): Promise<void> => {
  expect((await request.put(fakeTvUrl(LIVING.host, "/_fake/apps"), { data: apps })).ok()).toBe(true);
};

// The run's Hub is shared by every test, so each starts and ends with no TVs,
// Rooms or Media Sources, the Hub at the address it finds for itself, and the
// fake TV on, with its own apps installed and none running.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms", "media-sources"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  expect((await request.put("/api/hub/address", { data: { override: null } })).ok()).toBe(true);
  for (const power of ["standby", "on"]) {
    expect((await request.post(fakeTvUrl(LIVING.host, "/_fake/power"), { data: { power } })).ok()).toBe(true);
  }
  await installApps(request, FAKE_APPS);
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** Adds Living room · TV, with the Player installed on it, and the test Media Source, with the Hub at its loopback address. */
const setUp = async (request: APIRequestContext): Promise<void> => {
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Living room" } })).json()) as {
    id: number;
  };
  const tv = await request.post("/api/appliances", { data: { kind: "tv", address: LIVING.host, name: "TV", roomId } });
  expect(tv.status()).toBe(201);
  expect((await request.post("/api/media-sources", { data: { name: "Media", path: dir } })).status()).toBe(201);
  expect((await request.put("/api/hub/address", { data: { override: "127.0.0.1" } })).ok()).toBe(true);
  await installApps(request, [...FAKE_APPS, FAKE_PLAYER_APP]);
};

const playerOn = async (request: APIRequestContext): Promise<FakePlayerStatus> =>
  (await (await request.get(fakeTvUrl(LIVING.host, "/_fake/player"))).json()) as FakePlayerStatus;

const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const control = (page: Page, name: string): Locator =>
  nowPlaying(page).getByRole("group", { name: "Playback" }).getByRole("button", { name, exact: true });
const seekBar = (page: Page): Locator => nowPlaying(page).getByRole("slider", { name: "Seek" });

/** Plays Clip.mp4 on Living room · TV from Watch & Listen, and waits for the bar to show it. */
const playClip = async (page: Page): Promise<void> => {
  await page.goto("/");
  const watchAndListen = page.getByRole("region", { name: "Watch & Listen" });
  for (const name of ["Media", "Films", "Sci-Fi"]) {
    await watchAndListen.locator(".media-folder", { hasText: new RegExp(`^${name}$`) }).click();
  }
  await watchAndListen.getByRole("button", { name: /^Clip\.mp4 ?, / }).click();
  await expect(nowPlaying(page)).toContainText("Clip.mp4");
};

test("the bar follows the Player's position and length as it plays", async ({ page, request }) => {
  await setUp(request);
  await expect(nowPlaying(page)).toHaveCount(0);

  await playClip(page);

  await expect(nowPlaying(page)).toContainText("1:00");
  await expect(control(page, "Pause")).toBeVisible();
  await expect.poll(async () => Number(await seekBar(page).inputValue())).toBeGreaterThan(0);
  await expect(seekBar(page)).toHaveAttribute("max", "60");
});

test("each control on the bar reaches the Player and changes its playback, and stop removes the bar", async ({
  page,
  request,
}) => {
  await setUp(request);
  await playClip(page);
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");

  await control(page, "Pause").click();
  await expect.poll(async () => (await playerOn(request)).playback).toBe("paused");
  await expect(control(page, "Play")).toBeVisible();

  await seekBar(page).fill("45");
  await expect.poll(async () => (await playerOn(request)).positionMs).toBe(45_000);
  await expect(seekBar(page)).toHaveValue("45");

  for (const [name, positionMs] of [
    ["Back 30 seconds", 15_000],
    ["Back 10 seconds", 5_000],
    ["Forward 30 seconds", 35_000],
    ["Forward 10 seconds", 45_000],
  ] as const) {
    await control(page, name).click();
    await expect.poll(async () => (await playerOn(request)).positionMs, name).toBe(positionMs);
    await expect(seekBar(page)).toHaveValue(String(positionMs / 1_000));
  }

  await control(page, "Play").click();
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  await expect(control(page, "Pause")).toBeVisible();

  await control(page, "Stop").click();
  await expect.poll(async () => (await playerOn(request)).playback).toBe("idle");
  await expect(nowPlaying(page)).toHaveCount(0);
});

test("two Remotes on the same TV see the same playback, whichever controls it", async ({ page, browser, request }) => {
  await setUp(request);
  await playClip(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto("/");
  await expect(nowPlaying(other)).toContainText("Clip.mp4");
  await expect(control(other, "Pause")).toBeVisible();

  await control(page, "Pause").click();
  await seekBar(page).fill("30");

  await expect(control(other, "Play")).toBeVisible();
  await expect(seekBar(other)).toHaveValue("30");

  await control(other, "Stop").click();
  await expect(nowPlaying(page)).toHaveCount(0);
  await expect(nowPlaying(other)).toHaveCount(0);
  await other.context().close();
});

test("the bar is in TV Menu mode too, and controls the Player there", async ({ page, request }) => {
  await setUp(request);
  await playClip(page);

  await page.getByRole("button", { name: "TV Menu mode" }).click();
  const menuMode = page.getByRole("dialog", { name: "TV Menu mode" });
  const bar = menuMode.getByRole("region", { name: "Now playing" });
  await expect(bar).toContainText("Clip.mp4");
  await bar.getByRole("button", { name: "Pause" }).click();

  await expect.poll(async () => (await playerOn(request)).playback).toBe("paused");
  await expect(bar.getByRole("button", { name: "Play" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the bar meets WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await playClip(page);
    await control(page, "Pause").click();
    await expect(control(page, "Play")).toBeVisible();
    await page.waitForFunction("document.getAnimations().length === 0");

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".now-playing")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
