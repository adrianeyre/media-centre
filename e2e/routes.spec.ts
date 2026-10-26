import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { STREAMS_PATH } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-34, FR-41, FR-42, ADR 0006: the run's real Hub probes each Media File
// with ffprobe and chooses its Route to the Selected TV, which Watch & Listen
// shows; an MKV the TV decodes, but not from that container, takes the Remux
// Route, streamed as HLS to the fake TV's fake Player, which reads its
// playlist and segments from the TV's own address, as it plays and seeks.

const run = promisify(execFile);

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-routes-"));
  await makeTestMediaSource(dir);
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;
const RECORDING = "Films/Recording.mkv";

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

/** The ffmpegs running on this machine, where the run's Hub is, that read this spec's recording. */
const ffmpegsReading = async (): Promise<string[]> => {
  try {
    const { stdout } = await run("pgrep", ["-f", `ffmpeg .*${join(dir, RECORDING)}`]);
    return stdout.trim().split("\n");
  } catch {
    // pgrep says none by failing.
    return [];
  }
};

const watchAndListen = (page: Page): Locator => page.getByRole("region", { name: "Watch & Listen" });
const films = (page: Page): Locator => watchAndListen(page).getByRole("list", { name: "In Films" });
const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const seekBar = (page: Page): Locator => nowPlaying(page).getByRole("slider", { name: "Seek" });

/** Opens the Films folder of the test Media Source in Watch & Listen. */
const openFilms = async (page: Page): Promise<void> => {
  await page.goto("/");
  for (const name of ["Media", "Films"]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
  await expect(films(page)).toBeVisible();
};

/** Plays the recording from Watch & Listen, and resolves with its stream's URL once the fake Player has read a segment of it. */
const playRecording = async (page: Page, request: APIRequestContext): Promise<string> => {
  await openFilms(page);
  await films(page)
    .getByRole("button", { name: /^Recording\.mkv ?, / })
    .click();
  await expect(watchAndListen(page).getByText("Sent to the Player on Living room · TV.")).toBeVisible();
  await expect(nowPlaying(page)).toContainText("Recording.mkv");
  await expect.poll(async () => (await playerOn(request)).segments.length).toBeGreaterThan(0);
  const [url = ""] = (await playerOn(request)).received;
  return url;
};

test("Watch & Listen shows each Media File's Route to the Selected TV, and flags Full Conversion", async ({
  page,
  request,
}) => {
  await setUp(request);

  await openFilms(page);

  const route = (name: string): Locator => films(page).getByRole("listitem", { name }).locator(".media-file-route");
  await expect(route("Trailer.mkv")).toHaveText("Direct Play");
  await expect(route("Recording.mkv")).toHaveText("Remux");
  await expect(route("Concert.mkv")).toHaveText("Audio Conversion");
  await expect(route("Home Video.avi")).toHaveText("Full Conversion");
  await expect(films(page).locator(".media-file-cpu")).toHaveCount(1);
  await expect(films(page).getByRole("listitem", { name: "Home Video.avi" })).toContainText(
    "Uses a lot of the Hub's CPU",
  );
});

test("an MKV needing Remux plays through the fake TV's Player as HLS, and seeks within it", async ({
  page,
  request,
}) => {
  await setUp(request);

  const url = await playRecording(page, request);

  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
  const status = await playerOn(request);
  expect(status.playback).toBe("playing");
  expect(status.segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });

  // Seeking near the end of the minute reads the segment there, which the Player plays on from.
  await seekBar(page).fill("50");
  await expect
    .poll(async () => (await playerOn(request)).segments.map(({ url: read }) => read))
    .toContain(url.replace(/index\.m3u8$/, "8.ts"));
  const afterSeek = await playerOn(request);
  expect(afterSeek.segments.every((read) => read.status === 200 && read.bytes > 0)).toBe(true);
  expect(afterSeek.playback).toBe("playing");
  expect(afterSeek.positionMs).toBeGreaterThanOrEqual(50_000);
});

test("stopping a Media File played by Remux ends its stream, and leaves no ffmpeg running", async ({
  page,
  request,
}) => {
  await setUp(request);
  const url = await playRecording(page, request);

  await nowPlaying(page).getByRole("group", { name: "Playback" }).getByRole("button", { name: "Stop" }).click();

  await expect(nowPlaying(page)).toHaveCount(0);
  await expect.poll(async () => (await request.get(url)).status()).toBe(404);
  expect(await ffmpegsReading()).toEqual([]);
});

test("the Player disconnecting ends ffmpeg for its stream", async ({ page, request }) => {
  await setUp(request);
  await playRecording(page, request);

  // Standby closes the Player, whose socket to the Hub closes with it.
  expect((await request.post(fakeTvUrl(LIVING.host, "/_fake/power"), { data: { power: "standby" } })).ok()).toBe(true);

  await expect.poll(async () => (await playerOn(request)).running).toBe(false);
  await expect.poll(ffmpegsReading).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Routes in Watch & Listen meet WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await openFilms(page);
    await expect(films(page).locator(".media-file-cpu")).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".watch-and-listen")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
