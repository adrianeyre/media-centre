import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { FAKE_AIRCONS, FAKE_CLOUD_LOGIN, fakeAirconUrl, fakeCloudUrl } from "./fake-air-conditioners.ts";
import { openSettingsOn } from "./settings.ts";

interface Connection {
  readonly version: 2 | 3;
  readonly handshake: "none" | "accepted" | "refused";
}

// The run's Hub is shared by every test, so each starts and ends with no Appliances and no Rooms.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
};
test.beforeEach(async ({ request }) => {
  await forgetEverything(request);
  for (const { host } of Object.values(FAKE_AIRCONS)) {
    expect((await request.delete(fakeAirconUrl(host, "/_fake/connections"))).ok()).toBe(true);
    expect((await request.post(fakeAirconUrl(host, "/_fake/state"), { data: { power: false } })).ok()).toBe(true);
  }
  expect((await request.delete(fakeCloudUrl("/_fake/requests"))).ok()).toBe(true);
});
test.afterEach(async ({ request }) => forgetEverything(request));

const addRooms = async (request: APIRequestContext, names: readonly string[]): Promise<void> => {
  for (const name of names) expect((await request.post("/api/rooms", { data: { name } })).status()).toBe(201);
};

const openSettings = async (page: Page): Promise<void> => {
  await page.goto("/");
  await openSettingsOn(page, "Aircon");
  await expect(page.getByRole("heading", { name: "Air Conditioners", level: 2 })).toBeVisible();
};

const airConditioners = (page: Page) => page.getByRole("region", { name: "Air Conditioners", exact: true });

/** The Air Conditioners as Settings names them, Room by Room. */
const names = (page: Page) => airConditioners(page).locator(".room-group .room-row .room-name");

const addForm = (page: Page) => page.getByRole("form", { name: "Add Air Conditioner by IP" });

const fillAddForm = async (page: Page, address: string | undefined, name: string, room: string): Promise<void> => {
  const form = addForm(page);
  if (address !== undefined) await form.getByRole("textbox", { name: "IP address" }).fill(address);
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  await form.getByRole("combobox", { name: "Room" }).selectOption({ label: room });
  await form.getByRole("button", { name: "Add Air Conditioner" }).click();
};

const loginDialog = (page: Page) => page.getByRole("dialog", { name: "Sign in to MSmartHome" });

const signIn = async (page: Page, login: { account: string; password: string }, button: string): Promise<void> => {
  const dialog = loginDialog(page);
  await dialog.getByRole("textbox", { name: "Email" }).fill(login.account);
  await dialog.getByLabel("Password").fill(login.password);
  await dialog.getByRole("button", { name: button }).click();
};

const cloudRequests = async (request: APIRequestContext): Promise<{ path: string; outcome: string }[]> =>
  (await (await request.get(fakeCloudUrl("/_fake/requests"))).json()) as { path: string; outcome: string }[];

const connectionsTo = async (request: APIRequestContext, host: string): Promise<Connection[]> =>
  (await (await request.get(fakeAirconUrl(host, "/_fake/connections"))).json()) as Connection[];

// Aircon PRD §5 scenario 2, and FR-51.1, FR-8, FR-9 and FR-11.
test("Find Air Conditioners lists the fake units, a found one is added by IP, and they are named and moved as TVs are", async ({
  page,
  request,
}) => {
  await addRooms(request, ["Living room", "Bedroom"]);
  await openSettings(page);
  await expect(airConditioners(page).getByText("No Air Conditioners yet.")).toBeVisible();

  await airConditioners(page).getByRole("button", { name: "Find Air Conditioners" }).click();
  const found = airConditioners(page).getByRole("list", { name: "Air Conditioners found" });
  await expect(found.getByRole("listitem")).toHaveCount(2);
  const v2 = found.getByRole("listitem", {
    name: new RegExp(`, at ${FAKE_AIRCONS.living.host.replaceAll(".", "\\.")}$`),
  });
  const v3 = found.getByRole("listitem", {
    name: new RegExp(`, at ${FAKE_AIRCONS.bedroom.host.replaceAll(".", "\\.")}$`),
  });
  await expect(v3).toContainText("needs the MSmartHome login once");
  await expect(v2).not.toContainText("needs the MSmartHome login");

  // The v2 unit needs no login.
  await v2.getByRole("button", { name: /^Add / }).click();
  await expect(addForm(page).getByRole("textbox", { name: "IP address" })).toHaveValue(FAKE_AIRCONS.living.host);
  await fillAddForm(page, undefined, "Aircon", "Living room");
  await expect(names(page)).toHaveText(["Living room · Aircon"]);
  await expect(loginDialog(page)).toHaveCount(0);
  await expect(v2).toContainText("Added, as Living room · Aircon");
  expect(await cloudRequests(request)).toEqual([]);

  // A second "aircon" in the same Room is refused, as for TVs.
  await fillAddForm(page, FAKE_AIRCONS.living.host, "aircon", "Living room");
  await expect(addForm(page).getByRole("alert")).toHaveText(
    'There is already an Air Conditioner called "Aircon" in Living room.',
  );

  // Renamed and moved, then to "No room" as its Room goes.
  await airConditioners(page).getByRole("button", { name: "Edit Living room · Aircon" }).click();
  const edit = airConditioners(page).getByRole("form", { name: "Edit Living room · Aircon" });
  await edit.getByRole("textbox", { name: "Air Conditioner name" }).fill("Big aircon");
  await edit.getByRole("combobox", { name: "Room" }).selectOption({ label: "Bedroom" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(names(page)).toHaveText(["Bedroom · Big aircon"]);

  const rooms = (await (await request.get("/api/rooms")).json()) as { id: number; name: string }[];
  const bedroom = rooms.find(({ name }) => name === "Bedroom");
  expect((await request.delete(`/api/rooms/${String(bedroom?.id)}`)).status()).toBe(204);
  await page.reload();
  await expect(names(page)).toHaveText(["Big aircon"]);
  await expect(airConditioners(page).getByRole("heading", { level: 3 }).first()).toHaveText("No room");
});

// FR-51.2 and ADR 0009.
test("adding a v3 unit by IP asks once for the MSmartHome login, fetches its token and key, keeps no login, and controls it without the cloud", async ({
  page,
  request,
}) => {
  await addRooms(request, ["Bedroom"]);
  await openSettings(page);

  await fillAddForm(page, FAKE_AIRCONS.bedroom.host, "Aircon", "Bedroom");
  await expect(loginDialog(page)).toBeVisible();
  await expect(loginDialog(page)).toContainText("forgets your email and password");

  await signIn(page, { ...FAKE_CLOUD_LOGIN, password: "Tr0ub4dor&3" }, "Sign in and add");
  await expect(loginDialog(page).getByRole("alert")).toHaveText(
    "Neither MSmartHome nor Midea Air accepted that email and password. Check them, as you sign in to the app the Air Conditioner is set up in, then try again.",
  );

  await signIn(page, FAKE_CLOUD_LOGIN, "Sign in and add");
  await expect(loginDialog(page)).toHaveCount(0);
  await expect(names(page)).toHaveText(["Bedroom · Aircon"]);
  await expect(airConditioners(page).getByRole("listitem", { name: "Bedroom · Aircon" })).toContainText(
    `Midea, protocol v3, at ${FAKE_AIRCONS.bedroom.host}`,
  );
  expect((await connectionsTo(request, FAKE_AIRCONS.bedroom.host)).at(-1)).toEqual({
    version: 3,
    handshake: "accepted",
  });

  // The login was sent, used and forgotten: it isn't in the Hub's state.
  const database = await readFile(process.env.E2E_HUB_DATABASE ?? "");
  for (const text of [FAKE_CLOUD_LOGIN.account, FAKE_CLOUD_LOGIN.password]) {
    expect(database.includes(Buffer.from(text, "utf8"))).toBe(false);
  }

  // Controlled through the Hub from now on with no word to the cloud.
  const asked = (await cloudRequests(request)).length;
  const [aircon] = (await (await request.get("/api/appliances")).json()) as { id: number }[];
  const changed = await request.patch(`/api/appliances/${String(aircon?.id)}/state`, {
    data: { power: true, mode: "cool", targetTemperature: 21.5 },
  });
  expect(changed.status()).toBe(200);
  const state = (await (await request.get(fakeAirconUrl(FAKE_AIRCONS.bedroom.host, "/_fake/state"))).json()) as {
    power: boolean;
    targetTemperature: number;
  };
  expect(state).toMatchObject({ power: true, targetTemperature: 21.5 });
  expect(await cloudRequests(request)).toHaveLength(asked);
  expect(await changed.text()).not.toContain(process.env.E2E_AIRCON_TOKEN ?? "?");
});

// FR-51.4.
test('a unit that starts refusing its token and key shows "Fetch again", which restores control', async ({
  page,
  request,
}) => {
  const added = await request.post("/api/appliances", {
    data: {
      kind: "air-conditioner",
      address: FAKE_AIRCONS.bedroom.host,
      name: "Aircon",
      roomId: null,
      login: FAKE_CLOUD_LOGIN,
    },
  });
  expect(added.status()).toBe(201);
  const { id } = (await added.json()) as { id: number };

  // A factory reset, and the unit paired again in Midea's app, which issues it a new token and key.
  const keys = { token: randomBytes(64).toString("hex"), key: randomBytes(32).toString("hex") };
  expect((await request.post(fakeAirconUrl(FAKE_AIRCONS.bedroom.host, "/_fake/keys"), { data: keys })).status()).toBe(
    204,
  );
  expect(
    (await request.put(fakeCloudUrl("/_fake/units"), { data: [{ id: FAKE_AIRCONS.bedroom.id, ...keys }] })).ok(),
  ).toBe(true);

  await openSettings(page);
  const item = airConditioners(page).getByRole("listitem", { name: "Aircon" });
  await expect(item).toContainText("This Air Conditioner no longer accepts the Hub's token and key");
  await expect((await request.get(`/api/appliances/${String(id)}/state`)).json()).resolves.toEqual({
    known: false,
    why: "fetch-again",
  });

  await item.getByRole("button", { name: "Fetch again" }).click();
  await expect(loginDialog(page)).toContainText("Aircon no longer accepts its token and key");
  await signIn(page, FAKE_CLOUD_LOGIN, "Sign in and fetch again");

  await expect(loginDialog(page)).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Fetch again" })).toHaveCount(0);
  const changed = await request.patch(`/api/appliances/${String(id)}/state`, { data: { power: true } });
  expect(changed.status()).toBe(200);
  await expect(
    (await request.get(fakeAirconUrl(FAKE_AIRCONS.bedroom.host, "/_fake/state"))).json(),
  ).resolves.toMatchObject({ power: true });
});
