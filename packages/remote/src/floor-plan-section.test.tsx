import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { FloorPlanDrawing } from "@media-centre/shared";

import { FloorPlanSection } from "./floor-plan-section.tsx";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";

afterEach(cleanup);

const OWN: FloorPlanDrawing = {
  layout: {
    width: 400,
    height: 300,
    floors: [
      { name: "Ground", viewBox: "0 0 400 150", places: [{ id: "place-1", points: "10,10 100,10 100,100" }] },
      { name: "First", viewBox: "0 150 400 150", places: [{ id: "place-2", points: "10,160 100,160 100,250" }] },
    ],
  },
  image: { type: "image/png", version: 2 },
};

describe("Settings' Floor plan", () => {
  it("says the plan is the built-in drawing, and only offers to draw one", async () => {
    render(<FloorPlanSection rooms={fakeRoomsApi()} />);

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "The built-in drawing, with 2 floors and 13 places built in.",
    );
    expect(screen.getByRole("button", { name: "Draw the plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use the built-in plan" })).toBeNull();
  });

  it("says what was drawn, and goes back to the built-in plan once that is confirmed", async () => {
    const rooms = fakeRoomsApi([], {}, OWN);
    render(<FloorPlanSection rooms={rooms} />);

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Your own image, with 2 floors and 2 places drawn on it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use the built-in plan" }));
    fireEvent.click(screen.getByRole("button", { name: "No, keep it" }));
    expect(rooms.currentDrawing()).toEqual(OWN);

    fireEvent.click(screen.getByRole("button", { name: "Use the built-in plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, go back" }));
    await waitFor(() => {
      expect(rooms.currentDrawing()).toEqual({ layout: null, image: null });
    });
    expect(screen.getByRole("status").textContent).toBe("The built-in drawing, with 2 floors and 13 places built in.");
  });

  it("opens the editor, and shows the plan as it was saved", async () => {
    render(<FloorPlanSection rooms={fakeRoomsApi()} />);
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Draw the plan" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Draw the floor plan" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close the floor plan" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
