import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FloorPlanDrawing } from "@media-centre/shared";

import { FloorPlanEditor, placeLabel } from "./floor-plan-editor.tsx";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";

afterEach(cleanup);

// The built-in drawing, 1200 by 800, shown 600 by 400: a screen pixel is two of its units.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 600,
    bottom: 400,
    width: 600,
    height: 400,
    toJSON: () => ({}),
  });
});

const OWN: FloorPlanDrawing = {
  layout: {
    width: 400,
    height: 300,
    floors: [{ name: "Home", viewBox: "0 0 400 300", places: [{ id: "place-1", points: "10,10 100,10 100,100" }] }],
  },
  image: { type: "image/png", version: 1 },
};

const renderEditor = (
  rooms = fakeRoomsApi(),
  options: { onClose?: () => void; onSaved?: (drawing: FloorPlanDrawing) => void } = {},
) =>
  render(
    <FloorPlanEditor
      roomsApi={rooms}
      onClose={options.onClose ?? (() => undefined)}
      onSaved={options.onSaved ?? (() => undefined)}
      loadImage={(file) => Promise.resolve({ url: `blob:${file.name}`, width: 1000, height: 500 })}
    />,
  );

const canvas = () => screen.getByRole("img", { name: /^The drawing/ });
const tool = (name: string) =>
  fireEvent.click(within(screen.getByRole("group", { name: "Tools" })).getByRole("button", { name }));
const status = () => screen.getByRole("status").textContent;
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const placeButtons = () =>
  within(screen.getByRole("list", { name: "Places" }))
    .getAllByRole("button", { pressed: false })
    .concat(within(screen.getByRole("list", { name: "Places" })).queryAllByRole("button", { pressed: true }))
    .filter((button) => !button.getAttribute("aria-label")?.startsWith("Delete"))
    .map((button) => button.textContent);

const down = (x: number, y: number) => fireEvent.pointerDown(canvas(), { clientX: x, clientY: y, pointerId: 1 });
const move = (x: number, y: number) => fireEvent.pointerMove(canvas(), { clientX: x, clientY: y, pointerId: 1 });
const up = (x: number, y: number) => fireEvent.pointerUp(canvas(), { clientX: x, clientY: y, pointerId: 1 });
const tap = (x: number, y: number) => {
  down(x, y);
  up(x, y);
};

describe("the floor plan editor", () => {
  it("starts on the drawing the Hub has: the built-in one, with its floors and places, and nothing to save yet", async () => {
    renderEditor(fakeRoomsApi(["Kitchen"], { "downstairs-3": 1 }));

    expect(await screen.findByRole("img", { name: "The drawing, 2 floors and 13 places on it" })).toBeTruthy();
    expect(screen.getByText("The built-in drawing")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Floor 1 name" }).value).toBe("Upstairs");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Floor 2 name" }).value).toBe("Downstairs");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Undo" }).disabled).toBe(true);
    // A place that is a Room is listed by the Room's name, with its own.
    expect(screen.getByRole("button", { name: "Kitchen Downstairs 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upstairs 1" })).toBeTruthy();
    expect(placeLabel("place-12")).toBe("Place 12");
  });

  it("draws a place as a rectangle dragged across the room, on the floor it is on, and saves the layout", async () => {
    const rooms = fakeRoomsApi();
    const onSaved = vi.fn();
    renderEditor(rooms, { onSaved });
    await screen.findByRole("img", { name: /^The drawing/ });

    tool("Rectangle");
    down(100, 100);
    move(200, 150);
    up(200, 150);
    expect(status()).toBe("Place 1 added to Upstairs.");
    expect(canvas().getAttribute("aria-label")).toBe("The drawing, 2 floors and 14 places on it");
    expect(screen.getByRole("button", { name: "Place 1", pressed: true })).toBeTruthy();

    save();
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    const layout = rooms.currentDrawing().layout;
    expect(layout?.floors[0]?.places.at(-1)).toEqual({ id: "place-1", points: "200,200 400,200 400,300 200,300" });
    expect(rooms.images()).toEqual([]);
  });

  it("draws a rectangle from two taps, for a pointer that can't drag", async () => {
    renderEditor();
    await screen.findByRole("img", { name: /^The drawing/ });

    tool("Rectangle");
    tap(350, 100);
    expect(status()).toBe("Now tap the opposite corner.");
    tap(400, 160);
    expect(status()).toBe("Place 1 added to Downstairs.");
  });

  it("draws a shape corner by corner, closed at its first corner or with Finish shape, and lets a half-drawn one go", async () => {
    renderEditor();
    await screen.findByRole("img", { name: /^The drawing/ });

    tool("Shape");
    tap(100, 100);
    tap(200, 100);
    fireEvent.click(screen.getByRole("button", { name: "Finish shape" }));
    expect(screen.getByRole("alert").textContent).toBe("A shape needs at least three corners.");
    tap(150, 200);
    tap(101, 101);
    expect(status()).toBe("Place 1 added to Upstairs.");

    tap(100, 300);
    tap(200, 300);
    tap(200, 350);
    fireEvent.click(screen.getByRole("button", { name: "Finish shape" }));
    expect(status()).toBe("Place 2 added to Upstairs.");

    tap(10, 10);
    fireEvent.click(screen.getByRole("button", { name: "Let go" }));
    expect(status()).toBe("Let go of the shape.");
    expect(screen.queryByRole("button", { name: "Finish shape" })).toBeNull();
  });

  it("draws a place freehand, tidied to its corners as the pointer is let go", async () => {
    const rooms = fakeRoomsApi();
    renderEditor(rooms);
    await screen.findByRole("img", { name: /^The drawing/ });

    tool("Draw");
    down(100, 100);
    // Round a square, a little wobbly, as a hand is.
    [
      [130, 101],
      [160, 99],
      [200, 100],
      [201, 130],
      [199, 170],
      [200, 200],
      [160, 201],
      [120, 199],
      [100, 200],
      [100, 150],
    ].forEach(([x = 0, y = 0]) => move(x, y));
    up(100, 110);
    expect(status()).toBe("Place 1 added to Upstairs.");

    save();
    await waitFor(() => {
      expect(rooms.currentDrawing().layout).not.toBeNull();
    });
    const corners = rooms.currentDrawing().layout?.floors[0]?.places.at(-1)?.points.split(" ");
    expect(corners?.length).toBeLessThanOrEqual(6);
    expect(corners).toContain("200,200");
    expect(corners).toContain("400,400");

    tool("Draw");
    down(50, 50);
    up(52, 52);
    expect(status()).toBe("Too short to be a place. Draw round the room in one line.");
  });

  it("changes a chosen place's outline: a corner dragged, one added from an edge and moved by a tap, one removed", async () => {
    const rooms = fakeRoomsApi(["Kitchen"], { "upstairs-1": 1 });
    renderEditor(rooms);
    await screen.findByRole("img", { name: /^The drawing/ });
    const chosenPlace = () => screen.getByRole("group", { name: "Kitchen, chosen" });
    const corners = () =>
      rooms.currentDrawing().layout?.floors[0]?.places.find(({ id }) => id === "upstairs-1")?.points;

    // Upstairs 1 is the square 136,186 to 276,400: on screen, 68,93 to 138,200.
    tool("Select");
    fireEvent.click(screen.getByRole("button", { name: "Kitchen Upstairs 1" }));
    expect(chosenPlace().textContent).toContain("Kitchen · 4 corners");
    const handles = () => canvas().querySelectorAll(".floor-plan-handle-reach");
    const edges = () => canvas().querySelectorAll(".floor-plan-handle-edge");
    expect(handles()).toHaveLength(4);

    // The top-left corner dragged up and left.
    fireEvent.pointerDown(handles()[0] as Element, { clientX: 68, clientY: 93, pointerId: 1 });
    move(60, 80);
    up(60, 80);
    expect(status()).toBe("Corner moved.");

    // The dot on the right edge tapped: a corner there, picked, and put where the next tap is.
    fireEvent.pointerDown(edges()[1] as Element, { clientX: 138, clientY: 146, pointerId: 1 });
    up(138, 146);
    expect(status()).toBe("Tap where the corner goes, or remove it.");
    expect(chosenPlace().textContent).toContain("Kitchen · 5 corners");
    tap(170, 146);
    expect(status()).toBe("Corner moved.");

    // A corner tapped and removed.
    fireEvent.pointerDown(handles()[4] as Element, { clientX: 68, clientY: 200, pointerId: 1 });
    up(68, 200);
    fireEvent.click(screen.getByRole("button", { name: "Remove corner" }));
    expect(status()).toBe("Corner removed: Kitchen has 4.");

    save();
    await waitFor(() => {
      expect(corners()).toBe("120,160 276,186 340,292 276,400");
    });
    expect(rooms.places()).toEqual({ "upstairs-1": 1 });
  });

  it("keeps a place's last three corners, lets a picked corner be, and lets go of the place on a tap elsewhere", async () => {
    renderEditor();
    await screen.findByRole("img", { name: /^The drawing/ });
    tool("Rectangle");
    down(100, 100);
    move(200, 150);
    up(200, 150);
    tool("Select");
    fireEvent.click(screen.getByRole("button", { name: "Place 1" }));
    const handles = () => canvas().querySelectorAll(".floor-plan-handle-reach");

    fireEvent.pointerDown(handles()[0] as Element, { clientX: 100, clientY: 100, pointerId: 1 });
    up(100, 100);
    fireEvent.click(screen.getByRole("button", { name: "Leave it" }));
    expect(status()).toBe("The corner stays.");
    expect(screen.queryByRole("button", { name: "Remove corner" })).toBeNull();

    fireEvent.pointerDown(handles()[0] as Element, { clientX: 100, clientY: 100, pointerId: 1 });
    up(100, 100);
    fireEvent.click(screen.getByRole("button", { name: "Remove corner" }));
    expect(screen.getByRole("group", { name: "Place 1, chosen" }).textContent).toContain("3 corners");
    fireEvent.pointerDown(handles()[0] as Element, { clientX: 200, clientY: 100, pointerId: 1 });
    up(200, 100);
    fireEvent.click(screen.getByRole("button", { name: "Remove corner" }));
    expect(screen.getByRole("alert").textContent).toBe("A place has at least three corners.");
    fireEvent.click(screen.getByRole("button", { name: "Leave it" }));

    tap(500, 350);
    expect(screen.queryByRole("group", { name: "Place 1, chosen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Place 1", pressed: false })).toBeTruthy();
  });

  it("redraws a chosen place with any tool, keeping its id and so its Room, unless told to keep it as it was", async () => {
    const rooms = fakeRoomsApi(["Kitchen"], { "upstairs-1": 1 });
    renderEditor(rooms);
    await screen.findByRole("img", { name: /^The drawing/ });

    tool("Select");
    fireEvent.click(screen.getByRole("button", { name: "Kitchen Upstairs 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Redraw" }));
    expect(status()).toBe("Draw Kitchen again, with Rectangle, Shape or Draw. It keeps its Room.");
    expect(screen.getByRole("button", { name: "Rectangle", pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it as it was" }));
    expect(status()).toBe("Kitchen stays as it was.");

    tool("Select");
    fireEvent.click(screen.getByRole("button", { name: "Kitchen Upstairs 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Redraw" }));
    tool("Shape");
    tap(60, 90);
    tap(150, 90);
    tap(150, 150);
    tap(60, 210);
    fireEvent.click(screen.getByRole("button", { name: "Finish shape" }));
    expect(status()).toBe("Kitchen redrawn.");
    expect(canvas().getAttribute("aria-label")).toBe("The drawing, 2 floors and 13 places on it");

    save();
    await waitFor(() => {
      expect(rooms.places()).toEqual({ "upstairs-1": 1 });
    });
    expect(rooms.currentDrawing().layout?.floors[0]?.places[0]).toEqual({
      id: "upstairs-1",
      points: "120,180 300,180 300,300 120,420",
    });
  });

  it("deletes a place, which takes its Room off the plan once saved, and undoes a step at a time", async () => {
    const rooms = fakeRoomsApi(["Kitchen"], { "downstairs-3": 1 });
    renderEditor(rooms);
    await screen.findByRole("img", { name: /^The drawing/ });

    fireEvent.click(screen.getByRole("button", { name: "Delete Kitchen" }));
    expect(status()).toBe("Kitchen deleted. Kitchen is off the plan once saved.");
    expect(screen.queryByRole("button", { name: "Kitchen Downstairs 3" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(status()).toBe("Undone.");
    expect(screen.getByRole("button", { name: "Kitchen Downstairs 3" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete Kitchen" }));
    save();
    await waitFor(() => {
      expect(rooms.places()).toEqual({});
    });
  });

  it("takes an image as the drawing, one floor the whole of it, and saves the image before the layout", async () => {
    const rooms = fakeRoomsApi();
    const onSaved = vi.fn();
    renderEditor(rooms, { onSaved });
    await screen.findByRole("img", { name: /^The drawing/ });

    const picker = screen.getByLabelText<HTMLInputElement>("Image, up to 8 MB");
    const file = new File(["PNG"], "home.png", { type: "image/png" });
    Object.defineProperty(picker, "files", { value: [file] });
    fireEvent.change(picker);

    expect(await screen.findByText("home.png, once saved")).toBeTruthy();
    expect(status()).toBe("home.png is the drawing now. Draw its places, and its floors if it has more than one.");
    expect(canvas().getAttribute("aria-label")).toBe("The drawing, 1 floors and 0 places on it");
    expect(canvas().getAttribute("viewBox")).toBe("0 0 1000 500");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Floor 1 name" }).value).toBe("Home");
    expect(screen.getByText("None yet. Draw each room with Rectangle, Shape or Draw.")).toBeTruthy();

    tool("Floor");
    down(0, 0);
    move(300, 400);
    up(300, 400);
    expect(status()).toBe("Floor 2 added. Name it in the list.");
    fireEvent.input(screen.getByRole("textbox", { name: "Floor 2 name" }), { target: { value: "Ground" } });
    // Shown 600 by 300 in the 600 by 400 box, 50 pixels down: a pixel is one and two thirds of its units.
    tool("Rectangle");
    down(10, 60);
    move(100, 150);
    up(100, 150);
    expect(status()).toBe("Place 1 added to Home.");

    save();
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(rooms.images()).toEqual([file]);
    expect(rooms.currentDrawing()).toEqual({
      image: { type: "image/png", version: 1 },
      layout: {
        width: 1000,
        height: 500,
        floors: [
          { name: "Home", viewBox: "0 0 1000 500", places: [{ id: "place-1", points: "17,17 167,17 167,167 17,167" }] },
          { name: "Ground", viewBox: "0 0 500 500", places: [] },
        ],
      },
    });
  });

  it("refuses a file that isn't an image it can keep, before it reaches the Hub", async () => {
    const rooms = fakeRoomsApi();
    renderEditor(rooms);
    await screen.findByRole("img", { name: /^The drawing/ });

    const picker = screen.getByLabelText<HTMLInputElement>("Image, up to 8 MB");
    Object.defineProperty(picker, "files", { value: [new File(["GIF"], "home.gif", { type: "image/gif" })] });
    fireEvent.change(picker);
    expect(screen.getByRole("alert").textContent).toBe("Choose an SVG, PNG, JPEG or WebP image.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  });

  it("goes back to the built-in drawing, with its places, from an image given before", async () => {
    const rooms = fakeRoomsApi(["Kitchen"], { "place-1": 1 }, OWN);
    renderEditor(rooms);
    await screen.findByRole("img", { name: "The drawing, 1 floors and 1 places on it" });
    expect(screen.getByText("The image given before")).toBeTruthy();
    expect(canvas().querySelector("image")?.getAttribute("href")).toBe("/api/rooms/floor-plan-image?v=1");

    fireEvent.click(screen.getByRole("button", { name: "Use the built-in drawing" }));
    expect(canvas().getAttribute("aria-label")).toBe("The drawing, 2 floors and 13 places on it");
    expect(canvas().querySelector("image")?.getAttribute("href")).toBe("/images/floor-plan.svg");
    expect(placeButtons()).toHaveLength(13);

    save();
    await waitFor(() => {
      expect(rooms.currentDrawing()).toEqual({ layout: null, image: null });
    });
  });

  it("asks before closing with changes not saved, and says why the Hub refused them", async () => {
    const rooms = fakeRoomsApi();
    const onClose = vi.fn();
    renderEditor(rooms, { onClose });
    await screen.findByRole("img", { name: /^The drawing/ });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete Upstairs 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Leave without saving?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep drawing" }));
    expect(screen.queryByText("Leave without saving?")).toBeNull();

    rooms.refuseNext("A floor plan has at most 200 places.");
    save();
    expect((await screen.findByRole("alert")).textContent).toBe("A floor plan has at most 200 places.");
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave, and lose them" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
