import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { ALBUM_TAGS, makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { STREAMS_PATH } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-46, FR-48: "Play folder" in Watch & Listen plays the album's audio
// Media Files, in file-name order, as a Queue on the fake TV's fake Player,
// through the run's real Hub, which holds the Queue and sends the Player the
// next Media File itself as each ends. The now-playing bar shows the Queue,
// the current Media File marked, with previous, next, shuffle and repeat, on
// every Remote on the TV. The fake Player plays every Media File in real
// time, as a minute long, so each test seeks near the end for it to end.

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-queue-"));
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
const queueControl = (page: Page, name: string): Locator =>
  nowPlaying(page).getByRole("group", { name: "Queue" }).getByRole("button", { name, exact: true });
const queueList = (page: Page): Locator => nowPlaying(page).getByRole("list", { name: /^Queue/ });
const current = (page: Page): Locator => queueList(page).locator('li[aria-current="true"]');

/** Opens the album of the test Media Source in Watch & Listen, and plays it as a Queue. */
const playAlbum = async (page: Page): Promise<void> => {
  await page.goto("/");
  const watchAndListen = page.getByRole("region", { name: "Watch & Listen" });
  for (const name of ["Media", "Music", "Album"]) {
    await watchAndListen.locator(".media-folder", { hasText: new RegExp(`^${name}$`) }).click();
  }
  await watchAndListen.getByRole("button", { name: "Play folder" }).click();
  await expect(watchAndListen.getByRole("region", { name: "Play Album on Living room · TV" })).toContainText(
    "Sent to the Player on Living room · TV.",
  );
  await expect(current(page)).toHaveText("01 Tone.flac (playing)", { timeout: 10_000 });
};

/** Seeks to the last second of what plays, from the bar's seek bar, so that it ends in a moment. */
const nearTheEnd = async (page: Page): Promise<void> => {
  await nowPlaying(page).getByRole("slider", { name: "Seek" }).fill("59");
};

test("Play folder plays a FLAC album as a Queue, with cover art, each next Media File by itself, then ends", async ({
  page,
  request,
}) => {
  await setUp(request);

  await playAlbum(page);

  await expect(queueList(page).getByRole("listitem")).toHaveText([
    "01 Tone.flac (playing)",
    "02 Tone.mp3",
    "03 Tone.m4a",
  ]);
  await expect(nowPlaying(page).getByRole("heading", { name: "Queue 1 of 3" })).toBeVisible();
  // The Player's now-playing screen shows the FLAC's cover art, read from the Hub.
  await expect
    .poll(async () => (await playerOn(request)).music)
    .toMatchObject({ ...ALBUM_TAGS[0], coverArtRead: { status: 200 } });

  await nearTheEnd(page);
  await expect(current(page)).toHaveText("02 Tone.mp3 (playing)", { timeout: 10_000 });
  await expect(nowPlaying(page).locator(".now-playing-name")).toHaveText("02 Tone.mp3");
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");

  await nearTheEnd(page);
  await expect(current(page)).toHaveText("03 Tone.m4a (playing)", { timeout: 10_000 });
  // The ALAC by Audio Conversion, as it would be on its own.
  const { received } = await playerOn(request);
  expect(received).toHaveLength(3);
  expect(received[2]).toMatch(new RegExp(`${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));

  await nearTheEnd(page);
  await expect.poll(async () => (await playerOn(request)).playback, { timeout: 10_000 }).toBe("idle");
  await expect(nowPlaying(page)).toHaveCount(0);
  expect((await playerOn(request)).received).toHaveLength(3);
});

test("next, previous, shuffle and repeat change the Queue, and two Remotes see the same", async ({
  page,
  browser,
  request,
}) => {
  await setUp(request);
  await playAlbum(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto("/");
  await expect(current(other)).toHaveText("01 Tone.flac (playing)");
  await expect(queueControl(page, "Previous")).toBeDisabled();

  await queueControl(page, "Next").click();
  await expect(current(page)).toHaveText("02 Tone.mp3 (playing)");
  await expect(current(other)).toHaveText("02 Tone.mp3 (playing)");
  await expect.poll(async () => (await playerOn(request)).received.length).toBe(2);

  await queueControl(other, "Previous").click();
  await expect(current(page)).toHaveText("01 Tone.flac (playing)");

  // Shuffling leaves the current one where it is, and puts the rest in an order of its own.
  await queueControl(page, "Shuffle").click();
  await expect(queueControl(other, "Shuffle")).toHaveAttribute("aria-pressed", "true");
  await expect(current(other)).toHaveText("01 Tone.flac (playing)");
  const shuffled = await queueList(other).getByRole("listitem").allTextContents();
  expect(shuffled.toSorted()).toEqual(["01 Tone.flac (playing)", "02 Tone.mp3", "03 Tone.m4a"]);
  await queueControl(page, "Shuffle").click();
  await expect(queueList(other).getByRole("listitem")).toHaveText([
    "01 Tone.flac (playing)",
    "02 Tone.mp3",
    "03 Tone.m4a",
  ]);

  // Repeating all, previous from the first goes to the last, and its end back to the first.
  await nowPlaying(page).getByRole("combobox", { name: "Repeat" }).selectOption("All");
  await expect(nowPlaying(other).getByRole("combobox", { name: "Repeat" })).toHaveValue("all");
  await queueControl(page, "Previous").click();
  await expect(current(other)).toHaveText("03 Tone.m4a (playing)");
  await nearTheEnd(page);
  await expect(current(other)).toHaveText("01 Tone.flac (playing)", { timeout: 10_000 });

  // Repeating one, its end plays it again.
  await nowPlaying(other).getByRole("combobox", { name: "Repeat" }).selectOption("One");
  await expect(nowPlaying(page).getByRole("combobox", { name: "Repeat" })).toHaveValue("one");
  const sent = (await playerOn(request)).received.length;
  await nearTheEnd(page);
  await expect.poll(async () => (await playerOn(request)).received.length, { timeout: 10_000 }).toBe(sent + 1);
  const { received } = await playerOn(request);
  expect(received.at(-1)).toBe(received.at(-2));
  await expect(current(page)).toHaveText("01 Tone.flac (playing)");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the now-playing bar with a Queue meets WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await playAlbum(page);
    await queueControl(page, "Shuffle").click();
    await expect(queueControl(page, "Shuffle")).toHaveAttribute("aria-pressed", "true");

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".now-playing")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
