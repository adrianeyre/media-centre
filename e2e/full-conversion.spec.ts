import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { STREAMS_PATH } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-34, FR-41, FR-42, ADR 0006: the run's real Hub sends a DivX/Xvid AVI,
// whose video no Samsung TV plays, to the fake TV's fake Player by the Full
// Conversion Route, as HLS, its video re-encoded to H.264 in software and its
// MP3 copied; and the Player seeks within it, the Hub converting from there.

const run = promisify(execFile);

let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-full-"));
  await makeTestMediaSource(dir);
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;
/** A minute of Xvid and MP3 in an AVI, with a keyframe every 5 seconds. */
const HOME_VIDEO = "Films/Home Video.avi";

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

/** The ffmpegs running on this machine, where the run's Hub is, that read this spec's home video. */
const ffmpegsReading = async (): Promise<string[]> => {
  try {
    const { stdout } = await run("pgrep", ["-f", `ffmpeg .*${join(dir, HOME_VIDEO)}`]);
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

/** Plays the home video from Watch & Listen, and resolves with its stream's URL once the fake Player has read a segment of it. */
const playHomeVideo = async (page: Page, request: APIRequestContext): Promise<string> => {
  await openFilms(page);
  await films(page)
    .getByRole("button", { name: /^Home Video\.avi ?, / })
    .click();
  await expect(watchAndListen(page).getByText("Sent to the Player on Living room · TV.")).toBeVisible();
  await expect(nowPlaying(page)).toContainText("Home Video.avi");
  await expect.poll(async () => (await playerOn(request)).segments.length).toBeGreaterThan(0);
  const [url = ""] = (await playerOn(request)).received;
  return url;
};

/** What ffprobe says of a segment the run's Hub serves: each stream's codec, and when its first picture is, and whether it is a keyframe. */
const segmentAt = async (
  request: APIRequestContext,
  url: string,
): Promise<{ codecs: string[]; first: { at: number; keyframe: boolean } }> => {
  const answer = await request.get(url);
  expect(answer.status()).toBe(200);
  const work = await mkdtemp(join(tmpdir(), "media-centre-e2e-segment-"));
  try {
    const file = join(work, "segment.ts");
    await writeFile(file, await answer.body());
    const { stdout: streams } = await run("ffprobe", [
      ...["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", file],
    ]);
    const { stdout: frames } = await run("ffprobe", [
      ...["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1"],
      ...["-show_entries", "frame=pts_time,key_frame", "-of", "csv=p=0", file],
    ]);
    const [keyframe, at] = (frames.trim().split("\n")[0] ?? "").split(",");
    return {
      codecs: (JSON.parse(streams) as { streams: { codec_name: string }[] }).streams.map(({ codec_name: c }) => c),
      // MPEG-TS starts its timestamps 1.4 seconds in, which players take as the start.
      first: { at: Number(at) - 1.4, keyframe: keyframe === "1" },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

test("a DivX/Xvid AVI takes the Full Conversion Route, and plays through the fake TV's Player as HLS, its video re-encoded", async ({
  page,
  request,
}) => {
  await setUp(request);
  await openFilms(page);
  const homeVideo = films(page).getByRole("listitem", { name: "Home Video.avi" });
  await expect(homeVideo.locator(".media-file-route")).toHaveText("Full Conversion");
  await expect(homeVideo).toContainText("Uses a lot of the Hub's CPU");

  const url = await playHomeVideo(page, request);

  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${STREAMS_PATH}/[0-9a-f-]{36}/index\\.m3u8$`));
  const status = await playerOn(request);
  expect(status.playback).toBe("playing");
  expect(status.segments[0]).toMatchObject({ url: url.replace(/index\.m3u8$/, "0.ts"), status: 200 });
  expect(status.segments[0]?.bytes).toBeGreaterThan(0);
  // H.264 the TV plays, from Xvid it doesn't, and the MP3 as it was.
  const { codecs, first } = await segmentAt(request, url.replace(/index\.m3u8$/, "0.ts"));
  expect(codecs).toEqual(["h264", "mp3"]);
  expect(first.keyframe).toBe(true);
  expect(first.at).toBeCloseTo(0, 2);
});

test("seeking on Full Conversion reads the segment there, which starts with a keyframe exactly there, and plays on", async ({
  page,
  request,
}) => {
  await setUp(request);
  const url = await playHomeVideo(page, request);

  // 50 seconds in is in the 9th 6-second segment, from 48 seconds, between the AVI's keyframes at 45 and 50.
  await seekBar(page).fill("50");

  const ninth = url.replace(/index\.m3u8$/, "8.ts");
  await expect.poll(async () => (await playerOn(request)).segments.map(({ url: read }) => read)).toContain(ninth);
  const afterSeek = await playerOn(request);
  expect(afterSeek.segments.every((read) => read.status === 200 && read.bytes > 0)).toBe(true);
  expect(afterSeek.playback).toBe("playing");
  expect(afterSeek.positionMs).toBeGreaterThanOrEqual(50_000);
  const { codecs, first } = await segmentAt(request, ninth);
  expect(codecs).toEqual(["h264", "mp3"]);
  expect(first.keyframe).toBe(true);
  expect(first.at).toBeCloseTo(48, 2);
});

test("stopping a Media File played by Full Conversion ends its stream, and leaves no ffmpeg running", async ({
  page,
  request,
}) => {
  await setUp(request);
  const url = await playHomeVideo(page, request);

  await nowPlaying(page).getByRole("group", { name: "Playback" }).getByRole("button", { name: "Stop" }).click();

  await expect(nowPlaying(page)).toHaveCount(0);
  await expect.poll(async () => (await request.get(url)).status()).toBe(404);
  expect(await ffmpegsReading()).toEqual([]);
});
