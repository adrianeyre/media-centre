import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  FAKE_APPS,
  type FakeAppStatus,
  type FakeVolume,
  type RecordedRequest,
} from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// The run's Hub is shared by every test, so each starts and ends with no TVs
// and no Rooms, and with the run's fake TVs on, with their own apps installed
// and none running.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    // Standby closes every app.
    for (const power of ["standby", "on"] as const) await setPower(request, host, power);
    expect((await request.put(fakeTvUrl(host, "/_fake/apps"), { data: FAKE_APPS })).ok()).toBe(true);
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

const setPower = async (request: APIRequestContext, host: string, power: "on" | "standby"): Promise<void> => {
  expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power } })).ok()).toBe(true);
};

/** Brings the app with this id to the front on the fake TV, or none, as its own remote would. */
const bringToFront = async (request: APIRequestContext, host: string, app: string | null): Promise<void> => {
  expect((await request.post(fakeTvUrl(host, "/_fake/front"), { data: { app } })).ok()).toBe(true);
};

const YOUTUBE = "111299001912";
const NETFLIX = "3201907018807";

/** Adds Living room · TV and Bedroom · TV, the run's two fake TVs, through the Hub. */
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

const card = (page: Page) => page.getByRole("region", { name: "Now Showing" });

/** What the card says. */
const shown = (page: Page) => card(page).getByRole("status");

/** Chooses a TV in the TV picker. */
const choose = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: /^Selected TV: / }).click();
  await page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("button", { name: /^Selected TV: / })).toHaveText(`Selected TV: ${title}`);
};

/** The card reads what the Selected TV is showing every 3 seconds. */
const FOLLOWS = { timeout: 10_000 };

// FR-26: the app in front, by name and icon, followed as the TV's own remote changes it.
test("Now Showing names the app in front on the Selected TV, with its icon, and follows it without a reload", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await bringToFront(request, FAKE_TVS.living.host, YOUTUBE);
  await page.goto("/");

  await expect(shown(page)).toHaveText("YouTube");
  const icon = shown(page).locator("img");
  // The fake TV's icons are 16 pixels square: one that loaded from the Hub has its size.
  await expect(icon).toHaveJSProperty("naturalWidth", 16);
  expect((await request.get((await icon.getAttribute("src")) ?? "")).headers()["content-type"]).toBe("image/png");

  // Another app launched with the TV's own remote.
  await bringToFront(request, FAKE_TVS.living.host, NETFLIX);
  await expect(shown(page)).toHaveText("Netflix", FOLLOWS);
  await expect(shown(page).locator("img")).toHaveAttribute("src", new RegExp(`/apps/${NETFLIX}/icon$`));

  // And one launched from the Remote's own list of apps.
  await page.getByRole("region", { name: "Apps" }).getByRole("button", { name: "Launch Prime Video" }).click();
  await expect(shown(page)).toHaveText("Prime Video", FOLLOWS);
});

// FR-26, FR-25: when no app says it is in front, as with live TV, the card says it can't tell rather than guessing.
test("Now Showing says it can't tell when no app says it is in front", async ({ page, request }) => {
  await addTwoTvs(request);
  await page.goto("/");
  await expect(shown(page)).toHaveText(
    "Can't tell what Living room · TV is showing: none of its apps says it is in front.",
  );

  await bringToFront(request, FAKE_TVS.living.host, YOUTUBE);
  await expect(shown(page)).toHaveText("YouTube", FOLLOWS);
  // As switching to live TV with the TV's own remote would, leaving YouTube running behind.
  await bringToFront(request, FAKE_TVS.living.host, null);
  await expect(shown(page)).toHaveText(
    "Can't tell what Living room · TV is showing: none of its apps says it is in front.",
    FOLLOWS,
  );
  await expect(shown(page).locator("img")).toHaveCount(0);
});

// FR-26: a TV in standby says so.
test("Now Showing says the Selected TV is in standby", async ({ page, request }) => {
  await addTwoTvs(request);
  await bringToFront(request, FAKE_TVS.living.host, YOUTUBE);
  await page.goto("/");
  await expect(shown(page)).toHaveText("YouTube");

  await setPower(request, FAKE_TVS.living.host, "standby");
  await expect(shown(page)).toHaveText("Living room · TV is in standby.", FOLLOWS);

  await setPower(request, FAKE_TVS.living.host, "on");
  await bringToFront(request, FAKE_TVS.living.host, NETFLIX);
  await expect(shown(page)).toHaveText("Netflix", FOLLOWS);
});

/** Everything a fake TV has recorded that would change it, and what it has running, its volume, and its keyboard. */
const disturbances = async (request: APIRequestContext, host: string) => {
  const read = async <T>(path: Parameters<typeof fakeTvUrl>[1]): Promise<T> =>
    (await (await request.get(fakeTvUrl(host, path))).json()) as T;
  return {
    // Every REST request but a read: a launch, a close, anything else.
    changes: (await read<RecordedRequest[]>("/_fake/requests")).filter(({ method }) => method !== "GET"),
    keys: await read<unknown[]>("/_fake/keys"),
    text: await read<unknown[]>("/_fake/text"),
    wakes: await read<unknown[]>("/_fake/wakes"),
    running: (await read<FakeAppStatus[]>("/_fake/apps")).filter(({ running }) => running),
    volume: await read<FakeVolume>("/_fake/volume"),
  };
};

// PRD §5 scenario 3: switching the Selected TV switches the card, and does nothing to either TV.
test("switching the Selected TV switches Now Showing, and sends nothing to either TV", async ({ page, request }) => {
  await addTwoTvs(request);
  await bringToFront(request, FAKE_TVS.living.host, NETFLIX);
  await bringToFront(request, FAKE_TVS.bedroom.host, YOUTUBE);
  for (const { host } of Object.values(FAKE_TVS)) {
    for (const path of ["/_fake/requests", "/_fake/keys", "/_fake/text", "/_fake/wakes"] as const) {
      expect((await request.delete(fakeTvUrl(host, path))).ok()).toBe(true);
    }
  }
  const before = await Promise.all(Object.values(FAKE_TVS).map(({ host }) => disturbances(request, host)));
  expect(before.map(({ running }) => running.map(({ name, visible }) => ({ name, visible })))).toEqual([
    [{ name: "Netflix", visible: true }],
    [{ name: "YouTube", visible: true }],
  ]);

  await page.goto("/");
  await expect(shown(page)).toHaveText("Netflix");
  await choose(page, "Bedroom · TV");
  await expect(shown(page)).toHaveText("YouTube");
  await choose(page, "Living room · TV");
  await expect(shown(page)).toHaveText("Netflix");
  await choose(page, "Bedroom · TV");
  await expect(shown(page)).toHaveText("YouTube");

  const after = await Promise.all(Object.values(FAKE_TVS).map(({ host }) => disturbances(request, host)));
  expect(after).toEqual(before);
  for (const each of after) {
    expect(each.changes).toEqual([]);
    expect(each.keys).toEqual([]);
    expect(each.text).toEqual([]);
    expect(each.wakes).toEqual([]);
  }
});
