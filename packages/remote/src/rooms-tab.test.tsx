import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOMS_TAB_ROOM_KEY, RoomsTab } from "./rooms-tab.tsx";
import { SELECTED_TV_KEY } from "./selected-tv.ts";
import { aHiveAppliance, aLight, anAirConditioner, aTv, fakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import {
  aBluetoothDevice,
  aNetworkDevice,
  fakeNetworkApi,
  NO_BLUETOOTH_SCAN,
  NO_SCAN,
} from "./testing/fake-network-api.ts";
import { anEcho, anEchoState, fakeAmazonApi } from "./testing/fake-amazon-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { aRingDevice, aRingState, fakeRingApi } from "./testing/fake-ring-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";

afterEach(cleanup);

const LOUNGE = { id: 1, name: "Lounge" };
const BEDROOM = { id: 2, name: "Bedroom" };

const HOME = [
  aLight(10, "Lamp", LOUNGE.id),
  aHiveAppliance(11, "radiator-valve", "Radiator", LOUNGE.id),
  anAirConditioner(12, "Aircon", LOUNGE.id),
  aTv(13, "TV", LOUNGE.id),
  aTv(14, "TV", BEDROOM.id),
  aLight(15, "Porch", null),
];

const renderTab = (
  options: {
    appliances?: ReturnType<typeof fakeAppliancesApi>;
    names?: readonly string[];
    storage?: ReturnType<typeof memoryStorage>;
    onOpenTab?: (tab: "tv" | "heating") => void;
    onOpenSettings?: (section: string) => void;
    network?: ReturnType<typeof fakeNetworkApi>;
    amazon?: ReturnType<typeof fakeAmazonApi>;
    ring?: ReturnType<typeof fakeRingApi>;
  } = {},
) =>
  render(
    <RoomsTab
      appliances={options.appliances ?? fakeAppliancesApi(HOME)}
      rooms={fakeRoomsApi(options.names ?? [LOUNGE.name, BEDROOM.name])}
      network={options.network ?? fakeNetworkApi()}
      amazon={options.amazon ?? fakeAmazonApi()}
      ring={options.ring ?? fakeRingApi()}
      storage={options.storage ?? memoryStorage()}
      onOpenTab={options.onOpenTab ?? (() => undefined)}
      onOpenSettings={options.onOpenSettings ?? (() => undefined)}
      tvRefreshMs={60_000}
      deviceRefreshMs={60_000}
    />,
  );

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
const roomPicker = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Room" });

describe("the Rooms tab", () => {
  it("is a board of widgets, as the other tabs are: each one in the Room, arranged and hidden from the Widgets menu, remembered for each Room", async () => {
    const storage = memoryStorage();
    renderTab({ storage });
    await screen.findByRole("heading", { name: "Lounge · Lamp" });

    // Each Appliance in the Lounge is a widget of its own, with its grip; Hive's is one.
    for (const title of ["Lounge · TV", "Lounge · Aircon", "Lounge · Lamp", "Heating"]) {
      expect(screen.getByRole("button", { name: `Arrange ${title}` })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: /^Widgets/ }));
    const menu = screen.getByRole("group", { name: "Show on the Rooms tab" });
    expect(
      within(menu)
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent),
    ).toEqual(["Lounge · TV", "Lounge · Aircon", "Lounge · Lamp", "Heating"]);
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Lounge · Lamp" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Lounge · Lamp" })).toBeNull();
    });
    expect(JSON.parse(storage.items["media-centre:rooms-widgets:1"] ?? "{}")).toMatchObject({
      hidden: ["room-appliance-10"],
    });

    // The Bedroom has a board of its own, which hides nothing.
    fireEvent.change(roomPicker(), { target: { value: String(BEDROOM.id) } });
    expect(await screen.findByRole("button", { name: "Arrange Bedroom · TV" })).toBeTruthy();
    expect(storage.items["media-centre:rooms-widgets:2"]).toBeUndefined();
  });

  it("shows every kind of device put in the Room: its TV, Air Conditioner, Light and Heating, its Echo and Ring device with their controls, and its network and Bluetooth devices", async () => {
    const kitchenEcho = anEcho({ serial: "G1", name: "Lounge Echo Dot" });
    const frontDoor = aRingDevice({ id: "100001", name: "Front Door" });
    const inLounge = (key: string, kind: "amazon" | "ring", title: string, maker: string) => ({
      key,
      kind,
      roomId: LOUNGE.id,
      title,
      address: null,
      maker,
    });
    const network = fakeNetworkApi(
      {
        ...NO_SCAN,
        devices: [
          aNetworkDevice({
            address: "192.168.1.50",
            hostname: "nas.home",
            vendor: "WESTERN DIGITAL",
            room: { id: LOUNGE.id, name: LOUNGE.name },
          }),
        ],
      },
      {
        ...NO_BLUETOOTH_SCAN,
        devices: [
          aBluetoothDevice({
            address: "a4:c1:38:0a:1b:2c",
            name: "Kitchen bulb",
            room: { id: LOUNGE.id, name: LOUNGE.name },
          }),
        ],
      },
      () => [],
      [
        inLounge("amazon:G1", "amazon", "Lounge Echo Dot", "Amazon"),
        inLounge("ring:100001", "ring", "Front Door", "Ring"),
      ],
    );
    const amazon = fakeAmazonApi(
      {
        status: { state: "signed-in", domain: "amazon.co.uk", problem: null },
        devices: [kitchenEcho],
        routines: [],
        musicProviders: [],
      },
      [anEchoState("G1")],
    );
    const ring = fakeRingApi({ status: { state: "signed-in", problem: null }, devices: [frontDoor] }, [
      aRingState("100001"),
    ]);
    renderTab({ network, amazon, ring });

    // The Echo and the Ring doorbell, each with the controls its own tab has.
    const echo = await screen.findByRole("article", { name: "Lounge Echo Dot" });
    expect(await within(echo).findByText("Bohemian Rhapsody")).toBeTruthy();
    expect(within(echo).getByRole("button", { name: "Do Not Disturb" })).toBeTruthy();
    const door = screen.getByRole("article", { name: "Front Door" });
    expect(within(door).getByRole("button", { name: "Watch live" })).toBeTruthy();
    expect(within(door).getByRole("img", { name: "The latest snapshot from Front Door" })).toBeTruthy();
    // Neither is listed as well, nor has a Room picker here: it is already in its Room.
    expect(within(echo).queryByRole("combobox", { name: /Room/ })).toBeNull();

    // The TV, Air Conditioner, Light and Radiator Valve, as before, and the network and Bluetooth devices, listed.
    expect(await screen.findByRole("heading", { name: "Lounge · Lamp" })).toBeTruthy();
    expect(screen.getAllByText(/Lounge · (TV|Aircon|Radiator)/).length).toBeGreaterThan(0);
    const devices = screen.getByRole("region", { name: "Devices" });
    expect(
      within(devices)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["nas.homeNetwork · 192.168.1.50 · WESTERN DIGITAL", "Kitchen bulbBluetooth · a4:c1:38:0a:1b:2c"]);
  });

  it("lists an Echo or Ring device in its Room, by name, while the Hub is signed out of its account", async () => {
    const network = fakeNetworkApi(NO_SCAN, NO_BLUETOOTH_SCAN, () => [], [
      { key: "amazon:G1", kind: "amazon", roomId: LOUNGE.id, title: "Lounge Echo Dot", address: null, maker: "Amazon" },
      { key: "ring:100001", kind: "ring", roomId: LOUNGE.id, title: "Front Door", address: null, maker: "Ring" },
    ]);
    renderTab({ network });
    const devices = await screen.findByRole("region", { name: "Devices" });
    expect(
      within(devices)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Lounge Echo DotAmazon · Amazon", "Front DoorRing · Ring"]);
    expect(screen.queryByRole("article", { name: "Front Door" })).toBeNull();
  });

  it("lists the devices put in the Room from the Network tab beside its Appliances, and none put in another", async () => {
    const network = fakeNetworkApi(
      {
        ...NO_SCAN,
        devices: [
          aNetworkDevice({
            address: "192.168.1.50",
            hostname: "nas.home",
            vendor: "WESTERN DIGITAL",
            room: { id: LOUNGE.id, name: LOUNGE.name },
          }),
          aNetworkDevice({
            address: "192.168.1.60",
            hostname: "printer",
            room: { id: BEDROOM.id, name: BEDROOM.name },
          }),
        ],
      },
      {
        ...NO_BLUETOOTH_SCAN,
        devices: [
          aBluetoothDevice({
            address: "a4:c1:38:0a:1b:2c",
            name: "Kitchen bulb",
            maker: "Telink Semiconductor Co. Ltd",
            room: { id: LOUNGE.id, name: LOUNGE.name },
          }),
        ],
      },
    );
    renderTab({ network });

    const devices = await screen.findByRole("region", { name: "Devices" });
    expect(
      within(devices)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "nas.homeNetwork · 192.168.1.50 · WESTERN DIGITAL",
      "Kitchen bulbBluetooth · a4:c1:38:0a:1b:2c · Telink Semiconductor Co. Ltd",
    ]);
    expect(headings()).toContain("Devices");
  });

  it("shows a Room with no Appliances but a device put in it from the Network tab", async () => {
    const network = fakeNetworkApi({
      ...NO_SCAN,
      devices: [
        aNetworkDevice({ address: "192.168.1.50", hostname: "nas.home", room: { id: LOUNGE.id, name: LOUNGE.name } }),
      ],
    });
    renderTab({ appliances: fakeAppliancesApi([]), network });

    expect(within(await screen.findByRole("region", { name: "Devices" })).getByText("nas.home")).toBeTruthy();
    expect(screen.queryByText(/^Nothing in/)).toBeNull();
  });

  it("still shows the Room's Appliances when the Hub can't list its devices", async () => {
    const network = fakeNetworkApi();
    network.failNext("Can't reach the Hub");
    renderTab({ network });

    expect((await screen.findAllByRole("heading", { level: 2 })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "Devices" })).toBeNull();
  });

  it("shows every Appliance in the first Room, in the order of the tabs", async () => {
    renderTab();

    await screen.findByRole("combobox", { name: "Room" });
    expect(screen.getByRole("heading", { name: "Rooms", level: 1 })).toBeTruthy();
    expect([...roomPicker().options].map(({ textContent }) => textContent)).toEqual(["Lounge", "Bedroom", "No room"]);
    expect(roomPicker().value).toBe(String(LOUNGE.id));
    expect(headings()).toEqual(["Lounge", "Lounge · TV", "Lounge · Aircon", "Lounge · Lamp", "Lounge · Radiator"]);
  });

  it("shows the Room chosen, and remembers it", async () => {
    const storage = memoryStorage();
    renderTab({ storage });
    await screen.findByRole("combobox", { name: "Room" });

    fireEvent.change(roomPicker(), { target: { value: String(BEDROOM.id) } });
    expect(headings()).toEqual(["Bedroom", "Bedroom · TV"]);
    expect(storage.getItem(ROOMS_TAB_ROOM_KEY)).toBe(String(BEDROOM.id));

    fireEvent.change(roomPicker(), { target: { value: "none" } });
    expect(headings()).toEqual(["No room", "Porch"]);

    cleanup();
    renderTab({ storage });
    await screen.findByRole("combobox", { name: "Room" });
    expect(headings()).toEqual(["No room", "Porch"]);
  });

  it("controls a Light and an Air Conditioner as their own tabs do", async () => {
    const appliances = fakeAppliancesApi(HOME);
    renderTab({ appliances });

    const lamp = await screen.findByRole("region", { name: "Lounge · Lamp" });
    const power = await within(lamp).findByRole<HTMLButtonElement>("button", { name: "Power", pressed: true });
    await waitFor(() => {
      expect(power.disabled).toBe(false);
    });
    fireEvent.click(power);
    await waitFor(() => {
      expect(appliances.lightChanges).toEqual([{ id: 10, change: { on: false } }]);
    });
    expect(await screen.findByRole("region", { name: "Lounge · Aircon" })).toBeTruthy();
  });

  it("switches a TV's power, and opens the TV tab on it", async () => {
    const appliances = fakeAppliancesApi(HOME);
    appliances.setPower(13, "standby");
    const storage = memoryStorage();
    const onOpenTab = vi.fn();
    renderTab({ appliances, storage, onOpenTab });

    const tv = await screen.findByRole("region", { name: "Lounge · TV" });
    await within(tv).findByText("TV · Standby");
    fireEvent.click(within(tv).getByRole("button", { name: "Power" }));
    await waitFor(() => {
      expect(appliances.powerSwitches).toEqual([13]);
    });

    fireEvent.click(within(tv).getByRole("button", { name: "Open in the TV tab" }));
    expect(storage.getItem(SELECTED_TV_KEY)).toBe("13");
    expect(onOpenTab).toHaveBeenCalledWith("tv");
  });

  it("controls a Room's Radiator Valves as the Heating tab does, reading Hive only while a Room with one is shown", async () => {
    const appliances = fakeAppliancesApi(HOME);
    const storage = memoryStorage({ [ROOMS_TAB_ROOM_KEY]: String(BEDROOM.id) });
    renderTab({ appliances, storage });
    await screen.findByRole("region", { name: "Bedroom · TV" });
    // Bedroom has none of Hive's, so Hive isn't read.
    expect(appliances.heatingReads()).toBe(0);

    fireEvent.change(roomPicker(), { target: { value: String(LOUNGE.id) } });
    const valve = await screen.findByRole("region", { name: "Lounge · Radiator" });
    await waitFor(() => {
      expect(valve.querySelector(".aircon-summary")?.textContent).toBe("Schedule, 20°");
    });
    expect(appliances.heatingReads()).toBe(1);
    fireEvent.click(within(valve).getByRole("button", { name: "Lower Lounge · Radiator's target temperature" }));
    await waitFor(() => {
      expect(valve.querySelector(".aircon-summary")?.textContent).toBe("Schedule, 19.5°");
    });
    expect(appliances.heatingChanges).toEqual([{ to: 11, change: { target: 19.5 } }]);
  });

  it("has the Room-wide target of a Room with more than one Radiator Valve", async () => {
    const appliances = fakeAppliancesApi([
      aHiveAppliance(20, "radiator-valve", "Window", LOUNGE.id),
      aHiveAppliance(21, "radiator-valve", "Door", LOUNGE.id),
    ]);
    renderTab({ appliances });

    const room = await screen.findByRole("region", { name: "Lounge · Radiator Valves" });
    await waitFor(() => {
      expect(within(room).getByRole("status", { name: "Every Radiator Valve in Lounge set" }).textContent).toBe("20°");
    });
    expect(headings()).toEqual(["Lounge", "Lounge · Radiator Valves", "Lounge · Window", "Lounge · Door"]);
  });

  it("says how to add a Room where there are none, and a Room with nothing in it", async () => {
    const onOpenSettings = vi.fn();
    renderTab({ appliances: fakeAppliancesApi([]), names: [], onOpenSettings });
    fireEvent.click(
      within(await screen.findByRole("region", { name: "No Rooms yet" })).getByRole("button", {
        name: "Open Settings",
      }),
    );
    expect(onOpenSettings).toHaveBeenCalledWith("rooms");

    cleanup();
    renderTab({ appliances: fakeAppliancesApi([]), names: ["Loft"] });
    expect(await screen.findByRole("region", { name: "Nothing in Loft yet" })).toBeTruthy();
  });
});

describe("the Rooms tab's floor plan", () => {
  const plan = () => screen.getByRole("group", { name: "Floor plan" });
  const unnamed = (floor: "upstairs" | "downstairs") =>
    within(plan()).getAllByRole("button", { name: `Name a room ${floor}` });
  const dialog = () => screen.getByRole("dialog");
  const pressed = () => within(plan()).getByRole("button", { pressed: true }).getAttribute("aria-label");

  it("starts with every place no Room, each asking which it is, and makes one a Room the Hub has", async () => {
    const rooms = fakeRoomsApi(["Kitchen", "Study"]);
    render(
      <RoomsTab
        appliances={fakeAppliancesApi([aLight(10, "Lamp", 1)])}
        rooms={rooms}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        storage={memoryStorage()}
        onOpenTab={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    await screen.findByRole("group", { name: "Floor plan" });
    expect(unnamed("upstairs")).toHaveLength(7);
    expect(unnamed("downstairs")).toHaveLength(6);
    // No name of anyone's room is on the plan until it is given one.
    expect(within(plan()).queryByRole("button", { name: "Kitchen" })).toBeNull();

    fireEvent.click(unnamed("downstairs")[2] as Element);
    expect(within(dialog()).getByRole("heading", { name: "Which Room is this?" })).toBeTruthy();
    expect(within(dialog()).getByRole<HTMLInputElement>("radio", { name: "A Room you have" }).checked).toBe(true);
    expect(within(dialog()).getByRole<HTMLSelectElement>("combobox", { name: "Room" }).value).toBe("1");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(rooms.places()).toEqual({ "downstairs-3": 1 });
    });
    expect(pressed()).toBe("Kitchen");
    expect(headings()).toEqual(["Kitchen", "Kitchen · Lamp"]);
    expect(unnamed("downstairs")).toHaveLength(5);

    // A Room on the plan is offered again, to move here.
    fireEvent.click(unnamed("downstairs")[0] as Element);
    const options = within(dialog())
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Kitchen (moves here)", "Study"]);
    expect(within(dialog()).getByRole<HTMLSelectElement>("combobox", { name: "Room" }).value).toBe("2");
  });

  it("names a new Room on the plan, adding it to the Hub", async () => {
    const rooms = fakeRoomsApi([]);
    render(
      <RoomsTab
        appliances={fakeAppliancesApi([])}
        rooms={rooms}
        network={fakeNetworkApi()}
        amazon={fakeAmazonApi()}
        ring={fakeRingApi()}
        storage={memoryStorage()}
        onOpenTab={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    await screen.findByRole("region", { name: "No Rooms yet" });

    fireEvent.click(unnamed("upstairs")[0] as Element);
    // With no Rooms yet, only a new one can be named.
    expect(within(dialog()).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(within(dialog()).getByRole("alert").textContent).toBe("Give the Room a name.");

    fireEvent.input(within(dialog()).getByRole("textbox", { name: "Name this Room" }), {
      target: { value: " Study " },
    });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(rooms.current()).toEqual([{ id: 1, name: "Study" }]);
    });
    expect(rooms.places()).toEqual({ "upstairs-1": 1 });
    expect(pressed()).toBe("Study");
    expect(roomPicker().value).toBe("1");
  });

  it("says why the Hub refused a new Room's name, and keeps the dialog open", async () => {
    const rooms = fakeRoomsApi(["Kitchen"]);
    renderPlan(rooms);
    await screen.findByRole("group", { name: "Floor plan" });

    fireEvent.click(unnamed("upstairs")[0] as Element);
    fireEvent.click(within(dialog()).getByRole("radio", { name: "A new Room" }));
    fireEvent.input(within(dialog()).getByRole("textbox", { name: "New Room's name" }), {
      target: { value: "kitchen" },
    });
    rooms.refuseNext('There is already a Room called "Kitchen".');
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));

    expect((await within(dialog()).findByRole("alert")).textContent).toBe('There is already a Room called "Kitchen".');
    expect(rooms.places()).toEqual({});
  });

  it("shows a Room tapped on the plan, and while editing changes which Room a place is, or takes it off", async () => {
    const rooms = fakeRoomsApi(["Kitchen", "Study"], { "downstairs-3": 1, "upstairs-1": 2 });
    renderPlan(rooms);
    await screen.findByRole("group", { name: "Floor plan" });

    fireEvent.click(within(plan()).getByRole("button", { name: "Study" }));
    expect(pressed()).toBe("Study");
    fireEvent.keyDown(within(plan()).getByRole("button", { name: "Kitchen" }), { key: "Enter" });
    expect(pressed()).toBe("Kitchen");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit floor plan", pressed: false }));
    fireEvent.click(within(plan()).getByRole("button", { name: "Change Kitchen on the plan" }));
    fireEvent.change(within(dialog()).getByRole("combobox", { name: "Room" }), { target: { value: "2" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    // Study moves here from upstairs, which is no Room again.
    await waitFor(() => {
      expect(rooms.places()).toEqual({ "downstairs-3": 2 });
    });
    expect(unnamed("upstairs")).toHaveLength(7);

    fireEvent.click(within(plan()).getByRole("button", { name: "Change Study on the plan" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Take off the plan" }));
    await waitFor(() => {
      expect(rooms.places()).toEqual({});
    });
    fireEvent.click(screen.getByRole("button", { name: "Done", pressed: true }));
    expect(unnamed("downstairs")).toHaveLength(6);
  });
});

describe("the Rooms tab's own floor plan", () => {
  const plan = () => screen.getByRole("group", { name: "Floor plan" });

  it("is the drawing the Hub has, by its image's version, with the places drawn on it", async () => {
    const rooms = fakeRoomsApi(
      ["Kitchen"],
      { "place-2": 1 },
      {
        layout: {
          width: 400,
          height: 300,
          floors: [
            { name: "Ground", viewBox: "0 0 400 150", places: [{ id: "place-1", points: "10,10 100,10 100,100" }] },
            { name: "First", viewBox: "0 150 400 150", places: [{ id: "place-2", points: "10,160 100,160 100,250" }] },
          ],
        },
        image: { type: "image/png", version: 3 },
      },
    );
    renderPlan(rooms);
    await screen.findByRole("group", { name: "Floor plan" });

    expect(
      within(plan())
        .getAllByRole("group")
        .map((floor) => floor.getAttribute("aria-label")),
    ).toEqual(["Ground", "First"]);
    expect(within(plan()).getByRole("button", { name: "Name a room ground" })).toBeTruthy();
    expect(within(plan()).getByRole("button", { name: "Kitchen" })).toBeTruthy();
    expect(plan().querySelector("image")?.getAttribute("href")).toBe("/api/rooms/floor-plan-image?v=3");
    expect(plan().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 400 150");
  });

  it("is drawn from Edit floor plan, and shows what was saved", async () => {
    const rooms = fakeRoomsApi(["Kitchen"], { "downstairs-3": 1 });
    renderPlan(rooms);
    await screen.findByRole("group", { name: "Floor plan" });
    expect(screen.queryByRole("button", { name: "Draw the plan" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit floor plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Draw the plan" }));
    const editor = await screen.findByRole("dialog");
    await within(editor).findByRole("img", { name: /^The drawing/ });
    fireEvent.click(within(editor).getByRole("button", { name: "Delete Kitchen" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(within(plan()).queryByRole("button", { name: "Change Kitchen on the plan" })).toBeNull();
    });
    expect(within(plan()).getAllByRole("button", { name: "Name a room downstairs" })).toHaveLength(5);
    expect(rooms.places()).toEqual({});
  });
});

const renderPlan = (rooms: ReturnType<typeof fakeRoomsApi>) =>
  render(
    <RoomsTab
      appliances={fakeAppliancesApi([])}
      rooms={rooms}
      network={fakeNetworkApi()}
      amazon={fakeAmazonApi()}
      ring={fakeRingApi()}
      storage={memoryStorage()}
      onOpenTab={() => undefined}
      onOpenSettings={() => undefined}
    />,
  );
