import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { DeveloperSettings, HubAddress } from "../packages/shared/src/index.ts";
import type { RecordedRequest } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";
import { openSettingsOn } from "./settings.ts";

// The run's Hub is shared by every test, so each starts and ends with no TVs,
// no Rooms and no IP address set for the Hub, and with the run's fake TVs on,
// reporting Developer Mode off with no Developer IP.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  expect((await request.put("/api/hub/address", { data: { override: null } })).ok()).toBe(true);
  for (const { host } of Object.values(FAKE_TVS)) {
    expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power: "on" } })).ok()).toBe(true);
    await setDeveloper(request, host, { mode: "off", ip: null });
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** Has the fake TV report this of Developer Mode, as switching it on at the TV and restarting would, or neither. */
const setDeveloper = async (
  request: APIRequestContext,
  host: string,
  developer: DeveloperSettings | null,
): Promise<void> => {
  expect((await request.put(fakeTvUrl(host, "/_fake/developer"), { data: JSON.stringify(developer) })).ok()).toBe(true);
};

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

const section = (page: Page) => page.getByRole("region", { name: "Developer" });

const openSection = async (page: Page): Promise<void> => {
  const toggle = section(page).getByRole("button", { name: "Developer", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
};

/** The value the device info shows for this label. */
const field = (page: Page, label: string) =>
  section(page)
    .locator(".device-info dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");

/** The step that says what to enter as the Developer IP. */
const ipStep = (page: Page) =>
  section(page).getByRole("listitem").filter({ hasText: "Where it asks for an IP address" });

/** Chooses a TV in the TV picker. */
const choose = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: /^Selected TV: / }).click();
  await page.getByRole("list", { name: "Choose a TV" }).getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("button", { name: /^Selected TV: / })).toHaveText(`Selected TV: ${title}`);
};

/** The section reads the TV's device info every 5 seconds while open. */
const FOLLOWS = { timeout: 15_000 };

// FR-28: each field of the fake's device info, with the Developer Mode and Developer IP it reports.
test("the Developer section shows the Selected TV's device info, with Developer Mode and the Developer IP it reports", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await setDeveloper(request, FAKE_TVS.living.host, { mode: "on", ip: "192.168.1.5" });
  await page.goto("/");
  await openSection(page);

  await expect(field(page, "Model")).toHaveText("QE55Q60TAUXXU");
  await expect(field(page, "Name")).toHaveText(FAKE_TVS.living.name);
  await expect(field(page, "MAC address")).toHaveText(FAKE_TVS.living.macAddress);
  await expect(field(page, "Network")).toHaveText("Wi-Fi");
  await expect(field(page, "Frame TV")).toHaveText("No");
  await expect(field(page, "Developer Mode")).toHaveText("On");
  await expect(field(page, "Developer IP")).toHaveText("192.168.1.5");
  await expect(section(page).getByText(/doesn't report/)).toHaveCount(0);

  // Another TV's own, once it is the Selected TV.
  await choose(page, "Bedroom · TV");
  await openSection(page);
  await expect(field(page, "Name")).toHaveText(FAKE_TVS.bedroom.name);
  await expect(field(page, "Developer Mode")).toHaveText("Off");
  await expect(field(page, "Developer IP")).toHaveText("None set");
});

// FR-28, §10: the Developer section copes with a TV that doesn't report Developer Mode or the Developer IP.
test("the Developer section says when the TV doesn't report Developer Mode and the Developer IP, and follows the TV", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  await setDeveloper(request, FAKE_TVS.living.host, null);
  await page.goto("/");
  await openSection(page);

  await expect(
    section(page).getByText("Living room · TV doesn't report whether Developer Mode is on, nor its Developer IP."),
  ).toBeVisible();
  await expect(field(page, "Model")).toHaveText("QE55Q60TAUXXU");
  await expect(section(page).locator(".device-info dt")).toHaveText([
    "Model",
    "Name",
    "MAC address",
    "Network",
    "Frame TV",
  ]);

  // As firmware that reports them would, once Developer Mode is switched on at the TV: no reload.
  await setDeveloper(request, FAKE_TVS.living.host, { mode: "on", ip: "192.168.1.5" });
  await expect(field(page, "Developer IP")).toHaveText("192.168.1.5", FOLLOWS);
  await expect(section(page).getByText(/doesn't report/)).toHaveCount(0);

  // A TV in standby still reports its device info.
  expect(
    (await request.post(fakeTvUrl(FAKE_TVS.living.host, "/_fake/power"), { data: { power: "standby" } })).ok(),
  ).toBe(true);
  await expect(page.getByRole("region", { name: "Now Showing" })).toContainText("in standby", FOLLOWS);
  await expect(field(page, "Developer Mode")).toHaveText("On");
});

// FR-29: the steps give the Hub's own IP address as the Developer IP, and follow one set in Settings.
test("the Developer steps give the Hub's IP address as the Developer IP, as found or as set in Settings", async ({
  page,
  request,
}) => {
  await addTwoTvs(request);
  const { found } = (await (await request.get("/api/hub/address")).json()) as HubAddress;
  await page.goto("/");
  await openSection(page);

  await expect(section(page).getByRole("heading", { name: "Turn on Developer Mode" })).toBeVisible();
  await expect(section(page).getByRole("listitem")).toHaveCount(6);
  await expect(section(page).getByRole("listitem").first()).toHaveText(
    "Press Home on the physical remote, and open Apps.",
  );
  if (found === null) {
    await expect(ipStep(page)).toContainText("The Hub couldn't find its own IP address on your home network");
  } else {
    await expect(ipStep(page)).toHaveText(
      `Where it asks for an IP address, enter the Hub's IP, ${found}, then choose OK.`,
    );
  }

  // Set in Settings, as on a machine on more than one network.
  await section(page).getByRole("button", { name: "Set it in Settings" }).click();
  const setting = page.getByRole("group", { name: "IP address" });
  await expect(setting.locator(".hub-address-now")).toHaveText(
    found === null
      ? "The Hub couldn't find its IP address on your home network. Set it below."
      : `The Hub's IP address is ${found}, which it found on its network.`,
  );
  await setting.getByRole("textbox", { name: "IP address to use" }).fill("hub.local");
  await setting.getByRole("button", { name: "Use this IP address" }).click();
  await expect(setting.getByRole("alert")).toHaveText(
    "Give the Hub's IP address as four numbers with dots, e.g. 192.168.1.10.",
  );
  await setting.getByRole("textbox", { name: "IP address to use" }).fill("192.168.1.77");
  await setting.getByRole("button", { name: "Use this IP address" }).click();
  await expect(setting.locator(".hub-address-now")).toContainText("set to 192.168.1.77");

  await page.getByRole("tab", { name: "TV" }).click();
  await openSection(page);
  await expect(ipStep(page)).toHaveText(
    "Where it asks for an IP address, enter the Hub's IP, 192.168.1.77, then choose OK.",
  );

  // It survives a reload, kept on the Hub.
  await page.reload();
  await openSection(page);
  await expect(ipStep(page)).toContainText("192.168.1.77");

  // And goes back to the one found.
  await openSettingsOn(page, "General");
  await page.getByRole("group", { name: "IP address" }).getByRole("button", { name: "Use the one found" }).click();
  await expect(
    page.getByRole("group", { name: "IP address" }).getByRole("button", { name: "Use the one found" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "TV" }).click();
  await openSection(page);
  await expect(ipStep(page)).not.toContainText("192.168.1.77");
});

// FR-28: reading device info is a read, and nothing else.
test("the Developer section sends nothing to the TV that would change it", async ({ page, request }) => {
  await addTwoTvs(request);
  for (const { host } of Object.values(FAKE_TVS)) {
    for (const path of ["/_fake/requests", "/_fake/keys", "/_fake/wakes", "/_fake/connections"] as const) {
      expect((await request.delete(fakeTvUrl(host, path))).ok()).toBe(true);
    }
  }
  await page.goto("/");
  await openSection(page);
  await expect(field(page, "Model")).toHaveText("QE55Q60TAUXXU");
  await choose(page, "Bedroom · TV");
  await openSection(page);
  await expect(field(page, "Name")).toHaveText(FAKE_TVS.bedroom.name);

  for (const { host } of Object.values(FAKE_TVS)) {
    const requests = (await (await request.get(fakeTvUrl(host, "/_fake/requests"))).json()) as RecordedRequest[];
    expect(requests.filter(({ method }) => method !== "GET")).toEqual([]);
    expect(await (await request.get(fakeTvUrl(host, "/_fake/keys"))).json()).toEqual([]);
    expect(await (await request.get(fakeTvUrl(host, "/_fake/wakes"))).json()).toEqual([]);
  }
});
