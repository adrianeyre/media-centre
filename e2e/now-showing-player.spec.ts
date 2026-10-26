import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-27: with the Player in front, Now Showing adds the Media File it plays,
// its position, duration and the tracks in use, and, for video, a preview
// picture the run's real Hub extracts from the file itself with ffmpeg,
// which moves every 5 seconds as the fake TV's fake Player plays, holds
// still while it is paused, and follows a seek.

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-now-showing-player-"));
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

const card = (page: Page): Locator => page.getByRole("region", { name: "Now Showing" });
const preview = (page: Page): Locator => card(page).locator("img.now-showing-preview");
const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const control = (page: Page, name: string): Locator =>
  nowPlaying(page).getByRole("group", { name: "Playback" }).getByRole("button", { name, exact: true });

/** Where the preview picture shown is from, in milliseconds, as its address says. */
const previewAt = async (page: Page): Promise<number> =>
  Number(new URL((await preview(page).getAttribute("src")) ?? "", "http://hub").searchParams.get("at"));

/** Whether the preview picture shown has loaded, from the Hub, as a picture with a size: as wide as the film, 64 pixels. */
const previewLoaded = async (page: Page): Promise<boolean> =>
  (await preview(page).getAttribute("src")) !== null &&
  (await preview(page).evaluate((img) => (img as { readonly naturalWidth: number }).naturalWidth)) === 64;

/** The preview picture the Hub serves now, as bytes. */
const previewBytes = async (page: Page, request: APIRequestContext): Promise<Buffer> => {
  const response = await request.get((await preview(page).getAttribute("src")) ?? "");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/jpeg");
  return response.body();
};

/** Plays the film with subtitles on Living room · TV from Watch & Listen, and waits for the card to show it. */
const playFilm = async (page: Page): Promise<void> => {
  await page.goto("/");
  const watchAndListen = page.getByRole("region", { name: "Watch & Listen" });
  for (const name of ["Media", "Films"]) {
    await watchAndListen.locator(".media-folder", { hasText: new RegExp(`^${name}$`) }).click();
  }
  await watchAndListen.getByRole("button", { name: /^Film\.mkv ?, / }).click();
  await expect(card(page).locator(".now-showing-media-file")).toHaveText("Film.mkv", { timeout: 10_000 });
};

test("Now Showing names the Player, and the Media File it plays, with its position, duration and tracks in use", async ({
  page,
  request,
}) => {
  await setUp(request);

  await playFilm(page);

  await expect(card(page).getByRole("status")).toHaveText("Media Centre");
  await expect(card(page).locator(".now-showing-position")).toHaveText(/^Playing · 0:0[0-9] of 1:00$/);
  await expect(card(page).locator(".now-showing-position")).not.toHaveText("Playing · 0:00 of 1:00");
  const tracks = card(page).locator(".now-showing-tracks");
  await expect(tracks).toContainText("AudioTrack 1 · AAC mono");
  await expect(tracks).toContainText("SubtitlesOff");

  await nowPlaying(page).getByRole("combobox", { name: "Subtitles" }).selectOption({ label: "English · SRT file" });

  await expect(tracks).toContainText("SubtitlesEnglish · SRT file");
  await expect.poll(async () => (await playerOn(request)).subtitleTrack).toBe(2);
});

test("the preview picture is the file's at its position, moves every 5 seconds as it plays, holds still paused, and follows a seek", async ({
  page,
  request,
}) => {
  test.slow();
  await setUp(request);
  await playFilm(page);
  await expect.poll(() => previewLoaded(page)).toBe(true);
  const first = await previewAt(page);
  const firstBytes = await previewBytes(page, request);
  expect(first).toBeLessThan(5_000);

  // It moves on 5 seconds later, to where the Player is then, and not before.
  await expect.poll(() => previewAt(page), { timeout: 10_000 }).not.toBe(first);
  const next = await previewAt(page);
  expect(next - first).toBeGreaterThanOrEqual(5_000);
  expect(next - first).toBeLessThan(7_000);
  await expect.poll(() => previewLoaded(page)).toBe(true);
  expect((await previewBytes(page, request)).equals(firstBytes)).toBe(false);

  await control(page, "Pause").click();
  await expect.poll(async () => (await playerOn(request)).playback).toBe("paused");
  await expect(card(page).locator(".now-showing-position")).toHaveText(/^Paused · /);
  const paused = await previewAt(page);
  const pausedBytes = await previewBytes(page, request);

  // Longer than it would take to move twice while playing.
  await page.waitForTimeout(11_000);
  expect(await previewAt(page)).toBe(paused);
  expect((await previewBytes(page, request)).equals(pausedBytes)).toBe(true);

  await nowPlaying(page).getByRole("slider", { name: "Seek" }).fill("45");

  await expect.poll(() => previewAt(page)).toBe(45_000);
  await expect.poll(() => previewLoaded(page)).toBe(true);
  expect((await previewBytes(page, request)).equals(pausedBytes)).toBe(false);
  await expect(card(page).locator(".now-showing-position")).toHaveText("Paused · 0:45 of 1:00");
});

test("an audio Media File has no preview picture, and once stopped the card says the Player is waiting", async ({
  page,
  request,
}) => {
  await setUp(request);
  await page.goto("/");
  const watchAndListen = page.getByRole("region", { name: "Watch & Listen" });
  for (const name of ["Media", "Music", "Album"]) {
    await watchAndListen.locator(".media-folder", { hasText: new RegExp(`^${name}$`) }).click();
  }
  await watchAndListen.getByRole("button", { name: /^01 Tone\.flac ?, / }).click();

  await expect(card(page).locator(".now-showing-media-file")).toHaveText("01 Tone.flac", { timeout: 10_000 });
  await expect(card(page).locator(".now-showing-position")).toHaveText(/^Playing · /);
  await expect(preview(page)).toHaveCount(0);

  await control(page, "Stop").click();

  await expect(card(page).locator(".now-showing-player")).toHaveText("The Player is waiting for a Media File.");
  await expect(card(page).getByRole("status")).toHaveText("Media Centre");
});
