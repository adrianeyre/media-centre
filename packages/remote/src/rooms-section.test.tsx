import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { HubRequestFailed } from "./hub-request.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { RoomsSection } from "./rooms-section.tsx";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";

afterEach(cleanup);

const shownRooms = async (): Promise<string[]> => {
  const order = await screen.findByRole("list", { name: "Room order" });
  return within(order)
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".room-name")?.textContent ?? "");
};

const type = (label: string | RegExp, text: string): void => {
  fireEvent.input(screen.getByRole("textbox", { name: label }), { target: { value: text } });
};

describe("Settings' Rooms", () => {
  it("say how to start when there are none", async () => {
    render(<RoomsSection rooms={fakeRoomsApi()} />);

    expect(screen.getByText("Loading the Rooms…")).toBeTruthy();
    expect(await screen.findByText('No Rooms yet. Add one below, e.g. "Living room".')).toBeTruthy();
  });

  it("list the Rooms in Room order", async () => {
    render(<RoomsSection rooms={fakeRoomsApi(["Living room", "Bedroom", "Office"])} />);

    expect(await shownRooms()).toEqual(["Living room", "Bedroom", "Office"]);
  });

  it("add a Room at the end, and empty the field for the next", async () => {
    const rooms = fakeRoomsApi(["Living room"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    type("New Room", "Bedroom");
    fireEvent.click(screen.getByRole("button", { name: "Add Room" }));

    await waitFor(async () => {
      expect(await shownRooms()).toEqual(["Living room", "Bedroom"]);
    });
    expect(rooms.current().map((room) => room.name)).toEqual(["Living room", "Bedroom"]);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "New Room" }).value).toBe("");
  });

  it("keep the next name being typed while the last one is still being added", async () => {
    render(<RoomsSection rooms={fakeRoomsApi()} />);

    type("New Room", "Bedroom");
    fireEvent.click(screen.getByRole("button", { name: "Add Room" }));
    type("New Room", "Office");

    await waitFor(async () => {
      expect(await shownRooms()).toEqual(["Bedroom"]);
    });
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "New Room" }).value).toBe("Office");
  });

  it("show the Hub's reason for refusing a name beside the field, and keep what was typed", async () => {
    const rooms = fakeRoomsApi(["bedroom"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    rooms.refuseNext('There is already a Room called "bedroom".');
    type("New Room", "Bedroom");
    fireEvent.click(screen.getByRole("button", { name: "Add Room" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('There is already a Room called "bedroom".');
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "New Room" });
    expect(field.value).toBe("Bedroom");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(await shownRooms()).toEqual(["bedroom"]);
  });

  it("don't cut a long name short, so the Hub can say why it is refused", () => {
    render(<RoomsSection rooms={fakeRoomsApi()} />);

    expect(screen.getByRole("textbox", { name: "New Room" }).hasAttribute("maxlength")).toBe(false);
    expect(screen.getByRole("textbox", { name: "New Room" }).getAttribute("placeholder")).toBe("Up to 40 characters");
  });

  it("rename a Room in place, starting from its name", async () => {
    const rooms = fakeRoomsApi(["Living room", "Bedroom", "Office"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    fireEvent.click(screen.getByRole("button", { name: "Rename Bedroom" }));
    const form = screen.getByRole("form", { name: "Rename Bedroom" });
    const field = within(form).getByRole<HTMLInputElement>("textbox", { name: "Room name" });
    expect(field.value).toBe("Bedroom");
    expect(document.activeElement).toBe(field);
    type("Room name", "Guest room");
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect(await shownRooms()).toEqual(["Living room", "Guest room", "Office"]);
    });
    expect(screen.queryByRole("form", { name: /^Rename/ })).toBeNull();
  });

  it("keep the rename open, with the Hub's reason, when the Hub refuses it", async () => {
    const rooms = fakeRoomsApi(["Bedroom", "Office"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    fireEvent.click(screen.getByRole("button", { name: "Rename Office" }));
    rooms.refuseNext("Give the Room a name.");
    type("Room name", "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const form = screen.getByRole("form", { name: "Rename Office" });
    expect((await within(form).findByRole("alert")).textContent).toBe("Give the Room a name.");
    expect(rooms.current().map((room) => room.name)).toEqual(["Bedroom", "Office"]);

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Rename Office" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ask before deleting a Room", async () => {
    const rooms = fakeRoomsApi(["Living room", "Bedroom"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    fireEvent.click(screen.getByRole("button", { name: "Delete Bedroom" }));
    expect(screen.getByText("Delete Bedroom?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No, keep it" }));
    expect(await shownRooms()).toEqual(["Living room", "Bedroom"]);

    fireEvent.click(screen.getByRole("button", { name: "Delete Bedroom" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(async () => {
      expect(await shownRooms()).toEqual(["Living room"]);
    });
    expect(rooms.current().map((room) => room.name)).toEqual(["Living room"]);
  });

  it("move a Room up or down the Room order", async () => {
    const rooms = fakeRoomsApi(["Living room", "Bedroom", "Office"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Move Living room up" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Move Office down" }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Move Office up" }));
    await waitFor(async () => {
      expect(await shownRooms()).toEqual(["Living room", "Office", "Bedroom"]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Move Living room down" }));
    await waitFor(async () => {
      expect(await shownRooms()).toEqual(["Office", "Living room", "Bedroom"]);
    });
    expect(rooms.current().map((room) => room.name)).toEqual(["Office", "Living room", "Bedroom"]);
  });

  it("show the Rooms as the Hub has them after a change it refused, e.g. one another Remote made first", async () => {
    const rooms = fakeRoomsApi(["Living room", "Bedroom"]);
    render(<RoomsSection rooms={rooms} />);
    await shownRooms();

    await rooms.add("Office");
    rooms.refuseNext("The Rooms have changed since this list was shown. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Move Bedroom up" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The Rooms have changed since this list was shown. Try again.",
    );
    expect(await shownRooms()).toEqual(["Living room", "Bedroom", "Office"]);
  });

  it("say so when the Hub can't be reached", async () => {
    const unreachable: RoomsApi = {
      ...fakeRoomsApi(),
      list: () => Promise.reject(new HubRequestFailed("Can't reach the Hub")),
    };
    render(<RoomsSection rooms={unreachable} />);

    expect((await screen.findByRole("alert")).textContent).toBe("Can't reach the Hub");
    expect(screen.queryByText("Loading the Rooms…")).toBeNull();
  });
});
