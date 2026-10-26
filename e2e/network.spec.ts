import { expect, test, type Locator, type Page } from "@playwright/test";

import { FAKE_TV_REST_PORT, FAKE_TVS } from "./fake-tvs.ts";

/** Names the device on this card, or the one called `card`. */
const nameDevice = async (page: Page, card: string | Locator, name: string): Promise<void> => {
  const device = typeof card === "string" ? page.getByRole("article", { name: card }) : card;
  await device.getByRole("button", { name: /^(Name it|Rename)$/ }).click();
  await device.getByRole("textbox", { name: "Name" }).fill(name);
  await device.getByRole("button", { name: "Save" }).click();
};

test("the Network tab scans the network, showing each device as a widget with its open ports, and names one", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Network" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Network" })).toBeVisible();
  await page.getByRole("button", { name: /^Scan (the network|again)$/ }).click();

  // The Hub scans the fake TVs alone, as NETWORK_SCAN_TARGETS has it, each in a widget of its own.
  await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".network-status")).toHaveText(/^2 devices on .+, scanned at /);
  const devices = page.locator(".widget").getByRole("article");
  await expect(devices).toHaveCount(2);
  for (const { host } of Object.values(FAKE_TVS)) {
    const device = devices.filter({ hasText: host });
    await expect(device.getByRole("listitem")).toHaveText([String(FAKE_TV_REST_PORT)]);
    await expect(device.getByText("Checked the 1 common port.")).toBeVisible();
  }

  // Named, it is called so on every Remote, through a reload.
  await nameDevice(page, devices.filter({ hasText: FAKE_TVS.bedroom.host }), "Bedroom TV");
  await expect(page.getByRole("article", { name: "Bedroom TV" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("article", { name: "Bedroom TV" })).toBeVisible();
  await nameDevice(page, "Bedroom TV", "");
  await expect(page.getByRole("article", { name: "Bedroom TV" })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Filter" }).fill(FAKE_TVS.bedroom.host);
  await expect(devices).toHaveCount(1);
});

test("the Network tab's Bluetooth lists the devices the Hub hears, a possible light first, and names one", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Network" }).click();
  await page.getByRole("radio", { name: "Bluetooth" }).check();

  await page.getByRole("button", { name: /^Scan (for Bluetooth devices|again)$/ }).click();
  await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible({ timeout: 15_000 });
  const devices = page.locator(".widget").getByRole("article");
  await expect(devices).toHaveCount(3);
  const lamp = page.getByRole("article", { name: /^(Lepro LampUX|Kitchen bulb)$/ });
  await expect(lamp.getByText("Maybe a light")).toBeVisible();
  await expect(lamp.getByText("Telink Semiconductor Co. Ltd")).toBeVisible();

  await nameDevice(page, lamp, "Kitchen bulb");
  await expect(page.getByRole("article", { name: "Kitchen bulb" }).getByText("Lepro LampUX")).toBeVisible();

  // The Remote reopens on Bluetooth, as it was left.
  await page.reload();
  await expect(page.getByRole("radio", { name: "Bluetooth" })).toBeChecked();
  await nameDevice(page, "Kitchen bulb", "");
});

test("a device on the network is put in a new Room from its widget, and shows in that Room on the Rooms tab", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Network" }).click();
  await page.getByRole("radio", { name: "Home network" }).check();
  await page.getByRole("button", { name: /^Scan (the network|again)$/ }).click();
  await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible({ timeout: 15_000 });

  const device = page.locator(".widget").getByRole("article").filter({ hasText: FAKE_TVS.living.host });
  await device.getByRole("combobox", { name: /^Room for / }).selectOption({ label: "New room…" });
  await device.getByRole("textbox", { name: "New Room's name" }).fill("E2E Den");
  await device.getByRole("button", { name: "Create and put it there" }).click();
  await expect(device.locator(".chip", { hasText: "E2E Den" })).toBeVisible();

  try {
    await page.getByRole("tab", { name: "Rooms" }).click();
    await page.getByRole("combobox", { name: "Room" }).selectOption({ label: "E2E Den" });
    const devices = page.getByRole("region", { name: "Devices" });
    await expect(devices.getByRole("listitem")).toHaveCount(1);
    await expect(devices.getByRole("listitem")).toContainText(`Network · ${FAKE_TVS.living.host}`);
  } finally {
    const rooms = (await (await request.get("/api/rooms")).json()) as { id: number; name: string }[];
    for (const { id, name } of rooms) if (name === "E2E Den") await request.delete(`/api/rooms/${String(id)}`);
  }
});
