import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type {
  FakeKeyboard,
  RecordedConnection,
  RecordedText,
} from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";

// The run's Hub is shared by every test, so each starts and ends with no TVs
// and no Rooms, and with the run's fake TVs on, their keyboards closed, having
// recorded no connections and no text.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power: "on" } })).ok()).toBe(true);
    await setKeyboard(request, host, false);
    for (const path of ["/_fake/connections", "/_fake/text"] as const) {
      expect((await request.delete(fakeTvUrl(host, path))).ok()).toBe(true);
    }
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** Opens or closes the fake TV's on-screen keyboard, as choosing a search box on the TV would. */
const setKeyboard = async (request: APIRequestContext, host: string, open: boolean): Promise<void> => {
  const response = await request.post(fakeTvUrl(host, "/_fake/keyboard"), { data: { open } });
  expect(response.ok()).toBe(true);
};

const keyboardOf = async (request: APIRequestContext, host: string): Promise<FakeKeyboard> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/keyboard"))).json()) as FakeKeyboard;

const textsOf = async (request: APIRequestContext, host: string): Promise<RecordedText[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/text"))).json()) as RecordedText[];

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

/**
 * Opens the TV tab, and waits for the Hub to be listening on the TV's control
 * socket, as it is while the TV tab is open: a TV tells only those listening
 * when its keyboard opens.
 */
const openTvTab = async (page: Page, request: APIRequestContext, host: string): Promise<void> => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Selected TV: / })).toHaveText("Selected TV: Living room · TV");
  await expect
    .poll(async () => {
      const connections = (await (
        await request.get(fakeTvUrl(host, "/_fake/connections"))
      ).json()) as RecordedConnection[];
      return connections.some(({ outcome }) => outcome === "accepted");
    })
    .toBe(true);
};

const keyboard = (page: Page) => page.getByRole("form", { name: "TV keyboard" });
const field = (page: Page) => keyboard(page).getByRole("textbox", { name: "Text for the TV" });

/** The Remote asks about the Selected TV's keyboard every second, so it can take that long to follow the TV. */
const FOLLOWS = { timeout: 5_000 };

// FR-20: the text field is there exactly while the Selected TV's on-screen keyboard is open.
test("the text field appears when the Selected TV opens its keyboard, and goes when it closes", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await openTvTab(page, request, FAKE_TVS.living.host);
  await expect(page.getByRole("region", { name: "Keys" })).toBeVisible();
  await expect(keyboard(page)).toHaveCount(0);

  await setKeyboard(request, FAKE_TVS.living.host, true);
  await expect(field(page)).toBeVisible(FOLLOWS);
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue("");

  await setKeyboard(request, FAKE_TVS.living.host, false);
  await expect(keyboard(page)).toHaveCount(0, FOLLOWS);

  // Another TV's keyboard opening shows nothing for the Selected TV.
  await setKeyboard(request, FAKE_TVS.bedroom.host, true);
  for (let reading = 0; reading < 2; reading += 1) {
    await page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/keyboard"));
  }
  await expect(keyboard(page)).toHaveCount(0);

  // A TV going into standby closes its keyboard.
  await setKeyboard(request, FAKE_TVS.living.host, true);
  await expect(field(page)).toBeVisible(FOLLOWS);
  expect(
    (await request.post(fakeTvUrl(FAKE_TVS.living.host, "/_fake/power"), { data: { power: "standby" } })).ok(),
  ).toBe(true);
  await expect(keyboard(page)).toHaveCount(0, FOLLOWS);
});

// FR-20, and PRD §5 scenario 4: type a search on the phone's own keyboard, and it appears on the TV.
test('typing "cosmos documentary" and submitting it delivers exactly that text to the TV, and only that TV', async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await openTvTab(page, request, FAKE_TVS.living.host);
  await setKeyboard(request, FAKE_TVS.living.host, true);
  await expect(field(page)).toBeFocused(FOLLOWS);

  await field(page).pressSequentially("cosmos documentary");
  await field(page).press("Enter");

  await expect
    .poll(async () =>
      (await textsOf(request, FAKE_TVS.living.host)).map(({ text, keyboardOpen }) => ({ text, keyboardOpen })),
    )
    .toEqual([{ text: "cosmos documentary", keyboardOpen: true }]);
  // Submitting closes the TV's keyboard, and with it the field.
  expect(await keyboardOf(request, FAKE_TVS.living.host)).toEqual({ open: false });
  await expect(keyboard(page)).toHaveCount(0, FOLLOWS);
  expect(await textsOf(request, FAKE_TVS.bedroom.host)).toEqual([]);
});

// FR-20: text that isn't ASCII arrives intact.
test('"café", and text in other scripts, arrives intact', async ({ page, request }) => {
  await addTwoTvs(request);
  await openTvTab(page, request, FAKE_TVS.living.host);

  for (const text of ["café", "日本語のドキュメンタリー", "Ünïcödé 🎬"]) {
    await setKeyboard(request, FAKE_TVS.living.host, true);
    await expect(field(page)).toBeVisible(FOLLOWS);
    await field(page).pressSequentially(text);
    await keyboard(page).getByRole("button", { name: "Send" }).click();
    await expect(keyboard(page)).toHaveCount(0, FOLLOWS);
  }

  expect((await textsOf(request, FAKE_TVS.living.host)).map(({ text }) => text)).toEqual([
    "café",
    "日本語のドキュメンタリー",
    "Ünïcödé 🎬",
  ]);
});
