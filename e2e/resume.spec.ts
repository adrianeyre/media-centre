import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { mediaResumePositionPath, type MediaResumePosition } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-40: the run's real Hub records a Resume Position for each Media File
// from what the fake TV's fake Player reports as it plays, and choosing a
// Media File that has one offers "Resume from h:mm:ss" or "Start over". The
// fake Player plays every Media File in real time, as a minute long, so the
// last 5% of one is from 0:57.

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-resume-"));
  await makeTestMediaSource(dir);
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;
const CLIP = "Films/Sci-Fi/Clip.mp4";

const installApps = async (request: APIRequestContext, apps: readonly FakeApp[]): Promise<void> => {
  expect((await request.put(fakeTvUrl(LIVING.host, "/_fake/apps"), { data: apps })).ok()).toBe(true);
};

// The run's Hub is shared by every test, so each starts and ends with no TVs,
// Rooms or Media Sources, and so no Resume Positions, the Hub at the address
// it finds for itself, and the fake TV on, with its own apps installed and
// none running.
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

/** Adds Living room · TV, with the Player installed on it, and the test Media Source, and resolves with its id. */
const setUp = async (request: APIRequestContext): Promise<number> => {
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Living room" } })).json()) as {
    id: number;
  };
  const tv = await request.post("/api/appliances", { data: { kind: "tv", address: LIVING.host, name: "TV", roomId } });
  expect(tv.status()).toBe(201);
  const source = await request.post("/api/media-sources", { data: { name: "Media", path: dir } });
  expect(source.status()).toBe(201);
  expect((await request.put("/api/hub/address", { data: { override: "127.0.0.1" } })).ok()).toBe(true);
  await installApps(request, [...FAKE_APPS, FAKE_PLAYER_APP]);
  return ((await source.json()) as { id: number }).id;
};

const playerOn = async (request: APIRequestContext): Promise<FakePlayerStatus> =>
  (await (await request.get(fakeTvUrl(LIVING.host, "/_fake/player"))).json()) as FakePlayerStatus;

const resumePosition = async (request: APIRequestContext, sourceId: number): Promise<number | null> =>
  ((await (await request.get(mediaResumePositionPath(sourceId, CLIP))).json()) as MediaResumePosition).positionMs;

const watchAndListen = (page: Page): Locator => page.getByRole("region", { name: "Watch & Listen" });
const clipButton = (page: Page): Locator => watchAndListen(page).getByRole("button", { name: /^Clip\.mp4 ?, / });
const offer = (page: Page): Locator => page.getByRole("dialog", { name: "Play Clip.mp4" });
const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const control = (page: Page, name: string): Locator =>
  nowPlaying(page).getByRole("group", { name: "Playback" }).getByRole("button", { name, exact: true });
const seekBar = (page: Page): Locator => nowPlaying(page).getByRole("slider", { name: "Seek" });

/** Opens Films/Sci-Fi in Watch & Listen, from the TV tab. */
const openSciFi = async (page: Page): Promise<void> => {
  await page.goto("/");
  for (const name of ["Media", "Films", "Sci-Fi"]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
};

/** Plays Clip.mp4 from the start, then pauses it, seeks to `seconds` on the bar, and stops it there. */
const stopAt = async (page: Page, request: APIRequestContext, seconds: number): Promise<void> => {
  await clipButton(page).click();
  await expect(control(page, "Pause")).toBeVisible();
  await control(page, "Pause").click();
  await seekBar(page).fill(String(seconds));
  await expect.poll(async () => (await playerOn(request)).positionMs).toBe(seconds * 1_000);
  await control(page, "Stop").click();
  await expect(nowPlaying(page)).toHaveCount(0);
};

test("stopping halfway records the position, and choosing the Media File again offers Resume or Start over", async ({
  page,
  request,
}) => {
  const sourceId = await setUp(request);
  await openSciFi(page);
  await stopAt(page, request, 30);
  expect(await resumePosition(request, sourceId)).toBe(30_000);

  await clipButton(page).click();

  await expect(offer(page)).toBeVisible();
  await expect(offer(page)).toContainText("Playback last reached 0:30.");
  await expect(offer(page).getByRole("button", { name: "Resume from 0:30" })).toBeVisible();
  await expect(offer(page).getByRole("button", { name: "Start over" })).toBeVisible();
  expect((await playerOn(request)).received).toHaveLength(1);
});

test("Resume plays from the recorded position", async ({ page, request }) => {
  await setUp(request);
  await openSciFi(page);
  await stopAt(page, request, 30);

  await clipButton(page).click();
  await offer(page).getByRole("button", { name: "Resume from 0:30" }).click();

  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  expect((await playerOn(request)).received).toHaveLength(2);
  expect((await playerOn(request)).positionMs).toBeGreaterThanOrEqual(30_000);
  await expect.poll(async () => Number(await seekBar(page).inputValue())).toBeGreaterThanOrEqual(30);
});

test("Start over plays from the start, and the Resume Position follows it from there", async ({ page, request }) => {
  const sourceId = await setUp(request);
  await openSciFi(page);
  await stopAt(page, request, 30);

  await clipButton(page).click();
  await offer(page).getByRole("button", { name: "Start over" }).click();

  await expect.poll(async () => (await playerOn(request)).received).toHaveLength(2);
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  expect((await playerOn(request)).positionMs).toBeLessThan(10_000);
  await expect.poll(() => resumePosition(request, sourceId)).toBeLessThan(10_000);
});

test("closing the offer plays nothing", async ({ page, request }) => {
  await setUp(request);
  await openSciFi(page);
  await stopAt(page, request, 30);

  await clipButton(page).click();
  await offer(page).getByRole("button", { name: "Close, playing nothing" }).click();

  await expect(offer(page)).toHaveCount(0);
  expect((await playerOn(request)).received).toHaveLength(1);
  expect((await playerOn(request)).playback).toBe("idle");
});

test("playing past 95% clears the Resume Position, and the Media File plays from the start again", async ({
  page,
  request,
}) => {
  const sourceId = await setUp(request);
  await openSciFi(page);
  await stopAt(page, request, 30);
  await clipButton(page).click();
  await offer(page).getByRole("button", { name: "Resume from 0:30" }).click();
  await expect(control(page, "Pause")).toBeVisible();

  await seekBar(page).fill("58");

  await expect.poll(() => resumePosition(request, sourceId)).toBeNull();
  // The fake Player plays to the end of its minute, and the bar goes.
  await expect(nowPlaying(page)).toHaveCount(0, { timeout: 10_000 });
  await clipButton(page).click();
  await expect(watchAndListen(page).getByText("Sent to the Player on Living room · TV.")).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
  expect((await playerOn(request)).received).toHaveLength(3);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the offer meets WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await openSciFi(page);
    await stopAt(page, request, 30);
    await clipButton(page).click();
    await expect(offer(page)).toBeVisible();
    await page.waitForFunction("document.getAnimations().length === 0");

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include("dialog")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
