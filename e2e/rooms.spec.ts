import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openSettingsOn } from "./settings.ts";

// The run's Hub is shared by every test, so each starts and ends with no Rooms.
const deleteEveryRoom = async (request: APIRequestContext): Promise<void> => {
  const rooms = (await (await request.get("/api/rooms")).json()) as { id: number }[];
  for (const room of rooms) expect((await request.delete(`/api/rooms/${String(room.id)}`)).status()).toBe(204);
};
test.beforeEach(async ({ request }) => deleteEveryRoom(request));
test.afterEach(async ({ request }) => deleteEveryRoom(request));

const openSettings = async (page: Page): Promise<void> => {
  await page.goto("/");
  await openSettingsOn(page, "Rooms");
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
};

const roomOrder = (page: Page) => page.getByRole("list", { name: "Room order" }).locator(".room-name");

const addRoom = async (page: Page, name: string): Promise<void> => {
  await page.getByRole("textbox", { name: "New Room" }).fill(name);
  await page.getByRole("button", { name: "Add Room" }).click();
};

// PRD §5 scenario 1, step 1, then FR-7 and FR-10.
test("Settings creates, orders, renames and deletes Rooms, and the Hub keeps them", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByText("No Rooms yet.")).toBeVisible();

  for (const name of ["Living room", "Bedroom", "Office"]) await addRoom(page, name);
  await expect(roomOrder(page)).toHaveText(["Living room", "Bedroom", "Office"]);
  await expect(page.getByRole("textbox", { name: "New Room" })).toHaveValue("");

  await page.getByRole("button", { name: "Move Office up" }).click();
  await expect(roomOrder(page)).toHaveText(["Living room", "Office", "Bedroom"]);
  await page.getByRole("button", { name: "Move Office up" }).click();
  await expect(roomOrder(page)).toHaveText(["Office", "Living room", "Bedroom"]);
  await page.getByRole("button", { name: "Move Living room down" }).click();
  await expect(roomOrder(page)).toHaveText(["Office", "Bedroom", "Living room"]);

  await page.getByRole("button", { name: "Rename Bedroom" }).click();
  const rename = page.getByRole("form", { name: "Rename Bedroom" });
  await expect(rename.getByRole("textbox", { name: "Room name" })).toHaveValue("Bedroom");
  await rename.getByRole("textbox", { name: "Room name" }).fill("Guest room");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(roomOrder(page)).toHaveText(["Office", "Guest room", "Living room"]);

  await page.getByRole("button", { name: "Delete Office" }).click();
  await expect(page.getByText("Delete Office?")).toBeVisible();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(roomOrder(page)).toHaveText(["Guest room", "Living room"]);

  // The Rooms are the Hub's, not this browser's: a fresh page reads them back.
  await page.reload();
  await expect(roomOrder(page)).toHaveText(["Guest room", "Living room"]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Settings shows why the Hub refuses a Room's name", async ({ page }) => {
  await openSettings(page);
  await addRoom(page, "bedroom");
  await expect(roomOrder(page)).toHaveText(["bedroom"]);

  await addRoom(page, "Bedroom");
  await expect(page.getByRole("alert")).toHaveText('There is already a Room called "bedroom".');
  await expect(page.getByRole("textbox", { name: "New Room" })).toHaveValue("Bedroom");

  await addRoom(page, "A".repeat(41));
  await expect(page.getByRole("alert")).toHaveText("A Room's name can be at most 40 characters; that one has 41.");

  await addRoom(page, "   ");
  await expect(page.getByRole("alert")).toHaveText("Give the Room a name.");

  await page.getByRole("button", { name: "Rename bedroom" }).click();
  await page.getByRole("textbox", { name: "Room name" }).fill("B".repeat(41));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("form", { name: "Rename bedroom" }).getByRole("alert")).toHaveText(
    "A Room's name can be at most 40 characters; that one has 41.",
  );

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(roomOrder(page)).toHaveText(["bedroom"]);

  // Exactly 40 is allowed.
  await page.getByRole("button", { name: "Rename bedroom" }).click();
  await page.getByRole("textbox", { name: "Room name" }).fill("C".repeat(40));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(roomOrder(page)).toHaveText(["C".repeat(40)]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
