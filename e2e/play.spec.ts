import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { mediaFilePath } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// FR-35, FR-41 (Direct Play), ADR 0002, ADR 0003: choosing a Media File in
// Watch & Listen plays it on the Selected TV, through the run's real Hub and
// the fake TV at Living room · TV's address, whose fake Player connects back
// to the Hub from there.

/** Holds the test Media Source, generated with ffmpeg, and a folder beside it that is in no Media Source. */
let dir: string;
let media: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-play-"));
  media = join(dir, "Media");
  await makeTestMediaSource(media);
  await mkdir(join(dir, "Outside"));
  await writeFile(join(dir, "Outside", "private.mp4"), "PRIVATE");
  await symlink(join(dir, "Outside"), join(media, "Escape"));
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LIVING = FAKE_TVS.living;

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

const installApps = async (request: APIRequestContext, apps: readonly FakeApp[]): Promise<void> => {
  expect((await request.put(fakeTvUrl(LIVING.host, "/_fake/apps"), { data: apps })).ok()).toBe(true);
};

/**
 * Adds Living room · TV, with the Player installed on it, and the test Media
 * Source, and has the Hub give the TV its loopback address, where the fake
 * TVs reach it. Resolves with the Media Source's id.
 */
const setUp = async (request: APIRequestContext, { player = true } = {}): Promise<number> => {
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Living room" } })).json()) as {
    id: number;
  };
  const tv = await request.post("/api/appliances", { data: { kind: "tv", address: LIVING.host, name: "TV", roomId } });
  expect(tv.status()).toBe(201);
  const source = await request.post("/api/media-sources", { data: { name: "Media", path: media } });
  expect(source.status()).toBe(201);
  expect((await request.put("/api/hub/address", { data: { override: "127.0.0.1" } })).ok()).toBe(true);
  if (player) await installApps(request, [...FAKE_APPS, FAKE_PLAYER_APP]);
  return ((await source.json()) as { id: number }).id;
};

const playerOn = async (request: APIRequestContext): Promise<FakePlayerStatus> =>
  (await (await request.get(fakeTvUrl(LIVING.host, "/_fake/player"))).json()) as FakePlayerStatus;

const watchAndListen = (page: Page) => page.getByRole("region", { name: "Watch & Listen" });
/** A Media File's button, which a screen reader names by the file's name, size and length. */
const fileButton = (page: Page, file: string) =>
  watchAndListen(page).getByRole("button", { name: new RegExp(`^${file.replaceAll(".", "\\.")} ?, `) });
const progress = (page: Page) => watchAndListen(page).getByRole("region", { name: /^Play / });

/** Opens the folder in the test Media Source, from the TV tab. */
const openFolder = async (page: Page, ...names: string[]): Promise<void> => {
  await page.goto("/");
  for (const name of ["Media", ...names]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
};

/** Sends `path` exactly as written, as a TV's player might, and as Playwright's request would not. */
const getAsWritten = (base: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    httpRequest({ host: hostname, port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    })
      .on("error", reject)
      .end();
  });

test("with the TV on, choosing a Media File launches the Player, which is sent its URL", async ({
  page,
  request,
  baseURL,
}) => {
  const sourceId = await setUp(request);
  await openFolder(page, "Films", "Sci-Fi");
  await expect(watchAndListen(page).getByText("Choose a Media File to play it on Living room · TV.")).toBeVisible();

  await fileButton(page, "Clip.mp4").click();

  await expect(progress(page).getByRole("status")).toHaveText("Sent to the Player on Living room · TV.");
  await expect(progress(page).getByRole("listitem")).toHaveText([
    "Launch the Player (done)",
    "The Player connects to the Hub (done)",
    "Send the Media File (done)",
  ]);
  const url = `http://127.0.0.1:${new URL(baseURL ?? "").port}${mediaFilePath(sourceId, "Films/Sci-Fi/Clip.mp4")}`;
  await expect.poll(() => playerOn(request)).toMatchObject({ connected: true, received: [url], playback: "playing" });
  expect(((await (await request.get(fakeTvUrl(LIVING.host, "/_fake/wakes"))).json()) as unknown[]).length).toBe(0);
});

test("the URL the Player is sent serves the Media File, with range requests", async ({ page, request }) => {
  await setUp(request);
  await openFolder(page, "Films");
  await fileButton(page, "Trailer.mkv").click();
  await expect(progress(page).getByRole("status")).toHaveText("Sent to the Player on Living room · TV.");
  await expect.poll(async () => (await playerOn(request)).received).toHaveLength(1);
  const [url = ""] = (await playerOn(request)).received;
  const file = await readFile(join(media, "Films/Trailer.mkv"));

  const whole = await request.get(url);
  const part = await request.get(url, { headers: { range: "bytes=10-109" } });

  expect(whole.status()).toBe(200);
  expect(whole.headers()["accept-ranges"]).toBe("bytes");
  expect((await whole.body()).equals(file)).toBe(true);
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBe(`bytes 10-109/${String(file.length)}`);
  expect((await part.body()).equals(file.subarray(10, 110))).toBe(true);
});

test("a Media File's URL can't reach anything outside a Media Source", async ({ request, baseURL }) => {
  const sourceId = await setUp(request);
  const base = baseURL ?? "";
  const file = `/api/media-sources/${String(sourceId)}/file`;

  for (const path of [
    `${file}/../../Outside/private.mp4`,
    `${file}/%2e%2e/Outside/private.mp4`,
    `${file}/..%2fOutside%2fprivate.mp4`,
    `${file}/Escape/private.mp4`,
  ]) {
    const { status, body } = await getAsWritten(base, path);
    expect(status, path).toBe(403);
    expect(body).not.toContain("PRIVATE");
  }
  expect((await getAsWritten(base, `${file}/readme.txt`)).status).toBe(404);
});

test("with the TV in standby, the Hub wakes it first, then plays once it comes on", async ({ page, request }) => {
  await setUp(request);
  expect((await request.post(fakeTvUrl(LIVING.host, "/_fake/power"), { data: { power: "standby" } })).ok()).toBe(true);
  await openFolder(page, "Films", "Sci-Fi");

  await fileButton(page, "Clip.mp4").click();

  await expect(progress(page).getByRole("status")).toHaveText("Sent to the Player on Living room · TV.");
  await expect(progress(page).getByRole("listitem")).toHaveText([
    "Switch the TV on (done)",
    "Launch the Player (done)",
    "The Player connects to the Hub (done)",
    "Send the Media File (done)",
  ]);
  const wakes = (await (await request.get(fakeTvUrl(LIVING.host, "/_fake/wakes"))).json()) as {
    macAddress: string | undefined;
  }[];
  expect(wakes.map(({ macAddress }) => macAddress)).toEqual([LIVING.macAddress]);
  await expect.poll(async () => (await playerOn(request)).received).toHaveLength(1);
});

test("says the Player isn't installed on a TV that hasn't got it", async ({ page, request }) => {
  await setUp(request, { player: false });
  await openFolder(page, "Films", "Sci-Fi");

  await fileButton(page, "Clip.mp4").click();

  await expect(progress(page).getByRole("alert")).toHaveText(
    "The Player isn't installed on the TV. Install it from the TV's Developer section first.",
  );
  await expect(progress(page).getByRole("listitem").first()).toHaveText("Launch the Player (failed)");
  await progress(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(progress(page)).toHaveCount(0);
});
