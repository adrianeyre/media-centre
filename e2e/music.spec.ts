import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { ALBUM_TAGS, COVER_ART_SIZE, makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { STREAMS_PATH } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-27, FR-46, FR-47: audio Media Files are browsed as videos are, and take
// a Route the same way, through the run's real Hub, which sends each to the
// fake TV's fake Player with what its now-playing screen shows: the title,
// artist and album from its tags, or its file name, and its cover art, which
// the fake Player reads from the Hub, as the Player does. Now Showing shows
// the same cover art, or a placeholder for a file with none.

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-music-"));
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

const watchAndListen = (page: Page): Locator => page.getByRole("region", { name: "Watch & Listen" });
const album = (page: Page): Locator => watchAndListen(page).getByRole("list", { name: "In Album" });
const card = (page: Page): Locator => page.getByRole("region", { name: "Now Showing" });

/** Opens the album of the test Media Source in Watch & Listen. */
const openAlbum = async (page: Page): Promise<void> => {
  await page.goto("/");
  for (const name of ["Media", "Music", "Album"]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
  await expect(album(page)).toBeVisible();
};

/** Plays one of the album's Media Files from Watch & Listen, and waits for Now Showing to name it. */
const playFromAlbum = async (page: Page, name: string): Promise<void> => {
  await album(page)
    .getByRole("button", { name: new RegExp(`^${name.replace(/\./g, "\\.")} ?, `) })
    .click();
  await expect(card(page).locator(".now-showing-media-file")).toHaveText(name, { timeout: 10_000 });
};

test("Watch & Listen shows each audio Media File's Route, and a FLAC with tags and cover art plays with them", async ({
  page,
  request,
}) => {
  await setUp(request);
  await openAlbum(page);
  const route = (name: string): Locator => album(page).getByRole("listitem", { name }).locator(".media-file-route");
  await expect(route("01 Tone.flac")).toHaveText("Direct Play");
  await expect(route("02 Tone.mp3")).toHaveText("Direct Play");
  await expect(route("03 Tone.m4a")).toHaveText("Audio Conversion");

  await playFromAlbum(page, "01 Tone.flac");

  // What the Player's now-playing screen shows, its cover art read from the Hub.
  await expect
    .poll(async () => (await playerOn(request)).music)
    .toMatchObject({ ...ALBUM_TAGS[0], coverArtRead: { status: 200 } });
  // Now Showing shows the same cover art, a picture from the file, as large as it is.
  const coverArt = card(page).getByRole("img", { name: "Cover art of Test Tones" });
  await expect(coverArt).toBeVisible();
  await expect
    .poll(() => coverArt.evaluate((img) => (img as { readonly naturalWidth: number }).naturalWidth))
    .toBe(COVER_ART_SIZE);
  await expect(card(page).locator("img.now-showing-preview")).toHaveCount(0);
  const served = await request.get((await coverArt.getAttribute("src")) ?? "");
  expect(served.headers()["content-type"]).toBe("image/jpeg");
});

test("an untagged MP3 is named by its file name, with a placeholder for its cover art", async ({ page, request }) => {
  await setUp(request);
  await openAlbum(page);

  await playFromAlbum(page, "02 Tone.mp3");

  await expect
    .poll(async () => (await playerOn(request)).music)
    .toEqual({ title: "02 Tone.mp3", artist: null, album: null, coverArt: null, coverArtRead: null });
  await expect(card(page).getByRole("img", { name: "No cover art" })).toBeVisible();
  await expect(card(page).locator("img.now-showing-cover-art")).toHaveCount(0);
});

test("an ALAC M4A, which the TV can't decode, plays by Audio Conversion as HLS, with its tags", async ({
  page,
  request,
}) => {
  await setUp(request);
  await openAlbum(page);

  await playFromAlbum(page, "03 Tone.m4a");

  await expect.poll(async () => (await playerOn(request)).segments.length).toBeGreaterThan(0);
  const status = await playerOn(request);
  const [url = ""] = status.received;
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
  expect(status.segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });
  expect(status.playback).toBe("playing");
  expect(status.music).toEqual({ ...ALBUM_TAGS[2], coverArt: null, coverArtRead: null });
  await expect(card(page).getByRole("img", { name: "No cover art" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`Now Showing with cover art meets WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await openAlbum(page);
    await playFromAlbum(page, "01 Tone.flac");
    await expect(card(page).getByRole("img", { name: "Cover art of Test Tones" })).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".tv-now-showing")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
