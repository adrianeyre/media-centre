import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { startFakeMideaAircon } from "../packages/hub/src/fakes/midea-aircon/fake-midea-aircon.ts";
import { TABS } from "../packages/remote/src/tabs.ts";
import {
  FAKE_AIRCON_DISCOVERY_PORT,
  FAKE_AIRCON_HTTP_PORT,
  FAKE_AIRCON_PORT,
  FAKE_AIRCONS,
  SPARE_FAKE_AIRCON,
} from "./fake-air-conditioners.ts";
import { fakeHiveUrl, forgetHive, signInToFakeHive } from "./fake-hive.ts";
import { startFakeLight } from "./fake-lights.ts";
import { FAKE_TVS, fakeTvUrl } from "./fake-tvs.ts";
import { openSettingsOn } from "./settings.ts";

// The Remote meets WCAG 2.2 at Level AA. axe-core checks what can be checked
// automatically, on every screen and dialog, in both themes; the rest, such
// as keyboard use and focus, the other specs drive by hand.
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const forgetEverything = async (request: APIRequestContext): Promise<void> => {
  // Hive's Appliances go only as the Hub signs out of Hive.
  await forgetHive(request);
  for (const kind of ["appliances", "rooms", "media-sources"]) {
    const all = (await (await request.get(`/api/${kind}`)).json()) as { id: number }[];
    for (const { id } of all) expect((await request.delete(`/api/${kind}/${String(id)}`)).status()).toBe(204);
  }
  expect((await request.put("/api/hub/address", { data: { override: null } })).ok()).toBe(true);
};
test.beforeEach(async ({ request }) => forgetEverything(request));
test.afterEach(async ({ request }) => forgetEverything(request));

const addATv = async (request: APIRequestContext): Promise<void> => {
  const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Living room" } })).json()) as {
    id: number;
  };
  const response = await request.post("/api/appliances", {
    data: { kind: "tv", address: FAKE_TVS.living.host, name: "TV", roomId },
  });
  expect(response.status()).toBe(201);
};

/**
 * The run's v2 fake Air Conditioner in the Living room, with every control,
 * and the spare in the Office, switched off at the wall once it is added, so
 * that the tab shows one that can't be reached too.
 */
const addAirConditioners = async (request: APIRequestContext): Promise<void> => {
  const roomIds: number[] = [];
  for (const name of ["Living room", "Office"]) {
    const created = await request.post("/api/rooms", { data: { name } });
    expect(created.status()).toBe(201);
    roomIds.push(((await created.json()) as { id: number }).id);
  }
  const spare = await startFakeMideaAircon({
    host: SPARE_FAKE_AIRCON.host,
    port: FAKE_AIRCON_PORT,
    discoveryPort: FAKE_AIRCON_DISCOVERY_PORT,
    httpPort: FAKE_AIRCON_HTTP_PORT,
    version: SPARE_FAKE_AIRCON.version,
    id: SPARE_FAKE_AIRCON.id,
    serialNumber: SPARE_FAKE_AIRCON.serialNumber,
  });
  try {
    for (const [address, roomId] of [
      [FAKE_AIRCONS.living.host, roomIds[0]],
      [SPARE_FAKE_AIRCON.host, roomIds[1]],
    ] as const) {
      const added = await request.post("/api/appliances", {
        data: { kind: "air-conditioner", address, name: "Aircon", roomId },
      });
      expect(added.status()).toBe(201);
    }
  } finally {
    await spare.stop();
  }
};

/**
 * A colour bulb and a smart plug in the Living room, and a white bulb in the
 * Office, switched off at the wall once it is added, so that the tab shows
 * one that can't be reached too. Stops the others once `work` is done.
 */
const withLights = async (request: APIRequestContext, work: () => Promise<void>): Promise<void> => {
  const lamp = await startFakeLight("lamp");
  const plug = await startFakeLight("plug");
  const desk = await startFakeLight("desk");
  try {
    for (const [light, name, room] of [
      [lamp, "Lamp", "Living room"],
      [plug, "Plug", "Living room"],
      [desk, "Desk", "Office"],
    ] as const) {
      const rooms = (await (await request.get("/api/rooms")).json()) as { id: number; name: string }[];
      const roomId =
        rooms.find((each) => each.name === room)?.id ??
        ((await (await request.post("/api/rooms", { data: { name: room } })).json()) as { id: number }).id;
      const added = await request.post("/api/appliances", {
        data: { kind: "light", address: light.host, name, roomId, light: { id: light.id, key: light.key } },
      });
      expect(added.status()).toBe(201);
    }
    await desk.stop();
    await work();
  } finally {
    await Promise.all([lamp.stop(), plug.stop(), desk.stop()]);
  }
};

const expectNoViolations = async (page: Page, what: string, include?: string): Promise<void> => {
  // Once everything has finished fading in, so colours are measured as they settle.
  await page.waitForFunction("document.getAnimations().length === 0");
  const builder = new AxeBuilder({ page }).withTags(WCAG_AA);
  if (include !== undefined) builder.include(include);
  const { violations } = await builder.analyze();
  expect(
    violations.map(
      ({ id, help, nodes }) => `${id}: ${help} (${nodes.map(({ target }) => target.join(" ")).join(", ")})`,
    ),
    what,
  ).toEqual([]);
};

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`in the ${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("the TV tab, with a TV, and TV Menu mode", async ({ page, request }) => {
      await addATv(request);
      await page.goto("/");
      await expect(page.getByRole("region", { name: "Keys" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Now Showing" }).getByRole("status")).not.toHaveText(/Checking/);
      await expectNoViolations(page, "TV tab");

      await page.getByRole("button", { name: /^Selected TV: / }).click();
      await expectNoViolations(page, "TV picker, open");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "TV Menu mode" }).click();
      await expect(page.getByRole("dialog", { name: "TV Menu mode" })).toBeVisible();
      await expectNoViolations(page, "TV Menu mode");
    });

    test("the Network tab, before a scan and after one", async ({ page, request }) => {
      await addATv(request);
      await page.goto("/");
      await page.getByRole("tab", { name: "Network" }).click();
      const scan = page.getByRole("button", { name: /^Scan (the network|again)$/ });
      await expect(scan).toBeEnabled();
      await expectNoViolations(page, "Network tab");

      await scan.click();
      await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("article", { name: "TV" })).toBeVisible();
      await expectNoViolations(page, "Network tab, scanned");

      await page
        .getByRole("article", { name: "TV" })
        .getByRole("button", { name: /^(Name it|Rename)$/ })
        .click();
      await expectNoViolations(page, "Network tab, naming a device");
      await page.getByRole("article", { name: "TV" }).getByRole("button", { name: "Cancel" }).click();

      await page.getByRole("radio", { name: "Bluetooth" }).check();
      await page.getByRole("button", { name: /^Scan (for Bluetooth devices|again)$/ }).click();
      await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible({ timeout: 15_000 });
      await expectNoViolations(page, "Network tab, Bluetooth");
      await page.getByRole("radio", { name: "Home network" }).check();
    });

    test("the Amazon tab, signed out and signed in to the fake Amazon", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("tab", { name: "Amazon" }).click();
      const signIn = page.getByRole("region", { name: "Sign in to Amazon" });
      await expect(signIn).toBeVisible();
      await expectNoViolations(page, "Amazon tab, signed out");

      await signIn.getByRole("button", { name: "Sign in to Amazon" }).click();
      const kitchen = page.getByRole("article", { name: "Kitchen Echo Dot" });
      await expect(kitchen.getByText("Bohemian Rhapsody")).toBeVisible({ timeout: 15_000 });
      try {
        await kitchen.getByText(/^Alarms, timers and reminders/).click();
        await kitchen.getByText("Sound", { exact: true }).click();
        await expectNoViolations(page, "Amazon tab, signed in");
      } finally {
        await page.getByRole("button", { name: "Sign out" }).click();
      }
    });

    test("the Ring tab, signed out, asking for the code, and signed in to the fake Ring", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("tab", { name: "Ring" }).click();
      const signIn = page.getByRole("region", { name: "Sign in to Ring" });
      await expect(signIn).toBeVisible();
      await expectNoViolations(page, "Ring tab, signed out");

      await signIn.getByLabel("Email address").fill("owner@example.com");
      await signIn.getByLabel("Password").fill("fake-password");
      await signIn.getByRole("button", { name: "Sign in to Ring" }).click();
      const code = page.getByRole("region", { name: "Enter Ring's code" });
      await expect(code).toBeVisible();
      await expectNoViolations(page, "Ring tab, asking for the code");

      await code.getByLabel("Code").fill("123456");
      await code.getByRole("button", { name: "Sign in" }).click();
      const door = page.getByRole("article", { name: "Front Door" });
      await expect(door.getByText(/Wi-Fi good/)).toBeVisible({ timeout: 15_000 });
      try {
        await door.getByText(/^Recent events/).click();
        await expectNoViolations(page, "Ring tab, signed in");
      } finally {
        await page.getByRole("button", { name: "Sign out" }).click();
      }
    });

    test("the TV tab with no TVs, and Settings", async ({ page, request }) => {
      await addATv(request);
      await forgetEverything(request);
      await page.goto("/");
      await expect(page.getByRole("region", { name: "No TVs yet" })).toBeVisible();
      await expectNoViolations(page, "TV tab, empty");

      await addATv(request);
      await openSettingsOn(page, "TV");
      await expect(page.getByRole("region", { name: "TVs" }).getByText("Living room · TV")).toBeVisible();
      await expectNoViolations(page, "Settings");
    });

    // On a phone, as every check here is, and on a desktop, where the Air Conditioners stand side by side.
    for (const size of ["phone", "desktop"] as const) {
      test(`the Aircon tab on a ${size}, with an Air Conditioner and one that can't be reached, and with none`, async ({
        page,
        request,
      }) => {
        if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
        await addAirConditioners(request);
        await page.goto("/");
        await page.getByRole("tab", { name: "Aircon" }).click();
        const living = page.getByRole("region", { name: "Living room · Aircon" });
        await expect(living.getByRole("button", { name: "Power", exact: true })).toBeEnabled();
        await expect(page.getByRole("region", { name: "Office · Aircon" })).toContainText(
          "Can't reach this Air Conditioner",
          { timeout: 10_000 },
        );
        await expectNoViolations(page, `Aircon tab, ${size}`);

        await forgetEverything(request);
        await page.reload();
        await expect(page.getByRole("region", { name: "No Air Conditioners yet" })).toBeVisible();
        await expectNoViolations(page, `Aircon tab, empty, ${size}`);
      });
    }

    // On a phone and on a desktop, as the Aircon tab, where a Room's Lights stand side by side.
    for (const size of ["phone", "desktop"] as const) {
      test(`the Lights tab on a ${size}, with Lights, one that can't be reached, Room-wide control and All off, and with none`, async ({
        page,
        request,
      }) => {
        if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
        await withLights(request, async () => {
          await page.goto("/");
          await page.getByRole("tab", { name: "Lights" }).click();
          const lamp = page.getByRole("region", { name: "Living room · Lamp" });
          await expect(lamp.getByRole("button", { name: "Power", exact: true })).toBeEnabled();
          await expect(page.getByRole("region", { name: "Office · Desk" })).toContainText("Can't reach this Light", {
            timeout: 10_000,
          });
          await expectNoViolations(page, `Lights tab, ${size}`);

          // In colour, with what Room-wide control and All off say of the one they couldn't reach.
          await lamp.getByRole("radio", { name: "Colour" }).check();
          await expect(lamp.getByRole("slider", { name: "Hue" })).toBeEnabled();
          await page.getByRole("button", { name: "All off", exact: true }).click();
          await expect(page.locator(".lights-all-off-said").getByRole("alert")).toBeVisible();
          await page
            .getByRole("region", { name: "Office Lights" })
            .getByRole("button", { name: "On", exact: true })
            .click();
          await expect(page.getByRole("region", { name: "Office Lights" }).getByRole("alert")).toBeVisible();
          await expectNoViolations(page, `Lights tab, after All off, ${size}`);

          await openSettingsOn(page, "Lights");
          const lights = page.getByRole("region", { name: "Lights", exact: true });
          await expect(lights.getByText("Living room · Lamp")).toBeVisible();
          await lights.getByRole("button", { name: "Find Lights" }).click();
          // It listens as long as it takes the Office's, switched off, not to answer.
          await expect(lights.getByRole("list", { name: "Lights found" })).toBeVisible({ timeout: 15_000 });
          await expectNoViolations(page, `Settings, with Lights, ${size}`);
        });

        await forgetEverything(request);
        await page.getByRole("tab", { name: "Lights" }).click();
        await expect(page.getByRole("region", { name: "No Lights yet" })).toBeVisible();
        await expectNoViolations(page, `Lights tab, empty, ${size}`);
      });
    }

    // FR-62 to FR-68: the Heating tab, with a Radiator Valve Hive can't reach, a Boost, and with Hive gone.
    for (const size of ["phone", "desktop"] as const) {
      test(`the Heating tab on a ${size}, with a Radiator Valve that can't be reached, a Boost and its dialog, and with the whole tab unreachable`, async ({
        page,
        request,
      }) => {
        if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
        await signInToFakeHive(request);
        const { id: roomId } = (await (await request.post("/api/rooms", { data: { name: "Upstairs" } })).json()) as {
          id: number;
        };
        const hive = (await (await request.get("/api/appliances")).json()) as { id: number; name: string }[];
        for (const name of ["Bedroom", "Study"]) {
          const { id } = hive.find((each) => each.name === name) ?? { id: 0 };
          expect((await request.patch(`/api/appliances/${String(id)}`, { data: { roomId } })).ok()).toBe(true);
        }
        const products = (await (await request.get(fakeHiveUrl("/_fake/state"))).json()) as {
          id: string;
          name: string;
        }[];
        const study = products.find(({ name }) => name === "Study")?.id;
        expect((await request.post(fakeHiveUrl("/_fake/state"), { data: { id: study, online: false } })).ok()).toBe(
          true,
        );

        await page.goto("/");
        await page.getByRole("tab", { name: "Heating" }).click();
        await expect(page.getByRole("region", { name: "Upstairs · Study" })).toContainText(
          "Can't reach this Radiator Valve",
        );
        await page
          .getByRole("region", { name: "Downstairs", exact: true })
          .getByRole("button", { name: "Boost…" })
          .click();
        await expect(page.getByRole("dialog", { name: "Boost Downstairs" })).toBeVisible();
        await expectNoViolations(page, `Heating tab's Boost, ${size}`);
        await page.getByRole("dialog").getByRole("button", { name: "Boost", exact: true }).click();
        await expect(
          page.getByRole("region", { name: "Downstairs", exact: true }).getByRole("button", { name: "Cancel Boost" }),
        ).toBeVisible();
        await expectNoViolations(page, `Heating tab, ${size}`);

        // One change Hive refuses, as it says.
        const upstairs = products.find(({ name }) => name === "Upstairs")?.id;
        expect(
          (await request.post(fakeHiveUrl("/_fake/state"), { data: { id: upstairs, refusesChanges: true } })).ok(),
        ).toBe(true);
        await page.getByRole("region", { name: "Whole home" }).getByRole("radio", { name: "Off" }).check();
        await expect(page.getByRole("region", { name: "Whole home" }).getByRole("alert")).toBeVisible();
        await expectNoViolations(page, `Heating tab, a change refused, ${size}`);

        expect((await request.post(fakeHiveUrl("/_fake/outage"), { data: { down: true } })).ok()).toBe(true);
        await page.reload();
        await expect(page.getByText(/^Can't reach Hive\./)).toBeVisible();
        await expectNoViolations(page, `Heating tab, Hive unreachable, ${size}`);

        expect((await request.post(fakeHiveUrl("/_fake/outage"), { data: { down: false } })).ok()).toBe(true);
        expect((await request.post(fakeHiveUrl("/_fake/revoke"))).ok()).toBe(true);
        await page.reload();
        await expect(page.getByRole("alert").getByRole("button", { name: "Open Settings" })).toBeVisible();
        await expectNoViolations(page, `Heating tab, Hive's sign-in refused, ${size}`);
      });
    }

    // FR-56: each Room's Light Scenes, listed, being saved, refused, renamed and deleted, and what a recall says.
    for (const size of ["phone", "desktop"] as const) {
      test(`the Lights tab's Light Scenes on a ${size}, saved, recalled with one that can't be reached, and being named, renamed and deleted`, async ({
        page,
        request,
      }) => {
        if (size === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
        await withLights(request, async () => {
          const living = (await (await request.get("/api/rooms")).json()) as { id: number; name: string }[];
          const roomId = living.find(({ name }) => name === "Living room")?.id;
          for (const name of ["Film", "Bright"]) {
            expect((await request.post("/api/appliances/lights/scenes", { data: { roomId, name } })).status()).toBe(
              201,
            );
          }
          await page.goto("/");
          await page.getByRole("tab", { name: "Lights" }).click();
          const scenes = page.getByRole("region", { name: "Living room Light Scenes" });
          await expect(scenes.getByRole("button", { name: "Recall Film" })).toBeVisible();
          await expect(page.getByRole("region", { name: "Office Light Scenes" })).toContainText("No Light Scenes yet.");
          await expectNoViolations(page, `Lights tab's Light Scenes, ${size}`);

          await scenes.getByRole("button", { name: "Recall Film" }).click();
          await expect(scenes.getByRole("status")).toHaveText('Recalled "Film".');
          // The Office's, switched off at the wall, can't be reached.
          const office = page.getByRole("region", { name: "Office Light Scenes" });
          await office.getByRole("button", { name: "Save as Light Scene" }).click();
          await office.getByRole("textbox", { name: "Light Scene name" }).fill("Work");
          await office.getByRole("button", { name: "Save", exact: true }).click();
          await expect(office.getByRole("alert")).toBeVisible();
          // A name refused, said beside it.
          await scenes.getByRole("button", { name: "Save as Light Scene" }).click();
          await scenes.getByRole("textbox", { name: "Light Scene name" }).fill("film");
          await scenes.getByRole("button", { name: "Save", exact: true }).click();
          await expect(scenes.getByRole("alert")).toBeVisible();
          await expectNoViolations(page, `Lights tab's Light Scenes, saving, ${size}`);

          await scenes.getByRole("button", { name: "Cancel" }).click();
          await scenes.getByRole("button", { name: "Rename Film" }).click();
          await expect(scenes.getByRole("form", { name: "Rename Film" })).toBeVisible();
          await expectNoViolations(page, `Lights tab's Light Scenes, renaming, ${size}`);
          await scenes.getByRole("button", { name: "Delete Bright" }).click();
          await expect(scenes.getByRole("button", { name: "Yes, delete" })).toBeVisible();
          await expectNoViolations(page, `Lights tab's Light Scenes, deleting, ${size}`);
        });
      });
    }

    test("the Developer section, with the Player's buttons and an action's steps", async ({ page, request }) => {
      const developerMode = (data: unknown) =>
        request.put(fakeTvUrl(FAKE_TVS.living.host, "/_fake/developer"), { data: JSON.stringify(data) });
      try {
        await addATv(request);
        expect((await request.put("/api/hub/address", { data: { override: "192.168.1.10" } })).ok()).toBe(true);
        expect((await developerMode({ mode: "on", ip: "192.168.1.10" })).ok()).toBe(true);
        await page.goto("/");
        const developer = page.getByRole("region", { name: "Developer" });
        await developer.getByRole("button", { name: "Developer", exact: true }).click();
        await expect(developer.getByRole("button", { name: "Install / update Player" })).toBeVisible();
        await expectNoViolations(page, "Developer section", ".tv-developer");

        // The Player isn't installed on the run's fake TV, so uninstalling it fails, with every step shown.
        await developer.getByRole("button", { name: "Uninstall Player" }).click();
        await developer.getByRole("button", { name: "Yes, uninstall" }).click();
        await expect(developer.getByRole("alert")).toBeVisible();
        await expectNoViolations(page, "Developer section, uninstalling the Player", ".tv-developer");
      } finally {
        expect((await developerMode({ mode: "off", ip: null })).ok()).toBe(true);
      }
    });

    test("Watch & Listen, playing a Media File on the TV", async ({ page, request }) => {
      const media = await mkdtemp(join(tmpdir(), "media-centre-e2e-a11y-"));
      try {
        await writeFile(join(media, "Film.mp4"), "");
        await addATv(request);
        expect((await request.post("/api/media-sources", { data: { name: "Films", path: media } })).status()).toBe(201);
        // The Player isn't installed on the run's fake TV, so playing stops at its launch, with every step shown.
        expect((await request.put("/api/hub/address", { data: { override: "127.0.0.1" } })).ok()).toBe(true);
        await page.goto("/");
        const watchAndListen = page.getByRole("region", { name: "Watch & Listen" });
        await watchAndListen.getByRole("button", { name: "Films" }).click();
        await watchAndListen.getByRole("button", { name: /^Film\.mp4 ?, / }).click();
        await expect(watchAndListen.getByRole("alert")).toBeVisible();
        await expectNoViolations(page, "Watch & Listen, playing", ".watch-and-listen");
      } finally {
        await rm(media, { recursive: true, force: true });
      }
    });

    test("every policy's dialog", async ({ page }) => {
      await page.goto("/");
      for (const title of ["Privacy Policy", "Terms and Conditions", "Cookie Policy", "Accessibility"]) {
        await page.getByRole("contentinfo").getByRole("button", { name: title }).click();
        const dialog = page.getByRole("dialog", { name: title });
        await expect(dialog).toBeVisible();
        await expectNoViolations(page, title, "dialog[open]");
        await dialog.getByRole("button", { name: "Done" }).click();
      }
    });

    test("an update offered as the Remote opens, and in Settings", async ({ page }) => {
      await page.route("**/api/latest-version", (route) => route.fulfill({ json: { version: "99.0.0" } }));
      await page.goto("/");
      const dialog = page.getByRole("dialog", { name: "Update available" });
      await expect(dialog).toBeVisible();
      await expectNoViolations(page, "Update available", "dialog[open]");
      await dialog.getByRole("button", { name: "Not now" }).click();
      await openSettingsOn(page, "General");
      await expect(page.getByRole("link", { name: /^Update to 99\.0\.0/ })).toBeVisible();
      await expectNoViolations(page, "Settings, with an update");
    });

    test("the Changelog, from the footer's version", async ({ page }) => {
      await page.goto("/");
      await page
        .getByRole("contentinfo")
        .getByRole("button", { name: /^Version: .*, Changelog$/ })
        .click();
      await expect(page.getByRole("dialog", { name: "Changelog" })).toBeVisible();
      await expectNoViolations(page, "Changelog", "dialog[open]");
    });
  });
}

/** Where a Remote remembers how it looks, and its themes, as the Remote's appearance.ts has them. */
const APPEARANCE_KEY = "media-centre:appearance";
const THEMES = [
  { id: "evergreen", label: "Evergreen" },
  { id: "ocean", label: "Ocean" },
  { id: "violet", label: "Violet" },
  { id: "sunset", label: "Sunset" },
  { id: "rose", label: "Rose" },
  { id: "graphite", label: "Graphite" },
] as const;

// On a wide screen the tabs stand in a rail down the left, and each theme
// colours the open tab, the buttons and the footer with its own accent: every
// tab, and Settings, checked in each, light and dark, with a TV to control.
for (const mode of ["light", "dark"] as const) {
  for (const theme of THEMES) {
    test(`every tab on a wide screen, in ${theme.label}, ${mode}`, async ({ page, request }) => {
      await addATv(request);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript(
        ([key, appearance]) => {
          localStorage.setItem(key, appearance);
        },
        [APPEARANCE_KEY, JSON.stringify({ mode, theme: theme.id })] as const,
      );
      await page.goto("/");
      const tabs = page.getByRole("tablist", { name: "Remote" });
      await expect(tabs).toHaveAttribute("aria-orientation", "vertical");
      for (const { label } of TABS) {
        await tabs.getByRole("tab", { name: label }).click();
        await expect(tabs.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectNoViolations(page, `${label} tab, ${theme.label}, ${mode}`);
      }
      await page.getByRole("button", { name: "General settings" }).click();
      await expectNoViolations(page, `Settings, ${theme.label}, ${mode}`);
    });
  }
}
