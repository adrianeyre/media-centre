import { expect, test, type APIRequestContext } from "@playwright/test";

const deleteEveryRoom = async (request: APIRequestContext): Promise<void> => {
  const rooms = (await (await request.get("/api/rooms")).json()) as { id: number }[];
  for (const room of rooms) expect((await request.delete(`/api/rooms/${String(room.id)}`)).status()).toBe(204);
};

test.beforeEach(async ({ request }) => deleteEveryRoom(request));
test.afterEach(async ({ request }) => {
  await request.delete("/api/amazon/sign-in");
  await request.delete("/api/ring/sign-in");
  await deleteEveryRoom(request);
});

// The fake Amazon and fake Ring (AMAZON_FAKE, RING_FAKE): an Echo and the Ring
// doorbell, put in a Room on their own tabs' API, show in it on the Rooms tab,
// each with the controls its own tab has.
test("the Rooms tab shows an Echo and a Ring doorbell put in the Room, with their controls", async ({
  page,
  request,
}) => {
  const hall = (await (await request.post("/api/rooms", { data: { name: "Hall" } })).json()) as { id: number };

  await request.post("/api/amazon/sign-in", { data: { domain: "amazon.co.uk" } });
  await expect
    .poll(
      async () => ((await (await request.get("/api/amazon")).json()) as { status: { state: string } }).status.state,
      {
        timeout: 15_000,
      },
    )
    .toBe("signed-in");
  await request.post("/api/ring/sign-in", { data: { email: "owner@example.com", password: "fake-password" } });
  await request.post("/api/ring/code", { data: { code: "123456" } });

  expect((await request.put("/api/amazon/devices/G0911W0000000001/room", { data: { roomId: hall.id } })).ok()).toBe(
    true,
  );
  expect((await request.put("/api/ring/devices/100001/room", { data: { roomId: hall.id } })).ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("tab", { name: "Rooms" }).click();
  await page.getByRole("combobox", { name: "Room" }).selectOption({ label: "Hall" });

  const echo = page.getByRole("article", { name: "Kitchen Echo Dot" });
  await expect(echo.getByText("Bohemian Rhapsody")).toBeVisible({ timeout: 15_000 });
  await echo.getByRole("button", { name: "Do Not Disturb" }).click();
  await expect(echo.getByRole("button", { name: "Do Not Disturb" })).toHaveAttribute("aria-pressed", "true");

  const door = page.getByRole("article", { name: "Front Door" });
  await expect(door.getByText("Battery 82%")).toBeVisible();
  await expect(door.getByRole("button", { name: "Watch live" })).toBeVisible();

  // Shown with their controls, they aren't listed as well.
  await expect(page.getByRole("region", { name: "Devices" })).toBeHidden();
});
