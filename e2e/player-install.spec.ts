import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { FAKE_APPS, type FakeApp } from "../packages/hub/src/fakes/samsung-tv/fake-samsung-tv.ts";
import type { DeveloperSettings } from "../packages/shared/src/index.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";
import { openSettingsOn } from "./settings.ts";

// The Hub's IP address, as set in Settings, which the TV must have as its Developer IP.
const HUB_IP = "192.168.1.10";

const AUTHOR_PASSWORD = "e2e-author-Pa55";
const DISTRIBUTOR_PASSWORD = "e2e-distributor-Pa55";
/** The two halves of a signing certificate, as far as the Hub can tell: DER, as a .p12 file is. */
const AUTHOR = Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x01, 0x03, 0xaa]);
const DISTRIBUTOR = Buffer.from([0x30, 0x82, 0x02, 0x0b, 0x02, 0x01, 0x03, 0xbb]);

// The run's Hub is shared by every test, so each starts and ends with no TVs,
// no Rooms, no IP address set for the Hub and no signing certificate, and with
// the run's fake TVs on, in Developer Mode with the Hub's IP, without the Player.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  expect((await request.put("/api/hub/address", { data: { override: null } })).ok()).toBe(true);
  expect((await request.delete("/api/hub/signing-certificate")).ok()).toBe(true);
  for (const { host } of Object.values(FAKE_TVS)) {
    expect((await request.post(fakeTvUrl(host, "/_fake/power"), { data: { power: "on" } })).ok()).toBe(true);
    expect((await request.put(fakeTvUrl(host, "/_fake/apps"), { data: FAKE_APPS })).ok()).toBe(true);
    await setDeveloper(request, host, { mode: "off", ip: null });
  }
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** Has the fake TV report this of Developer Mode, as switching it on at the TV and restarting would. */
const setDeveloper = async (
  request: APIRequestContext,
  host: string,
  developer: DeveloperSettings | null,
): Promise<void> => {
  expect((await request.put(fakeTvUrl(host, "/_fake/developer"), { data: JSON.stringify(developer) })).ok()).toBe(true);
};

/** Adds Living room · TV, the run's first fake TV, and sets the Hub's IP, through the Hub. */
const addTv = async (request: APIRequestContext): Promise<void> => {
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Living room" } })).json()) as {
    id: number;
  };
  const response = await request.post("/api/appliances", {
    data: { kind: "tv", address: FAKE_TVS.living.host, name: "TV", roomId },
  });
  expect(response.status()).toBe(201);
  expect((await request.put("/api/hub/address", { data: { override: HUB_IP } })).ok()).toBe(true);
};

/** The ids of the apps the fake TV has installed. */
const installedApps = async (request: APIRequestContext): Promise<string[]> =>
  ((await (await request.get(fakeTvUrl(FAKE_TVS.living.host, "/_fake/apps"))).json()) as FakeApp[]).map(({ id }) => id);

const developer = (page: Page) => page.getByRole("region", { name: "Developer" });

const openDeveloper = async (page: Page): Promise<void> => {
  const toggle = developer(page).getByRole("button", { name: "Developer", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
};

/** Stores the signing certificate in Settings, as the person would, and goes back to the TV tab. */
const storeCertificate = async (page: Page): Promise<void> => {
  await openSettingsOn(page, "TV");
  const setting = page.getByRole("region", { name: "Signing certificate" });
  await expect(setting).toContainText("The Hub has no signing certificate yet.");
  await setting
    .getByLabel("Author certificate (author.p12)")
    .setInputFiles({ name: "author.p12", mimeType: "application/x-pkcs12", buffer: AUTHOR });
  await setting.getByLabel("Author certificate's password").fill(AUTHOR_PASSWORD);
  await setting
    .getByLabel("Distributor certificate (distributor.p12)")
    .setInputFiles({ name: "distributor.p12", mimeType: "application/x-pkcs12", buffer: DISTRIBUTOR });
  await setting.getByLabel("Distributor certificate's password").fill(DISTRIBUTOR_PASSWORD);
  await setting.getByRole("button", { name: "Store signing certificate" }).click();
  await expect(setting).toContainText("The Hub has a signing certificate, stored on");
  await expect(setting.getByLabel("Author certificate's password")).toHaveValue("");
  await page.getByRole("tab", { name: "TV" }).click();
};

/** The section reads the TV's device info every 5 seconds while open. */
const FOLLOWS = { timeout: 15_000 };

// FR-31, FR-4: the certificate goes to the Hub from Settings, and never back.
test("Settings stores the signing certificate on the Hub, which never sends it or its passwords back", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await storeCertificate(page);

  const answer = await (await request.get("/api/hub/signing-certificate")).text();
  expect(Object.keys(JSON.parse(answer) as object)).toEqual(["stored", "storedAt"]);
  expect(JSON.parse(answer)).toMatchObject({ stored: true });
  for (const secret of [
    AUTHOR_PASSWORD,
    DISTRIBUTOR_PASSWORD,
    AUTHOR.toString("base64"),
    DISTRIBUTOR.toString("base64"),
  ])
    expect(answer).not.toContain(secret);
});

// FR-31: the buttons are there only for a TV in Developer Mode with the Hub's IP, and follow it.
test("the Player's buttons appear only once the TV reports Developer Mode on with the Hub's IP", async ({
  page,
  request,
}) => {
  await addTv(request);
  await setDeveloper(request, FAKE_TVS.living.host, { mode: "on", ip: "192.168.1.99" });
  await page.goto("/");
  await openDeveloper(page);

  await expect(developer(page)).toContainText(
    "Once Developer Mode is on with the Hub's IP as Living room · TV's Developer IP, the Hub can install the Player",
  );
  await expect(developer(page).getByRole("button", { name: "Install / update Player" })).toHaveCount(0);

  await setDeveloper(request, FAKE_TVS.living.host, { mode: "on", ip: HUB_IP });

  await expect(developer(page).getByRole("button", { name: "Install / update Player" })).toBeVisible(FOLLOWS);
  await expect(developer(page).getByRole("button", { name: "Launch Player" })).toBeVisible();
  await expect(developer(page).getByRole("button", { name: "Uninstall Player" })).toBeVisible();
});

// FR-31: install, launch and uninstall, each step shown, through the Hub, the Samsung TV Driver and its tools.
test("Install / update Player installs the Player, signed with the certificate, and Launch and Uninstall work", async ({
  page,
  request,
}) => {
  await addTv(request);
  await setDeveloper(request, FAKE_TVS.living.host, { mode: "on", ip: HUB_IP });
  await page.goto("/");
  await storeCertificate(page);
  await openDeveloper(page);
  expect(await installedApps(request)).not.toContain("MediaCntre.Player");

  await developer(page).getByRole("button", { name: "Install / update Player" }).click();

  const install = developer(page).getByRole("region", { name: "Install / update the Player on Living room · TV" });
  await expect(install.getByRole("status")).toHaveText("The Player is installed on Living room · TV.");
  await expect(install.getByRole("listitem")).toHaveText([
    "Connect to the TV (done)",
    "Sign the Player with your certificate (done)",
    "Install it on the TV (done)",
  ]);
  expect(await installedApps(request)).toContain("MediaCntre.Player");

  await developer(page).getByRole("button", { name: "Launch Player" }).click();

  await expect(developer(page).getByRole("region", { name: "Launch the Player on Living room · TV" })).toContainText(
    "The Player is launched on Living room · TV.",
  );
  const front = (await (await request.get(fakeTvUrl(FAKE_TVS.living.host, "/_fake/front"))).json()) as {
    app: string | null;
  };
  expect(front.app).toBe("MediaCntre.Player");

  await developer(page).getByRole("button", { name: "Uninstall Player" }).click();
  await developer(page).getByRole("button", { name: "Yes, uninstall" }).click();

  await expect(developer(page).getByRole("region", { name: "Uninstall the Player on Living room · TV" })).toContainText(
    "The Player is uninstalled from Living room · TV.",
  );
  expect(await installedApps(request)).not.toContain("MediaCntre.Player");
});

// FR-31: errors reach the Remote, from the Hub refusing and from a step failing.
test("the Developer section shows why the Player couldn't be installed or uninstalled", async ({ page, request }) => {
  await addTv(request);
  await setDeveloper(request, FAKE_TVS.living.host, { mode: "on", ip: HUB_IP });
  await page.goto("/");
  await openDeveloper(page);

  await developer(page).getByRole("button", { name: "Install / update Player" }).click();
  await expect(developer(page).getByRole("alert")).toHaveText(
    "The Hub has no signing certificate to sign the Player with. Add yours in Settings, under Signing certificate.",
  );

  await developer(page).getByRole("button", { name: "Uninstall Player" }).click();
  await developer(page).getByRole("button", { name: "Yes, uninstall" }).click();
  const uninstall = developer(page).getByRole("region", { name: "Uninstall the Player on Living room · TV" });
  await expect(uninstall.getByRole("alert")).toContainText("The TV didn't uninstall the Player.");
  await expect(uninstall.getByRole("alert")).toContainText("Not installed");
  await expect(uninstall.getByRole("listitem")).toHaveText([
    "Connect to the TV (done)",
    "Uninstall the Player (failed)",
  ]);
});
