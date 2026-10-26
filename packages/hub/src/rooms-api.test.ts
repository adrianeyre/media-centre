import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FLOOR_PLAN_DRAWING_PATH,
  FLOOR_PLAN_IMAGE_PATH,
  FLOOR_PLAN_PATH,
  floorPlanPlacePath,
  ROOM_ORDER_PATH,
  ROOMS_PATH,
  roomPath,
  type FloorPlanDrawing,
  type FloorPlanLayout,
  type FloorPlanPlaces,
  type HubError,
  type Room,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";

let database: DatabaseSync;
let hub: Server;
let base: string;

beforeEach(async () => {
  database = openDatabase(":memory:");
  hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((done) => hub.close(done));
  database.close();
});

const send = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const listRooms = async (): Promise<Room[]> => (await (await send("GET", ROOMS_PATH)).json()) as Room[];
const names = async (): Promise<string[]> => (await listRooms()).map((room) => room.name);

const addRoom = async (name: string): Promise<Room> => {
  const response = await send("POST", ROOMS_PATH, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Room;
};

/** Expects the Hub to refuse, and returns the message it gave the person. */
const refusal = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  return ((await response.json()) as HubError).error;
};

describe("the Hub's Rooms", () => {
  it("start empty", async () => {
    const response = await send("GET", ROOMS_PATH);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  describe("creating", () => {
    it("adds each Room at the end of the Room order", async () => {
      const living = await addRoom("Living room");
      const bedroom = await addRoom("Bedroom");
      const office = await addRoom("Office");

      expect(living).toEqual({ id: expect.any(Number) as number, name: "Living room" });
      expect(await listRooms()).toEqual([living, bedroom, office]);
    });

    it("trims spaces from either end of the name", async () => {
      expect((await addRoom("  Hall  ")).name).toBe("Hall");
    });

    it.each(["", "   "])("refuses an empty name (%j)", async (name) => {
      expect(await refusal(await send("POST", ROOMS_PATH, { name }), 400)).toBe("Give the Room a name.");
      expect(await listRooms()).toEqual([]);
    });

    it("accepts a name of 1 character and of 40", async () => {
      await addRoom("A");
      await addRoom("x".repeat(40));

      expect(await names()).toEqual(["A", "x".repeat(40)]);
    });

    it("refuses a name longer than 40 characters", async () => {
      const message = await refusal(await send("POST", ROOMS_PATH, { name: "x".repeat(41) }), 400);

      expect(message).toBe("A Room's name can be at most 40 characters; that one has 41.");
      expect(await listRooms()).toEqual([]);
    });

    it("counts characters as a person does, not as code units", async () => {
      const name = `${"é".repeat(20)}${"👨‍👩‍👧".repeat(20)}`;

      expect((await addRoom(name)).name).toBe(name);
      expect(await refusal(await send("POST", ROOMS_PATH, { name: `${name}!` }), 400)).toContain("that one has 41");
    });

    it('refuses "Bedroom" when "bedroom" exists, naming the Room it clashes with', async () => {
      await addRoom("bedroom");

      const message = await refusal(await send("POST", ROOMS_PATH, { name: "Bedroom" }), 409);

      expect(message).toBe('There is already a Room called "bedroom".');
      expect(await names()).toEqual(["bedroom"]);
    });

    it("ignores case beyond ASCII, and spaces at either end, when names are compared", async () => {
      await addRoom("Ärztezimmer");

      expect((await send("POST", ROOMS_PATH, { name: " ärztezimmer " })).status).toBe(409);
    });

    it.each([
      ["no body at all", undefined],
      ["no name", {}],
      ["a name that is not text", { name: 7 }],
    ])("refuses a request with %s", async (_, body) => {
      expect(await refusal(await send("POST", ROOMS_PATH, body ?? null), 400)).toBe("Give the Room a name.");
    });

    it("refuses a body that is not JSON", async () => {
      const response = await fetch(`${base}${ROOMS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{name:",
      });

      expect(await refusal(response, 400)).toBe("That request is not valid JSON.");
    });

    it("refuses a body that is not sent as JSON, as a form on another web page would", async () => {
      const response = await fetch(`${base}${ROOMS_PATH}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ name: "Hall" }),
      });

      expect(response.status).toBe(415);
      expect(await listRooms()).toEqual([]);
    });

    it("refuses a body far bigger than any Room needs", async () => {
      const response = await send("POST", ROOMS_PATH, { name: "x".repeat(100_000) });

      expect(response.status).toBe(413);
      expect(await listRooms()).toEqual([]);
    });
  });

  describe("renaming", () => {
    it("renames a Room, keeping its place in the order", async () => {
      const living = await addRoom("Living room");
      const bedroom = await addRoom("Bedroom");
      await addRoom("Office");

      const response = await send("PATCH", roomPath(bedroom.id), { name: "Guest room" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: bedroom.id, name: "Guest room" });
      expect(await names()).toEqual(["Living room", "Guest room", "Office"]);
      expect((await listRooms())[0]).toEqual(living);
    });

    it("lets a Room change only the case of its own name", async () => {
      const bedroom = await addRoom("bedroom");

      expect(await (await send("PATCH", roomPath(bedroom.id), { name: "Bedroom" })).json()).toEqual({
        id: bedroom.id,
        name: "Bedroom",
      });
    });

    it("refuses the name of another Room, ignoring case", async () => {
      await addRoom("bedroom");
      const office = await addRoom("Office");

      const message = await refusal(await send("PATCH", roomPath(office.id), { name: "BEDROOM" }), 409);

      expect(message).toBe('There is already a Room called "bedroom".');
      expect(await names()).toEqual(["bedroom", "Office"]);
    });

    it.each([
      ["an empty name", "", "Give the Room a name."],
      ["a name over 40 characters", "y".repeat(41), "A Room's name can be at most 40 characters; that one has 41."],
    ])("refuses %s", async (_, name, expected) => {
      const office = await addRoom("Office");

      expect(await refusal(await send("PATCH", roomPath(office.id), { name }), 400)).toBe(expected);
      expect(await names()).toEqual(["Office"]);
    });

    it("refuses to rename a Room that doesn't exist", async () => {
      expect(await refusal(await send("PATCH", roomPath(99), { name: "Hall" }), 404)).toBe(
        "That Room no longer exists.",
      );
    });
  });

  describe("deleting", () => {
    it("deletes a Room, and closes the gap in the order", async () => {
      const living = await addRoom("Living room");
      const bedroom = await addRoom("Bedroom");
      const office = await addRoom("Office");

      const response = await send("DELETE", roomPath(bedroom.id));

      expect(response.status).toBe(204);
      expect(await listRooms()).toEqual([living, office]);
      const hall = await addRoom("Hall");
      expect(await listRooms()).toEqual([living, office, hall]);
    });

    it("never gives a deleted Room's id to a new one", async () => {
      await addRoom("Living room");
      const bedroom = await addRoom("Bedroom");
      await send("DELETE", roomPath(bedroom.id));

      const office = await addRoom("Office");

      expect(office.id).not.toBe(bedroom.id);
      expect((await send("PATCH", roomPath(bedroom.id), { name: "Spare room" })).status).toBe(404);
    });

    it("frees the name for a new Room", async () => {
      const bedroom = await addRoom("Bedroom");
      await send("DELETE", roomPath(bedroom.id));

      await addRoom("BEDROOM");

      expect(await names()).toEqual(["BEDROOM"]);
    });

    it("refuses to delete a Room that doesn't exist", async () => {
      expect((await send("DELETE", roomPath(99))).status).toBe(404);
    });
  });

  describe("ordering", () => {
    it("sets the Room order and answers with it", async () => {
      const living = await addRoom("Living room");
      const bedroom = await addRoom("Bedroom");
      const office = await addRoom("Office");

      const response = await send("PUT", ROOM_ORDER_PATH, { roomIds: [office.id, living.id, bedroom.id] });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([office, living, bedroom]);
      expect(await listRooms()).toEqual([office, living, bedroom]);
    });

    it("refuses an order that leaves a Room out, names one twice or names one that doesn't exist", async () => {
      const living = await addRoom("Living room");
      const bedroom = await addRoom("Bedroom");

      for (const roomIds of [[bedroom.id], [bedroom.id, bedroom.id], [bedroom.id, living.id, 99], [bedroom.id, 99]]) {
        expect(await refusal(await send("PUT", ROOM_ORDER_PATH, { roomIds }), 409)).toBe(
          "The Rooms have changed since this list was shown. Try again.",
        );
      }
      expect(await listRooms()).toEqual([living, bedroom]);
    });

    it.each([{}, { roomIds: "1,2" }, { roomIds: [1, "2"] }, { roomIds: [1.5] }])(
      "refuses an order that isn't a list of ids (%j)",
      async (body) => {
        expect(await refusal(await send("PUT", ROOM_ORDER_PATH, body), 400)).toBe(
          "Give the order as a list of Room ids.",
        );
      },
    );
  });

  it.each([
    ["DELETE", ROOMS_PATH, "GET, HEAD, POST"],
    ["GET", roomPath(1), "PATCH, DELETE"],
    ["POST", ROOM_ORDER_PATH, "PUT"],
  ])("refuses %s on %s, saying what it allows", async (method, path, allow) => {
    const response = await send(method, path);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
  });

  it.each(["/api/rooms/0", "/api/rooms/abc", "/api/rooms/1/2"])("answers %s with a 404", async (path) => {
    expect((await send("DELETE", path)).status).toBe(404);
  });
});

describe("the floor plan's places", () => {
  const places = async (): Promise<FloorPlanPlaces> =>
    (await (await send("GET", FLOOR_PLAN_PATH)).json()) as FloorPlanPlaces;
  const place = async (id: string, roomId: number): Promise<FloorPlanPlaces> => {
    const response = await send("PUT", floorPlanPlacePath(id), { roomId });
    expect(response.status).toBe(200);
    return (await response.json()) as FloorPlanPlaces;
  };

  it("start with no Room in any place, and keep the Room each place is made", async () => {
    expect(await places()).toEqual({});
    const kitchen = await addRoom("Kitchen");
    const study = await addRoom("Study");

    expect(await place("downstairs-3", kitchen.id)).toEqual({ "downstairs-3": kitchen.id });
    await place("upstairs-1", study.id);
    expect(await places()).toEqual({ "downstairs-3": kitchen.id, "upstairs-1": study.id });
  });

  it("keep a Room in one place, and a place to one Room", async () => {
    const kitchen = await addRoom("Kitchen");
    const study = await addRoom("Study");
    await place("downstairs-3", kitchen.id);

    // Moved: it leaves the place it was in.
    expect(await place("downstairs-4", kitchen.id)).toEqual({ "downstairs-4": kitchen.id });
    // Another Room in its place: the first leaves the plan.
    expect(await place("downstairs-4", study.id)).toEqual({ "downstairs-4": study.id });
  });

  it("leave a place no Room, and forget a Room's place as it is deleted", async () => {
    const kitchen = await addRoom("Kitchen");
    const study = await addRoom("Study");
    await place("downstairs-3", kitchen.id);
    await place("upstairs-1", study.id);

    const cleared = await send("DELETE", floorPlanPlacePath("upstairs-1"));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ "downstairs-3": kitchen.id });

    expect((await send("DELETE", roomPath(kitchen.id))).status).toBe(204);
    expect(await places()).toEqual({});
  });

  it("refuse a Room that doesn't exist, a place that isn't one, and no Room at all", async () => {
    expect(await refusal(await send("PUT", floorPlanPlacePath("upstairs-1"), { roomId: 99 }), 404)).toBe(
      "That Room no longer exists.",
    );
    const kitchen = await addRoom("Kitchen");
    expect(await refusal(await send("PUT", `${FLOOR_PLAN_PATH}/Not%20A%20Place`, { roomId: kitchen.id }), 400)).toBe(
      "That isn't a place on the floor plan.",
    );
    expect(await refusal(await send("PUT", floorPlanPlacePath("upstairs-1"), { name: "Kitchen" }), 400)).toBe(
      'Send the Room, e.g. {"roomId": 1}.',
    );
    expect((await send("POST", FLOOR_PLAN_PATH)).status).toBe(405);
    expect(await places()).toEqual({});
  });
});

describe("the floor plan's drawing", () => {
  const BUILT_IN: FloorPlanDrawing = { layout: null, image: null };
  const LAYOUT: FloorPlanLayout = {
    width: 1000,
    height: 500,
    floors: [
      {
        name: "Ground",
        viewBox: "0 0 1000 500",
        places: [
          { id: "place-1", points: "10,10 200,10 200,200 10,200" },
          { id: "place-2", points: "210,10 400,10 400,200" },
        ],
      },
    ],
  };
  const drawing = async (): Promise<FloorPlanDrawing> =>
    (await (await send("GET", FLOOR_PLAN_DRAWING_PATH)).json()) as FloorPlanDrawing;
  const sendImage = (bytes: string, type = "image/png"): Promise<Response> =>
    fetch(`${base}${FLOOR_PLAN_IMAGE_PATH}`, { method: "PUT", headers: { "content-type": type }, body: bytes });

  it("is the built-in one until a layout or an image is given, and keeps each", async () => {
    expect(await drawing()).toEqual(BUILT_IN);
    expect((await send("GET", FLOOR_PLAN_IMAGE_PATH)).status).toBe(404);

    const withLayout = await send("PUT", FLOOR_PLAN_DRAWING_PATH, LAYOUT);
    expect(withLayout.status).toBe(200);
    expect(await withLayout.json()).toEqual({ layout: LAYOUT, image: null });

    const withImage = await sendImage("PNG bytes");
    expect(withImage.status).toBe(200);
    expect(await withImage.json()).toEqual({ layout: LAYOUT, image: { type: "image/png", version: 1 } });
    expect(await drawing()).toEqual({ layout: LAYOUT, image: { type: "image/png", version: 1 } });
  });

  it("sends the image back as it was given, sandboxed, and counts each change to it", async () => {
    await sendImage("<svg/>", "image/svg+xml");
    const first = await send("GET", FLOOR_PLAN_IMAGE_PATH);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/svg+xml");
    expect(first.headers.get("content-security-policy")).toContain("sandbox");
    expect(first.headers.get("etag")).toBe('"v1"');
    expect(await first.text()).toBe("<svg/>");

    const unchanged = await fetch(`${base}${FLOOR_PLAN_IMAGE_PATH}`, { headers: { "if-none-match": '"v1"' } });
    expect(unchanged.status).toBe(304);

    await sendImage("PNG bytes");
    expect((await drawing()).image).toEqual({ type: "image/png", version: 2 });
    expect((await fetch(`${base}${FLOOR_PLAN_IMAGE_PATH}`, { headers: { "if-none-match": '"v1"' } })).status).toBe(200);
  });

  it("refuses an image of another kind, an empty one, or one that is too big", async () => {
    expect(await refusal(await sendImage("GIF bytes", "image/gif"), 415)).toContain("image/png");
    expect(await refusal(await sendImage(""), 400)).toBe("That image is empty.");
    expect(await refusal(await sendImage("x".repeat(8 * 1024 * 1024 + 1)), 413)).toBe("That file is too big.");
    expect(await drawing()).toEqual(BUILT_IN);
  });

  it("takes a place off the plan as it is no longer on the layout, and keeps the rest", async () => {
    const kitchen = await addRoom("Kitchen");
    const study = await addRoom("Study");
    await send("PUT", floorPlanPlacePath("place-1"), { roomId: kitchen.id });
    await send("PUT", floorPlanPlacePath("place-2"), { roomId: study.id });

    const { floors } = LAYOUT;
    const [ground] = floors;
    const narrower = { ...LAYOUT, floors: [{ ...ground, places: ground?.places.slice(0, 1) }] };
    await send("PUT", FLOOR_PLAN_DRAWING_PATH, narrower);

    expect(await (await send("GET", FLOOR_PLAN_PATH)).json()).toEqual({ "place-1": kitchen.id });
  });

  it("refuses a layout that isn't one, saying what is wrong", async () => {
    const put = async (layout: unknown, status = 400): Promise<string> =>
      refusal(await send("PUT", FLOOR_PLAN_DRAWING_PATH, layout), status);
    const [ground] = LAYOUT.floors;
    const withFloor = (floor: object) => ({ ...LAYOUT, floors: [{ ...ground, ...floor }] });

    expect(await put({})).toBe("Send the floor plan's layout.");
    expect(await put({ ...LAYOUT, width: 0 })).toBe("The drawing's width must be between 1 and 20000.");
    expect(await put({ ...LAYOUT, floors: [] })).toBe("A floor plan has at least one floor.");
    expect(await put(withFloor({ name: " " }))).toBe("Give each floor a name.");
    expect(await put(withFloor({ viewBox: "0 0 0 10" }))).toContain("must be an SVG viewBox");
    expect(await put(withFloor({ places: [{ id: "Bad Id", points: "0,0 1,0 1,1" }] }))).toBe(
      "That isn't a place on the floor plan.",
    );
    expect(await put(withFloor({ places: [{ id: "a", points: "0,0 1,0" }] }))).toBe(
      "A place's outline has 3 to 400 corners.",
    );
    expect(
      await put(
        withFloor({
          places: [
            { id: "a", points: "0,0 1,0 1,1" },
            { id: "a", points: "0,0 1,0 1,1" },
          ],
        }),
      ),
    ).toBe('Two places have the id "a".');
    expect(await drawing()).toEqual(BUILT_IN);
  });

  it("goes back to the built-in drawing, image and layout both", async () => {
    await send("PUT", FLOOR_PLAN_DRAWING_PATH, LAYOUT);
    await sendImage("PNG bytes");

    const reset = await send("DELETE", FLOOR_PLAN_DRAWING_PATH);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual(BUILT_IN);
    expect((await send("GET", FLOOR_PLAN_IMAGE_PATH)).status).toBe(404);
    // Given again, the image is a new version still, so no Remote shows the old one.
    await sendImage("PNG bytes");
    expect((await drawing()).image).toEqual({ type: "image/png", version: 2 });
  });
});
