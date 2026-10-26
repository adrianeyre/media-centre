import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

// FR-36, FR-41, FR-42, ADR 0006: the run's real Hub sends an MKV with DTS,
// which no Samsung TV from 2018 on decodes, to the fake TV's fake Player by
// the Audio Conversion Route, as HLS, its video copied and only its audio
// re-encoded; and the now-playing bar lists each Media File's audio tracks,
// by language, and switches between them, on that Route and on Direct Play,
// the Player playing on from where it was.

const run = promisify(execFile);

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-audio-"));
  await makeTestMediaSource(dir);
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;
/** Twelve seconds of H.264, with DTS 5.1 in English, Dolby Digital in French, and AAC in no language it says. */
const ARRIVAL = "Films/Sci-Fi/Arrival.mkv";

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
const audio = (page: Page): Locator => nowPlaying(page).getByRole("combobox", { name: "Audio" });

/** Opens this folder of the test Media Source in Watch & Listen, e.g. "Films/Sci-Fi", and returns its list. */
const openFolder = async (page: Page, path: string): Promise<Locator> => {
  await page.goto("/");
  const names = path.split("/");
  for (const name of ["Media", ...names]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
  const list = watchAndListen(page).getByRole("list", { name: `In ${names.at(-1) ?? ""}` });
  await expect(list).toBeVisible();
  return list;
};

/** Plays the Media File at `path` from Watch & Listen, and waits for the fake Player to be playing it. */
const play = async (page: Page, request: APIRequestContext, path: string): Promise<string> => {
  const name = path.split("/").at(-1) ?? "";
  const folder = await openFolder(page, path.split("/").slice(0, -1).join("/"));
  await folder.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")} ?, `) }).click();
  await expect(watchAndListen(page).getByText("Sent to the Player on Living room · TV.")).toBeVisible();
  await expect(nowPlaying(page)).toContainText(name);
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
  const [url = ""] = (await playerOn(request)).received;
  return url;
};

/** The MD5 of each picture of a file's first video stream, decoded: the same for video copied, not for re-encoded. */
const decodedPictures = async (file: string): Promise<string[]> => {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim() ?? "");
};

/** Switches to the audio track with this label on the bar, and checks the Player plays on from where it was, on it. */
const switchAudioTrack = async (
  page: Page,
  request: APIRequestContext,
  label: string,
  track: number,
): Promise<void> => {
  const before = (await playerOn(request)).positionMs;

  await audio(page).selectOption({ label });

  await expect.poll(async () => (await playerOn(request)).audioTrack).toBe(track);
  const after = await playerOn(request);
  expect(after.playback).toBe("playing");
  // Within a few seconds of where it was: the fake Player plays on in real time as it switches.
  expect(Math.abs(after.positionMs - before)).toBeLessThan(3_000);
  await expect(audio(page).locator("option:checked")).toHaveText(label);
};

test("an MKV with DTS takes the Audio Conversion Route, and plays as HLS, its video copied", async ({
  page,
  request,
}) => {
  await setUp(request);
  const sciFi = await openFolder(page, "Films/Sci-Fi");
  await expect(sciFi.getByRole("listitem", { name: "Arrival.mkv" }).locator(".media-file-route")).toHaveText(
    "Audio Conversion",
  );

  const url = await play(page, request, ARRIVAL);

  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
  await expect.poll(async () => (await playerOn(request)).segments.length).toBeGreaterThan(0);
  expect((await playerOn(request)).segments[0]).toMatchObject({
    url: url.replace(/index\.m3u8$/, "0.ts"),
    status: 200,
  });

  // The first segment, as the Hub served it the Player: the DTS is Dolby Digital now, the video as it was.
  const segment = await request.get(url.replace(/index\.m3u8$/, "0.ts"));
  expect(segment.status()).toBe(200);
  const work = await mkdtemp(join(tmpdir(), "media-centre-e2e-segment-"));
  try {
    await writeFile(join(work, "0.ts"), await segment.body());
    const { stdout } = await run("ffprobe", [
      ...["-v", "error", "-show_entries", "stream=codec_type,codec_name,channels", "-of", "json"],
      join(work, "0.ts"),
    ]);
    const { streams } = JSON.parse(stdout) as { streams: { codec_name: string; channels?: number }[] };
    expect(streams.map(({ codec_name: codec, channels }) => [codec, channels ?? null])).toEqual([
      ["h264", null],
      ["ac3", 6],
      ["ac3", 2],
      ["aac", 2],
    ]);
    const streamed = await decodedPictures(join(work, "0.ts"));
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed).toEqual((await decodedPictures(join(dir, ARRIVAL))).slice(0, streamed.length));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the now-playing bar lists every audio track by its language, and switches on a converted Route", async ({
  page,
  request,
}) => {
  await setUp(request);
  await play(page, request, ARRIVAL);

  await expect(audio(page).locator("option")).toHaveText([
    "English · Surround · DTS 5.1",
    "French · Dolby Digital stereo",
    "Track 3 · AAC stereo",
  ]);
  await expect(audio(page).locator("option:checked")).toHaveText("English · Surround · DTS 5.1");
  await seekBar(page).fill("8");
  await expect.poll(async () => (await playerOn(request)).positionMs).toBeGreaterThanOrEqual(8_000);

  await switchAudioTrack(page, request, "Track 3 · AAC stereo", 2);
  await switchAudioTrack(page, request, "French · Dolby Digital stereo", 1);
  // Played on in the stream it was sent, with every audio track in it.
  expect((await playerOn(request)).received).toHaveLength(1);
});

test("the now-playing bar switches audio track on Direct Play too", async ({ page, request }) => {
  await setUp(request);
  const url = await play(page, request, "Films/Trailer.mkv");
  expect(url).toContain("/file/Films/Trailer.mkv");

  await expect(audio(page).locator("option")).toHaveText(["English · AAC mono", "Spanish · AAC mono"]);
  await seekBar(page).fill("30");
  await expect.poll(async () => (await playerOn(request)).positionMs).toBeGreaterThanOrEqual(30_000);

  await switchAudioTrack(page, request, "Spanish · AAC mono", 1);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the bar's audio tracks meet WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme });
    await setUp(request);
    await play(page, request, ARRIVAL);
    await expect(audio(page)).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include(".now-playing")
      .analyze();

    expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  });
}
