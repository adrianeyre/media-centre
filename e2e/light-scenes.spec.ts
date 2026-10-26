import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { LightState } from "../packages/shared/src/index.ts";

import type { FakeLeproLight } from "../packages/hub/src/fakes/lepro-light/fake-lepro-light.ts";
import { startFakeLight, type FakeLightName } from "./fake-lights.ts";

/** The fake Lights running, by name, each stopped after the test that started it. */
let running = new Map<FakeLightName, FakeLeproLight>();

const start = async (name: FakeLightName): Promise<FakeLeproLight> => {
  const light = await startFakeLight(name);
  running.set(name, light);
  return light;
};

// The run's Hub is shared by every test, so each starts and ends with no Appliances and no Rooms, and so no Light Scenes.
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

/** Moves the Light to the Room, as Settings would. */
const moveLight = async (request: APIRequestContext, id: number, room: string): Promise<void> => {
  const moved = await request.patch(`/api/appliances/${String(id)}`, {
    data: { roomId: await roomNamed(request, room) },
  });
  expect(moved.status()).toBe(200);
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
const scenes = (page: Page, room: string) => card(page, `${room} Light Scenes`);
const summary = (page: Page, title: string) => card(page, title).locator(".light-summary");

/** The tab asks the Hub again every few seconds, so it can take that long to follow another Remote. */
const FOLLOWS = { timeout: 10_000 };

const reaches = async (name: FakeLightName, expected: Partial<LightState>): Promise<void> => {
  await expect.poll(() => fake(name).light()).toMatchObject(expected);
};

const LAMP = "Living room · Lamp";
const PLUG = "Living room · Plug";
const BLUE = { hue: 240, saturation: 100 };

const everyLightAnswers = async (page: Page, titles: readonly string[]): Promise<void> => {
  for (const title of titles) {
    await expect(card(page, title).getByRole("button", { name: "Power", exact: true })).toBeEnabled();
  }
};

/** "Save as Light Scene" in the Room's widget, named as given. */
const saveAs = async (page: Page, room: string, name: string): Promise<void> => {
  await scenes(page, room).getByRole("button", { name: "Save as Light Scene" }).click();
  const form = scenes(page, room).getByRole("form", { name: `Save ${room}'s Lights as a Light Scene` });
  await form.getByRole("textbox", { name: "Light Scene name" }).fill(name);
  await form.getByRole("button", { name: "Save", exact: true }).click();
};

const recallButton = (page: Page, room: string, name: string) =>
  scenes(page, room).getByRole("button", { name: `Recall ${name}`, exact: true });

// FR-56, and Lights PRD §5 scenario 3 and §8: a Light Scene recalls the Room as saved.
test("saving captures each Light in the Room as it is, and recalling sets each fake back to it, and no Light outside the Room", async ({
  page,
  request,
}) => {
  await addLight(request, "lamp", "Lamp", "Living room");
  await addLight(request, "plug", "Plug", "Living room");
  await addLight(request, "desk", "Desk", "Office");
  // A dim blue, and the plug off, as LampUX or the Remote would leave them.
  fake("lamp").setLight({ on: true, brightness: 30, colour: BLUE });
  fake("plug").setLight({ on: false });
  await openLights(page);
  await everyLightAnswers(page, [LAMP, PLUG, "Office · Desk"]);
  await expect(scenes(page, "Living room")).toContainText("No Light Scenes yet.");

  await saveAs(page, "Living room", "Film");
  await expect(scenes(page, "Living room").getByRole("status")).toHaveText('Saved "Film".');
  await expect(recallButton(page, "Living room", "Film")).toBeVisible();
  await expect(scenes(page, "Living room").getByRole("listitem")).toContainText("2 Lights");
  await expect(recallButton(page, "Office", "Film")).toHaveCount(0);

  // Everything changed since.
  fake("lamp").setLight({ on: false, brightness: 100, colourTemperature: 6_500 });
  fake("plug").setLight({ on: true });
  fake("desk").setLight({ on: false, brightness: 40 });
  const desk = fake("desk").light();

  await recallButton(page, "Living room", "Film").click();
  await reaches("lamp", { on: true, brightness: 30, colourTemperature: null, colour: BLUE });
  await reaches("plug", { on: false });
  await expect(scenes(page, "Living room").getByRole("status")).toHaveText('Recalled "Film".');
  // Each Light's widget shows what it said at once.
  await expect(summary(page, LAMP)).toHaveText("On, 30%, blue colour");
  await expect(summary(page, PLUG)).toHaveText("Off");
  expect(fake("desk").light()).toEqual(desk);
});

// FR-56: recall sets each Light still in the Room and in the Light Scene.
test("a Light added to the Room after saving is left as it is, and one moved out of it is skipped", async ({
  page,
  request,
}) => {
  await addLight(request, "lamp", "Lamp", "Living room");
  const plugId = await addLight(request, "plug", "Plug", "Living room");
  const deskId = await addLight(request, "desk", "Desk", "Office");
  fake("lamp").setLight({ on: true, brightness: 45, colourTemperature: 3_000 });
  fake("plug").setLight({ on: true });
  await openLights(page);
  await everyLightAnswers(page, [LAMP, PLUG]);
  await saveAs(page, "Living room", "Evening");
  await expect(recallButton(page, "Living room", "Evening")).toBeVisible();

  // The Desk joins the Living room, and the Plug leaves it for the Office.
  await moveLight(request, deskId, "Living room");
  await moveLight(request, plugId, "Office");
  await expect(card(page, "Living room · Desk")).toBeVisible(FOLLOWS);
  fake("lamp").setLight({ on: false });
  fake("plug").setLight({ on: false });
  fake("desk").setLight({ on: true, brightness: 15 });

  await recallButton(page, "Living room", "Evening").click();
  await reaches("lamp", { on: true, brightness: 45, colourTemperature: 3_000 });
  await expect(scenes(page, "Living room").getByRole("status")).toHaveText('Recalled "Evening".');
  expect(fake("plug").light().on).toBe(false);
  expect(fake("desk").light()).toMatchObject({ on: true, brightness: 15 });
});

// FR-56 and FR-57b: a Light that doesn't answer is named, saving and recalling.
test("with a Light switched off at the wall, recall reaches the rest and names it, and a save leaves it out, naming it", async ({
  page,
  request,
}) => {
  await addLight(request, "lamp", "Lamp", "Living room");
  await addLight(request, "plug", "Plug", "Living room");
  await openLights(page);
  await everyLightAnswers(page, [LAMP, PLUG]);
  await saveAs(page, "Living room", "Both");
  await expect(recallButton(page, "Living room", "Both")).toBeVisible();

  await fake("plug").stop();
  running.delete("plug");
  fake("lamp").setLight({ on: false });
  await recallButton(page, "Living room", "Both").click();
  await reaches("lamp", { on: true });
  await expect(scenes(page, "Living room").getByRole("alert")).toHaveText(
    `Recalled "Both", but couldn't reach ${PLUG}.`,
  );

  await saveAs(page, "Living room", "Lamp only");
  await expect(scenes(page, "Living room").getByRole("alert")).toHaveText(
    `Saved "Lamp only" without ${PLUG}, which didn't answer.`,
  );
  await expect(scenes(page, "Living room").getByRole("listitem").filter({ hasText: "Lamp only" })).toContainText(
    "1 Light",
  );
});

// FR-56: renamed and deleted from the Lights tab; and every Remote sees the same; two browsers are two Remotes.
test("two Remotes see the same Light Scenes, saved, renamed, recalled and deleted on either", async ({
  browser,
  baseURL,
  page,
  request,
}) => {
  await addLight(request, "lamp", "Lamp", "Living room");
  await openLights(page);
  await everyLightAnswers(page, [LAMP]);
  const other = await browser.newContext({ ...devices["Pixel 7"], ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    const second = await other.newPage();
    await openLights(second);
    await everyLightAnswers(second, [LAMP]);

    fake("lamp").setLight({ on: true, brightness: 20, colour: BLUE });
    await saveAs(page, "Living room", "Film");
    await expect(recallButton(second, "Living room", "Film")).toBeVisible(FOLLOWS);

    // Renamed on the other.
    await scenes(second, "Living room").getByRole("button", { name: "Rename Film" }).click();
    const rename = scenes(second, "Living room").getByRole("form", { name: "Rename Film" });
    await rename.getByRole("textbox", { name: "Light Scene name" }).fill("Cinema");
    await rename.getByRole("button", { name: "Save", exact: true }).click();
    await expect(recallButton(second, "Living room", "Cinema")).toBeVisible();
    await expect(recallButton(page, "Living room", "Cinema")).toBeVisible(FOLLOWS);
    await expect(recallButton(page, "Living room", "Film")).toHaveCount(0);

    // Recalled on the other, which this Remote follows too.
    fake("lamp").setLight({ on: false });
    await expect(summary(page, LAMP)).toHaveText("Off", FOLLOWS);
    await recallButton(second, "Living room", "Cinema").click();
    await reaches("lamp", { on: true, brightness: 20, colour: BLUE });
    await expect(summary(page, LAMP)).toHaveText("On, 20%, blue colour", FOLLOWS);

    // A name the Room has already is refused, said beside it.
    await saveAs(second, "Living room", "cinema");
    const form = scenes(second, "Living room").getByRole("form", {
      name: "Save Living room's Lights as a Light Scene",
    });
    await expect(form.getByRole("alert")).toHaveText('There is already a Light Scene called "Cinema" in Living room.');
    await form.getByRole("button", { name: "Cancel" }).click();

    // Deleted here, once asked to make sure, and gone from the other.
    await scenes(page, "Living room").getByRole("button", { name: "Delete Cinema" }).click();
    await scenes(page, "Living room").getByRole("button", { name: "Yes, delete" }).click();
    await expect(scenes(page, "Living room")).toContainText("No Light Scenes yet.");
    await expect(scenes(second, "Living room")).toContainText("No Light Scenes yet.", FOLLOWS);
  } finally {
    await other.close();
  }
});

// FR-58 and WCAG 2.5.7: the Light Scenes widget is arranged as every widget is, with no drag.
test("the Light Scenes widget is moved with its grip's keys and menu, hidden and shown from the Widgets menu", async ({
  page,
  request,
}) => {
  await addLight(request, "lamp", "Lamp", "Living room");
  await openLights(page);
  await everyLightAnswers(page, [LAMP]);
  const title = "Living room Light Scenes";
  const status = page.locator(".widget-board > [role='status']");

  // On a phone, beneath the Room's control: moved up above it by its grip's menu, and made taller by its keys.
  await page.getByRole("button", { name: `Arrange ${title}` }).click();
  const menu = page.getByRole("group", { name: `Arrange ${title}` });
  await menu.getByRole("button", { name: "Move up" }).click();
  await expect(status).toHaveText(`${title}: column 1, row 1, 4 wide and 9 tall.`);
  await page.getByRole("button", { name: `Arrange ${title}` }).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(status).toHaveText(`${title}: column 1, row 1, 4 wide and 10 tall.`);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.getByRole("button", { name: `Hide ${title}` }).click();
  await expect(card(page, title)).toHaveCount(0);
  await page.getByRole("button", { name: /^Widgets/ }).click();
  await page.getByRole("group", { name: "Show on the Lights tab" }).getByRole("checkbox", { name: title }).check();
  await expect(scenes(page, "Living room").getByRole("button", { name: "Save as Light Scene" })).toBeVisible();
});
