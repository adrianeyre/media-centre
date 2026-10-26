import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  FAKE_APPS,
  startFakeSamsungTv,
  type FakeApp,
  type FakeAppStatus,
  type FakeSamsungTv,
} from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TV_CONTROL_PORT, FAKE_TV_REST_PORT, FAKE_TVS, SPARE_FAKE_TV, fakeTvUrl } from "./fake-tvs.ts";

/** Started by the test that switches it off at the wall, and stopped after it if it is still on. */
let spare: FakeSamsungTv | undefined;

// The run's Hub is shared by every test, so each starts and ends with no TVs
// and no Rooms, and with the run's fake TVs on, with their own apps installed
// and none running.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  for (const { host } of Object.values(FAKE_TVS)) {
    // Standby closes every app.
    for (const power of ["standby", "on"]) {
      expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power } })).ok()).toBe(true);
    }
    await installApps(request, host, FAKE_APPS);
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => {
  await spare?.stop();
  spare = undefined;
  await forgetEverything(request);
});

/** Installs these apps on the fake TV instead of those it has, as installing and removing them on the TV would. */
const installApps = async (request: APIRequestContext, host: string, apps: readonly FakeApp[]): Promise<void> => {
  expect((await request.put(fakeTvUrl(host, "/_fake/apps"), { data: apps })).ok()).toBe(true);
};

/** What the fake TV reports of its apps that are running, and whether each is visible. */
const runningOn = async (
  request: APIRequestContext,
  host: string,
): Promise<Pick<FakeAppStatus, "name" | "visible">[]> =>
  ((await (await request.get(fakeTvUrl(host, "/_fake/apps"))).json()) as FakeAppStatus[])
    .filter(({ running }) => running)
    .map(({ name, visible }) => ({ name, visible }));

/** Adds Living room · TV and Bedroom · TV, the run's two fake TVs, through the Hub. */
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

const apps = (page: Page) => page.getByRole("region", { name: "Apps" });

/** The apps listed, as the Remote names them. */
const shownApps = async (page: Page): Promise<(string | null)[]> =>
  Promise.all((await apps(page).getByRole("listitem").all()).map((item) => item.getAttribute("aria-label")));

/** Chooses a TV in the TV picker. */
const choose = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: /^Selected TV: / }).click();
  await page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("button", { name: /^Selected TV: / })).toHaveText(`Selected TV: ${title}`);
};

/** The TV tab reads each TV's power state every 3 seconds, and the apps when that changes. */
const FOLLOWS = { timeout: 10_000 };

// FR-21: the Remote lists the Selected TV's installed apps, with names and icons where the TV gives them.
test("lists the Selected TV's installed apps, with their icons where the TV gives them", async ({ page, request }) => {
  await addTwoTvs(request);
  await installApps(request, FAKE_TVS.bedroom.host, [
    { id: "3201907018807", name: "Netflix" },
    { id: "a.plex", name: "Plex", icon: false },
  ]);
  await page.goto("/");

  await expect.poll(() => shownApps(page)).toEqual(["Internet", "Netflix", "Prime Video", "YouTube"]);
  const youTube = apps(page).getByRole("button", { name: "Launch YouTube" }).locator("img");
  // The fake TV's icons are 16 pixels square: one that loaded from the Hub has its size.
  await expect(youTube).toHaveJSProperty("naturalWidth", 16);
  const icon = await request.get((await youTube.getAttribute("src")) ?? "");
  expect(icon.headers()["content-type"]).toBe("image/png");
  await expect(apps(page).getByRole("button", { name: "Launch Internet" }).locator("img")).toHaveCount(0);

  await choose(page, "Bedroom · TV");
  await expect.poll(() => shownApps(page)).toEqual(["Netflix", "Plex"]);
  // An app removed from the TV goes from the list once the Remote reads it again.
  await installApps(request, FAKE_TVS.bedroom.host, [{ id: "a.plex", name: "Plex", icon: false }]);
  await page.reload();
  await expect.poll(() => shownApps(page)).toEqual(["Plex"]);
});

// FR-21: launching an app makes the fake TV report it running and visible, and closing it, no longer running.
test("launching an app makes the TV report it running and visible, and closing it makes it no longer running", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await page.goto("/");

  await apps(page).getByRole("button", { name: "Launch YouTube" }).click();
  await expect(apps(page).getByRole("status")).toHaveText("Launched YouTube.");
  expect(await runningOn(request, FAKE_TVS.living.host)).toEqual([{ name: "YouTube", visible: true }]);
  expect(await runningOn(request, FAKE_TVS.bedroom.host)).toEqual([]);

  await apps(page).getByRole("button", { name: "Launch Netflix" }).click();
  await expect(apps(page).getByRole("status")).toHaveText("Launched Netflix.");
  expect(await runningOn(request, FAKE_TVS.living.host)).toEqual([
    { name: "YouTube", visible: false },
    { name: "Netflix", visible: true },
  ]);

  await apps(page).getByRole("button", { name: "Close Netflix" }).click();
  await expect(apps(page).getByRole("status")).toHaveText("Closed Netflix.");
  expect(await runningOn(request, FAKE_TVS.living.host)).toEqual([{ name: "YouTube", visible: false }]);

  await apps(page).getByRole("button", { name: "Close YouTube" }).click();
  await expect(apps(page).getByRole("status")).toHaveText("Closed YouTube.");
  expect(await runningOn(request, FAKE_TVS.living.host)).toEqual([]);
});

// FR-21, FR-25: a TV in standby or unreachable says so, rather than showing an empty list.
test("a TV in standby, or switched off at the wall, says so rather than showing no apps", async ({ page, request }) => {
  spare = await startFakeSamsungTv({
    host: SPARE_FAKE_TV.host,
    restPort: FAKE_TV_REST_PORT,
    controlPort: FAKE_TV_CONTROL_PORT,
    name: SPARE_FAKE_TV.name,
    macAddress: SPARE_FAKE_TV.macAddress,
  });
  await addTwoTvs(request);
  expect(
    (
      await request.post("/api/appliances", { data: { kind: "tv", address: SPARE_FAKE_TV.host, name: "Spare" } })
    ).status(),
  ).toBe(201);
  await page.goto("/");
  await expect(apps(page).getByRole("listitem")).toHaveCount(4);

  // Put in standby with its own remote, while the Remote shows it.
  expect(
    (await request.post(fakeTvUrl(FAKE_TVS.living.host, "/_fake/power"), { data: { power: "standby" } })).ok(),
  ).toBe(true);
  await expect(apps(page)).toContainText("Living room · TV is in standby. Switch it on to see its apps.", FOLLOWS);
  await expect(apps(page).getByRole("listitem")).toHaveCount(0);

  expect((await request.post(fakeTvUrl(FAKE_TVS.living.host, "/_fake/power"), { data: { power: "on" } })).ok()).toBe(
    true,
  );
  await expect(apps(page).getByRole("listitem")).toHaveCount(4, FOLLOWS);

  // Switched off at the wall.
  await choose(page, "Spare");
  await expect(apps(page).getByRole("listitem")).toHaveCount(4);
  await spare.stop();
  spare = undefined;
  await expect(apps(page)).toContainText(
    "Spare isn't answering, so its apps can't be listed. Check that it is switched on and on the same network as the Hub.",
    FOLLOWS,
  );
  await expect(apps(page).getByRole("listitem")).toHaveCount(0);
});
