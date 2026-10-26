import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { FakeLeproLight } from "../packages/hub/src/fakes/lepro-light/fake-lepro-light.ts";
import { FAKE_LIGHTS, HIDDEN_FAKE_LIGHT, startFakeLight, type FakeLightName } from "./fake-lights.ts";
import { openSettingsOn } from "./settings.ts";

/** The fake Lights each test started, stopped after it. */
let started: FakeLeproLight[] = [];

const start = async (name: FakeLightName): Promise<FakeLeproLight> => {
  const light = await startFakeLight(name);
  started.push(light);
  return light;
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
  await Promise.all(started.map((light) => light.stop()));
  started = [];
  await forgetEverything(request);
});

const addRooms = async (request: APIRequestContext, names: readonly string[]): Promise<void> => {
  for (const name of names) expect((await request.post("/api/rooms", { data: { name } })).status()).toBe(201);
};

const openSettings = async (page: Page): Promise<void> => {
  await page.goto("/");
  await openSettingsOn(page, "Lights");
  await expect(page.getByRole("heading", { name: "Lights", level: 2 })).toBeVisible();
};

const lights = (page: Page) => page.getByRole("region", { name: "Lights", exact: true });

/** The Lights as Settings names them, Room by Room. */
const names = (page: Page) => lights(page).locator(".room-group .room-row .room-name");

const addForm = (page: Page) => page.getByRole("form", { name: "Add a Light by address" });

const fillAddForm = async (
  page: Page,
  fields: { address?: string; id?: string; key?: string; name?: string; room?: string },
): Promise<void> => {
  const form = addForm(page);
  if (fields.address !== undefined) await form.getByRole("textbox", { name: "IP address" }).fill(fields.address);
  if (fields.id !== undefined) await form.getByRole("textbox", { name: "Device id" }).fill(fields.id);
  if (fields.key !== undefined) await form.getByLabel("Local key").fill(fields.key);
  if (fields.name !== undefined) await form.getByRole("textbox", { name: "Name" }).fill(fields.name);
  if (fields.room !== undefined)
    await form.getByRole("combobox", { name: "Room" }).selectOption({ label: fields.room });
  await form.getByRole("button", { name: "Add Light" }).click();
};

const found = (page: Page, host: string) =>
  lights(page)
    .getByRole("list", { name: "Lights found" })
    .getByRole("listitem", { name: `Lepro Light, at ${host}` });

// Lights PRD FR-54, and FR-8, FR-9 and FR-11, as for every Appliance.
test("Find Lights lists the fake Lights, a found one is added with its local key, and they are named and moved as any Appliance", async ({
  page,
  request,
}) => {
  const lamp = await start("lamp");
  const plug = await start("plug");
  await start("desk");
  await addRooms(request, ["Living room", "Bedroom"]);
  await openSettings(page);
  await expect(lights(page).getByText("No Lights yet.")).toBeVisible();

  await lights(page).getByRole("button", { name: "Find Lights" }).click();
  await expect(lights(page).getByRole("list", { name: "Lights found" }).getByRole("listitem")).toHaveCount(3);

  // Chosen, its address is filled in and the local key is asked for.
  await found(page, FAKE_LIGHTS.lamp.host).getByRole("button", { name: /^Add / }).click();
  await expect(addForm(page).getByRole("textbox", { name: "IP address" })).toHaveValue(FAKE_LIGHTS.lamp.host);
  await expect(addForm(page).getByLabel("Local key")).toBeFocused();
  await expect(addForm(page).getByLabel("Local key")).toHaveAttribute("type", "password");

  // A key the Light doesn't answer to is refused, and nothing is added.
  await fillAddForm(page, { key: "0123456789abcdef", name: "Lamp", room: "Living room" });
  await expect(addForm(page).getByRole("alert")).toHaveText(
    "The Light didn't answer to that device id and local key. Check each, as they were read from the Light.",
  );
  await expect(names(page)).toHaveCount(0);

  await fillAddForm(page, { key: lamp.key });
  await expect(names(page)).toHaveText(["Living room · Lamp"]);
  await expect(found(page, FAKE_LIGHTS.lamp.host)).toContainText("Added, as Living room · Lamp");
  await expect(addForm(page).getByLabel("Local key")).toHaveValue("");

  // The plug beside it; a second "lamp" in the same Room is refused.
  await found(page, FAKE_LIGHTS.plug.host).getByRole("button", { name: /^Add / }).click();
  await fillAddForm(page, { key: plug.key, name: "lamp", room: "Living room" });
  await expect(addForm(page).getByRole("alert")).toHaveText('There is already a Light called "Lamp" in Living room.');
  await fillAddForm(page, { name: "Plug" });
  await expect(names(page)).toHaveText(["Living room · Lamp", "Living room · Plug"]);

  // Renamed and moved.
  await lights(page).getByRole("button", { name: "Edit Living room · Plug" }).click();
  const edit = lights(page).getByRole("form", { name: "Edit Living room · Plug" });
  await edit.getByRole("textbox", { name: "Light name" }).fill("Fan plug");
  await edit.getByRole("combobox", { name: "Room" }).selectOption({ label: "Bedroom" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(names(page)).toHaveText(["Living room · Lamp", "Bedroom · Fan plug"]);

  // Opened again, from what the Hub keeps, and never with a Light's id or key.
  await page.reload();
  await expect(names(page)).toHaveText(["Living room · Lamp", "Bedroom · Fan plug"]);
  const shown = await page.content();
  const kept = await (await request.get("/api/appliances")).text();
  for (const secret of [lamp.id, lamp.key, plug.id, plug.key]) {
    expect(shown).not.toContain(secret);
    expect(kept).not.toContain(secret);
  }

  // Removed, the Hub forgets it.
  await lights(page).getByRole("button", { name: "Remove Bedroom · Fan plug" }).click();
  await lights(page).getByRole("button", { name: "Yes, remove" }).click();
  await expect(names(page)).toHaveText(["Living room · Lamp"]);
});

// FR-54: a Light the Hub can't find is added by its address, with its device id and local key.
test("a Light the Hub can't find is added by its address, device id and local key, and controlled", async ({
  page,
  request,
}) => {
  const hidden = await start("hidden");
  await addRooms(request, ["Hall"]);
  await openSettings(page);

  await lights(page).getByRole("button", { name: "Find Lights" }).click();
  await expect(lights(page).getByRole("status")).toHaveText(
    /^No Lights found\. Check that it is switched on and on the same network as the Hub/,
    { timeout: 15_000 },
  );

  // Without its id the Hub listens for it at the address, and doesn't hear it.
  await fillAddForm(page, { address: HIDDEN_FAKE_LIGHT.host, key: hidden.key, name: "Ceiling", room: "Hall" });
  await expect(addForm(page).getByRole("alert")).toHaveText(/^No Light answered at 127\.0\.0\.11\./, {
    timeout: 15_000,
  });

  await fillAddForm(page, { id: hidden.id });
  await expect(names(page)).toHaveText(["Hall · Ceiling"]);
  await expect(lights(page).getByText(`Lepro, protocol v3.3, at ${HIDDEN_FAKE_LIGHT.host}`)).toBeVisible();

  // It answers to them from the Lights tab.
  await page.getByRole("tab", { name: "Lights" }).click();
  const ceiling = page.getByRole("region", { name: "Hall · Ceiling" });
  await expect(ceiling.getByRole("button", { name: "Power", exact: true })).toBeEnabled();
  await ceiling.getByRole("button", { name: "Power", exact: true }).click();
  await expect.poll(() => hidden.light().on).toBe(false);
});
