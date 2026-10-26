import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { MenuShortcut, RemoteKey } from "../packages/shared/src/index.ts";
import { SAMSUNG_KEY_CODES, SAMSUNG_SHORTCUT_KEY_CODES } from "../packages/hub/src/drivers/samsung-tv/keys.ts";
import type { FakeIgnoredKeys, RecordedKey } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

/** Ignores these keys on the fake TV from now on, as a model or firmware without them would. */
const ignoreKeys = async (request: APIRequestContext, host: string, ignored: FakeIgnoredKeys): Promise<void> => {
  expect((await request.put(fakeTvUrl(host, "/_fake/ignored-keys"), { data: ignored })).ok()).toBe(true);
};

// The run's Hub is shared by every test, so each starts and ends with no TVs, no Rooms, and fake TVs that ignore no
// key and have recorded nothing.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    await ignoreKeys(request, host, { keys: [], answer: "silence" });
    for (const path of ["/_fake/connections", "/_fake/keys"] as const) {
      expect((await request.delete(fakeTvUrl(host, path))).ok()).toBe(true);
    }
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

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

const keysOf = async (request: APIRequestContext, host: string): Promise<RecordedKey[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/keys"))).json()) as RecordedKey[];

/** The keys the fake TV has received, once it has received `count`. */
const received = async (request: APIRequestContext, host: string, count: number): Promise<RecordedKey[]> => {
  await expect.poll(async () => (await keysOf(request, host)).length, { intervals: [5] }).toBe(count);
  return keysOf(request, host);
};

/** The keys of FR-23, by the name the Remote gives each button. */
const KEYS: readonly (readonly [name: string, key: RemoteKey])[] = [
  ["Back", "back"],
  ["Home", "home"],
  ["Menu", "menu"],
  ["Tools", "tools"],
  ["Up", "up"],
  ["Left", "left"],
  ["OK", "ok"],
  ["Right", "right"],
  ["Down", "down"],
];

/** The shortcuts of FR-24, by the name the Remote gives each button. */
const SHORTCUTS: readonly (readonly [name: string, shortcut: MenuShortcut])[] = [
  ["Picture mode", "picture-mode"],
  ["Picture size", "picture-size"],
  ["Sleep timer", "sleep-timer"],
  ["Energy saving", "energy-saving"],
  ["Captions", "captions"],
  ["Audio description", "audio-description"],
  ["Audio track", "audio-track"],
  ["Input source", "input-source"],
];

const menuMode = (page: Page) => page.getByRole("dialog", { name: "TV Menu mode" });

const button = (page: Page, name: string) => menuMode(page).getByRole("button", { name, exact: true });

/** Opens the TV tab, with Living room · TV selected, and TV Menu mode over it. */
const openMenuMode = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Selected TV: / })).toHaveText("Selected TV: Living room · TV");
  await page.getByRole("button", { name: "TV Menu mode" }).click();
  await expect(menuMode(page)).toBeVisible();
};

// FR-23 and NFR-2: TV Menu mode fills a phone's screen, with every key in sight unscrolled, and big enough for a thumb.
test("TV Menu mode fills the phone's screen, over the tab bar, with a D-pad bigger than the key pad's", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await page.goto("/");
  const keyPadOk = await page
    .getByRole("region", { name: "Keys" })
    .getByRole("button", { name: "OK", exact: true })
    .boundingBox();
  await page.getByRole("button", { name: "TV Menu mode" }).click();
  const viewport = page.viewportSize();
  if (viewport === null || keyPadOk === null)
    throw new Error("The phone project has a viewport, and the key pad an OK");

  expect(await menuMode(page).boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  // The tab bar is still there, beneath it: a tap there lands on TV Menu mode instead.
  await expect(page.getByRole("tab", { name: "Rooms" }).click({ trial: true, timeout: 1_000 })).rejects.toThrow(
    /intercepts pointer events/,
  );

  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const name of [...KEYS.map(([each]) => each), ...SHORTCUTS.map(([each]) => each), "Close"]) {
    const box = await button(page, name).boundingBox();
    if (box === null) throw new Error(`${name} is not shown`);
    boxes.set(name, box);
    await expect(button(page, name), name).toBeInViewport({ ratio: 1 });
    expect(box.width, name).toBeGreaterThanOrEqual(44);
    expect(box.height, name).toBeGreaterThanOrEqual(44);
  }
  const all = [...boxes.entries()];
  for (const [index, [name, a]] of all.entries()) {
    for (const [other, b] of all.slice(index + 1)) {
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `${name} and ${other} overlap`).toBe(false);
    }
  }
  for (const name of ["Up", "Left", "OK", "Right", "Down"]) {
    expect(boxes.get(name)?.width ?? 0, name).toBeGreaterThan(keyPadOk.width);
    expect(boxes.get(name)?.height ?? 0, name).toBeGreaterThan(keyPadOk.height);
  }

  await button(page, "Close").click();
  await expect(menuMode(page)).toHaveCount(0);
});

// FR-23: every key in TV Menu mode reaches the Selected TV, through the Hub, as the code the TV takes for it.
test("every key in TV Menu mode reaches the Selected TV as its key code, and only that TV", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await openMenuMode(page);

  for (const [name] of KEYS) await button(page, name).click();

  const codes = (await received(request, FAKE_TVS.living.host, KEYS.length)).map(({ code }) => code);
  expect(codes).toEqual(KEYS.map(([, key]) => SAMSUNG_KEY_CODES[key]));
  expect(await keysOf(request, FAKE_TVS.bedroom.host)).toEqual([]);
});

// FR-24: each shortcut reaches the TV as the key the Samsung TV Driver maps it to, and the Remote never claims it worked.
test("every shortcut reaches the Selected TV as the key the Driver maps it to, reported as sent, not as done", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await openMenuMode(page);

  for (const [name] of SHORTCUTS) {
    await button(page, name).click();
    await expect(menuMode(page).getByRole("status")).toHaveText(
      `Sent ${name} to Living room · TV, which doesn't say whether it took it. ` +
        "If nothing changed on the TV, it ignores this shortcut: find the setting with Menu instead.",
    );
  }

  const keys = await received(request, FAKE_TVS.living.host, SHORTCUTS.length);
  expect(keys.map(({ code }) => code)).toEqual(SHORTCUTS.map(([, shortcut]) => SAMSUNG_SHORTCUT_KEY_CODES[shortcut]));
  expect(keys.every(({ command }) => command === "Click")).toBe(true);
  await expect(menuMode(page).getByRole("alert")).toHaveCount(0);
});

// FR-24: a shortcut the TV ignores is reported to the person, not silently dropped.
test("a shortcut the fake TV ignores, saying so, is reported as ignored", async ({ page, request }) => {
  await addTwoTvs(request);
  await ignoreKeys(request, FAKE_TVS.living.host, {
    keys: [SAMSUNG_SHORTCUT_KEY_CODES["energy-saving"]],
    answer: "error",
  });
  await openMenuMode(page);

  await button(page, "Energy saving").click();

  await expect(menuMode(page).getByRole("alert")).toHaveText(
    "Living room · TV ignored Energy saving: its model or firmware doesn't take that shortcut. Find the setting with Menu instead.",
  );
  expect((await received(request, FAKE_TVS.living.host, 1)).map(({ code, ignored }) => ({ code, ignored }))).toEqual([
    { code: SAMSUNG_SHORTCUT_KEY_CODES["energy-saving"], ignored: true },
  ]);

  // The next shortcut, which the TV takes, says no more than that it was sent.
  await button(page, "Picture mode").click();
  await expect(menuMode(page).getByRole("status")).toContainText("Sent Picture mode to Living room · TV");
  await expect(menuMode(page).getByRole("alert")).toHaveCount(0);
});

// FR-24: a TV that ignores a key without a word, as real ones are reported to, can't be told from one that took it,
// so the person is told the TV didn't confirm it, and what to look for, rather than that it worked.
test("a shortcut the fake TV ignores without a word is reported as unconfirmed, never as done", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await ignoreKeys(request, FAKE_TVS.living.host, {
    keys: [SAMSUNG_SHORTCUT_KEY_CODES["audio-description"]],
    answer: "silence",
  });
  await openMenuMode(page);

  await button(page, "Audio description").click();

  await expect(menuMode(page).getByRole("status")).toHaveText(
    "Sent Audio description to Living room · TV, which doesn't say whether it took it. " +
      "If nothing changed on the TV, it ignores this shortcut: find the setting with Menu instead.",
  );
  expect((await received(request, FAKE_TVS.living.host, 1))[0]?.ignored).toBe(true);
});

// FR-22: the Hub listens for the TV after a shortcut, but a key tapped next doesn't wait for that.
test("a key tapped straight after a shortcut reaches the TV within 200 ms of the tap", async ({ page, request }) => {
  await addTwoTvs(request);
  await ignoreKeys(request, FAKE_TVS.living.host, {
    keys: [SAMSUNG_SHORTCUT_KEY_CODES["picture-mode"]],
    answer: "error",
  });
  await openMenuMode(page);

  await button(page, "Picture mode").click();
  await received(request, FAKE_TVS.living.host, 1);
  const tapped = Date.now();
  await button(page, "Down").click();
  const keys = await received(request, FAKE_TVS.living.host, 2);

  const took = (keys[1]?.receivedAt ?? Infinity) - tapped;
  console.log(`Tap to key received, just after a shortcut, in ms: ${String(took)}`);
  expect(took).toBeLessThanOrEqual(200);
  // The Hub was still listening for the TV then: what it heard comes after.
  await expect(menuMode(page).getByRole("alert")).toContainText("ignored Picture mode");
});

/** Values a TV's settings take, any of which shown would claim to know what the Hub can't read (FR-25). */
const SETTING_VALUES =
  /\b(?:Standard|Dynamic|Movie|Natural|Vivid|Filmmaker|Eco|16:9|4:3|Fit to screen|Zoom|Custom|HDMI ?\d?|Low|Medium|High|Auto|\d+ ?min(?:ute)?s?|English|Stereo|Dolby)\b/;

// FR-25: the TV tab never shows a setting's value as if it were known, before or after its shortcut is used.
test("no setting's value is shown anywhere in the TV tab, nor in TV Menu mode", async ({ page, request }) => {
  await addTwoTvs(request);
  await page.goto("/");
  const tab = page.getByRole("tabpanel");
  await expect(page.getByRole("region", { name: "Apps" }).getByRole("listitem").first()).toBeVisible();
  expect(await tab.innerText()).not.toMatch(SETTING_VALUES);

  await page.getByRole("button", { name: "TV Menu mode" }).click();
  for (const [name] of SHORTCUTS) {
    await expect(button(page, name)).toHaveText(name);
    await button(page, name).click();
  }
  await expect(menuMode(page).getByRole("status")).toContainText("Sent Input source");
  expect(await menuMode(page).innerText()).not.toMatch(SETTING_VALUES);

  await button(page, "Close").click();
  expect(await tab.innerText()).not.toMatch(SETTING_VALUES);
});

test("TV Menu mode is modal: nothing behind it can be reached until it closes, when focus goes back", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await openMenuMode(page);

  await expect(page.locator("dialog:modal")).toHaveAccessibleName("TV Menu mode");
  for (let tab = 0; tab < 25; tab += 1) {
    await page.keyboard.press("Tab");
    // Tab may leave for the browser's own toolbar, but never for the page behind.
    await expect(page.locator(":focus:not(dialog:modal, dialog:modal *)")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(menuMode(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "TV Menu mode" })).toBeFocused();
});
