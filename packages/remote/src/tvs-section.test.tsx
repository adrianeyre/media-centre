import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Appliance } from "@media-centre/shared";

import { aFoundTv, aLight, aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { TvsSection } from "./tvs-section.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { deviceGroups } from "./testing/device-groups.ts";

afterEach(cleanup);

/** Rooms 1 and 2. */
const ROOMS = ["Living room", "Bedroom"];

const renderTvs = (appliances: FakeAppliancesApi, rooms: RoomsApi = fakeRoomsApi(ROOMS), roomsVersion = 0) =>
  render(<TvsSection appliances={appliances} rooms={rooms} roomsVersion={roomsVersion} />);

/** Each Room's heading, with the TVs listed under it as the Remote names them. */
const shownGroups = async (): Promise<[string, string[]][]> => {
  const section = await screen.findByRole("region", { name: "TVs" });
  await within(section).findAllByRole("button", { name: /^Edit / });
  return deviceGroups(section);
};

const addForm = () => screen.getByRole("form", { name: "Add TV by IP" });

const fillAddForm = (address: string, name: string, room: string): void => {
  const form = addForm();
  fireEvent.input(within(form).getByRole("textbox", { name: "IP address" }), { target: { value: address } });
  fireEvent.input(within(form).getByRole("textbox", { name: "Name" }), { target: { value: name } });
  const select = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Room" });
  const option = within(select).getByRole<HTMLOptionElement>("option", { name: room });
  fireEvent.change(select, { target: { value: option.value } });
};

describe("Settings' TVs", () => {
  it("say how to add one when there are none", async () => {
    renderTvs(fakeAppliancesApi());

    expect(screen.getByText("Loading the TVs…")).toBeTruthy();
    expect(
      await screen.findByText(/^No TVs yet\. Find them on the network below, or add one by its IP address/),
    ).toBeTruthy();
  });

  it('name each TV "Room · Name", under its Room in Room order, and a TV with no Room by its name alone', async () => {
    renderTvs(fakeAppliancesApi([aTv(1, "TV", 2), aTv(2, "Spare", null), aTv(3, "TV", 1)]));

    expect(await shownGroups()).toEqual([
      ["Living room", ["Living room · TV"]],
      ["Bedroom", ["Bedroom · TV"]],
      ["No room", ["Spare"]],
    ]);
    expect(screen.getByRole("listitem", { name: "Bedroom · TV" }).textContent).toContain(
      "QE55Q60TAUXXU, at 192.168.1.21",
    );
  });

  it("add a TV by IP, saying to choose Allow on the TV while the Hub waits for it", async () => {
    const appliances = fakeAppliancesApi();
    renderTvs(appliances);
    await screen.findByText(/^No TVs yet/);

    const release = appliances.holdPairing();
    fillAddForm("192.168.1.20", "TV", "Bedroom");
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add TV" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Choose Allow on the TV when it asks. The Hub is waiting for it…",
    );
    expect(within(addForm()).getByRole<HTMLButtonElement>("button", { name: "Add TV" }).disabled).toBe(true);

    release();

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["Bedroom", ["Bedroom · TV"]]]);
    });
    expect(appliances.current()).toEqual([expect.objectContaining({ address: "192.168.1.20", name: "TV", roomId: 2 })]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "IP address" }).value).toBe("");
  });

  it('add a TV with "No room" unless a Room is chosen', async () => {
    const appliances = fakeAppliancesApi();
    renderTvs(appliances);
    await screen.findByText(/^No TVs yet/);

    fireEvent.input(within(addForm()).getByRole("textbox", { name: "IP address" }), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add TV" }));

    await waitFor(() => {
      expect(appliances.current()).toEqual([expect.objectContaining({ roomId: null })]);
    });
    expect(await shownGroups()).toEqual([["No room", ["[TV] Samsung"]]]);
  });

  it("show the Hub's reason for refusing a TV beside the form, and keep what was typed", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
    renderTvs(appliances);
    await shownGroups();

    appliances.refuseNext('There is already a TV called "TV" in Living room.');
    fillAddForm("192.168.1.30", "tv", "Living room");
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add TV" }));

    expect((await within(addForm()).findByRole("alert")).textContent).toBe(
      'There is already a TV called "TV" in Living room.',
    );
    expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("tv");
    expect(appliances.current()).toHaveLength(1);
  });

  it('check each TV\'s pairing once on opening, and offer "Pair again" for one that refused the Hub', async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]);
    appliances.revoke(2);
    renderTvs(appliances);

    const bedroom = await screen.findByRole("listitem", { name: "Bedroom · TV" });
    await within(bedroom).findByRole("button", { name: "Pair again" });
    expect(within(bedroom).getByText("This TV no longer lets the Hub in.")).toBeTruthy();
    const living = screen.getByRole("listitem", { name: "Living room · TV" });
    expect(within(living).queryByRole("button", { name: "Pair again" })).toBeNull();
    expect([...appliances.connected].sort()).toEqual([1, 2]);

    const release = appliances.holdPairing();
    fireEvent.click(within(bedroom).getByRole("button", { name: "Pair again" }));
    expect((await within(bedroom).findByRole("status")).textContent).toContain("Choose Allow on the TV");
    release();

    await waitFor(() => {
      expect(
        within(screen.getByRole("listitem", { name: "Bedroom · TV" })).queryByRole("button", { name: "Pair again" }),
      ).toBeNull();
    });
    expect(appliances.current().map(({ pairing }) => pairing)).toEqual(["paired", "paired"]);
    expect(appliances.connected).toHaveLength(2);
  });

  it('show "Pair again" for a TV the Hub already knows refused it, without checking it', async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", null, { pairing: "pair-again" })]);
    renderTvs(appliances);

    expect(await screen.findByRole("button", { name: "Pair again" })).toBeTruthy();
    expect(appliances.connected).toEqual([]);
  });

  it("rename a TV and move it to another Room", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
    renderTvs(appliances);
    await shownGroups();

    fireEvent.click(screen.getByRole("button", { name: "Edit Living room · TV" }));
    const form = screen.getByRole("form", { name: "Edit Living room · TV" });
    const name = within(form).getByRole<HTMLInputElement>("textbox", { name: "TV name" });
    expect(name.value).toBe("TV");
    expect(document.activeElement).toBe(name);
    fireEvent.input(name, { target: { value: "Big TV" } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Room" }), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["Bedroom", ["Bedroom · Big TV"]]]);
    });
    expect(screen.queryByRole("form", { name: /^Edit/ })).toBeNull();
  });

  describe("film Light Scene (FR-57)", () => {
    /** Living room · TV and Bedroom · TV, with the Living room's Light Scenes "Film" (1) and "Bright" (2), and the Bedroom's "Night" (3). */
    const withLightScenes = async (living: Partial<Appliance> = {}): Promise<FakeAppliancesApi> => {
      const appliances = fakeAppliancesApi([
        aTv(1, "TV", 1, living),
        aTv(2, "TV", 2),
        aLight(3, "Lamp", 1),
        aLight(4, "Lamp", 2),
      ]);
      await appliances.saveLightScene(1, "Film");
      await appliances.saveLightScene(1, "Bright");
      await appliances.saveLightScene(2, "Night");
      return appliances;
    };

    const options = (select: HTMLElement): string[] =>
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent);

    const editLivingRoomTv = async () => {
      await shownGroups();
      fireEvent.click(screen.getByRole("button", { name: "Edit Living room · TV" }));
      const form = screen.getByRole("form", { name: "Edit Living room · TV" });
      return { form, select: within(form).getByRole<HTMLSelectElement>("combobox", { name: "Film Light Scene" }) };
    };

    it("is chosen from the TV's own Room's Light Scenes, or none, and shown with the TV", async () => {
      const appliances = await withLightScenes();
      renderTvs(appliances);

      const { form, select } = await editLivingRoomTv();
      expect(options(select)).toEqual(["None", "Film", "Bright"]);
      expect(select.value).toBe("");
      expect(select.getAttribute("aria-describedby")).toBe("tv-1-film-light-scene-help");
      expect(within(form).getByText(/^Recalled as a video starts on this TV\./)).toBeTruthy();
      fireEvent.change(select, { target: { value: "1" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(screen.queryByRole("form", { name: /^Edit/ })).toBeNull();
      });
      expect(appliances.current().find(({ id }) => id === 1)).toMatchObject({ filmLightSceneId: 1 });
      const living = screen.getByRole("listitem", { name: "Living room · TV" });
      expect(await within(living).findByText("Film Light Scene: Film")).toBeTruthy();
      expect(
        within(screen.getByRole("listitem", { name: "Bedroom · TV" })).queryByText(/^Film Light Scene/),
      ).toBeNull();

      const again = await editLivingRoomTv();
      expect(again.select.value).toBe("1");
      fireEvent.change(again.select, { target: { value: "" } });
      fireEvent.click(within(again.form).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(appliances.current().find(({ id }) => id === 1)).not.toHaveProperty("filmLightSceneId");
      });
      await waitFor(() => {
        expect(screen.queryByText(/^Film Light Scene:/)).toBeNull();
      });
    });

    it("offers the new Room's as the TV is moved, and none for a TV with no Room", async () => {
      const appliances = await withLightScenes({ filmLightSceneId: 1 });
      renderTvs(appliances);

      const { form, select } = await editLivingRoomTv();
      expect(select.value).toBe("1");
      const room = within(form).getByRole("combobox", { name: "Room" });

      fireEvent.change(room, { target: { value: "2" } });
      expect(options(select)).toEqual(["None", "Night"]);
      expect(select.value).toBe("");

      fireEvent.change(room, { target: { value: "" } });
      expect(options(select)).toEqual(["None"]);
      expect(within(form).getByText("A TV with no Room has no Light Scenes to choose from.")).toBeTruthy();
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(appliances.current().find(({ id }) => id === 1)).toEqual(aTv(1, "TV", null));
      });
    });

    it("says how to save one for a Room that has none", async () => {
      const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
      renderTvs(appliances);

      const { form, select } = await editLivingRoomTv();
      expect(options(select)).toEqual(["None"]);
      expect(within(form).getByText("Its Room has no Light Scenes yet. Save one in the Lights tab.")).toBeTruthy();
    });

    it("keeps the choice open, with the Hub's reason, when the Hub refuses it", async () => {
      const appliances = await withLightScenes();
      renderTvs(appliances);

      const { form, select } = await editLivingRoomTv();
      appliances.refuseNext("That Light Scene has been deleted.");
      fireEvent.change(select, { target: { value: "2" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));

      expect((await within(form).findByRole("alert")).textContent).toBe("That Light Scene has been deleted.");
      expect(select.value).toBe("2");
    });
  });

  it("keep the edit open, with the Hub's reason, when the Hub refuses it", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]);
    renderTvs(appliances);
    await shownGroups();

    fireEvent.click(screen.getByRole("button", { name: "Edit Bedroom · TV" }));
    appliances.refuseNext('There is already a TV called "TV" in Living room.');
    const form = screen.getByRole("form", { name: "Edit Bedroom · TV" });
    fireEvent.change(within(form).getByRole("combobox", { name: "Room" }), { target: { value: "1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect((await within(form).findByRole("alert")).textContent).toBe(
      'There is already a TV called "TV" in Living room.',
    );
    expect(within(form).getByRole("textbox", { name: "TV name" }).getAttribute("aria-invalid")).toBe("true");
  });

  it("remove a TV only once the person confirms it", async () => {
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1), aTv(2, "TV", 2)]);
    renderTvs(appliances);
    await shownGroups();

    fireEvent.click(screen.getByRole("button", { name: "Remove Living room · TV" }));
    expect(screen.getByText("Remove Living room · TV? The Hub forgets its pairing too.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No, keep it" }));
    expect(appliances.current()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove Living room · TV" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["Bedroom", ["Bedroom · TV"]]]);
    });
    expect(appliances.current().map(({ id }) => id)).toEqual([2]);
  });

  it("show the TVs in the Rooms as they now are once the Rooms change", async () => {
    const rooms = fakeRoomsApi(ROOMS);
    const appliances = fakeAppliancesApi([aTv(1, "TV", 1)]);
    const { rerender } = renderTvs(appliances, rooms);
    expect(await shownGroups()).toEqual([["Living room", ["Living room · TV"]]]);

    // As the Hub does, deleting the Room leaves its TV with no Room.
    await rooms.remove(1);
    await appliances.update(1, { roomId: null });
    rerender(<TvsSection appliances={appliances} rooms={rooms} roomsVersion={1} />);

    await waitFor(async () => {
      expect(await shownGroups()).toEqual([["No room", ["TV"]]]);
    });
  });

  describe('"Find TVs"', () => {
    const findSection = () => screen.getByRole("region", { name: "Find TVs" });

    const findTvs = async (appliances: FakeAppliancesApi): Promise<void> => {
      renderTvs(appliances);
      await screen.findByRole("heading", { name: "TVs", level: 2 });
      await waitFor(() => {
        expect(screen.queryByText("Loading the TVs…")).toBeNull();
      });
      fireEvent.click(within(findSection()).getByRole("button", { name: "Find TVs" }));
    };

    /** Each TV found, as listed, and what it offers: "Add", or what it is already added as. */
    const shownFound = async (): Promise<string[][]> => {
      const list = await within(findSection()).findByRole("list", { name: "TVs found" });
      return within(list)
        .getAllByRole("listitem")
        .map((item) => [
          item.getAttribute("aria-label") ?? "",
          item.querySelector(".found-name")?.textContent ?? "",
          item.querySelector("button")?.textContent ?? item.querySelector(".found-added")?.textContent ?? "",
          item.querySelector(".appliance-details")?.textContent ?? "",
        ]);
    };

    it("list every TV the Hub finds by its name and IP, saying it is looking meanwhile", async () => {
      const appliances = fakeAppliancesApi([], [aFoundTv(5, "[TV] Living room"), aFoundTv(6, "[TV] Bedroom")]);
      const release = appliances.holdSearch();
      await findTvs(appliances);

      expect((await within(findSection()).findByRole("status")).textContent).toBe("Looking for TVs on the network…");
      expect(within(findSection()).getByRole<HTMLButtonElement>("button", { name: "Find TVs" }).disabled).toBe(true);
      release();

      expect(await shownFound()).toEqual([
        ["[TV] Living room, at 192.168.1.25", "[TV] Living room", "Add", "QE55Q60TAUXXU, at 192.168.1.25"],
        ["[TV] Bedroom, at 192.168.1.26", "[TV] Bedroom", "Add", "QE55Q60TAUXXU, at 192.168.1.26"],
      ]);
      expect(within(findSection()).queryByRole("status")).toBeNull();
      expect(within(findSection()).getByRole<HTMLButtonElement>("button", { name: "Find TVs" }).disabled).toBe(false);
      expect(appliances.searches()).toBe(1);
    });

    it('lead a TV chosen from those found into "Add TV by IP", to be named, given a Room and paired', async () => {
      const appliances = fakeAppliancesApi([], [aFoundTv(5, "[TV] Living room"), aFoundTv(6, "[TV] Bedroom")]);
      await findTvs(appliances);
      await shownFound();

      fireEvent.click(screen.getByRole("button", { name: "Add [TV] Bedroom, at 192.168.1.26" }));

      const form = addForm();
      expect(within(form).getByRole<HTMLInputElement>("textbox", { name: "IP address" }).value).toBe("192.168.1.26");
      const name = within(form).getByRole<HTMLInputElement>("textbox", { name: "Name" });
      expect(name.value).toBe("");
      expect(document.activeElement).toBe(name);
      expect(appliances.current()).toEqual([]);

      fillAddForm("192.168.1.26", "TV", "Bedroom");
      const release = appliances.holdPairing();
      fireEvent.click(within(form).getByRole("button", { name: "Add TV" }));
      expect((await within(form).findByRole("status")).textContent).toContain("Choose Allow on the TV");
      release();

      await waitFor(async () => {
        expect(await shownGroups()).toEqual([["Bedroom", ["Bedroom · TV"]]]);
      });
      // Now added, it is no longer offered.
      expect(await shownFound()).toEqual([
        ["[TV] Living room, at 192.168.1.25", "[TV] Living room", "Add", "QE55Q60TAUXXU, at 192.168.1.25"],
        ["[TV] Bedroom, at 192.168.1.26", "[TV] Bedroom", "Added, as Bedroom · TV", "QE55Q60TAUXXU, at 192.168.1.26"],
      ]);
    });

    it("show a TV that is already added as added, by its name in the Remote, rather than offer it again", async () => {
      const appliances = fakeAppliancesApi(
        [aTv(1, "TV", 1), aTv(2, "Spare", null)],
        [aFoundTv(1, "[TV] Samsung Q60"), aFoundTv(2, "[TV] Samsung S95C"), aFoundTv(3, "[TV] New")],
      );
      await findTvs(appliances);

      expect((await shownFound()).map(([, name, offer]) => [name, offer])).toEqual([
        ["[TV] Samsung Q60", "Added, as Living room · TV"],
        ["[TV] Samsung S95C", "Added, as Spare"],
        ["[TV] New", "Add"],
      ]);
      expect(
        within(findSection())
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Find TVs", "Add"]);
    });

    it('say when no TVs were found, and point to "Add TV by IP"', async () => {
      const appliances = fakeAppliancesApi();
      await findTvs(appliances);

      expect((await within(findSection()).findByText(/^No TVs found\./)).textContent).toBe(
        "No TVs found. Check that the TV is switched on and on the same network as the Hub, or add it by its IP " +
          'address under "Add TV by IP" below.',
      );
      expect(within(findSection()).getByRole("status").textContent).toMatch(/^No TVs found\./);
      expect(within(findSection()).queryByRole("list")).toBeNull();
      expect(addForm()).toBeTruthy();
    });

    it("show the Hub's reason when it couldn't search, and search again on asking", async () => {
      const appliances = fakeAppliancesApi([], [aFoundTv(5, "[TV] Living room")]);
      appliances.refuseNext("The Hub couldn't search its network for TVs. Add the TV by its IP address instead.");
      await findTvs(appliances);

      expect((await within(findSection()).findByRole("alert")).textContent).toBe(
        "The Hub couldn't search its network for TVs. Add the TV by its IP address instead.",
      );

      fireEvent.click(within(findSection()).getByRole("button", { name: "Find TVs" }));

      expect((await shownFound()).map(([label]) => label)).toEqual(["[TV] Living room, at 192.168.1.25"]);
      expect(within(findSection()).queryByRole("alert")).toBeNull();
      expect(appliances.searches()).toBe(2);
    });
  });
});
