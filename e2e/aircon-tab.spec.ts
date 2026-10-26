import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  startFakeMideaAircon,
  type FakeAirconFeature,
  type FakeAirconState,
  type FakeMideaAircon,
  type FakeTemperatureRanges,
} from "../packages/hub/src/fakes/midea-aircon/fake-midea-aircon.ts";
import {
  FAKE_AIRCON_DISCOVERY_PORT,
  FAKE_AIRCON_HTTP_PORT,
  FAKE_AIRCON_PORT,
  FAKE_AIRCONS,
  SPARE_FAKE_AIRCON,
  fakeAirconUrl,
} from "./fake-air-conditioners.ts";
import { FAKE_TVS } from "./fake-tvs.ts";

/** Started by the tests that need fewer capabilities, or to switch it off at the wall, and stopped after each. */
let spare: FakeMideaAircon | undefined;

/** The run's v2 fake as it starts, which each test starts from: it keeps its state between tests. */
const AS_STARTED: Partial<FakeAirconState> = {
  power: false,
  mode: "cool",
  targetTemperature: 24,
  fanSpeed: 102,
  swing: { vertical: false, horizontal: false },
  eco: false,
  turbo: false,
  sleep: false,
  display: true,
  roomTemperature: 22.5,
  outdoorTemperature: 14,
  functions: { "self-clean": 0, breeze: 1, "vertical-vane": 50 },
};

// The run's Hub is shared by every test, so each starts and ends with no Appliances and no Rooms.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
};
test.beforeEach(async ({ request }) => {
  await forgetEverything(request);
  const reset = await request.post(fakeAirconUrl(FAKE_AIRCONS.living.host, "/_fake/state"), { data: AS_STARTED });
  expect(reset.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await spare?.stop();
  spare = undefined;
  await forgetEverything(request);
});

const startSpare = async (
  features?: readonly FakeAirconFeature[],
  temperatureRanges?: FakeTemperatureRanges,
): Promise<FakeMideaAircon> =>
  startFakeMideaAircon({
    host: SPARE_FAKE_AIRCON.host,
    port: FAKE_AIRCON_PORT,
    discoveryPort: FAKE_AIRCON_DISCOVERY_PORT,
    httpPort: FAKE_AIRCON_HTTP_PORT,
    version: SPARE_FAKE_AIRCON.version,
    id: SPARE_FAKE_AIRCON.id,
    serialNumber: SPARE_FAKE_AIRCON.serialNumber,
    ...(features === undefined ? {} : { features }),
    ...(temperatureRanges === undefined ? {} : { temperatureRanges }),
  });

/** Adds a Room, and a v2 Air Conditioner in it through the Hub, as Settings would, giving the Air Conditioner's id. */
const addAirConditioner = async (request: APIRequestContext, address: string, room: string): Promise<number> => {
  const created = await request.post("/api/rooms", { data: { name: room } });
  expect(created.status()).toBe(201);
  const { id: roomId } = (await created.json()) as { id: number };
  const added = await request.post("/api/appliances", {
    data: { kind: "air-conditioner", address, name: "Aircon", roomId },
  });
  expect(added.status()).toBe(201);
  return ((await added.json()) as { id: number }).id;
};

const fakeState = async (request: APIRequestContext): Promise<FakeAirconState> =>
  (await (await request.get(fakeAirconUrl(FAKE_AIRCONS.living.host, "/_fake/state"))).json()) as FakeAirconState;

const openAircon = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Aircon" }).click();
  await expect(page.getByRole("heading", { name: "Aircon", level: 1 })).toBeVisible();
};

const card = (page: Page, title: string) => page.getByRole("region", { name: title });
const group = (page: Page, title: string, name: string) => card(page, title).getByRole("group", { name, exact: true });
const radio = (page: Page, title: string, groupName: string, name: string) =>
  group(page, title, groupName).getByRole("radio", { name, exact: true });
const button = (page: Page, title: string, name: string) =>
  card(page, title).getByRole("button", { name, exact: true });
const slider = (page: Page, title: string) => card(page, title).getByRole("slider", { name: "Target temperature" });
const target = (page: Page, title: string) => card(page, title).getByRole("status", { name: "Target temperature set" });
const summary = (page: Page, title: string) => card(page, title).locator(".aircon-summary");

/** The tab asks the Hub again every few seconds, so it can take that long to follow the fake. */
const FOLLOWS = { timeout: 10_000 };

const LIVING = "Living room · Aircon";

// FR-49 and FR-50, Aircon PRD §5 scenario 1.
test("each control reaches the fake and changes its state, and a change made at the fake shows on the Remote", async ({
  page,
  request,
}) => {
  await addAirConditioner(request, FAKE_AIRCONS.living.host, "Living room");
  await openAircon(page);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([LIVING]);
  await expect(summary(page, LIVING)).toHaveText("Off");
  await expect(card(page, LIVING).locator(".aircon-temperatures")).toHaveText("Room22.5°Outdoor14°");

  const reaches = async (expected: Partial<FakeAirconState>): Promise<void> => {
    await expect.poll(async () => fakeState(request)).toMatchObject(expected);
  };

  await button(page, LIVING, "Power").click();
  await reaches({ power: true });
  await radio(page, LIVING, "Mode", "Heat").check();
  await reaches({ mode: "heat" });
  await expect(slider(page, LIVING)).toHaveAttribute("step", "0.5");
  await button(page, LIVING, "Raise the target temperature").click();
  await reaches({ targetTemperature: 24.5 });
  await slider(page, LIVING).fill("26");
  await reaches({ targetTemperature: 26 });
  await radio(page, LIVING, "Fan speed", "Silent").check();
  await reaches({ fanSpeed: 20 });
  await button(page, LIVING, "Up and down").click();
  await reaches({ swing: { vertical: true, horizontal: false } });
  await button(page, LIVING, "Side to side").click();
  await reaches({ swing: { vertical: true, horizontal: true } });
  await button(page, LIVING, "Eco").click();
  await reaches({ eco: true, turbo: false });
  await button(page, LIVING, "Turbo").click();
  await reaches({ eco: false, turbo: true });
  await button(page, LIVING, "Sleep").click();
  await reaches({ turbo: false, sleep: true });
  await button(page, LIVING, "Display").click();
  await reaches({ display: false });
  await button(page, LIVING, "Self-clean").click();
  await reaches({ functions: { "self-clean": 1 } });
  await card(page, LIVING).getByRole("combobox", { name: "Breeze" }).selectOption({ label: "Breeze mild" });
  await reaches({ functions: { breeze: 3 } });
  await card(page, LIVING).getByRole("combobox", { name: "Up-and-down louvre" }).selectOption({ label: "Position 5" });
  await reaches({ functions: { "vertical-vane": 100 } });
  await expect(summary(page, LIVING)).toHaveText("Heat, set to 26°");
  await expect(card(page, LIVING).getByRole("alert")).toHaveCount(0);

  // Changed with its own remote, and by the weather.
  const changed = await request.post(fakeAirconUrl(FAKE_AIRCONS.living.host, "/_fake/state"), {
    data: { mode: "dry", targetTemperature: 19, fanSpeed: 80, roomTemperature: 27.5, outdoorTemperature: 31 },
  });
  expect(changed.ok()).toBe(true);
  await expect(summary(page, LIVING)).toHaveText("Dry, set to 19°", FOLLOWS);
  await expect(radio(page, LIVING, "Mode", "Dry")).toBeChecked();
  await expect(radio(page, LIVING, "Fan speed", "High")).toBeChecked();
  await expect(target(page, LIVING)).toHaveText("19°");
  await expect(card(page, LIVING).locator(".aircon-temperatures")).toHaveText("Room27.5°Outdoor31°");
});

// FR-50: the controls are the ones the unit reports, and the target temperature its range per mode, in its steps.
test("a fake with fewer capabilities shows only those, and the temperature follows its range per mode and its step", async ({
  page,
  request,
}) => {
  spare = await startSpare(["cool", "heat", "fan-auto"], { cool: [17, 30], auto: [17, 30], heat: [16, 28] });
  await addAirConditioner(request, SPARE_FAKE_AIRCON.host, "Office");
  await openAircon(page);
  const office = "Office · Aircon";
  await expect(summary(page, office)).toHaveText("Off");

  await expect(group(page, office, "Mode").getByRole("radio")).toHaveCount(3);
  await expect(group(page, office, "Mode").locator("label")).toHaveText(["Cool", "Heat", "Fan"]);
  await expect(group(page, office, "Fan speed").locator("label")).toHaveText(["Low", "High", "Auto"]);
  await expect(group(page, office, "Preset").getByRole("button")).toHaveText(["Sleep"]);
  await expect(group(page, office, "Swing")).toHaveCount(0);
  await expect(group(page, office, "More")).toHaveCount(0);
  await expect(button(page, office, "Display")).toHaveCount(0);
  await expect(card(page, office).locator(".aircon-temperatures")).toHaveText("Room22.5°");

  // Cool: 17° to 30°, in whole degrees.
  await expect(slider(page, office)).toHaveAttribute("min", "17");
  await expect(slider(page, office)).toHaveAttribute("max", "30");
  await expect(slider(page, office)).toHaveAttribute("step", "1");
  await expect(card(page, office).getByText("17° to 30° in cool mode, in whole degrees.")).toBeVisible();
  await button(page, office, "Lower the target temperature").click();
  await expect.poll(() => spare?.state().targetTemperature).toBe(23);
  await expect(target(page, office)).toHaveText("23°");

  // Heat: 16° to 28°.
  await radio(page, office, "Mode", "Heat").check();
  await expect.poll(() => spare?.state().mode).toBe("heat");
  await expect(slider(page, office)).toHaveAttribute("min", "16");
  await expect(slider(page, office)).toHaveAttribute("max", "28");
  await slider(page, office).fill("28");
  await expect.poll(() => spare?.state().targetTemperature).toBe(28);
  await expect(button(page, office, "Raise the target temperature")).toBeDisabled();

  // Fan: none.
  await radio(page, office, "Mode", "Fan").check();
  await expect.poll(() => spare?.state().mode).toBe("fan");
  await expect(slider(page, office)).toBeDisabled();
  await expect(card(page, office).getByText("Fan mode takes no target temperature.")).toBeVisible();
});

// FR-51a and Aircon PRD §5 scenario 3.
test('stopping the fake shows "Can\'t reach this Air Conditioner" and disables its controls; restarting it brings them back', async ({
  page,
  request,
}) => {
  spare = await startSpare();
  await addAirConditioner(request, SPARE_FAKE_AIRCON.host, "Living room");
  await openAircon(page);
  await expect(button(page, LIVING, "Power")).toBeEnabled();
  await expect(radio(page, LIVING, "Mode", "Cool")).toBeChecked();

  // Switched off at the wall.
  await spare.stop();
  spare = undefined;
  await expect(summary(page, LIVING)).toHaveText("Can't reach this Air Conditioner", FOLLOWS);
  await expect(button(page, LIVING, "Power")).toBeDisabled();
  await expect(radio(page, LIVING, "Mode", "Cool")).toBeDisabled();
  await expect(radio(page, LIVING, "Mode", "Cool")).not.toBeChecked();
  await expect(slider(page, LIVING)).toBeDisabled();
  await expect(button(page, LIVING, "Display")).toBeDisabled();
  await expect(card(page, LIVING).getByRole("combobox", { name: "Breeze" })).toBeDisabled();

  // Back on.
  spare = await startSpare();
  await expect(button(page, LIVING, "Power")).toBeEnabled(FOLLOWS);
  await expect(summary(page, LIVING)).toHaveText("Off");
  await expect(radio(page, LIVING, "Mode", "Cool")).toBeChecked();
  await button(page, LIVING, "Power").click();
  await expect.poll(() => spare?.state().power).toBe(true);
});

// FR-49: every Remote sees the same state; two browsers are two Remotes.
test("two Remotes see the same state, whichever changes it", async ({ browser, baseURL, page, request }) => {
  await addAirConditioner(request, FAKE_AIRCONS.living.host, "Living room");
  const other = await browser.newContext({ ...devices["Pixel 7"], ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    const second = await other.newPage();
    await openAircon(page);
    await openAircon(second);
    await expect(summary(second, LIVING)).toHaveText("Off");

    await button(page, LIVING, "Power").click();
    await radio(page, LIVING, "Mode", "Heat").check();
    await expect(summary(second, LIVING)).toHaveText("Heat, set to 24°", FOLLOWS);
    await expect(button(second, LIVING, "Power")).toHaveAttribute("aria-pressed", "true");

    await radio(second, LIVING, "Fan speed", "High").check();
    await button(second, LIVING, "Display").click();
    await expect(radio(page, LIVING, "Fan speed", "High")).toBeChecked(FOLLOWS);
    await expect(button(page, LIVING, "Display")).toHaveAttribute("aria-pressed", "false", FOLLOWS);
    await expect(radio(second, LIVING, "Fan speed", "High")).toBeChecked();
  } finally {
    await other.close();
  }
});

/** Where a widget is on the page, to compare with another: as widgets glide into place, poll what it says. */
const boxOf = async (page: Page, title: string) => {
  const box = await card(page, title).locator("xpath=ancestor::div[@data-widget]").boundingBox();
  expect(box).not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
};

/** What this Remote remembers under `key`, as the Remote keeps it in the browser. */
const remembered = (page: Page, key: string) =>
  page.evaluate((each) => JSON.parse(localStorage.getItem(each) ?? "null") as unknown, key);

// FR-58, as the TV tab: each Air Conditioner is a widget, starting in Room order.
for (const size of ["phone", "desktop"] as const) {
  test(`on a ${size}, each Air Conditioner is a widget, starting in Room order, each Room's below the last's`, async ({
    page,
    request,
  }) => {
    if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
    spare = await startSpare(["cool", "heat", "fan-auto"]);
    await addAirConditioner(request, FAKE_AIRCONS.living.host, "Living room");
    await addAirConditioner(request, SPARE_FAKE_AIRCON.host, "Office");
    await openAircon(page);
    const office = "Office · Aircon";
    await expect(button(page, office, "Power")).toBeEnabled();

    await expect(page.locator("[data-widget] h2")).toHaveText([LIVING, office]);
    const living = await boxOf(page, LIVING);
    const below = await boxOf(page, office);
    expect(below.x).toBe(living.x);
    expect(below.y).toBeGreaterThanOrEqual(living.y + living.height);
    // On a phone, a widget fills its width; on a desktop, three would stand side by side.
    // The grid's own width: on a desktop the tabs' rail takes some of the screen's.
    const width = (await page.locator(".widget-grid").first().boundingBox())?.width ?? 0;
    if (size === "phone") expect(living.width).toBeGreaterThan(width * 0.8);
    else expect(living.width).toBeLessThan(width / 2.5);
    // Every control of the run's fake, with all of them, is in sight in its widget, with no scrolling inside it.
    const body = card(page, LIVING).locator("xpath=ancestor::div[contains(@class, 'widget-body')]");
    expect(
      await body.evaluate((each) => {
        const { scrollHeight, clientHeight } = each as { readonly scrollHeight: number; readonly clientHeight: number };
        return scrollHeight <= clientHeight;
      }),
    ).toBe(true);
  });
}

// FR-58 and WCAG 2.5.7: arranged by keyboard or menu, with no drag, and dragged by the grip too.
test("each Air Conditioner's widget is moved with its grip's keys, its menu or a drag, and hidden and shown from the Widgets menu", async ({
  page,
  request,
}) => {
  spare = await startSpare(["cool", "heat", "fan-auto"]);
  await addAirConditioner(request, FAKE_AIRCONS.living.host, "Living room");
  await addAirConditioner(request, SPARE_FAKE_AIRCON.host, "Office");
  await openAircon(page);
  const office = "Office · Aircon";
  await expect(button(page, office, "Power")).toBeEnabled();
  const status = page.locator(".widget-board > [role='status']");

  // The arrow keys on its grip: moved down onto the Office's, the two swap.
  await page.getByRole("button", { name: `Arrange ${LIVING}` }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText(/^Living room · Aircon: column 1, row \d+, 4 wide and 42 tall\.$/);
  await expect.poll(async () => (await boxOf(page, office)).y < (await boxOf(page, LIVING)).y).toBe(true);

  // Its grip's menu, one tap and one more, with no drag.
  await page.getByRole("button", { name: `Arrange ${LIVING}` }).click();
  const menu = page.getByRole("group", { name: `Arrange ${LIVING}` });
  await menu.getByRole("button", { name: "Move up" }).click();
  await expect(status).toHaveText("Living room · Aircon: column 1, row 1, 4 wide and 42 tall.");
  await expect.poll(async () => (await boxOf(page, LIVING)).y < (await boxOf(page, office)).y).toBe(true);
  await menu.getByRole("button", { name: "Shorter" }).click();
  await expect(status).toHaveText("Living room · Aircon: column 1, row 1, 4 wide and 41 tall.");

  // Dragged by its grip, on a desktop tall enough to show both, whose 12 columns have a layout of their own,
  // the Office's goes up beside the Living room's.
  await page.setViewportSize({ width: 1280, height: 2000 });
  await page.evaluate("window.scrollTo(0, 0)");
  await expect.poll(async () => (await boxOf(page, LIVING)).width).toBeLessThan(500);
  const grip = page.getByRole("button", { name: `Arrange ${office}` });
  const from = await grip.boundingBox();
  const beside = await boxOf(page, LIVING);
  expect(from).not.toBeNull();
  if (from !== null) {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + beside.width + 12, beside.y + from.height / 2 + 8, {
      steps: 12,
    });
    await page.mouse.up();
  }
  await expect.poll(async () => (await boxOf(page, office)).y).toBeCloseTo(beside.y, 0);
  await expect.poll(async () => (await boxOf(page, office)).x).toBeGreaterThan(beside.x + beside.width);
  // Its controls still reach the fake wherever it is.
  await button(page, office, "Power").click();
  await expect.poll(() => spare?.state().power).toBe(true);

  // Hidden, and shown again from the Widgets menu.
  await page.getByRole("button", { name: `Hide ${office}` }).click();
  await expect(card(page, office)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Widgets/ })).toContainText("1 hidden");
  await page.getByRole("button", { name: /^Widgets/ }).click();
  const shown = page.getByRole("group", { name: "Show on the Aircon tab" });
  await expect(shown.getByRole("checkbox")).toHaveCount(2);
  await shown.getByRole("checkbox", { name: office }).check();
  await expect(button(page, office, "Power")).toBeEnabled();

  // Reset puts each back where it started, in Room order.
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(page.locator("[data-widget] h2")).toHaveText([LIVING, office]);
  await expect.poll(async () => (await boxOf(page, LIVING)).y < (await boxOf(page, office)).y).toBe(true);
  await expect.poll(async () => (await boxOf(page, office)).x === (await boxOf(page, LIVING)).x).toBe(true);
});

// FR-58: each Remote remembers its own layout, the Aircon tab's under its own key and the TV tab's where it was.
test("the Aircon tab's layout is remembered under its own key, and the TV tab's under media-centre:tv-widgets still", async ({
  page,
  request,
}) => {
  spare = await startSpare(["cool", "heat", "fan-auto"]);
  await addAirConditioner(request, FAKE_AIRCONS.living.host, "Living room");
  const officeId = await addAirConditioner(request, SPARE_FAKE_AIRCON.host, "Office");
  const tv = await request.post("/api/appliances", {
    data: { kind: "tv", address: FAKE_TVS.living.host, name: "TV", roomId: null },
  });
  expect(tv.status()).toBe(201);
  const office = "Office · Aircon";

  // The TV tab first, its Developer section hidden.
  await page.goto("/");
  await page.getByRole("button", { name: "Hide Developer" }).click();
  await expect.poll(() => remembered(page, "media-centre:tv-widgets")).toMatchObject({ hidden: ["developer"] });

  await page.getByRole("tab", { name: "Aircon" }).click();
  await expect(button(page, office, "Power")).toBeEnabled();
  await page.getByRole("button", { name: `Hide ${office}` }).click();
  await expect
    .poll(() => remembered(page, "media-centre:aircon-widgets"))
    .toMatchObject({ hidden: [`air-conditioner-${String(officeId)}`] });
  expect(await remembered(page, "media-centre:tv-widgets")).toMatchObject({ hidden: ["developer"] });

  // Opened again, each tab is as this Remote left it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Aircon", level: 1 })).toBeVisible();
  await expect(button(page, LIVING, "Power")).toBeEnabled();
  await expect(card(page, office)).toHaveCount(0);
  await page.getByRole("tab", { name: "TV" }).click();
  await expect(page.getByRole("region", { name: "Keys" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Developer" })).toHaveCount(0);

  // A layout is this Remote's alone: another starts from the defaults.
  const other = await page.context().browser()?.newContext();
  try {
    const second = await other?.newPage();
    if (second !== undefined) {
      await second.goto(page.url());
      await second.getByRole("tab", { name: "Aircon" }).click();
      await expect(button(second, office, "Power")).toBeEnabled();
    }
  } finally {
    await other?.close();
  }
});
