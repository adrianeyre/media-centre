import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { SAMSUNG_KEY_CODES } from "../packages/hub/src/drivers/samsung-tv/keys.ts";
import type { FakeVolume, RecordedKey } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// The run's Hub is shared by every test, so each starts and ends with no TVs
// and no Rooms, and with the run's fake TVs on, at volume 11, not muted,
// having recorded no keys.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    await setPower(request, host, "on");
    await setVolume(request, host, { volume: 11, muted: false });
    expect((await request.delete(fakeTvUrl(host, "/_fake/keys"))).ok()).toBe(true);
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

const setPower = async (request: APIRequestContext, host: string, power: "on" | "standby"): Promise<void> => {
  expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power } })).ok()).toBe(true);
};

/** Changes the fake TV's volume or mute as its own remote would, without the Hub. */
const setVolume = async (request: APIRequestContext, host: string, change: Partial<FakeVolume>): Promise<void> => {
  expect((await request.post(fakeTvUrl(host, "/_fake/volume"), { data: change })).ok()).toBe(true);
};

const volumeOf = async (request: APIRequestContext, host: string): Promise<FakeVolume> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/volume"))).json()) as FakeVolume;

const keysOf = async (request: APIRequestContext, host: string): Promise<RecordedKey[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/keys"))).json()) as RecordedKey[];

/** Living room · TV and Bedroom · TV, the run's two fake TVs, added through the Hub. */
const addTwoTvs = async (request: APIRequestContext): Promise<void> => {
  for (const [room, host] of [
    ["Living room", FAKE_TVS.living.host],
    ["Bedroom", FAKE_TVS.bedroom.host],
  ] as const) {
    const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: room } })).json()) as {
      id: number;
    };
    const response = await request.post("/api/appliances", { data: { kind: "tv", address: host, name: "TV", roomId } });
    expect(response.status()).toBe(201);
  }
};

const volume = (page: Page) => page.getByRole("region", { name: "Volume" });
const slider = (page: Page) => volume(page).getByRole("slider", { name: "Volume" });
const level = (page: Page) => volume(page).getByRole("status", { name: "Volume level" });
const mute = (page: Page) => volume(page).getByRole("button", { name: "Mute" });

/** The Remote reads the Selected TV's volume every few seconds, so it can take that long to follow the TV. */
const FOLLOWS = { timeout: 10_000 };

// FR-19, and PRD §5 scenario 2: drag the volume slider to 18.
test("dragging the slider to 18 sets the Selected TV's own volume to 18, and no other's", async ({ page, request }) => {
  await addTwoTvs(request);

  await page.goto("/");
  await expect(level(page)).toHaveText("11");
  await expect(slider(page)).toBeEnabled();
  await slider(page).fill("18");

  await expect.poll(async () => (await volumeOf(request, FAKE_TVS.living.host)).volume).toBe(18);
  await expect(level(page)).toHaveText("18");
  await expect(slider(page)).toHaveValue("18");
  expect(await volumeOf(request, FAKE_TVS.bedroom.host)).toEqual({ volume: 11, muted: false });
  // Set over the TV's own volume, not with keys.
  expect(await keysOf(request, FAKE_TVS.living.host)).toEqual([]);
});

// FR-19: the slider shows the TV's real volume, even after someone else changed it with the physical remote.
test("the slider follows the TV's volume as its own remote changes it, without reloading", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await page.goto("/");
  await expect(level(page)).toHaveText("11");

  await setVolume(request, FAKE_TVS.living.host, { volume: 33 });

  await expect(level(page)).toHaveText("33", FOLLOWS);
  await expect(slider(page)).toHaveValue("33");

  // And another TV's, once it is the Selected TV.
  await setVolume(request, FAKE_TVS.bedroom.host, { volume: 7 });
  await page.getByRole("button", { name: /^Selected TV: / }).click();
  await page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: "Bedroom · TV" }).click();
  await expect(level(page)).toHaveText("7");
});

// FR-19: mute reads and sets the TV's own mute.
test("mute shows whether the TV is muted, as its own remote left it, and mutes and unmutes it", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await page.goto("/");
  await expect(mute(page)).toHaveAttribute("aria-pressed", "false");

  await setVolume(request, FAKE_TVS.living.host, { muted: true });
  await expect(mute(page)).toHaveAttribute("aria-pressed", "true", FOLLOWS);

  await mute(page).click();
  await expect.poll(async () => (await volumeOf(request, FAKE_TVS.living.host)).muted).toBe(false);
  await expect(mute(page)).toHaveAttribute("aria-pressed", "false");

  await mute(page).click();
  await expect.poll(async () => (await volumeOf(request, FAKE_TVS.living.host)).muted).toBe(true);
  await expect(mute(page)).toHaveAttribute("aria-pressed", "true");
  expect((await volumeOf(request, FAKE_TVS.living.host)).volume).toBe(11);
});

// FR-19 and FR-25: in standby the TV can't say its volume, so the slider is disabled and shows none, and the keys still work.
test("with the TV in standby, the slider is disabled and shows no volume, and volume up and down still press keys", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await page.goto("/");
  await expect(level(page)).toHaveText("11");

  await setPower(request, FAKE_TVS.living.host, "standby");

  await expect(slider(page)).toBeDisabled(FOLLOWS);
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "Not known");
  await expect(level(page)).toHaveText("–");
  await expect(mute(page)).toBeDisabled();
  await expect(volume(page).getByText("The TV can't say its volume now")).toBeVisible();

  await volume(page).getByRole("button", { name: "Volume up" }).click();
  await volume(page).getByRole("button", { name: "Volume down" }).click();

  await expect
    .poll(async () => (await keysOf(request, FAKE_TVS.living.host)).map(({ code, command }) => `${command} ${code}`))
    .toEqual([`Click ${SAMSUNG_KEY_CODES["volume-up"]}`, `Click ${SAMSUNG_KEY_CODES["volume-down"]}`]);
  await expect(level(page)).toHaveText("–");

  // Back on, it says its volume again.
  await setPower(request, FAKE_TVS.living.host, "on");
  await expect(level(page)).toHaveText("11", FOLLOWS);
  await expect(slider(page)).toBeEnabled();
});

// FR-19: volume up and down are keys, and the slider follows what they did to the TV's volume.
test("volume up and down turn the TV's volume with its keys, and the slider follows", async ({ page, request }) => {
  await addTwoTvs(request);
  await page.goto("/");
  await expect(level(page)).toHaveText("11");

  await volume(page).getByRole("button", { name: "Volume up" }).click();
  await expect(level(page)).toHaveText("12");
  await volume(page).getByRole("button", { name: "Volume up" }).click();
  await expect(level(page)).toHaveText("13");
  await volume(page).getByRole("button", { name: "Volume down" }).click();
  await expect(level(page)).toHaveText("12");

  expect((await volumeOf(request, FAKE_TVS.living.host)).volume).toBe(12);
  expect((await keysOf(request, FAKE_TVS.living.host)).map(({ code }) => code)).toEqual([
    SAMSUNG_KEY_CODES["volume-up"],
    SAMSUNG_KEY_CODES["volume-up"],
    SAMSUNG_KEY_CODES["volume-down"],
  ]);
});
