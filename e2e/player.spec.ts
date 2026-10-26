import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { startFakeSamsungTv, type FakeSamsungTv } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../packages/hub/src/testing/ports.ts";
import { startNodeProcess, type RunningProcess } from "../packages/hub/src/testing/process.ts";
import { FAKE_APPS, FAKE_PLAYER_APP } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { COVER_ART_SIZE, FILM_SUBTITLES, makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import {
  appliancePlaybackPath,
  appliancePlayerPath,
  appliancePlayPath,
  mediaResumePositionPath,
  playerLaunchParameter,
  type Appliance,
  type AppliancePlayback,
  type AppliancePlayer,
  type MediaResumePosition,
  type MediaSource,
} from "../packages/shared/src/index.ts";
import {
  FAKE_TV_CONTROL_PORT,
  FAKE_TV_REST_PORT,
  FAKE_TV_SSDP_PORT,
  FAKE_TV_UPNP_PORT,
  FAKE_TV_WAKE_PORT,
  FAKE_TVS,
  fakeTvUrl,
  PLAYER_FAKE_TV,
} from "./fake-tvs.ts";

// The Player as `pnpm build` makes it for the TV, opened from its files as
// the TV's web runtime opens it, in a browser at a TV's size. `tizen` is
// stood in for, with the launch data the TV gives the Player (ADR 0004); the
// Hub is real.
const PLAYER_PAGE = pathToFileURL(join(import.meta.dirname, "../packages/player/dist/index.html")).href;
const HUB_MAIN = join(import.meta.dirname, "../packages/hub/src/main.ts");

test.use({ viewport: { width: 1920, height: 1080 } });

/** Stands in for `tizen` on the page, as a TV that launched the Player with this data, or with none. */
const launchPlayer = async (page: Page, data: readonly { key: string; value: string[] }[]): Promise<void> => {
  await page.addInitScript((appControlData) => {
    const requested = { appControl: { data: appControlData } };
    const application = { getCurrentApplication: () => ({ getRequestedAppControl: () => requested }) };
    Object.defineProperty(globalThis, "tizen", { value: { application } });
  }, data);
  await page.goto(PLAYER_PAGE);
};

/** The deep link the Hub launches the Player with, giving it the Hub's address. */
const deepLink = (hubAddress: string): { key: string; value: string[] }[] => [
  { key: "PAYLOAD", value: [JSON.stringify({ values: playerLaunchParameter(hubAddress) })] },
];

/** The run's Hub, which `playwright.config.ts` starts. */
const runHub = (baseURL: string | undefined): string => {
  if (baseURL === undefined) throw new Error("The run's Hub has no base URL");
  return baseURL;
};

/** The address the Hub's base URL is at, as the Hub launches the Player with it. */
const addressOf = (base: string): string => new URL(base).host;

const addTv = async (request: APIRequestContext, base: string, address: string, name = "TV"): Promise<Appliance> => {
  const response = await request.post(`${base}/api/appliances`, { data: { kind: "tv", address, name, roomId: null } });
  expect(response.status()).toBe(201);
  return (await response.json()) as Appliance;
};

const playerOn = async (request: APIRequestContext, base: string, tv: Appliance): Promise<AppliancePlayer> =>
  (await (await request.get(`${base}${appliancePlayerPath(tv.id)}`)).json()) as AppliancePlayer;

const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  const all = (await (await request.get("/api/appliances")).json()) as { id: number }[];
  for (const { id } of all) expect((await request.delete(`/api/appliances/${String(id)}`)).status()).toBe(204);
};

let tv: FakeSamsungTv;

test.beforeEach(async ({ request }) => {
  await forgetEverything(request);
  tv = await startFakeSamsungTv({
    host: PLAYER_FAKE_TV.host,
    restPort: FAKE_TV_REST_PORT,
    controlPort: FAKE_TV_CONTROL_PORT,
    ssdpPort: FAKE_TV_SSDP_PORT,
    wakePort: FAKE_TV_WAKE_PORT,
    upnpPort: FAKE_TV_UPNP_PORT,
    name: PLAYER_FAKE_TV.name,
    macAddress: PLAYER_FAKE_TV.macAddress,
  });
});
test.afterEach(async ({ request }) => {
  await tv.stop();
  await forgetEverything(request);
});

// FR-35, ADR 0003: the Hub launches the Player with its address, and the Player connects back to it.
test("launched with the Hub's address, the Player connects to the Hub, which knows the TV it is on", async ({
  page,
  request,
  baseURL,
}) => {
  const base = runHub(baseURL);
  const playerTv = await addTv(request, base, PLAYER_FAKE_TV.host);
  const otherTv = await addTv(request, base, FAKE_TVS.living.host, "Other TV");
  expect(await playerOn(request, base, playerTv)).toEqual({ connected: false });

  await launchPlayer(page, deepLink(addressOf(base)));

  await expect(page.getByRole("status")).toHaveText("Connected to the Hub");
  await expect.poll(() => playerOn(request, base, playerTv)).toEqual({ connected: true });
  expect(await playerOn(request, base, otherTv)).toEqual({ connected: false });

  await page.close();
  await expect.poll(() => playerOn(request, base, playerTv)).toEqual({ connected: false });
});

// FR-39: opened from the TV's own app list, with no launch data, it uses the address it remembers.
test("opened from the app list, the Player waits for the Remote at the Hub it remembers", async ({
  context,
  request,
  baseURL,
}) => {
  const base = runHub(baseURL);
  const playerTv = await addTv(request, base, PLAYER_FAKE_TV.host);
  const launched = await context.newPage();
  await launchPlayer(launched, deepLink(addressOf(base)));
  await expect(launched.getByRole("status")).toHaveText("Connected to the Hub");
  await launched.close();

  const opened = await context.newPage();
  await launchPlayer(opened, []);

  await expect(opened.getByRole("heading", { level: 1 })).toHaveText("Waiting for the Remote");
  await expect(opened.getByText(`Hub: ${addressOf(base)}`)).toBeVisible();
  await expect(opened.getByRole("status")).toHaveText("Connected to the Hub");
  await expect.poll(() => playerOn(request, base, playerTv)).toEqual({ connected: true });
});

test("opened for the first time from the app list, the Player says it hasn't been given the Hub's address", async ({
  page,
}) => {
  await launchPlayer(page, []);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Waiting for the Remote");
  await expect(page.getByText("This TV hasn't been given the Hub's address yet.", { exact: false })).toBeVisible();
});

// NFR-4: a Hub that restarts, as for an upgrade, has its Players back without anyone touching the TV.
test("the Player connects again once the Hub restarts", async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-player-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const env = {
    HUB_PORT: String(port),
    HUB_DATABASE: join(dir, "media-centre.sqlite"),
    SAMSUNG_TV_REST_PORT: String(FAKE_TV_REST_PORT),
    SAMSUNG_TV_CONTROL_PORT: String(FAKE_TV_CONTROL_PORT),
    SAMSUNG_TV_UPNP_PORT: String(FAKE_TV_UPNP_PORT),
    SAMSUNG_TV_WAKE_PORT: String(FAKE_TV_WAKE_PORT),
  };
  const startHub = (): Promise<RunningProcess> => startNodeProcess(HUB_MAIN, env, /Hub listening on/);
  let hub = await startHub();
  try {
    const playerTv = await addTv(request, base, PLAYER_FAKE_TV.host);
    await launchPlayer(page, deepLink(addressOf(base)));
    await expect(page.getByRole("status")).toHaveText("Connected to the Hub");
    await expect.poll(() => playerOn(request, base, playerTv)).toEqual({ connected: true });

    expect(await hub.stop()).toBe(0);
    await expect(page.getByRole("status")).toHaveText("Can't reach the Hub. Trying again…");

    hub = await startHub();

    await expect(page.getByRole("status")).toHaveText("Connected to the Hub", { timeout: 15_000 });
    await expect.poll(() => playerOn(request, base, playerTv)).toEqual({ connected: true });
    expect(hub.output).toContain("A Player connected on TV");
  } finally {
    await hub.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// FR-39, FR-40, NFR-4: the Hub records a Resume Position as a Media File
// plays, here on the run's Living-room fake TV, whose fake Player plays it,
// and keeps it through a restart; the Player opened on another TV then offers
// to resume it, and its button plays it from there.
test("the Player's Resume button plays the last Media File from its Resume Position, after a Hub restart", async ({
  page,
  request,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-player-resume-"));
  await makeTestMediaSource(join(dir, "media"));
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const env = {
    HUB_PORT: String(port),
    HUB_DATABASE: join(dir, "media-centre.sqlite"),
    SAMSUNG_TV_REST_PORT: String(FAKE_TV_REST_PORT),
    SAMSUNG_TV_CONTROL_PORT: String(FAKE_TV_CONTROL_PORT),
    SAMSUNG_TV_UPNP_PORT: String(FAKE_TV_UPNP_PORT),
    SAMSUNG_TV_WAKE_PORT: String(FAKE_TV_WAKE_PORT),
  };
  const living = FAKE_TVS.living.host;
  const startHub = (): Promise<RunningProcess> => startNodeProcess(HUB_MAIN, env, /Hub listening on/);
  let hub = await startHub();
  try {
    expect((await request.put(fakeTvUrl(living, "/_fake/apps"), { data: [...FAKE_APPS, FAKE_PLAYER_APP] })).ok()).toBe(
      true,
    );
    const livingTv = await addTv(request, base, living);
    const playerTv = await addTv(request, base, PLAYER_FAKE_TV.host, "Player TV");
    const added = await request.post(`${base}/api/media-sources`, {
      data: { name: "Media", path: join(dir, "media") },
    });
    expect(added.status()).toBe(201);
    const source = (await added.json()) as MediaSource;
    expect((await request.put(`${base}/api/hub/address`, { data: { override: "127.0.0.1" } })).ok()).toBe(true);
    const play = await request.post(`${base}${appliancePlayPath(livingTv.id)}`, {
      data: { mediaSourceId: source.id, path: "Films/Sci-Fi/Clip.mp4" },
    });
    expect(await play.text()).toContain('"sent"');
    const controlLiving = async (data: object): Promise<void> => {
      await expect
        .poll(async () => (await request.post(`${base}${appliancePlaybackPath(livingTv.id)}`, { data })).status())
        .toBe(200);
    };
    await controlLiving({ action: "pause" });
    await controlLiving({ action: "seek", positionMs: 30_000 });
    await controlLiving({ action: "stop" });
    const resumePosition = async (): Promise<number | null> =>
      (
        (await (
          await request.get(`${base}${mediaResumePositionPath(source.id, "Films/Sci-Fi/Clip.mp4")}`)
        ).json()) as MediaResumePosition
      ).positionMs;
    await expect.poll(resumePosition).toBe(30_000);

    expect(await hub.stop()).toBe(0);
    hub = await startHub();
    expect(await resumePosition()).toBe(30_000);

    await launchPlayer(page, deepLink(addressOf(base)));

    await expect(page.getByRole("status")).toHaveText("Connected to the Hub");
    const resume = page.getByRole("button", { name: "Resume Clip.mp4 from 0:30" });
    await expect(resume).toBeVisible();
    await expect(resume).toBeFocused();
    // OK on the TV's own remote, as the TV sends it to the page.
    await page.keyboard.press("Enter");

    const playing = async (): Promise<AppliancePlayback["nowPlaying"]> =>
      ((await (await request.get(`${base}${appliancePlaybackPath(playerTv.id)}`)).json()) as AppliancePlayback)
        .nowPlaying;
    await expect.poll(async () => (await playing())?.state).toBe("playing");
    expect((await playing())?.name).toBe("Clip.mp4");
    expect((await playing())?.positionMs).toBeGreaterThanOrEqual(30_000);
    await expect(page.getByRole("heading", { level: 1 })).toBeHidden();
    expect(hub.output).toContain('Resumed "Clip.mp4" from 0:30 on the Player on Player TV, by Direct Play');
  } finally {
    await hub.stop();
    for (const power of ["standby", "on"]) {
      await request.post(fakeTvUrl(living, "/_fake/power"), { data: { power } });
    }
    await request.put(fakeTvUrl(living, "/_fake/apps"), { data: FAKE_APPS });
    await rm(dir, { recursive: true, force: true });
  }
});

// FR-36, FR-44, FR-45: the built Player shows the subtitle track the Hub asks
// for over the picture, reading it from the Hub itself, from another origin
// as a TV's page is, and the ASS beside the Media File as the SubRip the Hub
// converts it to; and none for "Off". It plays `Film.mkv` from its Resume
// Position, recorded on the run's Living-room fake TV, as the page connects
// from the Player TV's address, where the Hub can't launch it.
test("the Player shows the subtitle track the Hub asks for over the picture, and hides it for Off", async ({
  page,
  request,
  baseURL,
}) => {
  const base = runHub(baseURL);
  const dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-player-subtitles-"));
  const living = FAKE_TVS.living.host;
  try {
    await makeTestMediaSource(dir);
    expect((await request.put(fakeTvUrl(living, "/_fake/apps"), { data: [...FAKE_APPS, FAKE_PLAYER_APP] })).ok()).toBe(
      true,
    );
    const livingTv = await addTv(request, base, living);
    const playerTv = await addTv(request, base, PLAYER_FAKE_TV.host, "Player TV");
    const added = await request.post(`${base}/api/media-sources`, { data: { name: "Media", path: dir } });
    expect(added.status()).toBe(201);
    const source = (await added.json()) as MediaSource;
    expect((await request.put(`${base}/api/hub/address`, { data: { override: "127.0.0.1" } })).ok()).toBe(true);
    const play = await request.post(`${base}${appliancePlayPath(livingTv.id)}`, {
      data: { mediaSourceId: source.id, path: "Films/Film.mkv" },
    });
    expect(await play.text()).toContain('"sent"');
    const control = async (tv: Appliance, data: object): Promise<void> => {
      await expect
        .poll(async () => (await request.post(`${base}${appliancePlaybackPath(tv.id)}`, { data })).status())
        .toBe(200);
    };
    await control(livingTv, { action: "pause" });
    await control(livingTv, { action: "seek", positionMs: 20_000 });
    await control(livingTv, { action: "stop" });
    await expect
      .poll(
        async () =>
          (
            (await (
              await request.get(`${base}${mediaResumePositionPath(source.id, "Films/Film.mkv")}`)
            ).json()) as MediaResumePosition
          ).positionMs,
      )
      .toBe(20_000);

    await launchPlayer(page, deepLink(addressOf(base)));
    await page.getByRole("button", { name: "Resume Film.mkv from 0:20" }).press("Enter");
    const playing = async (): Promise<AppliancePlayback["nowPlaying"]> =>
      ((await (await request.get(`${base}${appliancePlaybackPath(playerTv.id)}`)).json()) as AppliancePlayback)
        .nowPlaying;
    await expect.poll(async () => (await playing())?.state).toBe("playing");
    expect((await playing())?.subtitleTracks).toHaveLength(4);
    const shown = page.locator("#subtitles");
    await expect(shown).toBeHidden();

    await control(playerTv, { action: "subtitle-track", track: 3 });

    await expect(shown).toBeVisible();
    await expect(shown).toHaveText(FILM_SUBTITLES[3]);
    await expect.poll(async () => (await playing())?.subtitleTrack).toBe(3);

    await control(playerTv, { action: "subtitle-track", track: 0 });
    await expect(shown).toHaveText(FILM_SUBTITLES[0]);

    await control(playerTv, { action: "subtitle-track", track: null });

    await expect(shown).toBeHidden();
    await expect.poll(async () => (await playing())?.subtitleTrack).toBeNull();
    expect((await playing())?.state).toBe("playing");
  } finally {
    const sources = (await (await request.get(`${base}/api/media-sources`)).json()) as { id: number }[];
    for (const { id } of sources) await request.delete(`${base}/api/media-sources/${String(id)}`);
    await request.put(`${base}/api/hub/address`, { data: { override: null } });
    for (const power of ["standby", "on"]) {
      await request.post(fakeTvUrl(living, "/_fake/power"), { data: { power } });
    }
    await request.put(fakeTvUrl(living, "/_fake/apps"), { data: FAKE_APPS });
    await rm(dir, { recursive: true, force: true });
  }
});

// FR-47: the built Player shows its now-playing screen while it plays audio:
// a FLAC's cover art, read from the Hub itself from another origin, as a
// TV's page is, its title, artist and album from its tags, and its progress;
// and for an untagged MP3, its file name and a placeholder for the cover art
// it hasn't got. It plays each from its Resume Position, recorded on the
// run's Living-room fake TV, as the page connects from the Player TV's
// address, where the Hub can't launch it.
test("the Player shows a now-playing screen while audio plays, with its cover art, tags and progress", async ({
  page,
  request,
  baseURL,
}) => {
  const base = runHub(baseURL);
  const dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-player-music-"));
  const living = FAKE_TVS.living.host;
  try {
    await makeTestMediaSource(dir);
    expect((await request.put(fakeTvUrl(living, "/_fake/apps"), { data: [...FAKE_APPS, FAKE_PLAYER_APP] })).ok()).toBe(
      true,
    );
    const livingTv = await addTv(request, base, living);
    const playerTv = await addTv(request, base, PLAYER_FAKE_TV.host, "Player TV");
    const added = await request.post(`${base}/api/media-sources`, { data: { name: "Media", path: dir } });
    expect(added.status()).toBe(201);
    const source = (await added.json()) as MediaSource;
    expect((await request.put(`${base}/api/hub/address`, { data: { override: "127.0.0.1" } })).ok()).toBe(true);
    const control = async (tv: Appliance, data: object): Promise<void> => {
      await expect
        .poll(async () => (await request.post(`${base}${appliancePlaybackPath(tv.id)}`, { data })).status())
        .toBe(200);
    };
    /** Plays the Media File on Living room · TV, and leaves it with a Resume Position 20 seconds in. */
    const resumableOnLiving = async (path: string): Promise<void> => {
      const play = await request.post(`${base}${appliancePlayPath(livingTv.id)}`, {
        data: { mediaSourceId: source.id, path },
      });
      expect(await play.text()).toContain('"sent"');
      await control(livingTv, { action: "pause" });
      await control(livingTv, { action: "seek", positionMs: 20_000 });
      await control(livingTv, { action: "stop" });
      await expect
        .poll(
          async () =>
            (
              (await (
                await request.get(`${base}${mediaResumePositionPath(source.id, path)}`)
              ).json()) as MediaResumePosition
            ).positionMs,
        )
        .toBe(20_000);
    };
    const screen = page.locator("section.now-playing");

    await resumableOnLiving("Music/Album/01 Tone.flac");
    await launchPlayer(page, deepLink(addressOf(base)));
    await page.getByRole("button", { name: "Resume 01 Tone.flac from 0:20" }).press("Enter");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tone in A");
    await expect(screen.locator(".artist")).toHaveText("The Sine Waves");
    await expect(screen.locator(".album")).toHaveText("Test Tones");
    const coverArt = page.getByRole("img", { name: "Cover art of Test Tones" });
    await expect(coverArt).toBeVisible();
    expect(await coverArt.evaluate((img) => (img as { readonly naturalWidth: number }).naturalWidth)).toBe(
      COVER_ART_SIZE,
    );
    await expect(page.getByRole("img", { name: "No cover art" })).toBeHidden();
    // It plays on from 20 seconds in, through the fake playback, in real time.
    await expect(screen.locator(".times")).toHaveText(/^0:2[1-9] \/ 1:00$/);
    await expect(page.getByRole("progressbar", { name: "Progress" })).toHaveAttribute("aria-valuemax", "60");
    await expect(page.getByRole("heading", { name: "Waiting for the Remote" })).toBeHidden();

    await control(playerTv, { action: "stop" });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Waiting for the Remote");
    await expect(screen).toBeHidden();

    await resumableOnLiving("Music/Album/02 Tone.mp3");
    // Opened again from the app list, it offers the Media File recorded last.
    await page.reload();
    await page.getByRole("button", { name: "Resume 02 Tone.mp3 from 0:20" }).press("Enter");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("02 Tone.mp3");
    await expect(page.getByRole("img", { name: "No cover art" })).toBeVisible();
    await expect(screen.locator(".artist")).toBeHidden();
    await expect(screen.locator(".album")).toBeHidden();
    await expect(screen.locator("img.cover-art")).toBeHidden();
  } finally {
    const sources = (await (await request.get(`${base}/api/media-sources`)).json()) as { id: number }[];
    for (const { id } of sources) await request.delete(`${base}/api/media-sources/${String(id)}`);
    await request.put(`${base}/api/hub/address`, { data: { override: null } });
    for (const power of ["standby", "on"]) {
      await request.post(fakeTvUrl(living, "/_fake/power"), { data: { power } });
    }
    await request.put(fakeTvUrl(living, "/_fake/apps"), { data: FAKE_APPS });
    await rm(dir, { recursive: true, force: true });
  }
});
