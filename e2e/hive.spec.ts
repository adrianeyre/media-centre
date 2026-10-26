import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { Appliance, HiveAccount, HiveSignInOutcome } from "../packages/shared/src/index.ts";
import { FAKE_HIVE_CODE, FAKE_HIVE_LOGIN, fakeHiveUrl } from "./fake-hive.ts";
import { openSettingsOn } from "./settings.ts";

const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const HIVE_KINDS: readonly string[] = ["heating", "radiator-valve", "hot-water"];

// The run's Hub is shared by every test, so each starts and ends signed out
// of Hive, which removes its Appliances, with no other Appliances and no
// Rooms, and with the fake Hive cloud trusting no Hub, so that it asks for
// the code.
const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  expect((await request.delete("/api/hive")).status()).toBe(204);
  for (const kind of ["appliances", "rooms"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  expect((await request.post(fakeHiveUrl("/_fake/revoke"), { data: { devices: true } })).ok()).toBe(true);
  expect((await request.delete(fakeHiveUrl("/_fake/requests"))).ok()).toBe(true);
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

/** Every answer the Hub gave the Remote, to prove none holds the password, the code or a token. */
const answersTo = (page: Page): string[] => {
  const answers: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/")) {
      void response.text().then(
        (text) => answers.push(text),
        () => undefined,
      );
    }
  });
  return answers;
};

const openSettings = async (page: Page): Promise<void> => {
  await page.goto("/");
  await openSettingsOn(page, "Heating");
  await expect(page.getByRole("heading", { name: "Hive", level: 2 })).toBeVisible();
};

const hive = (page: Page) => page.getByRole("region", { name: "Hive", exact: true });

/** Hive's Appliances as Settings names them, Room by Room. */
const names = (page: Page) => hive(page).locator(".room-group .room-row .room-name");

const signIn = async (page: Page, password: string = FAKE_HIVE_LOGIN.password): Promise<void> => {
  const form = hive(page).getByRole("form", { name: "Sign in to Hive" });
  await form.getByRole("textbox", { name: "Email" }).fill(FAKE_HIVE_LOGIN.account);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
};

const enterCode = async (page: Page, code: string): Promise<void> => {
  const form = hive(page).getByRole("form", { name: "Hive's code" });
  await form.getByRole("textbox", { name: "Code" }).fill(code);
  await form.getByRole("button", { name: "Sign in" }).click();
};

/** Signs the Hub in to the fake Hive cloud, with its code, as Settings would. */
const signInThroughTheHub = async (request: APIRequestContext): Promise<void> => {
  const asked = (await (
    await request.post("/api/hive/sign-in", { data: FAKE_HIVE_LOGIN })
  ).json()) as HiveSignInOutcome;
  expect(asked).toEqual({ signedIn: false, needs: "code" });
  const signedIn = await request.post("/api/hive/code", { data: { code: FAKE_HIVE_CODE } });
  expect(signedIn.ok()).toBe(true);
};

const hiveAppliances = async (request: APIRequestContext): Promise<Appliance[]> =>
  ((await (await request.get("/api/appliances")).json()) as Appliance[]).filter(({ kind }) =>
    HIVE_KINDS.includes(kind),
  );

const expectNoViolations = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG_AA)
    .include("[aria-labelledby=settings-hive]")
    .analyze();
  expect(violations.map(({ id, help }) => `${id}: ${help}`)).toEqual([]);
};

// Heating PRD §5 scenario 6, and FR-67 and FR-67a.
test("signing in, with the code Hive asks for, lists both Heating zones, every Radiator Valve and the Hot Water by Hive's names, renamed and given a Room as TVs are", async ({
  page,
  request,
}) => {
  expect((await request.post("/api/rooms", { data: { name: "Bedroom" } })).status()).toBe(201);
  const answers = answersTo(page);
  await openSettings(page);
  await expect(hive(page)).toContainText("so they need the internet");
  await expectNoViolations(page);

  await signIn(page, "not the password");
  await expect(hive(page).getByRole("alert")).toHaveText(
    "Hive refused the email or password. Use the Hive account owner's.",
  );
  await signIn(page);
  await expect(hive(page).getByRole("form", { name: "Hive's code" })).toBeVisible();
  await expectNoViolations(page);
  await enterCode(page, "000000");
  await expect(hive(page).getByRole("alert")).toHaveText("That isn't the code Hive sent. Try it again.");
  await enterCode(page, FAKE_HIVE_CODE);

  await expect(hive(page).getByText("Signed in to Hive.")).toBeVisible();
  await expect(names(page)).toHaveText(["Downstairs", "Upstairs", "Bedroom", "Study", "Living Room", "Hot Water"]);
  await expect(hive(page).getByRole("listitem", { name: "Study" })).toContainText("Hive Radiator Valve");
  await expectNoViolations(page);

  await hive(page).getByRole("button", { name: "Edit Bedroom" }).click();
  const form = hive(page).getByRole("form", { name: "Edit Bedroom" });
  await form.getByRole("textbox", { name: "Name" }).fill("Radiator");
  await form.getByRole("combobox", { name: "Room" }).selectOption({ label: "Bedroom" });
  await form.getByRole("button", { name: "Save" }).click();
  await expect(names(page)).toHaveText([
    "Bedroom · Radiator",
    "Downstairs",
    "Upstairs",
    "Study",
    "Living Room",
    "Hot Water",
  ]);

  // As Settings opens again, the Hub asks Hive, and nothing asks for the password.
  await page.reload();
  await openSettingsOn(page, "Heating");
  await expect(hive(page).getByText("Signed in to Hive.")).toBeVisible();
  await expect(hive(page).getByRole("form", { name: "Sign in to Hive" })).toHaveCount(0);
  await expect(names(page).first()).toHaveText("Bedroom · Radiator");

  const account = (await (await request.get("/api/hive")).json()) as HiveAccount;
  expect(account).toEqual({ signedIn: true, tokens: "accepted" });
  expect(answers.length).toBeGreaterThan(5);
  for (const secret of [FAKE_HIVE_LOGIN.password, "not the password", FAKE_HIVE_CODE]) {
    for (const answer of answers) expect(answer).not.toContain(secret);
  }
});

// FR-67b: Hive's tokens expire on its own schedule, and Settings says so.
test('a fake that revokes the tokens leads to "Sign in again", which restores control with no code, keeping every name and Room', async ({
  page,
  request,
}) => {
  await signInThroughTheHub(request);
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Hall" } })).json()) as {
    id: number;
  };
  const [downstairs] = await hiveAppliances(request);
  expect((await request.patch(`/api/appliances/${String(downstairs?.id)}`, { data: { roomId } })).ok()).toBe(true);
  expect((await request.post(fakeHiveUrl("/_fake/revoke"))).ok()).toBe(true);

  await openSettings(page);
  await expect(hive(page).getByText(/^Hive no longer accepts the Hub's sign-in/)).toBeVisible();
  await expect(names(page)).toHaveText([
    "Hall · Downstairs",
    "Upstairs",
    "Bedroom",
    "Study",
    "Living Room",
    "Hot Water",
  ]);
  await expectNoViolations(page);

  await hive(page).getByRole("button", { name: "Sign in again" }).click();
  await signIn(page);
  // The Hub is still a device the fake trusts, so it asks for no code.
  await expect(hive(page).getByText("Signed in to Hive.")).toBeVisible();
  await expect(hive(page).getByRole("form", { name: "Hive's code" })).toHaveCount(0);
  await expect(hive(page).getByText(/^Hive no longer accepts/)).toHaveCount(0);
  await expect(names(page)).toHaveText([
    "Hall · Downstairs",
    "Upstairs",
    "Bedroom",
    "Study",
    "Living Room",
    "Hot Water",
  ]);

  // Control is back: the Hub reads Hive with its new tokens.
  expect((await request.delete(fakeHiveUrl("/_fake/requests"))).ok()).toBe(true);
  expect((await (await request.get("/api/hive")).json()) as HiveAccount).toEqual({
    signedIn: true,
    tokens: "accepted",
  });
  const requests = (await (await request.get(fakeHiveUrl("/_fake/requests"))).json()) as { outcome: string }[];
  expect(requests.map(({ outcome }) => outcome)).toEqual(["accepted"]);
});

// FR-67: Sign out removes Hive's Appliances, and with them the Heating tab's widgets.
test("Sign out removes every Hive Appliance, and asks to sign in once more", async ({ page, request }) => {
  await signInThroughTheHub(request);
  expect(await hiveAppliances(request)).toHaveLength(6);
  await openSettings(page);
  await expect(names(page)).toHaveCount(6);

  await hive(page).getByRole("button", { name: "Sign out of Hive" }).click();
  await hive(page).getByRole("button", { name: "Yes, sign out" }).click();

  await expect(hive(page).getByRole("form", { name: "Sign in to Hive" })).toBeVisible();
  await expect(names(page)).toHaveCount(0);
  expect(await hiveAppliances(request)).toEqual([]);
  expect((await (await request.get("/api/hive")).json()) as HiveAccount).toEqual({ signedIn: false });

  // Signed in once more, the Hub has forgotten the device Hive trusted, so Hive asks for the code again.
  await signIn(page);
  await expect(hive(page).getByRole("form", { name: "Hive's code" })).toBeVisible();
});
