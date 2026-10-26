import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { RemoteKey } from "../packages/shared/src/index.ts";
import { SAMSUNG_KEY_CODES } from "../packages/hub/src/drivers/samsung-tv/keys.ts";
import type { RecordedConnection, RecordedKey } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// The run's Hub is shared by every test, so each starts with no TVs, no
// Rooms, and fake TVs that have recorded nothing.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    for (const path of ["/_fake/connections", "/_fake/keys"] as const) {
      expect((await request.delete(fakeTvUrl(host, path))).ok()).toBe(true);
    }
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** Living room · TV and Bedroom · TV, the run's two fake TVs, and the id of each. */
const addTwoTvs = async (request: APIRequestContext): Promise<{ living: number; bedroom: number }> => {
  const ids: number[] = [];
  for (const [room, host] of [
    ["Living room", FAKE_TVS.living.host],
    ["Bedroom", FAKE_TVS.bedroom.host],
  ] as const) {
    const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: room } })).json()) as {
      id: number;
    };
    const response = await request.post("/api/appliances", { data: { kind: "tv", address: host, name: "TV", roomId } });
    expect(response.status()).toBe(201);
    ids.push(((await response.json()) as { id: number }).id);
  }
  const [living = 0, bedroom = 0] = ids;
  return { living, bedroom };
};

const keysOf = async (request: APIRequestContext, host: string): Promise<RecordedKey[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/keys"))).json()) as RecordedKey[];

/** The keys the fake TV has received, once it has received `count`. */
const received = async (request: APIRequestContext, host: string, count: number): Promise<RecordedKey[]> => {
  await expect.poll(async () => (await keysOf(request, host)).length, { intervals: [5] }).toBe(count);
  return keysOf(request, host);
};

/** Every key of FR-18, by the name the Remote gives its button. */
const KEYS: readonly (readonly [name: string, key: RemoteKey])[] = [
  ["Back", "back"],
  ["Home", "home"],
  ["Source", "source"],
  ["Menu", "menu"],
  ["Tools", "tools"],
  ["Info", "info"],
  ["Up", "up"],
  ["Left", "left"],
  ["OK", "ok"],
  ["Right", "right"],
  ["Down", "down"],
  ["Rewind", "rewind"],
  ["Play", "play"],
  ["Pause", "pause"],
  ["Stop", "stop"],
  ["Fast-forward", "fast-forward"],
  ["Red", "red"],
  ["Green", "green"],
  ["Yellow", "yellow"],
  ["Blue", "blue"],
  ...(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const).map((digit) => [digit, digit] as const),
  ["Channel up", "channel-up"],
  ["Channel down", "channel-down"],
];

const keyPad = (page: Page) => page.getByRole("region", { name: "Keys" });

const key = (page: Page, name: string) => keyPad(page).getByRole("button", { name, exact: true });

const openTvTab = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Selected TV: / })).toHaveText("Selected TV: Living room · TV");
};

// FR-18: every key reaches the Selected TV, through the Hub, as the code the TV takes for it.
test("every key on the key pad reaches the Selected TV as its key code, and only that TV", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await openTvTab(page);

  for (const [name] of KEYS) await key(page, name).click();

  const codes = (await received(request, FAKE_TVS.living.host, KEYS.length)).map(({ code }) => code);
  expect(codes).toEqual(KEYS.map(([, each]) => SAMSUNG_KEY_CODES[each]));
  expect(await keysOf(request, FAKE_TVS.bedroom.host)).toEqual([]);

  await page.getByRole("button", { name: /^Selected TV: / }).click();
  await page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: "Bedroom · TV" }).click();
  await key(page, "OK").click();
  expect((await received(request, FAKE_TVS.bedroom.host, 1)).map(({ code }) => code)).toEqual([SAMSUNG_KEY_CODES.ok]);
});

// FR-22: the TV acts on a key within 200 ms of the tap. Timed from before Playwright starts the tap to when the fake TV
// read the key, on one clock, so it overstates the time, never understates it.
test("the fake TV receives each key within 200 ms of the tap, the first included", async ({ page, request }) => {
  await addTwoTvs(request);
  await openTvTab(page);
  const taps = ["Down", "Down", "Right", "OK", "Back", "Home", "Up", "OK", "Channel up", "5"];

  const took: number[] = [];
  for (const [index, name] of taps.entries()) {
    const tapped = Date.now();
    await key(page, name).click();
    const keys = await received(request, FAKE_TVS.living.host, index + 1);
    took.push((keys.at(-1)?.receivedAt ?? Infinity) - tapped);
  }

  console.log(`Tap to key received, in ms: ${took.join(", ")}`);
  for (const each of took) expect(each).toBeLessThanOrEqual(200);
});

// FR-22: the Hub keeps the TV's control socket open, rather than connecting for each key.
// The TV tab opens that socket as it starts listening for the TV's keyboard (FR-20), if the first key hasn't.
test("every key goes on one control socket, kept open", async ({ page, request }) => {
  await addTwoTvs(request);
  await openTvTab(page);

  for (const name of ["Up", "Up", "OK", "Back", "Menu", "Down", "OK"]) await key(page, name).click();

  const keys = await received(request, FAKE_TVS.living.host, 7);
  const connections = (await (
    await request.get(fakeTvUrl(FAKE_TVS.living.host, "/_fake/connections"))
  ).json()) as RecordedConnection[];
  // Paired when the TV was added, then one connection on its token for every key, and the keyboard.
  expect(connections.map(({ outcome }) => outcome)).toEqual(["paired", "accepted"]);
  expect(new Set(keys.map(({ connection }) => connection))).toEqual(new Set([1]));
});

// FR-30: the factory key is refused by the Driver, even asked for straight from the Hub's API rather than the Remote.
test("the factory key, sent straight to the Hub, is refused and never reaches the TV", async ({ request }) => {
  const { living } = await addTwoTvs(request);

  const response = await request.post(`/api/appliances/${String(living)}/keys`, { data: { key: "factory" } });

  expect(response.status()).toBe(403);
  expect(((await response.json()) as { error: string }).error).toBe(
    "The Hub never sends the Factory key: it opens the TV's service menu, which can misconfigure or break the TV.",
  );
  expect((await request.post(`/api/appliances/${String(living)}/keys`, { data: { key: "home" } })).status()).toBe(204);
  expect((await received(request, FAKE_TVS.living.host, 1)).map(({ code }) => code)).toEqual([SAMSUNG_KEY_CODES.home]);
});

// NFR-2: the keys are sized for a thumb, and laid out to fit a phone's screen.
test("the keys are sized and laid out for a phone", async ({ page, request }) => {
  await addTwoTvs(request);
  await openTvTab(page);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("The phone project has a viewport");

  // The key pad, and each group of keys in it, fits across the phone, so nothing scrolls sideways.
  for (const part of [keyPad(page), ...(await keyPad(page).getByRole("group").all())]) {
    const box = await part.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  }

  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const [name] of KEYS) {
    const box = await key(page, name).boundingBox();
    if (box === null) throw new Error(`${name} is not shown`);
    boxes.set(name, box);
    // At least the 44 × 44 CSS pixels a fingertip needs.
    expect(box.width, name).toBeGreaterThanOrEqual(44);
    expect(box.height, name).toBeGreaterThanOrEqual(44);
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(viewport.width);
  }

  // No two keys overlap, so a tap lands on one key only.
  const all = [...boxes.entries()];
  for (const [index, [name, a]] of all.entries()) {
    for (const [other, b] of all.slice(index + 1)) {
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `${name} and ${other} overlap`).toBe(false);
    }
  }

  // The D-pad is a cross around OK, in sight when the TV tab opens, with keys bigger than the rest.
  const centre = (name: string) => {
    const box = boxes.get(name);
    if (box === undefined) throw new Error(`${name} is not shown`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const ok = centre("OK");
  expect(centre("Up").y).toBeLessThan(ok.y);
  expect(centre("Down").y).toBeGreaterThan(ok.y);
  expect(centre("Left").x).toBeLessThan(ok.x);
  expect(centre("Right").x).toBeGreaterThan(ok.x);
  for (const name of ["Up", "Down"]) expect(Math.abs(centre(name).x - ok.x)).toBeLessThan(1);
  for (const name of ["Left", "Right"]) expect(Math.abs(centre(name).y - ok.y)).toBeLessThan(1);
  expect(Math.abs(ok.x - viewport.width / 2)).toBeLessThan(2);
  for (const name of ["Up", "Left", "OK", "Right", "Down"]) {
    await expect(key(page, name)).toBeInViewport();
    expect(boxes.get(name)?.height ?? 0).toBeGreaterThan(boxes.get("Back")?.height ?? Infinity);
  }

  // The digits are a phone's number pad: 1 2 3 across the top, 0 under 8.
  expect(centre("1").y).toBe(centre("3").y);
  expect(centre("1").x).toBeLessThan(centre("2").x);
  expect(centre("1").y).toBeLessThan(centre("4").y);
  expect(Math.abs(centre("0").x - centre("8").x)).toBeLessThan(1);
  expect(centre("0").y).toBeGreaterThan(centre("8").y);
});
