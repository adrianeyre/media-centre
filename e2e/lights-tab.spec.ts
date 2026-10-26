import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { LightState } from "../packages/shared/src/index.ts";

import type { FakeLeproLight } from "../packages/hub/src/fakes/lepro-light/fake-lepro-light.ts";
import { startFakeLight, type FakeLightName } from "./fake-lights.ts";
import { FAKE_TVS } from "./fake-tvs.ts";

/** The fake Lights running, by name, each stopped after the test that started it. */
let running = new Map<FakeLightName, FakeLeproLight>();

const start = async (name: FakeLightName): Promise<FakeLeproLight> => {
  const light = await startFakeLight(name);
  running.set(name, light);
  return light;
};

/** Switched off at the wall. */
const stop = async (name: FakeLightName): Promise<void> => {
  await running.get(name)?.stop();
  running.delete(name);
};

// The run's Hub is shared by every test, so each starts and ends with no Appliances and no Rooms.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => {
  await Promise.all([...running.values()].map((light) => light.stop()));
  running = new Map();
  await forgetEverything(request);
});

/** Adds a Room, unless the Hub has it, giving its id. */
const roomNamed = async (request: APIRequestContext, name: string): Promise<number> => {
  const rooms = (await (await request.get("/api/rooms")).json()) as { id: number; name: string }[];
  const room = rooms.find((each) => each.name === name);
  if (room !== undefined) return room.id;
  const created = await request.post("/api/rooms", { data: { name } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: number }).id;
};

/** Starts the fake, and adds it through the Hub, as Settings would, named and in the Room, giving its id. */
const addLight = async (
  request: APIRequestContext,
  which: FakeLightName,
  name: string,
  room: string,
): Promise<number> => {
  const light = await start(which);
  const added = await request.post("/api/appliances", {
    data: {
      kind: "light",
      address: light.host,
      name,
      roomId: await roomNamed(request, room),
      light: { id: light.id, key: light.key },
    },
  });
  expect(added.status()).toBe(201);
  return ((await added.json()) as { id: number }).id;
};

const fake = (name: FakeLightName): FakeLeproLight => {
  const light = running.get(name);
  if (light === undefined) throw new Error(`The fake ${name} isn't running`);
  return light;
};

const openLights = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Lights" }).click();
  await expect(page.getByRole("heading", { name: "Lights", level: 1 })).toBeVisible();
};

const card = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const button = (page: Page, title: string, name: string) =>
  card(page, title).getByRole("button", { name, exact: true });
const slider = (page: Page, title: string, name: string) => card(page, title).getByRole("slider", { name });
const summary = (page: Page, title: string) => card(page, title).locator(".light-summary");
const roomButton = (page: Page, room: string, name: "On" | "Off") =>
  card(page, `${room} Lights`)
    .getByRole("group", { name: `Every Light in ${room}` })
    .getByRole("button", { name, exact: true });

/** The tab asks the Hub again every few seconds, so it can take that long to follow the fake. */
const FOLLOWS = { timeout: 10_000 };

const reaches = async (name: FakeLightName, expected: Partial<LightState>): Promise<void> => {
  await expect.poll(() => fake(name).light()).toMatchObject(expected);
};

const LAMP = "Living room · Lamp";

// FR-52, and Lights PRD §8: on/off, brightness, colour temperature and colour change it.
test("each control reaches the fake, and a change made in LampUX shows on the Remote", async ({ page, request }) => {
  await addLight(request, "lamp", "Lamp", "Living room");
  await openLights(page);
  await expect(button(page, LAMP, "Power")).toBeEnabled();
  await expect(summary(page, LAMP)).toHaveText("On, 100%, 4,600 K");

  await button(page, LAMP, "Power").click();
  await reaches("lamp", { on: false });
  await button(page, LAMP, "Power").click();
  await reaches("lamp", { on: true });
  await slider(page, LAMP, "Brightness").fill("30");
  await reaches("lamp", { brightness: 30 });
  await slider(page, LAMP, "Colour temperature").fill("2700");
  await reaches("lamp", { colourTemperature: 2_700, colour: null });
  await card(page, LAMP).getByRole("radio", { name: "Colour" }).check();
  await reaches("lamp", { colour: { hue: 0, saturation: 100 }, colourTemperature: null });
  await slider(page, LAMP, "Hue").fill("240");
  await reaches("lamp", { colour: { hue: 240, saturation: 100 } });
  await slider(page, LAMP, "Saturation").fill("50");
  await reaches("lamp", { colour: { hue: 240, saturation: 50 } });
  await expect(summary(page, LAMP)).toHaveText("On, 30%, blue colour");
  await card(page, LAMP).getByRole("radio", { name: "White" }).check();
  await reaches("lamp", { colourTemperature: 2_700, colour: null });
  await expect(card(page, LAMP).getByRole("alert")).toHaveCount(0);

  // Changed in LampUX.
  fake("lamp").setLight({ on: false, brightness: 80, colourTemperature: 6_500 });
  await expect(summary(page, LAMP)).toHaveText("Off", FOLLOWS);
  await expect(card(page, LAMP).getByRole("status", { name: "Brightness set" })).toHaveText("80%");
  await expect(card(page, LAMP).getByRole("status", { name: "Colour temperature set" })).toHaveText("6,500 K");
});

// FR-52: a Light's controls are the ones it reports.
test("a plug shows on/off alone, and a white bulb no colours", async ({ page, request }) => {
  await addLight(request, "plug", "Plug", "Living room");
  await addLight(request, "desk", "Desk", "Office");
  await openLights(page);
  const plug = "Living room · Plug";
  const desk = "Office · Desk";
  await expect(button(page, plug, "Power")).toBeEnabled();
  await expect(button(page, desk, "Power")).toBeEnabled();

  await expect(card(page, plug).getByRole("button")).toHaveText(["Power"]);
  await expect(card(page, plug).getByRole("slider")).toHaveCount(0);
  await expect(card(page, plug).getByRole("radio")).toHaveCount(0);
  // Nor has its Room anything to dim.
  await expect(card(page, "Living room Lights").getByRole("slider")).toHaveCount(0);

  await expect(card(page, desk).getByRole("slider")).toHaveCount(2);
  await expect(slider(page, desk, "Brightness")).toBeVisible();
  await expect(slider(page, desk, "Colour temperature")).toHaveAttribute("min", "2700");
  await expect(slider(page, desk, "Colour temperature")).toHaveAttribute("max", "6500");
  await expect(card(page, desk).getByRole("radio")).toHaveCount(0);

  await button(page, plug, "Power").click();
  await reaches("plug", { on: false });
  await slider(page, desk, "Brightness").fill("55");
  await reaches("desk", { brightness: 55 });
});

/** The Living room's colour bulb and plug, and the Office's white bulb. */
const home = async (request: APIRequestContext): Promise<void> => {
  await addLight(request, "lamp", "Lamp", "Living room");
  await addLight(request, "plug", "Plug", "Living room");
  await addLight(request, "desk", "Desk", "Office");
};

const everyLightAnswers = async (page: Page): Promise<void> => {
  for (const title of [LAMP, "Living room · Plug", "Office · Desk"]) {
    await expect(button(page, title, "Power")).toBeEnabled();
  }
};

// FR-53 and Lights PRD §5 scenarios 1 and 2.
test("Room-wide on/off and brightness change every Light in the Room and none outside it, and All off switches every Light off", async ({
  page,
  request,
}) => {
  await home(request);
  await openLights(page);
  await everyLightAnswers(page);
  await expect(summary(page, "Living room Lights")).toHaveText("2 on");

  await roomButton(page, "Living room", "Off").click();
  await reaches("lamp", { on: false });
  await reaches("plug", { on: false });
  await expect(summary(page, "Living room Lights")).toHaveText("2 off");
  await expect(summary(page, LAMP)).toHaveText("Off");
  await expect(summary(page, "Living room · Plug")).toHaveText("Off");
  expect(fake("desk").light().on).toBe(true);

  // Dimmed to 30%, which switches the bulb on and leaves the plug as it is.
  await slider(page, "Living room Lights", "Brightness").fill("30");
  await reaches("lamp", { on: true, brightness: 30 });
  expect(fake("plug").light().on).toBe(false);
  expect(fake("desk").light().brightness).toBe(100);
  await expect(card(page, LAMP).getByRole("status", { name: "Brightness set" })).toHaveText("30%");

  await roomButton(page, "Living room", "On").click();
  await reaches("plug", { on: true });
  await expect(summary(page, "Living room Lights")).toHaveText("2 on");
  await expect(card(page, "Living room Lights").getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "All off", exact: true }).click();
  await expect(page.getByText("Every Light is off.")).toBeVisible();
  await reaches("lamp", { on: false });
  await reaches("plug", { on: false });
  await reaches("desk", { on: false });
  for (const title of [LAMP, "Living room · Plug", "Office · Desk"])
    await expect(summary(page, title)).toHaveText("Off");
});

// FR-57b: a Light that doesn't answer, and Room-wide control and All off without it.
test("with one fake stopped, it can't be reached, Room-wide control and All off reach the rest and name it, and it comes back", async ({
  page,
  request,
}) => {
  await home(request);
  await openLights(page);
  await everyLightAnswers(page);
  const plug = "Living room · Plug";

  // Switched off at the wall.
  await stop("plug");
  await expect(summary(page, plug)).toHaveText("Can't reach this Light", FOLLOWS);
  await expect(button(page, plug, "Power")).toBeDisabled();
  await expect(button(page, plug, "Power")).not.toHaveAttribute("aria-pressed");

  await roomButton(page, "Living room", "Off").click();
  await expect(card(page, "Living room Lights").getByRole("alert")).toHaveText("Couldn't reach Living room · Plug.");
  await reaches("lamp", { on: false });
  expect(fake("desk").light().on).toBe(true);
  await expect(summary(page, "Living room Lights")).toHaveText("1 off, 1 can't be reached");

  await page.getByRole("button", { name: "All off", exact: true }).click();
  await expect(page.locator(".lights-all-off-said").getByRole("alert")).toHaveText(
    "Couldn't reach Living room · Plug. Every other Light is off.",
  );
  await reaches("desk", { on: false });
  await expect(summary(page, "Office · Desk")).toHaveText("Off");

  // Back on, as it was when it lost power.
  await start("plug");
  await expect(button(page, plug, "Power")).toBeEnabled(FOLLOWS);
  await expect(summary(page, plug)).toHaveText("On");
  await page.getByRole("button", { name: "All off", exact: true }).click();
  await expect(page.getByText("Every Light is off.")).toBeVisible();
  await reaches("plug", { on: false });
});

// FR-52: every Remote sees the same state; two browsers are two Remotes.
test("two Remotes see the same state, whichever changes it", async ({ browser, baseURL, page, request }) => {
  await home(request);
  const other = await browser.newContext({ ...devices["Pixel 7"], ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    const second = await other.newPage();
    await openLights(page);
    await openLights(second);
    await everyLightAnswers(second);

    await button(page, LAMP, "Power").click();
    await slider(page, "Office · Desk", "Brightness").fill("40");
    await expect(summary(second, LAMP)).toHaveText("Off", FOLLOWS);
    await expect(
      second.getByRole("region", { name: "Office · Desk" }).getByRole("status", { name: "Brightness set" }),
    ).toHaveText("40%", FOLLOWS);

    await roomButton(second, "Living room", "On").click();
    await second.getByRole("button", { name: "All off", exact: true }).click();
    await expect(second.getByText("Every Light is off.")).toBeVisible();
    for (const title of [LAMP, "Living room · Plug", "Office · Desk"]) {
      await expect(summary(page, title)).toHaveText("Off", FOLLOWS);
    }
    await expect(summary(page, "Living room Lights")).toHaveText("2 off");
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

// FR-58, as the TV and Aircon tabs: each Room's Room-wide control, its Light Scenes and each Light is a widget, in Room order.
for (const size of ["phone", "desktop"] as const) {
  test(`on a ${size}, each Room's Room-wide control, its Light Scenes and each Light is a widget, in Room order, each Room below the last`, async ({
    page,
    request,
  }) => {
    if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
    await home(request);
    await openLights(page);
    await everyLightAnswers(page);

    await expect(page.locator("[data-widget] h2")).toHaveText([
      "Living room Lights",
      "Living room Light Scenes",
      LAMP,
      "Living room · Plug",
      "Office Lights",
      "Office Light Scenes",
      "Office · Desk",
    ]);
    const room = await boxOf(page, "Living room Lights");
    const scenes = await boxOf(page, "Living room Light Scenes");
    const lamp = await boxOf(page, LAMP);
    const plug = await boxOf(page, "Living room · Plug");
    const office = await boxOf(page, "Office Lights");
    expect(lamp.y).toBeGreaterThanOrEqual(Math.max(room.y + room.height, scenes.y + scenes.height));
    expect(office.y).toBeGreaterThanOrEqual(Math.max(lamp.y + lamp.height, plug.y + plug.height));
    // The grid's own width: on a desktop the tabs' rail takes some of the screen's.
    const width = (await page.locator(".widget-grid").first().boundingBox())?.width ?? 0;
    if (size === "phone") {
      // One above another, filling the width.
      expect(lamp.width).toBeGreaterThan(width * 0.8);
      expect(plug.y).toBeGreaterThanOrEqual(lamp.y + lamp.height);
      expect(scenes.y).toBeGreaterThanOrEqual(room.y + room.height);
    } else {
      // The Room's control and its Light Scenes side by side across the grid, its Lights side by side beneath them.
      expect(room.width + scenes.width).toBeGreaterThan(width * 0.8);
      expect(scenes.y).toBeCloseTo(room.y, 0);
      expect(scenes.x).toBeGreaterThan(room.x + room.width);
      expect(lamp.width).toBeLessThan(width / 2.5);
      expect(plug.y).toBeCloseTo(lamp.y, 0);
      expect(plug.x).toBeGreaterThan(lamp.x + lamp.width);
    }
    // Every control of a colour Light, and of a Room, is in sight in its widget, with no scrolling inside it.
    for (const title of [LAMP, "Living room Lights", "Living room Light Scenes"]) {
      const body = card(page, title).locator("xpath=ancestor::div[contains(@class, 'widget-body')]");
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

// FR-58 and WCAG 2.5.7: arranged by keyboard or menu, with no drag, and dragged by the grip too.
test("each widget is moved with its grip's keys, its menu or a drag, and hidden and shown from the Widgets menu", async ({
  page,
  request,
}) => {
  await home(request);
  await openLights(page);
  await everyLightAnswers(page);
  const plug = "Living room · Plug";
  const status = page.locator(".widget-board > [role='status']");

  // The arrow keys on its grip: moved down onto the Plug's, the two swap.
  await page.getByRole("button", { name: `Arrange ${LAMP}` }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText(/^Living room · Lamp: column 1, row \d+, 4 wide and 13 tall\.$/);
  await expect.poll(async () => (await boxOf(page, plug)).y < (await boxOf(page, LAMP)).y).toBe(true);

  // Its grip's menu, one tap and one more, with no drag.
  await page.getByRole("button", { name: `Arrange ${LAMP}` }).click();
  const menu = page.getByRole("group", { name: `Arrange ${LAMP}` });
  await menu.getByRole("button", { name: "Move up" }).click();
  await expect(status).toHaveText("Living room · Lamp: column 1, row 19, 4 wide and 13 tall.");
  await expect.poll(async () => (await boxOf(page, LAMP)).y < (await boxOf(page, plug)).y).toBe(true);
  await menu.getByRole("button", { name: "Taller" }).click();
  await expect(status).toHaveText("Living room · Lamp: column 1, row 19, 4 wide and 14 tall.");

  // Dragged by its grip, on a desktop tall enough to show them all, whose 12 columns have a layout of their own,
  // the Office's Desk goes up beside the Living room's Plug.
  await page.setViewportSize({ width: 1280, height: 2000 });
  await page.evaluate("window.scrollTo(0, 0)");
  await expect.poll(async () => (await boxOf(page, LAMP)).width).toBeLessThan(500);
  // Once every widget has glided to where the desktop's layout puts it, the Plug beside the Lamp.
  await page.waitForFunction("document.getAnimations().length === 0");
  await expect.poll(async () => (await boxOf(page, plug)).y).toBeCloseTo((await boxOf(page, LAMP)).y, 0);
  const grip = page.getByRole("button", { name: "Arrange Office · Desk" });
  const from = await grip.boundingBox();
  const desk = await boxOf(page, "Office · Desk");
  const beside = await boxOf(page, plug);
  expect(from).not.toBeNull();
  if (from !== null) {
    // Moved by as much as the widget is to go: from below the Lamp to the next column but one, beside the Plug.
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (beside.x + beside.width + 12 - desk.x), y + (beside.y - desk.y) + 8, { steps: 12 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await boxOf(page, "Office · Desk")).y).toBeCloseTo(beside.y, 0);
  await expect.poll(async () => (await boxOf(page, "Office · Desk")).x).toBeGreaterThan(beside.x + beside.width);
  // Its controls still reach the fake wherever it is.
  await button(page, "Office · Desk", "Power").click();
  await reaches("desk", { on: false });

  // Hidden, and shown again from the Widgets menu.
  await page.getByRole("button", { name: "Hide Office Lights" }).click();
  await expect(card(page, "Office Lights")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Widgets/ })).toContainText("1 hidden");
  await page.getByRole("button", { name: /^Widgets/ }).click();
  const shown = page.getByRole("group", { name: "Show on the Lights tab" });
  await expect(shown.getByRole("checkbox")).toHaveCount(7);
  await shown.getByRole("checkbox", { name: "Office Lights" }).check();
  await expect(roomButton(page, "Office", "On")).toBeVisible();

  // Reset puts each back where it started, in Room order.
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(page.locator("[data-widget] h2")).toHaveText([
    "Living room Lights",
    "Living room Light Scenes",
    LAMP,
    plug,
    "Office Lights",
    "Office Light Scenes",
    "Office · Desk",
  ]);
  await expect.poll(async () => (await boxOf(page, "Office · Desk")).y > (await boxOf(page, plug)).y).toBe(true);
});

// FR-58: each Remote remembers its own layout, the Lights tab's under its own key and the others' where they were.
test("the Lights tab's layout is remembered under its own key, and the TV tab's under media-centre:tv-widgets still", async ({
  page,
  request,
}) => {
  const plugId = await addLight(request, "plug", "Plug", "Living room");
  await addLight(request, "lamp", "Lamp", "Living room");
  const tv = await request.post("/api/appliances", {
    data: { kind: "tv", address: FAKE_TVS.living.host, name: "TV", roomId: null },
  });
  expect(tv.status()).toBe(201);
  const plug = "Living room · Plug";

  // The TV tab first, its Developer section hidden.
  await page.goto("/");
  await page.getByRole("button", { name: "Hide Developer" }).click();
  await expect.poll(() => remembered(page, "media-centre:tv-widgets")).toMatchObject({ hidden: ["developer"] });

  await page.getByRole("tab", { name: "Lights" }).click();
  await expect(button(page, plug, "Power")).toBeEnabled();
  await page.getByRole("button", { name: `Hide ${plug}` }).click();
  await expect
    .poll(() => remembered(page, "media-centre:lights-widgets"))
    .toMatchObject({ hidden: [`light-${String(plugId)}`] });
  expect(await remembered(page, "media-centre:tv-widgets")).toMatchObject({ hidden: ["developer"] });

  // Opened again, each tab is as this Remote left it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Lights", level: 1 })).toBeVisible();
  await expect(button(page, LAMP, "Power")).toBeEnabled();
  await expect(card(page, plug)).toHaveCount(0);
  await page.getByRole("tab", { name: "TV" }).click();
  await expect(page.getByRole("region", { name: "Keys" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Developer" })).toHaveCount(0);

  // A layout is this Remote's alone: another starts from the defaults.
  const other = await page.context().browser()?.newContext();
  try {
    const second = await other?.newPage();
    if (second !== undefined) {
      await second.goto(page.url());
      await second.getByRole("tab", { name: "Lights" }).click();
      await expect(button(second, plug, "Power")).toBeEnabled();
    }
  } finally {
    await other?.close();
  }
});
