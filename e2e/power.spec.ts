import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { SAMSUNG_POWER_KEY } from "../packages/hub/src/drivers/samsung-tv/keys.ts";
import {
  startFakeSamsungTv,
  type FakeSamsungTv,
  type RecordedKey,
  type RecordedWake,
} from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import {
  FAKE_TV_CONTROL_PORT,
  FAKE_TV_REST_PORT,
  FAKE_TV_WAKE_PORT,
  FAKE_TVS,
  SPARE_FAKE_TV,
  fakeTvUrl,
} from "./fake-tvs.ts";

/** Started as a Frame TV by the test that needs one, and stopped after it. */
let frame: FakeSamsungTv | undefined;

// The run's Hub is shared by every test, so each starts and ends with no TVs
// and no Rooms, and with the run's fake TVs on, having recorded nothing.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    await setPower(request, host, "on");
    for (const path of ["/_fake/keys", "/_fake/wakes"] as const) {
      expect((await request.delete(fakeTvUrl(host, path))).ok()).toBe(true);
    }
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => {
  await frame?.stop();
  frame = undefined;
  await forgetEverything(request);
});

const setPower = async (request: APIRequestContext, host: string, power: "on" | "standby"): Promise<void> => {
  expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power } })).ok()).toBe(true);
};

/** Adds a TV in a Room of its own name, through the Hub, which pairs with the fake TV there. */
const addTv = async (request: APIRequestContext, room: string, address: string): Promise<void> => {
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: room } })).json()) as { id: number };
  const response = await request.post("/api/appliances", { data: { kind: "tv", address, name: "TV", roomId } });
  expect(response.status()).toBe(201);
};

const wakesOf = async (request: APIRequestContext, host: string): Promise<RecordedWake[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/wakes"))).json()) as RecordedWake[];

const keysOf = async (request: APIRequestContext, host: string): Promise<RecordedKey[]> =>
  (await (await request.get(fakeTvUrl(host, "/_fake/keys"))).json()) as RecordedKey[];

const powerButton = (page: Page) => page.getByRole("region", { name: "Power" }).getByRole("button", { name: "Power" });

const powerOf = (page: Page, title: string) =>
  page.getByRole("region", { name: "TVs" }).getByRole("listitem", { name: title }).locator(".power");

/** The TV tab asks the Hub again every few seconds, so it can take that long to follow a TV. */
const FOLLOWS = { timeout: 10_000 };

// FR-17: power on is Wake-on-LAN, to the MAC address the Hub read from the TV's device info.
test("Power wakes a TV in standby with a magic packet for its MAC address, and the Remote shows it come on", async ({
  page,
  request,
}) => {
  await addTv(request, "Living room", FAKE_TVS.living.host);
  await addTv(request, "Bedroom", FAKE_TVS.bedroom.host);
  await setPower(request, FAKE_TVS.living.host, "standby");

  await page.goto("/");
  await expect(powerOf(page, "Living room · TV")).toHaveText("Standby");
  await powerButton(page).click();

  await expect
    .poll(async () => (await wakesOf(request, FAKE_TVS.living.host)).map(({ macAddress }) => macAddress))
    .toEqual([FAKE_TVS.living.macAddress]);
  await expect(powerOf(page, "Living room · TV")).toHaveText("On", FOLLOWS);
  await expect(page.getByRole("region", { name: "Power" }).getByRole("status")).toHaveText("");
  expect(await keysOf(request, FAKE_TVS.living.host)).toEqual([]);
  expect(await wakesOf(request, FAKE_TVS.bedroom.host)).toEqual([]);
  await expect(powerOf(page, "Bedroom · TV")).toHaveText("On");
});

// FR-17: power off is one press of the power key.
test("Power switches a TV that is on off with one press of its power key, and the Remote shows it go into standby", async ({
  page,
  request,
}) => {
  await addTv(request, "Living room", FAKE_TVS.living.host);

  await page.goto("/");
  await expect(powerOf(page, "Living room · TV")).toHaveText("On");
  await powerButton(page).click();

  await expect(powerOf(page, "Living room · TV")).toHaveText("Standby", FOLLOWS);
  const keys = await keysOf(request, FAKE_TVS.living.host);
  expect(keys.map(({ code, command }) => ({ code, command }))).toEqual([{ code: SAMSUNG_POWER_KEY, command: "Click" }]);
  expect(await wakesOf(request, FAKE_TVS.living.host)).toEqual([]);

  // And on again, from standby.
  await powerButton(page).click();
  await expect(powerOf(page, "Living room · TV")).toHaveText("On", FOLLOWS);
  expect(await wakesOf(request, FAKE_TVS.living.host)).toHaveLength(1);
  expect(await keysOf(request, FAKE_TVS.living.host)).toHaveLength(1);
});

// FR-17: a Frame TV, as its device info says, takes a tap of the power key for Art Mode, so the Driver holds it.
test("Power holds the power key of a Frame TV, and the Remote shows it go into standby", async ({ page, request }) => {
  frame = await startFakeSamsungTv({
    host: SPARE_FAKE_TV.host,
    restPort: FAKE_TV_REST_PORT,
    controlPort: FAKE_TV_CONTROL_PORT,
    wakePort: FAKE_TV_WAKE_PORT,
    name: SPARE_FAKE_TV.name,
    macAddress: SPARE_FAKE_TV.macAddress,
    frame: true,
  });
  await addTv(request, "Lounge", SPARE_FAKE_TV.host);

  await page.goto("/");
  await expect(powerOf(page, "Lounge · TV")).toHaveText("On");
  await powerButton(page).click();

  // Held for seconds, during which the button can't be tapped again.
  await expect(powerButton(page)).toBeDisabled();
  await expect(page.getByRole("region", { name: "Power" }).getByRole("status")).toHaveText("Switching…");
  await expect(powerOf(page, "Lounge · TV")).toHaveText("Standby", FOLLOWS);
  await expect(powerButton(page)).toBeEnabled();

  const [down, up, ...more] = frame.keys;
  expect([down, up].map((key) => ({ code: key?.code, command: key?.command }))).toEqual([
    { code: SAMSUNG_POWER_KEY, command: "Press" },
    { code: SAMSUNG_POWER_KEY, command: "Release" },
  ]);
  expect(more).toEqual([]);
  expect((up?.receivedAt ?? 0) - (down?.receivedAt ?? 0)).toBeGreaterThanOrEqual(2_900);

  // A Frame in standby wakes over Wake-on-LAN like any other TV.
  await powerButton(page).click();
  await expect(powerOf(page, "Lounge · TV")).toHaveText("On", FOLLOWS);
  expect(frame.wakes.map(({ macAddress }) => macAddress)).toEqual([SPARE_FAKE_TV.macAddress]);
});
