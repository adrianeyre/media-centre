import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import type { FakeLeproLight } from "../packages/hub/src/fakes/lepro-light/fake-lepro-light.ts";
import type { FakePlayerStatus } from "../packages/hub/src/fakes/player/fake-player.ts";
import { FAKE_APPS, FAKE_PLAYER_APP, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import type { LightScene, LightState } from "../packages/shared/src/index.ts";
import { startFakeLight, type FakeLightName } from "./fake-lights.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";
import { openSettingsOn } from "./settings.ts";

// FR-57, and Lights PRD §5 scenario 4: Living room · TV has "Film" as its
// Light Scene, chosen in its settings. A video played on it from Watch &
// Listen, through the run's real Hub and the fake TV's fake Player, brings
// the Living room's fake Lights to "Film", and stopping it sets them back.

const LIVING = FAKE_TVS.living;
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Holds the test Media Source, generated with ffmpeg. */
let media: string;

test.beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "media-centre-e2e-film-light-scene-"));
  await makeTestMediaSource(media);
});

test.afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

/** The fake Lights running, by name, each stopped after the test that started it. */
let running = new Map<FakeLightName, FakeLeproLight>();

const installApps = async (request: APIRequestContext, apps: readonly FakeApp[]): Promise<void> => {
  expect((await request.put(fakeTvUrl(LIVING.host, "/_fake/apps"), { data: apps })).ok()).toBe(true);
};

// The run's Hub is shared by every test, so each starts and ends with no
// Appliances, Rooms, Light Scenes or Media Sources, the Hub at the address it
// finds for itself, and the fake TV on, with its own apps installed and none
// running.
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
test.afterEach(async ({ request }) => {
  await Promise.all([...running.values()].map((light) => light.stop()));
  running = new Map();
  await forgetEverything(request);
});

const fake = (name: FakeLightName): FakeLeproLight => {
  const light = running.get(name);
  if (light === undefined) throw new Error(`The fake ${name} isn't running`);
  return light;
};

const BLUE = { hue: 240, saturation: 100 };
/** The Living room's Lamp as "Film" has it, and the Plug off. */
const FILM: LightState = { on: true, brightness: 10, colourTemperature: null, colour: BLUE };
/** The Lamp as it is of an evening, before any film, and the Plug on. */
const EVENING: LightState = { on: true, brightness: 80, colourTemperature: 4_000, colour: null };

/**
 * The Living room with its TV, the Player installed on it, and its Lamp and
 * Plug, saved as the Light Scene "Film" dimmed to blue and off, then left
 * as they are of an evening; and the test Media Source, the Hub giving the
 * TV its loopback address, where the fake TVs reach it.
 */
const setUp = async (request: APIRequestContext): Promise<{ tvId: number; sourceId: number; film: LightScene }> => {
  const room = await request.post("/api/rooms", { data: { name: "Living room" } });
  expect(room.status()).toBe(201);
  const { id: roomId } = (await room.json()) as { id: number };
  for (const [name, title] of [
    ["lamp", "Lamp"],
    ["plug", "Plug"],
  ] as const) {
    const light = await startFakeLight(name);
    running.set(name, light);
    const added = await request.post("/api/appliances", {
      data: { kind: "light", address: light.host, name: title, roomId, light: { id: light.id, key: light.key } },
    });
    expect(added.status()).toBe(201);
  }
  fake("lamp").setLight({ on: true, brightness: 10, colour: BLUE });
  fake("plug").setLight({ on: false });
  const saved = await request.post("/api/appliances/lights/scenes", { data: { roomId, name: "Film" } });
  expect(saved.status()).toBe(201);
  const { lightScene: film } = (await saved.json()) as { lightScene: LightScene };
  fake("lamp").setLight({ on: true, brightness: 80, colourTemperature: 4_000 });
  fake("plug").setLight({ on: true });

  const tv = await request.post("/api/appliances", { data: { kind: "tv", address: LIVING.host, name: "TV", roomId } });
  expect(tv.status()).toBe(201);
  const source = await request.post("/api/media-sources", { data: { name: "Media", path: media } });
  expect(source.status()).toBe(201);
  expect((await request.put("/api/hub/address", { data: { override: "127.0.0.1" } })).ok()).toBe(true);
  await installApps(request, [...FAKE_APPS, FAKE_PLAYER_APP]);
  return {
    tvId: ((await tv.json()) as { id: number }).id,
    sourceId: ((await source.json()) as { id: number }).id,
    film,
  };
};

/** Chooses the TV's film Light Scene through the Hub, as Settings does. */
const choose = async (request: APIRequestContext, tvId: number, filmLightSceneId: number | null): Promise<void> => {
  expect((await request.patch(`/api/appliances/${String(tvId)}`, { data: { filmLightSceneId } })).status()).toBe(200);
};

const playerOn = async (request: APIRequestContext): Promise<FakePlayerStatus> =>
  (await (await request.get(fakeTvUrl(LIVING.host, "/_fake/player"))).json()) as FakePlayerStatus;

const watchAndListen = (page: Page) => page.getByRole("region", { name: "Watch & Listen" });
/** A Media File's button, which a screen reader names by the file's name, size and length. */
const fileButton = (page: Page, file: string) =>
  watchAndListen(page).getByRole("button", { name: new RegExp(`^${file.replaceAll(".", "\\.")} ?, `) });
const nowPlaying = (page: Page): Locator => page.getByRole("region", { name: "Now playing" });
const control = (page: Page, name: string): Locator =>
  nowPlaying(page).getByRole("group", { name: "Playback" }).getByRole("button", { name, exact: true });

/** Plays the Media File in the test Media Source from Watch & Listen, on the Selected TV, Living room · TV. */
const playFrom = async (page: Page, request: APIRequestContext, ...path: string[]): Promise<void> => {
  await page.goto("/");
  // The Remote reopens on the last tab used.
  await page.getByRole("tab", { name: "TV" }).click();
  for (const name of ["Media", ...path.slice(0, -1)]) {
    await watchAndListen(page)
      .locator(".media-folder", { hasText: new RegExp(`^${name}$`) })
      .click();
  }
  await fileButton(page, path.at(-1) ?? "").click();
  await expect.poll(async () => (await playerOn(request)).playback).toBe("playing");
};

const stop = async (page: Page, request: APIRequestContext): Promise<void> => {
  await control(page, "Stop").click();
  await expect.poll(async () => (await playerOn(request)).playback).toBe("idle");
};

const reaches = async (name: FakeLightName, expected: Partial<LightState>): Promise<void> => {
  await expect.poll(() => fake(name).light()).toMatchObject(expected);
};

/** Long enough for the Hub to have changed a Light, had it been going to. */
const SETTLE_MS = 1_500;

test("chosen in the TV's settings, its Light Scene comes on with a video, and the Room goes back as it stops", async ({
  page,
  request,
}) => {
  const { tvId, film } = await setUp(request);
  await page.goto("/");
  await openSettingsOn(page, "TV");
  await page.getByRole("button", { name: "Edit Living room · TV" }).click();
  const form = page.getByRole("form", { name: "Edit Living room · TV" });
  const select = form.getByRole("combobox", { name: "Film Light Scene" });
  await expect(select.getByRole("option")).toHaveText(["None", "Film"]);
  await expect(select).toHaveAccessibleDescription(/^Recalled as a video starts on this TV\./);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).include("form").analyze();
  expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
  await select.selectOption({ label: "Film" });
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("listitem", { name: "Living room · TV" })).toContainText("Film Light Scene: Film");
  const tvs = (await (await request.get("/api/appliances")).json()) as { id: number; filmLightSceneId?: number }[];
  expect(tvs.find(({ id }) => id === tvId)?.filmLightSceneId).toBe(film.id);

  await playFrom(page, request, "Films", "Sci-Fi", "Clip.mp4");
  await reaches("lamp", FILM);
  await reaches("plug", { on: false });

  await stop(page, request);
  await reaches("lamp", EVENING);
  await reaches("plug", { on: true });
});

test("playing audio changes nothing", async ({ page, request }) => {
  const { tvId, film } = await setUp(request);
  await choose(request, tvId, film.id);
  fake("lamp").clear();
  fake("plug").clear();

  await playFrom(page, request, "Music", "Album", "01 Tone.flac");
  await page.waitForTimeout(SETTLE_MS);
  await stop(page, request);
  await page.waitForTimeout(SETTLE_MS);

  expect(fake("lamp").light()).toEqual(EVENING);
  expect(fake("plug").light().on).toBe(true);
  expect([...fake("lamp").commands, ...fake("plug").commands].filter(({ command }) => command === "control")).toEqual(
    [],
  );
});

test("a Light changed by hand in the Lights tab during the video stays as it was left, and the others go back", async ({
  page,
  request,
}) => {
  const { tvId, film } = await setUp(request);
  await choose(request, tvId, film.id);
  await playFrom(page, request, "Films", "Sci-Fi", "Clip.mp4");
  await reaches("lamp", FILM);
  await reaches("plug", { on: false });

  // The person switches the Plug back on from the Lights tab, as the video plays.
  await page.getByRole("tab", { name: "Lights" }).click();
  const plug = page.getByRole("region", { name: "Living room · Plug", exact: true });
  await expect(plug.getByRole("button", { name: "Power", exact: true })).toHaveAttribute("aria-pressed", "false");
  await plug.getByRole("button", { name: "Power", exact: true }).click();
  await reaches("plug", { on: true });
  // Then off again, as they leave it.
  await plug.getByRole("button", { name: "Power", exact: true }).click();
  await reaches("plug", { on: false });

  await page.getByRole("tab", { name: "TV" }).click();
  await stop(page, request);
  await reaches("lamp", EVENING);
  await page.waitForTimeout(SETTLE_MS);
  expect(fake("plug").light().on).toBe(false);
});

test("a TV with no Light Scene chosen, or with no Room, changes nothing", async ({ page, request }) => {
  const { tvId } = await setUp(request);
  fake("lamp").clear();
  fake("plug").clear();

  await playFrom(page, request, "Films", "Sci-Fi", "Clip.mp4");
  await page.waitForTimeout(SETTLE_MS);
  await stop(page, request);

  expect((await request.patch(`/api/appliances/${String(tvId)}`, { data: { roomId: null } })).status()).toBe(200);
  await openSettingsOn(page, "TV");
  await page.getByRole("button", { name: "Edit TV" }).click();
  const select = page.getByRole("form", { name: "Edit TV" }).getByRole("combobox", { name: "Film Light Scene" });
  await expect(select.getByRole("option")).toHaveText(["None"]);
  await expect(select).toHaveAccessibleDescription("A TV with no Room has no Light Scenes to choose from.");

  // Another video, as the one before now offers to resume.
  await playFrom(page, request, "Films", "Trailer.mkv");
  await page.waitForTimeout(SETTLE_MS);
  await stop(page, request);
  await page.waitForTimeout(SETTLE_MS);

  expect(fake("lamp").light()).toEqual(EVENING);
  expect(fake("plug").light().on).toBe(true);
  expect([...fake("lamp").commands, ...fake("plug").commands].filter(({ command }) => command === "control")).toEqual(
    [],
  );
});
