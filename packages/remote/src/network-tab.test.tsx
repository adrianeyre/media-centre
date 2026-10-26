import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { BluetoothScan, NetworkScan } from "@media-centre/shared";

import { BLUETOOTH_SCAN_CACHE_KEY, NETWORK_SCAN_CACHE_KEY, NETWORK_VIEW_KEY, NetworkTab } from "./network-tab.tsx";
import {
  aBluetoothDevice,
  aNetworkDevice,
  fakeNetworkApi,
  NO_BLUETOOTH_SCAN,
  NO_SCAN,
  type FakeNetworkApi,
} from "./testing/fake-network-api.ts";
import { fakeRoomsApi, type FakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";

afterEach(cleanup);

const SCANNED: NetworkScan = {
  subnet: "192.168.1.0/24",
  scanning: false,
  checked: 254,
  total: 254,
  startedAt: "2026-10-24T15:00:00.000Z",
  finishedAt: "2026-10-24T15:00:12.000Z",
  devices: [
    aNetworkDevice({
      address: "192.168.1.5",
      macAddress: "f4:ee:08:b1:69:5e",
      vendor: "Dell Inc.",
      isHub: true,
      openPorts: [{ port: 41_080, service: "media-centre Hub" }],
    }),
    aNetworkDevice({
      address: "192.168.1.50",
      macAddress: "00:90:a9:6a:37:6a",
      vendor: "WESTERN DIGITAL",
      hostname: "nas.home",
      openPorts: [
        { port: 22, service: "SSH" },
        { port: 445, service: "SMB file sharing" },
        { port: 5005, service: null },
      ],
      portCheck: { kind: "common", ports: 46, remembered: 1 },
    }),
    aNetworkDevice({
      address: "192.168.1.74",
      appliance: { id: 3, kind: "air-conditioner", name: "Aircon", room: "Lounge" },
      room: { id: 1, name: "Lounge" },
      openPorts: [{ port: 1883, service: "MQTT" }],
    }),
    aNetworkDevice({
      address: "192.168.1.173",
      macAddress: "3a:1b:2c:3d:4e:5f",
      vendor: null,
      privateMacAddress: true,
      responseMs: null,
    }),
  ],
};

const HEARD: BluetoothScan = {
  ...NO_BLUETOOTH_SCAN,
  startedAt: "2026-10-24T15:00:00.000Z",
  finishedAt: "2026-10-24T15:00:20.000Z",
  devices: [
    aBluetoothDevice({
      address: "a4:c1:38:0a:1b:2c",
      advertisedName: "Lepro LampUX",
      maker: "Telink Semiconductor Co. Ltd",
      signal: -58,
      maybeLight: true,
      services: [{ uuid: "0000fff0-0000-1000-8000-00805f9b34fb", name: null }],
    }),
    aBluetoothDevice({ address: "6a:1f:2e:3d:4c:5b", randomAddress: true, maker: "Apple, Inc.", signal: -88 }),
  ],
};

const card = (name: string): HTMLElement => screen.getByRole("article", { name });

/** The status line of the view's scan, not the widget board's own. */
const status = (): string | null | undefined => document.querySelector(".network-status")?.textContent;

const renderTab = (network: FakeNetworkApi, storage = memoryStorage(), rooms: FakeRoomsApi = fakeRoomsApi()) => {
  render(<NetworkTab network={network} rooms={rooms} storage={storage} />);
  return storage;
};

/** The Hub's network scan, with Rooms the fake Rooms API has, as a device put in one is said to be in it. */
const withRooms = (names: readonly string[], bluetooth = NO_BLUETOOTH_SCAN) => {
  const rooms = fakeRoomsApi(names);
  const network = fakeNetworkApi(SCANNED, bluetooth, rooms.current);
  return { rooms, network };
};

describe("the Network tab's home network", () => {
  it("offers to scan the network before the Hub has, and shows the scan under way with how far it has got", async () => {
    const network = fakeNetworkApi(NO_SCAN);
    renderTab(network);

    expect(await screen.findByText("The Hub hasn't scanned the network yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan the network" }));

    expect(await screen.findByRole("button", { name: "Scanning…" })).toHaveProperty("disabled", true);
    expect(status()).toBe("Looking at 0 of 254 addresses on 192.168.1.0/24…");
    expect(screen.getByRole("progressbar", { name: "How far the scan has got" })).toBeTruthy();
    expect(network.scans()).toBe(1);

    network.set(SCANNED);
    expect(await screen.findByRole("button", { name: "Scan again" }, { timeout: 3_000 })).toBeTruthy();
    expect(status()).toMatch(/^4 devices on 192\.168\.1\.0\/24, scanned at /);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows each device as a widget, with what it is, its details and its open ports, remembered ones too", async () => {
    renderTab(fakeNetworkApi(SCANNED));

    const nas = await screen.findByRole("article", { name: "nas.home" });
    expect(nas.closest(".widget")).not.toBeNull();
    expect(within(nas).getByText("192.168.1.50")).toBeTruthy();
    expect(within(nas).getByText("WESTERN DIGITAL")).toBeTruthy();
    expect(within(nas).getByText("00:90:a9:6a:37:6a")).toBeTruthy();
    expect(within(nas).getByText("12 ms")).toBeTruthy();
    expect(
      within(nas)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["22SSH", "445SMB file sharing", "5005"]);
    expect(within(nas).getByText("Checked the 46 common ports, and 1 port found open before.")).toBeTruthy();

    expect(within(card("This Hub")).getByText("This Hub", { selector: ".chip" })).toBeTruthy();
    expect(within(card("Aircon")).getByText("Lounge", { selector: ".chip" })).toBeTruthy();
    const phone = card("A device with a private address");
    expect(within(phone).getByText("Not known: a private MAC address")).toBeTruthy();
    expect(within(phone).getByText("Only to the Hub's ARP")).toBeTruthy();
    expect(within(phone).getByText("None open.")).toBeTruthy();
  });

  it("names a device, which it is then called, and forgets its name when it is emptied", async () => {
    renderTab(fakeNetworkApi(SCANNED));

    fireEvent.click(
      within(await screen.findByRole("article", { name: "nas.home" })).getByRole("button", { name: "Name it" }),
    );
    fireEvent.input(within(card("nas.home")).getByRole("textbox", { name: "Name" }), {
      target: { value: "Media NAS" },
    });
    fireEvent.click(within(card("nas.home")).getByRole("button", { name: "Save" }));

    const named = await screen.findByRole("article", { name: "Media NAS" });
    expect(within(named).getByText("nas.home")).toBeTruthy();

    fireEvent.click(within(named).getByRole("button", { name: "Rename" }));
    fireEvent.input(within(named).getByRole("textbox", { name: "Name" }), { target: { value: "  " } });
    fireEvent.click(within(named).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("article", { name: "nas.home" })).toBeTruthy();
  });

  it("puts a device in a Room the Hub has, and back in No room, showing its Room beside its address", async () => {
    const { rooms, network } = withRooms(["Lounge", "Study"]);
    renderTab(network, memoryStorage(), rooms);

    const picker = await within(await screen.findByRole("article", { name: "nas.home" })).findByRole<HTMLSelectElement>(
      "combobox",
      { name: "Room for nas.home" },
    );
    await waitFor(() => {
      expect([...picker.options].map((option) => option.text)).toEqual(["No room", "Lounge", "Study", "New room…"]);
    });
    expect(picker.value).toBe("");

    const study = rooms.current().find(({ name }) => name === "Study");
    fireEvent.change(picker, { target: { value: String(study?.id) } });
    expect(await within(card("nas.home")).findByText("Study", { selector: ".chip" })).toBeTruthy();
    expect(network.roomsAsked()).toEqual([["192.168.1.50", study?.id]]);

    fireEvent.change(within(card("nas.home")).getByRole("combobox", { name: "Room for nas.home" }), {
      target: { value: "" },
    });
    await waitFor(() => {
      expect(within(card("nas.home")).queryByText("Study", { selector: ".chip" })).toBeNull();
    });
    expect(network.roomsAsked().at(-1)).toEqual(["192.168.1.50", null]);
  });

  it("makes a new Room from a device's Room picker, and puts the device in it", async () => {
    const { rooms, network } = withRooms(["Lounge"]);
    renderTab(network, memoryStorage(), rooms);

    const nas = await screen.findByRole("article", { name: "nas.home" });
    fireEvent.change(within(nas).getByRole("combobox", { name: "Room for nas.home" }), { target: { value: "new" } });
    fireEvent.input(within(nas).getByRole("textbox", { name: "New Room's name" }), { target: { value: "Garage" } });
    fireEvent.click(within(nas).getByRole("button", { name: "Create and put it there" }));

    expect(await within(card("nas.home")).findByText("Garage", { selector: ".chip" })).toBeTruthy();
    expect(rooms.current().map(({ name }) => name)).toEqual(["Lounge", "Garage"]);
    const picker = within(card("nas.home")).getByRole<HTMLSelectElement>("combobox", { name: "Room for nas.home" });
    expect(picker.selectedOptions[0]?.text).toBe("Garage");
    expect(within(card("nas.home")).queryByRole("textbox", { name: "New Room's name" })).toBeNull();
  });

  it("says why the Hub refused a new Room, or moving an Appliance, beside the picker", async () => {
    const { rooms, network } = withRooms(["Lounge"]);
    renderTab(network, memoryStorage(), rooms);

    const nas = await screen.findByRole("article", { name: "nas.home" });
    fireEvent.change(within(nas).getByRole("combobox", { name: "Room for nas.home" }), { target: { value: "new" } });
    rooms.refuseNext("There is already a Room called Lounge.");
    fireEvent.input(within(nas).getByRole("textbox", { name: "New Room's name" }), { target: { value: "lounge" } });
    fireEvent.click(within(nas).getByRole("button", { name: "Create and put it there" }));
    expect((await within(card("nas.home")).findByRole("alert")).textContent).toBe(
      "There is already a Room called Lounge.",
    );

    const aircon = card("Aircon");
    network.failNext("There is already an Air Conditioner called Aircon in Lounge.");
    fireEvent.change(within(aircon).getByRole("combobox", { name: "Room for Aircon" }), {
      target: { value: String(rooms.current()[0]?.id) },
    });
    expect((await within(card("Aircon")).findByRole("alert")).textContent).toBe(
      "There is already an Air Conditioner called Aircon in Lounge.",
    );
  });

  it("says why the Hub refused a name, beside the field", async () => {
    const network = fakeNetworkApi(SCANNED);
    renderTab(network);

    fireEvent.click(
      within(await screen.findByRole("article", { name: "nas.home" })).getByRole("button", { name: "Name it" }),
    );
    network.failNext("A device's name is at most 40 characters.");
    fireEvent.click(within(card("nas.home")).getByRole("button", { name: "Save" }));

    expect((await within(card("nas.home")).findByRole("alert")).textContent).toBe(
      "A device's name is at most 40 characters.",
    );
    expect(within(card("nas.home")).getByRole("textbox", { name: "Name" }).getAttribute("aria-invalid")).toBe("true");
  });

  it("filters the devices by name, address, maker or port", async () => {
    renderTab(fakeNetworkApi(SCANNED));
    const filter = await screen.findByRole("searchbox", { name: "Filter" });

    fireEvent.input(filter, { target: { value: "smb" } });
    expect(screen.getAllByRole("article").map((each) => each.getAttribute("aria-labelledby"))).toEqual([
      "device-192-168-1-50",
    ]);

    fireEvent.input(filter, { target: { value: "1883" } });
    expect(screen.getByRole("article", { name: "Aircon" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(1);

    fireEvent.input(filter, { target: { value: "printer" } });
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText("No device matches “printer”.")).toBeTruthy();
  });

  it("checks every port of a device on asking, showing how far it has got, and that the Hub remembers those open", async () => {
    const network = fakeNetworkApi(SCANNED);
    renderTab(network);

    fireEvent.click(
      within(await screen.findByRole("article", { name: "nas.home" })).getByRole("button", {
        name: "Check every port",
      }),
    );

    expect(await within(card("nas.home")).findByText("Checking every port: 0 of 65,535…")).toBeTruthy();
    expect(within(card("nas.home")).queryByRole("button", { name: "Check every port" })).toBeNull();
    expect(network.allPortChecks()).toEqual(["192.168.1.50"]);

    network.set({
      ...SCANNED,
      devices: SCANNED.devices.map((device) =>
        device.address === "192.168.1.50"
          ? { ...device, portCheck: { kind: "all", checked: 65_535, total: 65_535, done: true } }
          : device,
      ),
    });
    expect(
      await within(card("nas.home")).findByText(
        "Checked every port, all 65,535. The Hub remembers those open, and checks them each scan.",
        {},
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  });

  it("shows the last scan this Remote kept at once, with no scan, even before the Hub answers, and keeps each it is shown", async () => {
    const storage = memoryStorage({ [NETWORK_SCAN_CACHE_KEY]: JSON.stringify(SCANNED) });
    const network = fakeNetworkApi(NO_SCAN);
    network.failNext("Can't reach the Hub");
    renderTab(network, storage);

    // Shown from this Remote's own copy, as the Hub can't be reached, with "Scan again" to look afresh.
    expect(screen.getByRole("article", { name: "nas.home" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe("Can't reach the Hub");
    expect(network.scans()).toBe(0);

    // A scan under way isn't kept; the one it ends with is.
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    await screen.findByRole("button", { name: "Scanning…" });
    expect(JSON.parse(storage.items[NETWORK_SCAN_CACHE_KEY] ?? "{}")).toMatchObject({ scanning: false });
    network.set({ ...SCANNED, devices: SCANNED.devices.slice(0, 1) });
    await waitFor(
      () => {
        expect((JSON.parse(storage.items[NETWORK_SCAN_CACHE_KEY] ?? "{}") as NetworkScan).devices).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
  });

  it("says why when the Hub can't be reached", async () => {
    const network = fakeNetworkApi(NO_SCAN);
    network.failNext("Can't reach the Hub");
    renderTab(network);

    expect((await screen.findByRole("alert")).textContent).toBe("Can't reach the Hub");
  });
});

describe("the Network tab's Bluetooth", () => {
  const openBluetooth = (): void => {
    fireEvent.click(screen.getByRole("radio", { name: "Bluetooth" }));
  };

  it("listens on asking, saying how to make a bulb advertise, and shows each device heard as a widget", async () => {
    const network = fakeNetworkApi(SCANNED, NO_BLUETOOTH_SCAN);
    const storage = renderTab(network);
    openBluetooth();
    expect(storage.items[NETWORK_VIEW_KEY]).toBe("bluetooth");

    expect(await screen.findByText("The Hub hasn't listened for Bluetooth devices yet.")).toBeTruthy();
    expect(screen.getByText(/close its app, such as LampUX/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan for Bluetooth devices" }));
    expect(await screen.findByRole("button", { name: "Scanning…" })).toHaveProperty("disabled", true);
    expect(network.bluetoothScans()).toBe(1);

    network.setBluetooth(HEARD);
    const lamp = await screen.findByRole("article", { name: "Lepro LampUX" }, { timeout: 3_000 });
    expect(lamp.closest(".widget")).not.toBeNull();
    expect(within(lamp).getByText("Maybe a light")).toBeTruthy();
    expect(within(lamp).getByText("Telink Semiconductor Co. Ltd")).toBeTruthy();
    expect(within(lamp).getByText("Strong, -58 dBm")).toBeTruthy();
    expect(within(lamp).getByText("0000fff0-0000-1000-8000-00805f9b34fb")).toBeTruthy();

    const phone = card("Apple, Inc.");
    expect(within(phone).getByText("Changing address")).toBeTruthy();
    expect(within(phone).getByText("Very weak, -88 dBm")).toBeTruthy();
    expect(within(phone).getByText("It names none.")).toBeTruthy();

    fireEvent.input(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "light" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("puts a Bluetooth device in a Room", async () => {
    const { rooms, network } = withRooms(["Kitchen"], HEARD);
    renderTab(network, memoryStorage(), rooms);
    openBluetooth();

    const lamp = await screen.findByRole("article", { name: "Lepro LampUX" });
    const picker = within(lamp).getByRole<HTMLSelectElement>("combobox", { name: "Room for Lepro LampUX" });
    await waitFor(() => {
      expect(picker.options).toHaveLength(3);
    });
    fireEvent.change(picker, { target: { value: String(rooms.current()[0]?.id) } });
    expect(await within(card("Lepro LampUX")).findByText("Kitchen", { selector: ".chip" })).toBeTruthy();
    expect(network.roomsAsked()).toEqual([["a4:c1:38:0a:1b:2c", rooms.current()[0]?.id]]);
  });

  it("shows the last Bluetooth scan this Remote kept at once", () => {
    renderTab(
      fakeNetworkApi(SCANNED, NO_BLUETOOTH_SCAN),
      memoryStorage({ [NETWORK_VIEW_KEY]: "bluetooth", [BLUETOOTH_SCAN_CACHE_KEY]: JSON.stringify(HEARD) }),
    );
    expect(screen.getByRole("article", { name: "Lepro LampUX" })).toBeTruthy();
  });

  it("names a Bluetooth device", async () => {
    renderTab(fakeNetworkApi(SCANNED, HEARD));
    openBluetooth();

    fireEvent.click(
      within(await screen.findByRole("article", { name: "Lepro LampUX" })).getByRole("button", { name: "Name it" }),
    );
    fireEvent.input(within(card("Lepro LampUX")).getByRole("textbox", { name: "Name" }), {
      target: { value: "Kitchen bulb" },
    });
    fireEvent.click(within(card("Lepro LampUX")).getByRole("button", { name: "Save" }));

    expect(within(await screen.findByRole("article", { name: "Kitchen bulb" })).getByText("Lepro LampUX")).toBeTruthy();
  });

  it("reopens on Bluetooth, as it was left, and says why a Hub that can't listen can't", async () => {
    renderTab(
      fakeNetworkApi(SCANNED, {
        ...NO_BLUETOOTH_SCAN,
        available: false,
        problem: "The Hub can listen for Bluetooth devices only when it runs on Windows, for now.",
      }),
      memoryStorage({ [NETWORK_VIEW_KEY]: "bluetooth" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The Hub can listen for Bluetooth devices only when it runs on Windows, for now.",
    );
    expect(screen.getByRole("button", { name: "Scan for Bluetooth devices" })).toHaveProperty("disabled", true);
    expect(screen.queryByText(/close its app/)).toBeNull();
  });

  it("says why Windows stopped listening", async () => {
    renderTab(
      fakeNetworkApi(SCANNED, { ...HEARD, problem: "The Hub's PC has no Bluetooth, or it is switched off." }),
      memoryStorage({ [NETWORK_VIEW_KEY]: "bluetooth" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("The Hub's PC has no Bluetooth, or it is switched off.");
    });
  });
});
