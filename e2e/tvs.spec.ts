import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";
import { openSettingsOn } from "./settings.ts";

interface Connection {
  readonly outcome: "paired" | "accepted" | "refused" | "unanswered";
  readonly token?: string;
  readonly issuedToken?: string;
}

// The run's Hub is shared by every test, so each starts and ends with no TVs and no Rooms.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
};
test.beforeEach(async ({ request }) => {
  await forgetEverything(request);
  for (const { host } of Object.values(FAKE_TVS)) {
    expect((await request.delete(fakeTvUrl(host, "/_fake/connections"))).ok()).toBe(true);
  }
});
test.afterEach(async ({ request }) => forgetEverything(request));

const addRooms = async (request: APIRequestContext, names: readonly string[]): Promise<void> => {
  for (const name of names) expect((await request.post("/api/rooms", { data: { name } })).status()).toBe(201);
};

const connectionsTo = async (request: APIRequestContext, host: string): Promise<Connection[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/connections"))).json()) as Connection[];

const openSettings = async (page: Page): Promise<void> => {
  await page.goto("/");
  await openSettingsOn(page, "TV");
  await expect(page.getByRole("heading", { name: "TVs", level: 2 })).toBeVisible();
};

const tvs = (page: Page) => page.getByRole("region", { name: "TVs" });

/** The TVs as Settings names them, Room by Room. */
const tvNames = (page: Page) => tvs(page).locator(".room-row .room-name");

const addTv = async (page: Page, address: string, name: string, room: string): Promise<void> => {
  const form = page.getByRole("form", { name: "Add TV by IP" });
  await form.getByRole("textbox", { name: "IP address" }).fill(address);
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  await form.getByRole("combobox", { name: "Room" }).selectOption({ label: room });
  await form.getByRole("button", { name: "Add TV" }).click();
};

// PRD §5 scenario 1, steps 2 and 3, by IP; then FR-8, FR-9, FR-11 and FR-14.
test("Settings adds two TVs by IP, names them Room · Name, and keeps them when their Room goes", async ({
  page,
  request,
}) => {
  await addRooms(request, ["Living room", "Bedroom"]);
  await openSettings(page);
  await expect(tvs(page).getByText("No TVs yet.")).toBeVisible();

  await addTv(page, FAKE_TVS.living.host, "TV", "Living room");
  await expect(tvNames(page)).toHaveText(["Living room · TV"]);

  // A second "tv" in the same Room is refused, before the TV is asked anything.
  await addTv(page, FAKE_TVS.bedroom.host, "tv", "Living room");
  await expect(tvs(page).getByRole("alert")).toHaveText('There is already a TV called "TV" in Living room.');
  expect(await connectionsTo(request, FAKE_TVS.bedroom.host)).toEqual([]);

  await addTv(page, FAKE_TVS.bedroom.host, "TV", "Bedroom");
  await expect(tvNames(page)).toHaveText(["Living room · TV", "Bedroom · TV"]);
  await expect(tvs(page).getByRole("heading", { level: 3 })).toHaveText([
    "Living room",
    "Bedroom",
    "Find TVs",
    "Add TV by IP",
  ]);
  await expect(tvs(page).getByRole("alert")).toHaveCount(0);

  // What the Hub kept, read from each TV's device info.
  const kept = (await (await request.get("/api/appliances")).json()) as Record<string, unknown>[];
  expect(kept.map(({ address, macAddress, model, name }) => ({ address, macAddress, model, name }))).toEqual([
    { address: FAKE_TVS.living.host, macAddress: FAKE_TVS.living.macAddress, model: "QE55Q60TAUXXU", name: "TV" },
    { address: FAKE_TVS.bedroom.host, macAddress: FAKE_TVS.bedroom.macAddress, model: "QE55Q60TAUXXU", name: "TV" },
  ]);

  // Deleting a Room, in Settings' Rooms, moves its TV to "No room", where it is named alone.
  const menu = page.getByRole("navigation", { name: "Settings" });
  await menu.getByRole("button", { name: "Rooms", exact: true }).click();
  const rooms = page.getByRole("region", { name: "Rooms" });
  await rooms.getByRole("button", { name: "Delete Living room" }).click();
  await rooms.getByRole("button", { name: "Yes, delete" }).click();
  await menu.getByRole("button", { name: "TV", exact: true }).click();
  await expect(tvs(page).getByRole("heading", { level: 3 })).toHaveText([
    "Bedroom",
    "No room",
    "Find TVs",
    "Add TV by IP",
  ]);
  await expect(tvNames(page)).toHaveText(["Bedroom · TV", "TV"]);
  expect((await (await request.get("/api/appliances")).json()) as unknown[]).toHaveLength(2);

  // Removing a TV is its own action, and confirmed.
  await tvs(page).getByRole("button", { name: "Remove Bedroom · TV" }).click();
  await tvs(page).getByRole("button", { name: "Yes, remove" }).click();
  await expect(tvNames(page)).toHaveText(["TV"]);

  // Added again with no name, it takes the TV's own.
  await addTv(page, FAKE_TVS.bedroom.host, "", "No room");
  await expect(tvNames(page)).toHaveText(["TV", FAKE_TVS.bedroom.name]);

  // The TVs are the Hub's, not this browser's.
  await page.reload();
  await openSettingsOn(page, "TV");
  await expect(tvNames(page)).toHaveText(["TV", FAKE_TVS.bedroom.name]);
});

// PRD §5 scenario 1, step 2, and FR-12: "Find TVs" over SSDP, then the same flow as adding by IP.
test('"Find TVs" lists the TVs on the network, marks one already added, and adds another through "Add TV by IP"', async ({
  page,
  request,
}) => {
  await addRooms(request, ["Living room", "Bedroom"]);
  await openSettings(page);
  await addTv(page, FAKE_TVS.bedroom.host, "TV", "Bedroom");
  await expect(tvNames(page)).toHaveText(["Bedroom · TV"]);

  const find = page.getByRole("region", { name: "Find TVs" });
  await find.getByRole("button", { name: "Find TVs" }).click();
  await expect(find.getByRole("status")).toHaveText("Looking for TVs on the network…");

  const found = find.getByRole("list", { name: "TVs found" }).getByRole("listitem");
  await expect(found).toHaveText([
    `${FAKE_TVS.living.name}AddQE55Q60TAUXXU, at ${FAKE_TVS.living.host}`,
    `${FAKE_TVS.bedroom.name}Added, as Bedroom · TVQE55Q60TAUXXU, at ${FAKE_TVS.bedroom.host}`,
  ]);
  const living = find.getByRole("listitem", { name: `${FAKE_TVS.living.name}, at ${FAKE_TVS.living.host}` });
  const bedroom = find.getByRole("listitem", { name: `${FAKE_TVS.bedroom.name}, at ${FAKE_TVS.bedroom.host}` });
  await expect(bedroom.getByRole("button")).toHaveCount(0);
  // Finding a TV doesn't pair with it.
  expect(await connectionsTo(request, FAKE_TVS.living.host)).toEqual([]);

  await living.getByRole("button", { name: `Add ${FAKE_TVS.living.name}, at ${FAKE_TVS.living.host}` }).click();
  const form = page.getByRole("form", { name: "Add TV by IP" });
  await expect(form.getByRole("textbox", { name: "IP address" })).toHaveValue(FAKE_TVS.living.host);
  await expect(form.getByRole("textbox", { name: "Name" })).toBeFocused();
  await form.getByRole("textbox", { name: "Name" }).fill("TV");
  await form.getByRole("combobox", { name: "Room" }).selectOption({ label: "Living room" });
  await form.getByRole("button", { name: "Add TV" }).click();

  await expect(tvNames(page)).toHaveText(["Living room · TV", "Bedroom · TV"]);
  expect((await connectionsTo(request, FAKE_TVS.living.host))[0]?.outcome).toBe("paired");
  await expect(living.getByText("Added, as Living room · TV")).toBeVisible();
  await expect(find.getByRole("button", { name: /^Add / })).toHaveCount(0);
});

// FR-4 and FR-13.
test('a TV whose access was revoked shows "Pair again", and the Hub never shows the Remote a token', async ({
  page,
  request,
}) => {
  const answers: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/")) {
      void response.text().then(
        (text) => answers.push(text),
        () => undefined,
      );
    }
  });
  await addRooms(request, ["Living room"]);
  await openSettings(page);
  await addTv(page, FAKE_TVS.living.host, "TV", "Living room");
  const tv = tvs(page).getByRole("listitem", { name: "Living room · TV" });
  await expect(tv).toBeVisible();
  await expect(tv.getByRole("button", { name: "Pair again" })).toHaveCount(0);

  const [paired] = await connectionsTo(request, FAKE_TVS.living.host);
  expect(paired?.outcome).toBe("paired");
  const first = paired?.issuedToken ?? "";

  // Opening Settings again has the Hub connect with the token it stored.
  await page.reload();
  await expect(tv).toBeVisible();
  await expect
    .poll(async () => (await connectionsTo(request, FAKE_TVS.living.host)).at(-1))
    .toMatchObject({
      outcome: "accepted",
      token: first,
    });

  // Access is revoked on the TV.
  expect((await request.post(fakeTvUrl(FAKE_TVS.living.host, "/_fake/revoke-access"))).ok()).toBe(true);
  await page.reload();
  await expect(tv.getByText("This TV no longer lets the Hub in.")).toBeVisible();

  await tv.getByRole("button", { name: "Pair again" }).click();
  await expect(tv.getByRole("button", { name: "Pair again" })).toHaveCount(0);
  const again = (await connectionsTo(request, FAKE_TVS.living.host)).at(-1);
  expect(again).toMatchObject({ outcome: "paired" });
  const second = again?.issuedToken ?? "";
  expect(second).not.toBe(first);

  // The new token is the one presented next time.
  await page.reload();
  await expect(tv).toBeVisible();
  await expect
    .poll(async () => (await connectionsTo(request, FAKE_TVS.living.host)).at(-1))
    .toMatchObject({
      outcome: "accepted",
      token: second,
    });

  await page.waitForLoadState("networkidle");
  expect(answers.length).toBeGreaterThan(5);
  for (const token of [first, second]) {
    expect(token).toMatch(/^\d{8}$/);
    for (const answer of answers) expect(answer).not.toContain(token);
  }
});
