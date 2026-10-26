import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource, OPERA_SUBTITLE, operaBrightness } from "../packages/hub/src/testing/media.ts";
import { STREAMS_PATH } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-45, ADR 0006: the run's real Hub offers a Media File's image subtitle
// tracks, PGS and VobSub, which a Samsung TV can't render, in the
// now-playing bar as needing Full Conversion. The Remote warns before
// switching to one; then the Hub sends the fake TV's fake Player the Media
// File again, from where it was, by Full Conversion, with the track burned
// into its picture; and "Off" or a text track sends it again by Direct Play.

const run = promisify(execFile);

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-image-subtitles-"));
  await makeTestMediaSource(dir);
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;
/**
 * A minute of black H.264 and AAC, which a TV plays as they are, with a
 * SubRip in English, then PGS in Italian and VobSub in French, both a white box.
 */
const OPERA = "Films/Opera.mkv";

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

/** The ffmpegs running on this machine, where the run's Hub is, that read this spec's opera. */
const ffmpegsReading = async (): Promise<string[]> => {
  try {
    const { stdout } = await run("pgrep", ["-f", `ffmpeg .*${join(dir, OPERA)}`]);
    return stdout.trim().split("\n");
  } catch {
    // pgrep says none by failing.
    return [];
  }
};

const watchAndListen = (page: Page): Locator => page.getByRole("region", { name: "Watch & Listen" });
const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const seekBar = (page: Page): Locator => nowPlaying(page).getByRole("slider", { name: "Seek" });
const subtitles = (page: Page): Locator => nowPlaying(page).getByRole("combobox", { name: "Subtitles" });
const warning = (page: Page): Locator => page.getByRole("dialog", { name: "These subtitles need Full Conversion" });

/** The Direct Play URL of the opera, as the Player was first sent it. */
let operaUrl: string;

/** Plays the opera from Watch & Listen, seeks 20 seconds in, and waits for the fake Player to be playing there. */
const playOpera = async (page: Page, request: APIRequestContext): Promise<void> => {
  await page.goto("/");
  for (const name of ["Media", "Films"]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
  const films = watchAndListen(page).getByRole("list", { name: "In Films" });
  await expect(films.getByRole("listitem", { name: "Opera.mkv" }).locator(".media-file-route")).toHaveText(
    "Direct Play",
  );
  await films.getByRole("button", { name: /^Opera\.mkv ?, / }).click();
  await expect(watchAndListen(page).getByText("Sent to the Player on Living room · TV.")).toBeVisible();
  await expect(nowPlaying(page)).toContainText("Opera.mkv");
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  await seekBar(page).fill("20");
  await expect.poll(async () => (await playerOn(request)).positionMs).toBeGreaterThanOrEqual(20_000);
  [operaUrl = ""] = (await playerOn(request)).received;
  expect(operaUrl).toMatch(/\/file\/Films\/Opera\.mkv$/);
};

/**
 * Chooses the image subtitle track with this label on the bar, agrees to
 * Full Conversion when warned, and resolves with the stream the fake Player
 * was sent then, once it plays it, from about where it was.
 */
const burnIn = async (page: Page, request: APIRequestContext, label: string): Promise<string> => {
  const before = await playerOn(request);
  await subtitles(page).selectOption({ label });
  await warning(page).getByRole("button", { name: "Use Full Conversion" }).click();

  await expect.poll(async () => (await playerOn(request)).received).toHaveLength(before.received.length + 1);
  const url = (await playerOn(request)).received.at(-1) ?? "";
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  const after = await playerOn(request);
  // From where it was, give or take the second between the fake Player's reports.
  expect(Math.abs(after.positionMs - before.positionMs)).toBeLessThan(3_000);
  await expect(subtitles(page).locator("option:checked")).toHaveText(label);
  return url;
};

test("PGS and VobSub are offered as needing Full Conversion, after the text track", async ({ page, request }) => {
  await setUp(request);

  await playOpera(page, request);

  await expect(subtitles(page).locator("option")).toHaveText([
    "Off",
    "English · SRT",
    "Italian · PGS · Full Conversion",
    "French · VobSub · Full Conversion",
  ]);
  await expect(subtitles(page).locator("option:checked")).toHaveText("Off");
});

test("choosing PGS warns first, then plays on by Full Conversion from where it was, with it burned into the picture", async ({
  page,
  request,
}) => {
  await setUp(request);
  await playOpera(page, request);

  await subtitles(page).selectOption({ label: "Italian · PGS · Full Conversion" });

  await expect(warning(page)).toBeVisible();
  await expect(warning(page)).toContainText("Italian · PGS are image subtitles");
  await expect(warning(page)).toContainText("uses a lot of the Hub's CPU");
  // Nothing is sent until the person agrees.
  expect((await playerOn(request)).received).toEqual([operaUrl]);
  await expect(subtitles(page).locator("option:checked")).toHaveText("Off");

  const stream = await burnIn(page, request, "Italian · PGS · Full Conversion");

  await expect(warning(page)).toHaveCount(0);
  // Burned in, so the Player draws none of its own.
  expect(await playerOn(request)).toMatchObject({ subtitleTrack: null, subtitle: null });
  // It reads the stream from the segment at its position, 20 seconds in, which the Hub converts as it asks.
  const third = stream.replace(/index\.m3u8$/, "3.ts");
  await expect
    .poll(async () => (await playerOn(request)).segments.find(({ url }) => url === third))
    .toMatchObject({ status: 200 });
  // The white box of the subtitles on the black picture, half a second into the stream.
  const segment = await request.get(stream.replace(/index\.m3u8$/, "0.ts"));
  expect(segment.status()).toBe(200);
  const bytes = new Uint8Array(await segment.body());
  expect(await operaBrightness(bytes, 5, "box")).toBeGreaterThan(200);
  expect(await operaBrightness(bytes, 5, "outside")).toBeLessThan(40);
});

test("Cancel keeps the subtitles as they were, sending the Player nothing", async ({ page, request }) => {
  await setUp(request);
  await playOpera(page, request);

  await subtitles(page).selectOption({ label: "French · VobSub · Full Conversion" });
  await warning(page).getByRole("button", { name: "Cancel" }).click();

  await expect(warning(page)).toHaveCount(0);
  await expect(subtitles(page).locator("option:checked")).toHaveText("Off");
  expect((await playerOn(request)).received).toEqual([operaUrl]);
  expect(await ffmpegsReading()).toEqual([]);
});

test("Off goes back to Direct Play from where it was, ending the stream and its ffmpeg", async ({ page, request }) => {
  await setUp(request);
  await playOpera(page, request);
  const stream = await burnIn(page, request, "French · VobSub · Full Conversion");
  const before = await playerOn(request);

  await subtitles(page).selectOption({ label: "Off" });

  await expect(warning(page)).toHaveCount(0);
  await expect.poll(async () => (await playerOn(request)).received).toEqual([operaUrl, stream, operaUrl]);
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  const after = await playerOn(request);
  expect(Math.abs(after.positionMs - before.positionMs)).toBeLessThan(3_000);
  expect(after).toMatchObject({ subtitleTrack: null, subtitle: null });
  await expect(subtitles(page).locator("option:checked")).toHaveText("Off");
  await expect.poll(async () => (await request.get(stream)).status()).toBe(404);
  await expect.poll(ffmpegsReading).toEqual([]);
});

test("a text track goes back to Direct Play too, the fake Player showing it itself", async ({ page, request }) => {
  await setUp(request);
  await playOpera(page, request);
  const stream = await burnIn(page, request, "Italian · PGS · Full Conversion");

  await subtitles(page).selectOption({ label: "English · SRT" });

  await expect.poll(async () => (await playerOn(request)).received).toEqual([operaUrl, stream, operaUrl]);
  await expect.poll(async () => (await playerOn(request)).subtitle).toBe(OPERA_SUBTITLE);
  expect(await playerOn(request)).toMatchObject({ playback: "playing", subtitleTrack: 0 });
  await expect(subtitles(page).locator("option:checked")).toHaveText("English · SRT");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Full Conversion warning meets WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await playOpera(page, request);
    await subtitles(page).selectOption({ label: "Italian · PGS · Full Conversion" });
    await expect(warning(page)).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".dialog")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
