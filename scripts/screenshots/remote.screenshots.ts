import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { buildDemoHome, tearDownDemoHome, type DemoRoom } from "./demo-home.ts";

/**
 * Screenshots of every tab of the Remote, at a desktop's, a tablet's and a
 * phone's size, light and dark, into `docs/images/screenshots/`, and the web
 * app manifest's, into `packages/remote/public/screenshots/`, all of the
 * demo home `demo-home.ts` builds. Run with `pnpm screenshots`.
 */

const ROOT = join(import.meta.dirname, "../..");
const DOCS = process.env.SCREENSHOTS_DOCS_DIR ?? join(ROOT, "docs/images/screenshots");
const MANIFEST = process.env.SCREENSHOTS_MANIFEST_DIR ?? join(ROOT, "packages/remote/public/screenshots");

type Tab = "tv" | "aircon" | "lights" | "heating" | "network" | "amazon" | "ring" | "rooms" | "settings";

const EVERY_TAB: readonly Tab[] = [
  "tv",
  "aircon",
  "lights",
  "heating",
  "network",
  "amazon",
  "ring",
  "rooms",
  "settings",
];

/** Each tab's name in the Remote's tab list. */
const TAB_LABELS: Readonly<Record<Exclude<Tab, "settings">, string>> = {
  tv: "TV",
  aircon: "Aircon",
  lights: "Lights",
  heating: "Heating",
  network: "Network",
  amazon: "Amazon",
  ring: "Ring",
  rooms: "Rooms",
};

/** The Room the Rooms tab shows. */
const ROOM_SHOWN: DemoRoom = "Living Room";

/** A Light in each Room the Rooms tab is shot on, which shows once it has read the Room. */
const LIGHT_IN: Partial<Record<DemoRoom, string>> = {
  "Living Room": "Floor Lamp",
  Office: "Desk Lamp",
};

interface Device {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly mobile: boolean;
}

const DESKTOP: Device = { width: 1440, height: 900, scale: 1, mobile: false };
const TABLET: Device = { width: 820, height: 1180, scale: 1, mobile: true };
const PHONE: Device = { width: 390, height: 844, scale: 2, mobile: true };
const WIDE: Device = { width: 1280, height: 800, scale: 1, mobile: false };
const NARROW: Device = { width: 390, height: 844, scale: 1, mobile: true };

interface Shot {
  readonly file: string;
  readonly device: Device;
  readonly tab: Tab;
  readonly dark: boolean;
  /** The Room the Rooms tab shows, if not {@link ROOM_SHOWN}. */
  readonly room?: DemoRoom;
  /** What is done on the tab, once it shows its content, before it is shot. */
  readonly scene?: (page: Page) => Promise<void>;
}

/** The Network tab's Bluetooth view. */
const bluetooth = async (page: Page): Promise<void> => {
  await page.getByRole("radio", { name: "Bluetooth" }).check();
  await expect(page.getByText("Bathroom Bulb").first()).toBeVisible();
};

/** The Home Server's Room picker, part way through putting it in a new Room. */
const newRoom = async (page: Page): Promise<void> => {
  const device = page.getByRole("article", { name: "Home Server" });
  await device.getByRole("combobox", { name: /^Room for / }).selectOption({ label: "New room…" });
  await device.getByRole("textbox", { name: "New Room's name" }).fill("Study");
};

/** The Room's devices, scrolled to. */
const roomDevices = async (page: Page): Promise<void> => {
  const devices = page.getByRole("region", { name: "Devices" });
  await expect(devices.getByText("Home Server")).toBeVisible();
  await devices.evaluate((element: { scrollIntoView: (options: object) => void }) => {
    element.scrollIntoView({ block: "center" });
  });
};

const shots = (prefix: string, device: Device, light: readonly Tab[], dark: readonly Tab[]): Shot[] => [
  ...light.map((tab) => ({ file: join(DOCS, `${prefix}-${tab}.png`), device, tab, dark: false })),
  ...dark.map((tab) => ({ file: join(DOCS, `${prefix}-${tab}-dark.png`), device, tab, dark: true })),
];

const SHOTS: readonly Shot[] = [
  ...shots("desktop", DESKTOP, EVERY_TAB, ["tv", "lights", "rooms"]),
  { file: join(DOCS, "desktop-network-bluetooth.png"), device: DESKTOP, tab: "network", dark: false, scene: bluetooth },
  { file: join(DOCS, "desktop-network-room.png"), device: DESKTOP, tab: "network", dark: false, scene: newRoom },
  {
    file: join(DOCS, "desktop-rooms-devices.png"),
    device: DESKTOP,
    tab: "rooms",
    dark: false,
    room: "Office",
    scene: roomDevices,
  },
  ...shots("tablet", TABLET, ["tv", "lights", "rooms"], ["rooms"]),
  ...shots("phone", PHONE, EVERY_TAB, ["tv", "lights"]),
  { file: join(MANIFEST, "wide-tv.png"), device: WIDE, tab: "tv", dark: false },
  { file: join(MANIFEST, "wide-rooms.png"), device: WIDE, tab: "rooms", dark: false },
  { file: join(MANIFEST, "narrow-tv.png"), device: NARROW, tab: "tv", dark: false },
  { file: join(MANIFEST, "narrow-lights.png"), device: NARROW, tab: "lights", dark: false },
];

/** What shows once each tab has read what the demo home has, before which it isn't ready to be shot. */
const showsItsContent = async (page: Page, tab: Tab, room: DemoRoom): Promise<void> => {
  const visible = { timeout: 30_000 };
  switch (tab) {
    case "tv":
      await expect(page.getByRole("button", { name: /^Selected TV: / })).toBeVisible(visible);
      await expect(page.getByText(/Big Buck Bunny/).first()).toBeAttached(visible);
      break;
    case "aircon":
      await expect(page.getByText(/^Cool, set to 21/).first()).toBeVisible(visible);
      break;
    case "lights":
      await expect(page.getByText("Floor Lamp").first()).toBeVisible(visible);
      break;
    case "heating":
      await expect(page.getByText("Hot Water").first()).toBeVisible(visible);
      break;
    case "network":
      await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible(visible);
      break;
    case "amazon":
      await expect(page.getByText("Bohemian Rhapsody").first()).toBeVisible(visible);
      break;
    case "ring":
      await expect(page.getByText("Battery 82%").first()).toBeVisible(visible);
      break;
    case "rooms":
      await expect(page.getByText(LIGHT_IN[room] ?? "Floor Lamp").first()).toBeAttached(visible);
      break;
    case "settings":
      await expect(page.getByText("Appearance").first()).toBeVisible(visible);
      break;
  }
};

/** Waits for the page to stop changing: fonts and images loaded, nothing busy, and the Hub's chip settled. */
const settled = async (page: Page): Promise<void> => {
  await expect(page.getByText("Hub online").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // In the page, which the root tsconfig has no DOM types for, so as source.
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  await page.waitForFunction("[...document.images].every((image) => image.complete)");
  // Whatever the Remote reads every few seconds, read once more, and drawn.
  await page.waitForTimeout(1_500);
};

const open = async (page: Page, { tab, room = ROOM_SHOWN, scene }: Shot): Promise<void> => {
  await page.goto("/");
  await expect(page.getByText("Hub online").first()).toBeVisible({ timeout: 30_000 });
  if (tab === "settings") {
    await page.getByRole("button", { name: "General settings" }).click();
  } else {
    await page
      .getByRole("tablist", { name: "Remote" })
      .getByRole("tab", { name: TAB_LABELS[tab], exact: true })
      .click();
  }
  if (tab === "rooms") {
    await page.getByRole("combobox", { name: "Room", exact: true }).selectOption({ label: room });
  }
  await showsItsContent(page, tab, room);
  await page.mouse.move(0, 0);
  await page.evaluate("window.scrollTo(0, 0); document.activeElement?.blur?.()");
  await scene?.(page);
  await settled(page);
};

const take = async (browser: Browser, baseURL: string | undefined, shot: Shot): Promise<void> => {
  const { file, device, dark } = shot;
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.scale,
    isMobile: device.mobile,
    hasTouch: device.mobile,
    colorScheme: dark ? "dark" : "light",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  try {
    const page = await context.newPage();
    await open(page, shot);
    await page.screenshot({ path: file, animations: "disabled", caret: shot.scene === newRoom ? "initial" : "hide" });
  } finally {
    await context.close();
  }
};

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  await mkdir(DOCS, { recursive: true });
  await mkdir(MANIFEST, { recursive: true });
  await buildDemoHome(request);
});
test.afterAll(tearDownDemoHome);

for (const shot of SHOTS) {
  test(shot.file.slice(ROOT.length + 1), async ({ browser, baseURL }) => {
    await take(browser, baseURL, shot);
  });
}
