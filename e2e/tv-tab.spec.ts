import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { startFakeSamsungTv, type FakeSamsungTv } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TV_CONTROL_PORT, FAKE_TV_REST_PORT, FAKE_TVS, SPARE_FAKE_TV, fakeTvUrl } from "./fake-tvs.ts";
import { openSettingsOn } from "./settings.ts";

/** Started by the test that switches it off at the wall, and stopped after it if it is still on. */
let spare: FakeSamsungTv | undefined;

// The run's Hub is shared by every test, so each starts and ends with no TVs
// and no Rooms, and with the run's fake TVs on.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) await setPower(request, host, "on");
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => {
  await spare?.stop();
  spare = undefined;
  await forgetEverything(request);
});

const setPower = async (request: APIRequestContext, host: string, power: "on" | "standby"): Promise<void> => {
  expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power } })).ok()).toBe(true);
};

/** Adds Rooms, in this order, and returns each one's id by name. */
const addRooms = async (request: APIRequestContext, names: readonly string[]): Promise<Record<string, number>> => {
  const ids: Record<string, number> = {};
  for (const name of names) {
    const response = await request.post("/api/rooms", { data: { name } });
    expect(response.status()).toBe(201);
    ids[name] = ((await response.json()) as { id: number }).id;
  }
  return ids;
};

/** Adds a TV through the Hub, which pairs with the fake TV there, as Settings would. */
const addTv = async (
  request: APIRequestContext,
  address: string,
  name: string,
  roomId: number | null,
): Promise<void> => {
  const response = await request.post("/api/appliances", { data: { kind: "tv", address, name, roomId } });
  expect(response.status()).toBe(201);
};

/** Living room · TV and Bedroom · TV, the run's two fake TVs. */
const addTwoTvs = async (request: APIRequestContext): Promise<void> => {
  const rooms = await addRooms(request, ["Living room", "Bedroom"]);
  await addTv(request, FAKE_TVS.living.host, "TV", rooms["Living room"] ?? null);
  await addTv(request, FAKE_TVS.bedroom.host, "TV", rooms.Bedroom ?? null);
};

const tvList = (page: Page) => page.getByRole("region", { name: "TVs" });

const powerOf = (page: Page, title: string) => tvList(page).getByRole("listitem", { name: title }).locator(".power");

const picker = (page: Page) => page.getByRole("button", { name: /^Selected TV: / });

const pickerChoices = (page: Page) => page.getByRole("list", { name: "Choose a TV" }).getByRole("button");

const choose = async (page: Page, title: string): Promise<void> => {
  await picker(page).click();
  await page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: title, exact: true }).click();
  await expect(picker(page)).toHaveText(`Selected TV: ${title}`);
};

/** The TV tab asks the Hub again every few seconds, so it can take that long to follow a TV. */
const FOLLOWS = { timeout: 10_000 };

// FR-10: the TV tab lists the TVs by Room, in the Room order Settings sets, with "No room" last.
test('the TV tab lists every TV under its Room, in Room order, with "No room" last', async ({ page, request }) => {
  const rooms = await addRooms(request, ["Living room", "Bedroom", "Office"]);
  await addTv(request, FAKE_TVS.bedroom.host, "TV", rooms.Bedroom ?? null);
  await addTv(request, FAKE_TVS.living.host, "Spare", null);

  await page.goto("/");
  await expect(tvList(page).getByRole("heading", { level: 3 })).toHaveText(["Bedroom", "No room"]);
  await expect(tvList(page).locator(".room-name")).toHaveText(["Bedroom · TV", "Spare"]);

  // Moving the TV with no Room into the first Room, then reordering the Rooms in Settings.
  const all = (await (await request.get("/api/appliances")).json()) as { id: number; name: string }[];
  const roomless = all.find(({ name }) => name === "Spare");
  expect(
    (await request.patch(`/api/appliances/${String(roomless?.id)}`, { data: { roomId: rooms["Living room"] } })).ok(),
  ).toBe(true);
  await page.reload();
  await expect(tvList(page).getByRole("heading", { level: 3 })).toHaveText(["Living room", "Bedroom"]);

  await openSettingsOn(page, "Rooms");
  const order = page.getByRole("region", { name: "Rooms" });
  await order.getByRole("button", { name: "Move Bedroom up" }).click();
  await expect(order.getByRole("list", { name: "Room order" }).locator(".room-name")).toHaveText([
    "Bedroom",
    "Living room",
    "Office",
  ]);
  await page.getByRole("tab", { name: "TV" }).click();
  await expect(tvList(page).getByRole("heading", { level: 3 })).toHaveText(["Bedroom", "Living room"]);
  await expect(tvList(page).locator(".room-name")).toHaveText(["Bedroom · TV", "Living room · Spare"]);
});

// FR-16: on and standby read from each TV's device info, and unreachable when it is switched off at the wall.
test("each TV's power state follows the fake TV through on, standby and unreachable", async ({ page, request }) => {
  spare = await startFakeSamsungTv({
    host: SPARE_FAKE_TV.host,
    restPort: FAKE_TV_REST_PORT,
    controlPort: FAKE_TV_CONTROL_PORT,
    name: SPARE_FAKE_TV.name,
    macAddress: SPARE_FAKE_TV.macAddress,
  });
  const rooms = await addRooms(request, ["Living room", "Office"]);
  await addTv(request, FAKE_TVS.living.host, "TV", rooms["Living room"] ?? null);
  await addTv(request, SPARE_FAKE_TV.host, "TV", rooms.Office ?? null);

  await page.goto("/");
  await expect(powerOf(page, "Living room · TV")).toHaveText("On");
  await expect(powerOf(page, "Office · TV")).toHaveText("On");

  // Put in standby with its own remote, while the Remote shows it.
  await setPower(request, FAKE_TVS.living.host, "standby");
  await expect(powerOf(page, "Living room · TV")).toHaveText("Standby", FOLLOWS);
  await expect(powerOf(page, "Office · TV")).toHaveText("On");

  spare.setPowerState("standby");
  await expect(powerOf(page, "Office · TV")).toHaveText("Standby", FOLLOWS);

  // Switched off at the wall.
  await spare.stop();
  spare = undefined;
  await expect(powerOf(page, "Office · TV")).toHaveText("Unreachable", FOLLOWS);
  await expect(powerOf(page, "Living room · TV")).toHaveText("Standby");

  await setPower(request, FAKE_TVS.living.host, "on");
  await expect(powerOf(page, "Living room · TV")).toHaveText("On", FOLLOWS);
  await page.reload();
  await expect(powerOf(page, "Living room · TV")).toHaveText("On");
  await expect(powerOf(page, "Office · TV")).toHaveText("Unreachable");
});

// FR-15 and PRD §5 scenario 2, step 1: the Remote opens on the TV it was left on.
test("the Selected TV is the first TV until another is chosen, and survives a reload of the Remote", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);

  await page.goto("/");
  await expect(picker(page)).toHaveText("Selected TV: Living room · TV");
  await expect(tvList(page).getByRole("listitem", { name: "Living room · TV" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await choose(page, "Bedroom · TV");
  await expect(tvList(page).getByRole("listitem", { name: "Bedroom · TV" })).toHaveAttribute("aria-current", "true");
  await expect(tvList(page).getByRole("listitem", { name: "Living room · TV" })).not.toHaveAttribute("aria-current");

  await page.reload();
  await expect(picker(page)).toHaveText("Selected TV: Bedroom · TV");

  // And after Settings, or reopened from its home-screen icon.
  await page.getByRole("button", { name: "General settings" }).click();
  await page.getByRole("tab", { name: "TV" }).click();
  await expect(picker(page)).toHaveText("Selected TV: Bedroom · TV");
  const reopened = await page.context().newPage();
  await reopened.goto("/");
  await expect(picker(reopened)).toHaveText("Selected TV: Bedroom · TV");
});

// FR-15: "each Remote has at most one" Selected TV; two browsers are two Remotes.
test("two Remotes can each have a different Selected TV", async ({ browser, baseURL, page, request }) => {
  await addTwoTvs(request);
  const other = await browser.newContext({ ...devices["Pixel 7"], ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    const tablet = await other.newPage();
    await page.goto("/");
    await tablet.goto("/");

    await choose(page, "Bedroom · TV");
    await tablet.reload();
    await expect(picker(tablet)).toHaveText("Selected TV: Living room · TV");

    await choose(tablet, "Bedroom · TV");
    await choose(page, "Living room · TV");

    await Promise.all([page.reload(), tablet.reload()]);
    await expect(picker(page)).toHaveText("Selected TV: Living room · TV");
    await expect(picker(tablet)).toHaveText("Selected TV: Bedroom · TV");
  } finally {
    await other.close();
  }
});

// FR-15: with the Selected TV removed, the first TV in the list is selected.
test("removing the Selected TV falls back to the first TV", async ({ page, request }) => {
  await addTwoTvs(request);
  await page.goto("/");
  await choose(page, "Bedroom · TV");

  await openSettingsOn(page, "TV");
  const tvs = page.getByRole("region", { name: "TVs" });
  await tvs.getByRole("button", { name: "Remove Bedroom · TV" }).click();
  await tvs.getByRole("button", { name: "Yes, remove" }).click();
  await expect(tvs.locator(".room-row .room-name")).toHaveText(["Living room · TV"]);

  await page.getByRole("tab", { name: "TV" }).click();
  await expect(picker(page)).toHaveText("Selected TV: Living room · TV");
  await expect(tvList(page).locator(".room-name")).toHaveText(["Living room · TV"]);

  // Removed on another Remote while this one shows it, it follows too.
  await addTv(request, FAKE_TVS.bedroom.host, "TV", null);
  await expect(tvList(page).locator(".room-name")).toHaveText(["Living room · TV", "TV"], FOLLOWS);
  await choose(page, "TV");
  const all = (await (await request.get("/api/appliances")).json()) as { id: number; roomId: number | null }[];
  const roomless = all.find(({ roomId }) => roomId === null);
  expect((await request.delete(`/api/appliances/${String(roomless?.id)}`)).status()).toBe(204);
  await expect(picker(page)).toHaveText("Selected TV: Living room · TV", FOLLOWS);
  await page.reload();
  await expect(picker(page)).toHaveText("Selected TV: Living room · TV");
});

/**
 * Every TV screen, and how to get to it. Only the TV tab so far; each TV
 * screen still to come (TV Menu mode, Watch & Listen…) is added here.
 */
const TV_SCREENS: readonly { readonly name: string; readonly open: (page: Page) => Promise<void> }[] = [
  {
    name: "the TV tab",
    open: async (page) => {
      await page.goto("/");
      await page.getByRole("tab", { name: "TV" }).click();
      await expect(page.getByRole("heading", { name: "TV", level: 1 })).toBeVisible();
    },
  },
];

// FR-15: the TV picker shows every TV as Room · Name, and is one tap from every TV screen.
for (const screen of TV_SCREENS) {
  test(`the TV picker is one tap from ${screen.name}, and offers every TV as Room · Name`, async ({
    page,
    request,
  }) => {
    const rooms = await addRooms(request, ["Living room", "Bedroom"]);
    await addTv(request, FAKE_TVS.bedroom.host, "TV", rooms.Bedroom ?? null);
    await addTv(request, FAKE_TVS.living.host, "Spare", null);

    await screen.open(page);
    await expect(pickerChoices(page)).toHaveCount(0);

    await picker(page).click();

    await expect(pickerChoices(page)).toHaveText(["Bedroom · TV", "Spare"]);
    await expect(pickerChoices(page).first()).toBeInViewport();
    await expect(
      page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: "Bedroom · TV" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
}
