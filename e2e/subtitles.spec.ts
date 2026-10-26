import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FILM_SUBTITLES, makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-36, FR-44, FR-45: the run's real Hub offers a Media File's own text
// subtitle tracks and the sidecar files beside it, `Film.en.srt` and
// `Film.fr.ass` beside `Film.mkv`, in the now-playing bar, by language; and
// the fake TV's fake Player shows the one chosen, read from the Hub, which
// converts the ASS it can't render to SubRip first, and none for "Off".

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-subtitles-"));
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
const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const seekBar = (page: Page): Locator => nowPlaying(page).getByRole("slider", { name: "Seek" });
const subtitles = (page: Page): Locator => nowPlaying(page).getByRole("combobox", { name: "Subtitles" });

/**
 * Plays `Films/Film.mkv`, a minute of H.264 and AAC, which a TV plays as they
 * are, with SubRip in English and ASS in German of its own, from Watch &
 * Listen, seeks 20 seconds in, and waits for the fake Player to be playing there. */
const playFilm = async (page: Page, request: APIRequestContext): Promise<void> => {
  await page.goto("/");
  for (const name of ["Media", "Films"]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
  const films = watchAndListen(page).getByRole("list", { name: "In Films" });
  // Its sidecar files are no Media Files, so aren't listed.
  await expect(films.getByRole("listitem", { name: "Film.mkv" })).toBeVisible();
  await expect(films.getByText(/\.(srt|ass)$/)).toHaveCount(0);
  await films.getByRole("button", { name: /^Film\.mkv ?, / }).click();
  await expect(watchAndListen(page).getByText("Sent to the Player on Living room · TV.")).toBeVisible();
  await expect(nowPlaying(page)).toContainText("Film.mkv");
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  await seekBar(page).fill("20");
  await expect.poll(async () => (await playerOn(request)).positionMs).toBeGreaterThanOrEqual(20_000);
};

/** Chooses the subtitle track with this label on the bar, and checks the fake Player shows it, playing on. */
const choose = async (
  page: Page,
  request: APIRequestContext,
  label: string,
  shown: { readonly track: number | null; readonly text: string | null },
): Promise<void> => {
  await subtitles(page).selectOption({ label });

  await expect.poll(async () => (await playerOn(request)).subtitleTrack).toBe(shown.track);
  const player = await playerOn(request);
  expect(player.subtitle).toBe(shown.text);
  expect(player.playback).toBe("playing");
  await expect(subtitles(page).locator("option:checked")).toHaveText(label);
};

test("Film.en.srt and Film.fr.ass beside Film.mkv are offered as English and French, after its own tracks by language", async ({
  page,
  request,
}) => {
  await setUp(request);

  await playFilm(page, request);

  await expect(subtitles(page).locator("option")).toHaveText([
    "Off",
    "English · SRT",
    "German · Signs · ASS",
    "English · SRT file",
    "French · ASS file",
  ]);
  await expect(subtitles(page).locator("option:checked")).toHaveText("Off");
  expect(await playerOn(request)).toMatchObject({ subtitleTrack: null, subtitle: null });
});

test("choosing a subtitle track shows it through the fake Player, the ASS converted for it, and Off hides it", async ({
  page,
  request,
}) => {
  await setUp(request);
  await playFilm(page, request);

  // The fake Player renders only SubRip and WebVTT, as the Player does, so
  // shows an ASS only once the Hub has converted it.
  await choose(page, request, "French · ASS file", { track: 3, text: FILM_SUBTITLES[3] });
  await choose(page, request, "English · SRT file", { track: 2, text: FILM_SUBTITLES[2] });
  await choose(page, request, "German · Signs · ASS", { track: 1, text: FILM_SUBTITLES[1] });
  await choose(page, request, "English · SRT", { track: 0, text: FILM_SUBTITLES[0] });
  await choose(page, request, "Off", { track: null, text: null });

  // Shown over what it was sent, not by sending it again.
  expect((await playerOn(request)).received).toHaveLength(1);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the bar's subtitle tracks meet WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await playFilm(page, request);
    await expect(subtitles(page)).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".now-playing")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
