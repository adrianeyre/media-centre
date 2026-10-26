import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { Appliance } from "../packages/shared/src/index.ts";
import { fakeHiveUrl, forgetHive, signInToFakeHive } from "./fake-hive.ts";

// The run's Hub is shared by every test, so each starts and ends signed out
// of Hive, which removes its Appliances, with no other Appliances and no
// Rooms, and with the fake Hive cloud up, its products as they began.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  await forgetHive(request);
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** The tab asks every 30 seconds while it is open: the page's clock is moved on past that, rather than waited for. */
const REFRESH = "00:31";

/** A product as the fake says it is now. */
interface FakeProduct {
  readonly id: string;
  readonly name: string;
  readonly mode: string;
  readonly target: number | null;
  readonly boost: number | null;
}

const products = async (request: APIRequestContext): Promise<FakeProduct[]> =>
  (await (await request.get(fakeHiveUrl("/_fake/state"))).json()) as FakeProduct[];

const product = async (request: APIRequestContext, name: string): Promise<FakeProduct | undefined> =>
  (await products(request)).find((each) => each.name === name);

/** Changes a product at the fake, as Hive's app would. */
const setAtTheFake = async (request: APIRequestContext, name: string, change: object): Promise<void> => {
  const id = (await product(request, name))?.id;
  expect((await request.post(fakeHiveUrl("/_fake/state"), { data: { id, ...change } })).ok()).toBe(true);
};

/** The requests the fake answered, as "METHOD outcome": by whatever path Hive's API has, which only the Driver and the fake know. */
const fakeRequests = async (request: APIRequestContext): Promise<string[]> =>
  ((await (await request.get(fakeHiveUrl("/_fake/requests"))).json()) as { request: string; outcome: string }[]).map(
    ({ request: asked, outcome }) => `${asked.split(" ")[0] ?? ""} ${outcome}`,
  );

const hiveAppliance = async (request: APIRequestContext, name: string): Promise<Appliance> => {
  const found = ((await (await request.get("/api/appliances")).json()) as Appliance[]).find(
    (each) => each.name === name,
  );
  if (found === undefined) throw new Error(`No Appliance is called ${name}`);
  return found;
};

const addRoom = async (request: APIRequestContext, name: string): Promise<number> =>
  ((await (await request.post("/api/rooms", { data: { name } })).json()) as { id: number }).id;

const moveTo = async (request: APIRequestContext, name: string, roomId: number): Promise<void> => {
  const { id } = await hiveAppliance(request, name);
  expect((await request.patch(`/api/appliances/${String(id)}`, { data: { roomId } })).ok()).toBe(true);
};

/** Opens the Heating tab, with the page's clock in the test's hands, and waits for it to have read Hive. */
const openHeating = async (page: Page): Promise<void> => {
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("tab", { name: "Heating" }).click();
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20°");
};

const widget = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const summary = (page: Page, title: string) => widget(page, title).locator(".aircon-summary").first();
const target = (page: Page, title: string, group = "Target temperature") =>
  widget(page, title).getByRole("status", { name: `${group} set` });

const boost = async (page: Page, title: string, duration: string, raise = 0): Promise<void> => {
  await widget(page, title).getByRole("button", { name: "Boost…" }).click();
  const dialog = page.getByRole("dialog", { name: `Boost ${title}` });
  for (let step = 0; step < raise; step += 1) {
    await dialog.getByRole("button", { name: "Raise the Boost temperature" }).click();
  }
  await dialog.getByRole("combobox", { name: "For" }).selectOption({ label: duration });
  await dialog.getByRole("button", { name: "Boost", exact: true }).click();
};

// FR-62, FR-63, FR-65, FR-66.
test("each control reaches the fake and changes its state, and a change made at the fake shows on the Remote", async ({
  page,
  request,
}) => {
  await signInToFakeHive(request);
  const bedroom = await addRoom(request, "Bedroom");
  await moveTo(request, "Bedroom", bedroom);
  await openHeating(page);
  const valve = "Bedroom · Bedroom";

  // A Heating: its target in half degrees, its mode.
  await widget(page, "Downstairs").getByRole("button", { name: "Raise Downstairs's target temperature" }).click();
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20.5°");
  await widget(page, "Downstairs").getByRole("radio", { name: "Manual" }).check();
  await expect(summary(page, "Downstairs")).toHaveText("Manual, 20.5°");
  expect(await product(request, "Downstairs")).toMatchObject({ mode: "manual", target: 20.5 });

  // A Radiator Valve, under its Room, with the Heating zone Hive reports.
  await expect(widget(page, valve)).toContainText("Heating zoneUpstairs");
  await widget(page, valve)
    .getByRole("button", { name: `Lower ${valve}'s target temperature` })
    .click();
  await expect(summary(page, valve)).toHaveText("Schedule, 17.5°");
  await widget(page, valve).getByRole("radio", { name: "Off" }).check();
  await expect(summary(page, valve)).toHaveText("Off, 17.5°");
  expect(await product(request, "Bedroom")).toMatchObject({ mode: "off", target: 17.5 });

  // The Hot Water: Schedule, On or Off.
  await widget(page, "Hot Water").getByRole("radio", { name: "On" }).check();
  await expect(summary(page, "Hot Water")).toHaveText("On");
  expect(await product(request, "Hot Water")).toMatchObject({ mode: "on" });

  // As Hive's app, or the weather, changes them, the tab shows it as it next reads Hive.
  await setAtTheFake(request, "Upstairs", { target: 23, mode: "manual", temperature: 21.5, working: true });
  await setAtTheFake(request, "Study", { battery: 10 });
  await page.clock.fastForward(REFRESH);
  await expect(summary(page, "Upstairs")).toHaveText("Manual, 23°");
  await expect(widget(page, "Upstairs")).toContainText("Reads21.5°");
  await expect(widget(page, "Upstairs")).toContainText("Calling for heat");
  await expect(widget(page, "Study")).toContainText("Low battery");
  await expect(widget(page, "Living Room")).not.toContainText("Low battery");
});

// FR-64.
test('Whole home changes every Heating, shows "Mixed" where they differ, and names a Heating the fake refuses', async ({
  page,
  request,
}) => {
  await signInToFakeHive(request);
  await openHeating(page);
  await setAtTheFake(request, "Upstairs", { target: 20 });
  await page.clock.fastForward(REFRESH);
  await expect(summary(page, "Whole home")).toHaveText("Schedule, 20°");

  await widget(page, "Whole home").getByRole("button", { name: "Raise every Heating's target temperature" }).click();
  await expect(summary(page, "Whole home")).toHaveText("Schedule, 20.5°");
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20.5°");
  await expect(summary(page, "Upstairs")).toHaveText("Schedule, 20.5°");
  // Never a Radiator Valve nor the Hot Water.
  expect((await products(request)).map(({ name, target: each }) => [name, each])).toEqual([
    ["Downstairs", 20.5],
    ["Upstairs", 20.5],
    ["Bedroom", 18],
    ["Study", 20],
    ["Living Room", 21],
    ["Hot Water", null],
  ]);

  await setAtTheFake(request, "Upstairs", { target: 18 });
  await page.clock.fastForward(REFRESH);
  await expect(summary(page, "Whole home")).toHaveText("Mixed");
  await expect(target(page, "Whole home")).toHaveText("Mixed");

  await setAtTheFake(request, "Upstairs", { refusesChanges: true });
  await widget(page, "Whole home").getByRole("radio", { name: "Off" }).check();
  await expect(widget(page, "Whole home").getByRole("alert")).toHaveText("Hive refused this for Upstairs.");
  await expect(summary(page, "Downstairs")).toHaveText("Off, 20.5°");
  await expect(summary(page, "Upstairs")).toHaveText("Schedule, 18°");
  expect((await products(request)).slice(0, 2).map(({ mode }) => mode)).toEqual(["off", "schedule"]);
});

// FR-65.
test("a Room-wide target changes every Radiator Valve in the Room, and none outside it", async ({ page, request }) => {
  await signInToFakeHive(request);
  const upstairs = await addRoom(request, "Upstairs");
  const lounge = await addRoom(request, "Lounge");
  await moveTo(request, "Bedroom", upstairs);
  await moveTo(request, "Study", upstairs);
  await moveTo(request, "Living Room", lounge);
  await openHeating(page);

  // Each Radiator Valve is a widget of its own, by Room, in Room order, after the Hot Water,
  // a Room with more than one led by its Room-wide target's.
  await expect(page.locator("[data-widget] h2")).toHaveText([
    "Whole home",
    "Downstairs",
    "Upstairs",
    "Hot Water",
    "Upstairs · Radiator Valves",
    "Upstairs · Bedroom",
    "Upstairs · Study",
    "Lounge · Living Room",
  ]);
  const room = widget(page, "Upstairs · Radiator Valves");
  await expect(target(page, "Upstairs · Radiator Valves", "Every Radiator Valve in Upstairs")).toHaveText("Mixed");
  // A Room with one has none.
  await expect(widget(page, "Lounge · Radiator Valves")).toHaveCount(0);

  await room.getByRole("button", { name: "Raise every Radiator Valve's target in Upstairs" }).click();
  await expect(target(page, "Upstairs · Radiator Valves", "Every Radiator Valve in Upstairs")).toHaveText("19.5°");
  await expect(summary(page, "Upstairs · Bedroom")).toHaveText("Schedule, 19.5°");
  await expect(summary(page, "Upstairs · Study")).toHaveText("Schedule, 19.5°");
  expect((await products(request)).map(({ name, target: each }) => [name, each])).toEqual([
    ["Downstairs", 20],
    ["Upstairs", 19],
    ["Bedroom", 19.5],
    ["Study", 19.5],
    ["Living Room", 21],
    ["Hot Water", null],
  ]);

  // One that refuses it is named.
  await setAtTheFake(request, "Study", { refusesChanges: true });
  await room.getByRole("button", { name: "Raise every Radiator Valve's target in Upstairs" }).click();
  await expect(room.getByRole("alert")).toHaveText("Hive refused this for Upstairs · Study.");
  expect((await products(request)).slice(2, 4).map(({ target: each }) => each)).toEqual([20, 19.5]);
});

// FR-63, FR-66.
test("Boosts show their time left and can be cancelled", async ({ page, request }) => {
  await signInToFakeHive(request);
  await openHeating(page);

  await boost(page, "Downstairs", "1 h", 2);
  await expect(summary(page, "Downstairs")).toHaveText("Boost to 22°, 1 h left");
  expect(await product(request, "Downstairs")).toMatchObject({ mode: "boost", target: 22, boost: 60 });

  await boost(page, "Hot Water", "30 min");
  await expect(summary(page, "Hot Water")).toHaveText("Boost, 30 min left");
  expect(await product(request, "Hot Water")).toMatchObject({ mode: "boost", boost: 30 });

  // A quarter of an hour on, by Hive's clock, as the tab next reads it.
  expect((await request.post(fakeHiveUrl("/_fake/clock"), { data: { minutes: 15 } })).ok()).toBe(true);
  await page.clock.fastForward(REFRESH);
  await expect(summary(page, "Downstairs")).toHaveText("Boost to 22°, 45 min left");
  await expect(summary(page, "Hot Water")).toHaveText("Boost, 15 min left");

  await widget(page, "Downstairs").getByRole("button", { name: "Cancel Boost" }).click();
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20°");
  await widget(page, "Hot Water").getByRole("button", { name: "Cancel Boost" }).click();
  await expect(summary(page, "Hot Water")).toHaveText("Schedule");
  expect(await product(request, "Downstairs")).toMatchObject({ mode: "schedule", target: 20, boost: null });
  expect(await product(request, "Hot Water")).toMatchObject({ mode: "schedule", boost: null });
});

// FR-68.
for (const name of ["Downstairs", "Living Room", "Hot Water"]) {
  test(`a change the fake refuses to ${name} is shown as refused, and the control shows what the fake reports`, async ({
    page,
    request,
  }) => {
    await signInToFakeHive(request);
    await openHeating(page);
    await setAtTheFake(request, name, { refusesChanges: true });

    const shown = widget(page, name);
    const before = await summary(page, name).textContent();
    await shown.getByRole("radio", { name: "Off" }).check();
    await expect(shown.getByRole("alert")).toHaveText("Hive refused this. It shows what Hive reports.");
    await expect(summary(page, name)).toHaveText(before ?? "");
    await expect(shown.getByRole("radio", { name: "Schedule" })).toBeChecked();
    expect(await product(request, name)).toMatchObject({ mode: "schedule" });
  });
}

// FR-68: Hive's cloud gone, as the internet down, and back; and one Radiator Valve Hive can't reach.
test("stopping the fake shows \"Can't reach Hive\" and disables every control; restarting it brings them back; a valve taken offline can't be reached", async ({
  page,
  request,
}) => {
  await signInToFakeHive(request);
  await openHeating(page);

  expect((await request.post(fakeHiveUrl("/_fake/outage"), { data: { down: true } })).ok()).toBe(true);
  await page.clock.fastForward(REFRESH);
  await expect(page.getByRole("alert")).toContainText("Can't reach Hive.");
  const controls = page.locator("[data-widget] .widget-body").locator("button, input");
  expect(await controls.count()).toBeGreaterThan(20);
  for (const control of await controls.all()) await expect(control).toBeDisabled();
  await expect(target(page, "Downstairs")).toHaveText("–");
  // The other tabs carry on.
  await page.getByRole("tab", { name: "Lights" }).click();
  await expect(page.getByRole("region", { name: "No Lights yet" })).toBeVisible();
  await page.getByRole("tab", { name: "Heating" }).click();
  await expect(page.getByRole("alert")).toContainText("Can't reach Hive.");

  // Back by itself, as the tab goes on asking.
  expect((await request.post(fakeHiveUrl("/_fake/outage"), { data: { down: false } })).ok()).toBe(true);
  await page.clock.fastForward(REFRESH);
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20°");
  await expect(page.getByText(/^Can't reach Hive/)).toHaveCount(0);
  await expect(widget(page, "Downstairs").getByRole("radio", { name: "Off" })).toBeEnabled();

  await setAtTheFake(request, "Living Room", { online: false });
  await page.clock.fastForward(REFRESH);
  const valve = widget(page, "Living Room");
  await expect(summary(page, "Living Room")).toHaveText("Can't reach this Radiator Valve");
  for (const control of await valve.locator("button, input").all()) await expect(control).toBeDisabled();
  await expect(widget(page, "Bedroom").getByRole("radio", { name: "Off" })).toBeEnabled();
  await setAtTheFake(request, "Living Room", { online: true });
  await page.clock.fastForward(REFRESH);
  await expect(summary(page, "Living Room")).toHaveText("Schedule, 21°");
});

// FR-62: nothing is read while no Remote has the tab open.
test("the Hub reads the fake only while a Remote has the Heating tab open", async ({ page, request }) => {
  await signInToFakeHive(request);
  expect((await request.delete(fakeHiveUrl("/_fake/requests"))).ok()).toBe(true);
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Heating" })).toBeVisible();
  await page.getByRole("tab", { name: "Lights" }).click();
  await page.clock.fastForward("05:00");
  await page.waitForTimeout(500);
  expect(await fakeRequests(request)).toEqual([]);

  // Open: once as it opens, and once every 30 seconds.
  await page.getByRole("tab", { name: "Heating" }).click();
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20°");
  await page.clock.fastForward(REFRESH);
  await expect.poll(() => fakeRequests(request)).toHaveLength(2);
  expect(await fakeRequests(request)).toEqual(["GET accepted", "GET accepted"]);

  // Closed again: nothing, however long.
  await page.getByRole("tab", { name: "TV" }).click();
  await expect(page.getByRole("heading", { name: "Heating", level: 1 })).toHaveCount(0);
  // A read begun while it was open may land a moment after.
  await page.waitForTimeout(1_000);
  expect((await request.delete(fakeHiveUrl("/_fake/requests"))).ok()).toBe(true);
  await page.clock.fastForward("10:00");
  await page.waitForTimeout(500);
  expect(await fakeRequests(request)).toEqual([]);
});

test("two Remotes see the same state, whichever changes it", async ({ browser, baseURL, page, request }) => {
  await signInToFakeHive(request);
  const other = await browser.newContext({ ...devices["Pixel 7"], ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    const second = await other.newPage();
    await openHeating(page);
    await openHeating(second);

    await widget(page, "Upstairs").getByRole("radio", { name: "Manual" }).check();
    await expect(summary(page, "Upstairs")).toHaveText("Manual, 19°");
    await second.clock.fastForward(REFRESH);
    await expect(summary(second, "Upstairs")).toHaveText("Manual, 19°");

    await widget(second, "Whole home")
      .getByRole("button", { name: "Raise every Heating's target temperature" })
      .click();
    // From Mixed, a step goes from between the two: both are set to 20°, but their modes still differ.
    await expect(target(second, "Whole home")).toHaveText("20°");
    await expect(summary(second, "Whole home")).toHaveText("Mixed");
    await page.clock.fastForward(REFRESH);
    await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20°");
    await expect(summary(page, "Upstairs")).toHaveText("Manual, 20°");
    await expect(summary(page, "Whole home")).toHaveText("Mixed");
    await expect(target(page, "Whole home")).toHaveText("20°");
  } finally {
    await other.close();
  }
});

// FR-67: the tab is always there, and says how to sign in until the Hub is signed in to Hive.
test("signed out of Hive, the Heating tab says how to sign in, and opens Settings on Heating", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Heating" }).click();
  const empty = page.getByRole("region", { name: "Not signed in to Hive" });
  await empty.getByRole("button", { name: "Open Settings" }).click();

  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Heating" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("form", { name: "Sign in to Hive" })).toBeVisible();
  await expect(page.getByRole("tablist").getByRole("tab")).toHaveText([
    "TV",
    "Aircon",
    "Lights",
    "Heating",
    "Network",
    "Amazon",
    "Ring",
    "Rooms",
  ]);
});

/** Where a widget is on the page, to compare with another: as widgets glide into place, poll what it says. */
const boxOf = async (page: Page, title: string) => {
  const box = await widget(page, title).locator("xpath=ancestor::div[@data-widget]").boundingBox();
  expect(box).not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
};

/** What this Remote remembers under `key`, as the Remote keeps it in the browser. */
const remembered = (page: Page, key: string) =>
  page.evaluate((each) => JSON.parse(localStorage.getItem(each) ?? "null") as unknown, key);

// FR-58, as the TV tab.
for (const size of ["phone", "desktop"] as const) {
  test(`on a ${size}, the Heating tab is a board of widgets, the Whole home first, each with every control in sight`, async ({
    page,
    request,
  }) => {
    if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
    await signInToFakeHive(request);
    const bedroom = await addRoom(request, "Bedroom");
    await moveTo(request, "Bedroom", bedroom);
    await moveTo(request, "Study", bedroom);
    await openHeating(page);

    await expect(page.locator("[data-widget] h2")).toHaveText([
      "Whole home",
      "Downstairs",
      "Upstairs",
      "Hot Water",
      "Bedroom · Radiator Valves",
      "Bedroom · Bedroom",
      "Bedroom · Study",
      "Living Room",
    ]);
    const whole = await boxOf(page, "Whole home");
    const downstairs = await boxOf(page, "Downstairs");
    // The grid's own width: on a desktop the tabs' rail takes some of the screen's.
    const width = (await page.locator(".widget-grid").first().boundingBox())?.width ?? 0;
    if (size === "phone") {
      expect(whole.width).toBeGreaterThan(width * 0.8);
      expect(downstairs.y).toBeGreaterThanOrEqual(whole.y + whole.height);
    } else {
      expect(whole.width).toBeLessThan(width / 2.5);
      expect(downstairs.y).toBe(whole.y);
      expect(downstairs.x).toBeGreaterThan(whole.x + whole.width);
    }
    for (const title of ["Whole home", "Downstairs", "Hot Water", "Bedroom · Radiator Valves", "Bedroom · Study"]) {
      const body = widget(page, title).locator("xpath=ancestor::div[contains(@class, 'widget-body')]");
      expect(
        await body.evaluate((each) => {
          const { scrollHeight, clientHeight } = each as {
            readonly scrollHeight: number;
            readonly clientHeight: number;
          };
          return scrollHeight <= clientHeight;
        }),
        title,
      ).toBe(true);
    }
  });
}

// FR-58 and WCAG 2.5.7: arranged by keyboard or menu, with no drag; hidden and shown; remembered under its own key.
test("each widget is moved with its grip's keys or its menu, hidden and shown from the Widgets menu, and remembered under its own key", async ({
  page,
  request,
}) => {
  await signInToFakeHive(request);
  const hotWater = await hiveAppliance(request, "Hot Water");
  // Another tab's layout, which the Heating tab's never touches.
  const tv = { hidden: ["keys"], layouts: {} };
  await page.goto("/");
  await page.evaluate((saved) => {
    localStorage.setItem("media-centre:tv-widgets", saved);
  }, JSON.stringify(tv));
  await page.getByRole("tab", { name: "Heating" }).click();
  await expect(summary(page, "Downstairs")).toHaveText("Schedule, 20°");
  const status = page.locator(".widget-board > [role='status']");

  await page.getByRole("button", { name: "Arrange Whole home" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText(/^Whole home: column 1, row \d+, 4 wide and \d+ tall\.$/);
  await expect.poll(async () => (await boxOf(page, "Downstairs")).y < (await boxOf(page, "Whole home")).y).toBe(true);

  await page.getByRole("button", { name: "Arrange Whole home" }).click();
  const menu = page.getByRole("group", { name: "Arrange Whole home" });
  await menu.getByRole("button", { name: "Move up" }).click();
  await expect(status).toHaveText(/^Whole home: column 1, row 1, 4 wide/);
  await page.keyboard.press("Escape");
  // Its controls still reach the fake wherever it is.
  await widget(page, "Whole home").getByRole("radio", { name: "Manual" }).check();
  await expect
    .poll(async () => (await products(request)).slice(0, 2).map(({ mode }) => mode))
    .toEqual(["manual", "manual"]);

  await page.getByRole("button", { name: "Hide Hot Water" }).click();
  await expect(widget(page, "Hot Water")).toHaveCount(0);
  await expect
    .poll(() => remembered(page, "media-centre:heating-widgets"))
    .toMatchObject({ hidden: [`hot-water-${String(hotWater.id)}`] });
  expect(await remembered(page, "media-centre:tv-widgets")).toEqual(tv);

  await page.reload();
  await expect(summary(page, "Downstairs")).toHaveText("Manual, 20°");
  await expect(widget(page, "Hot Water")).toHaveCount(0);
  await page.getByRole("button", { name: /^Widgets/ }).click();
  const shown = page.getByRole("group", { name: "Show on the Heating tab" });
  await expect(shown.getByRole("checkbox")).toHaveCount(7);
  await shown.getByRole("checkbox", { name: "Hot Water" }).check();
  await expect(summary(page, "Hot Water")).toHaveText("Schedule");
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(page.locator("[data-widget] h2")).toHaveText([
    "Whole home",
    "Downstairs",
    "Upstairs",
    "Hot Water",
    "Bedroom",
    "Study",
    "Living Room",
  ]);
});
