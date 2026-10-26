import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLUETOOTH_PATH,
  BLUETOOTH_SCAN_PATH,
  bluetoothDeviceNamePath,
  bluetoothDeviceRoomPath,
  NETWORK_ROOMS_PATH,
  type BluetoothScan,
  type RoomDevices,
} from "@media-centre/shared";

import {
  companyNamed,
  serviceNamed,
  watchLineIn,
  windowsWatch,
  type BluetoothScannerOptions,
  type BluetoothWatch,
  type WatchLine,
} from "./bluetooth.ts";
import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";
import { roomStore } from "./rooms.ts";

const FAKE_HELPER = join(import.meta.dirname, "fakes", "bluetooth", "fake-ble-watch.ts");

const advert = (fields: readonly string[]): string => ["ADVERT", ...fields].join("\t");

describe("a line the Bluetooth helper writes", () => {
  it("reads an advertisement: its address, whether it is made up, its signal, name, companies and services", () => {
    expect(
      watchLineIn(
        advert([
          "a4c1380a1b2c",
          "0",
          "-58",
          Buffer.from("Lepro LampUX").toString("hex"),
          "0211,07d0",
          "0000fff0-0000-1000-8000-00805f9b34fb",
        ]),
      ),
    ).toEqual({
      kind: "advert",
      advert: {
        address: "a4:c1:38:0a:1b:2c",
        randomAddress: false,
        signal: -58,
        name: "Lepro LampUX",
        companies: ["0211", "07d0"],
        uuids: ["0000fff0-0000-1000-8000-00805f9b34fb"],
      },
    });
    expect(watchLineIn(`${advert(["6A1F2E3D4C5B", "1", "-88", "", "004c", ""])}\r`)).toMatchObject({
      advert: { address: "6a:1f:2e:3d:4c:5b", randomAddress: true, name: null, companies: ["004c"], uuids: [] },
    });
  });

  it("reads Windows stopping it, and its end, and nothing else", () => {
    expect(watchLineIn("STOPPED\tRadioNotAvailable")).toEqual({ kind: "stopped", why: "RadioNotAvailable" });
    expect(watchLineIn("DONE")).toEqual({ kind: "done" });
    expect(watchLineIn("Microsoft (R) Visual C# Compiler")).toBeUndefined();
    expect(watchLineIn(advert(["not-an-address", "0", "-50", "", "", ""]))).toBeUndefined();
  });
});

describe("what a Bluetooth device names", () => {
  it("is read by the Bluetooth SIG's assigned numbers", () => {
    expect(companyNamed("004c")).toBe("Apple, Inc.");
    expect(companyNamed("07d0")).toBe("Hangzhou Tuya Information Technology Co., Ltd");
    expect(companyNamed("ffff")).toBeNull();
    expect(serviceNamed("0000180f-0000-1000-8000-00805f9b34fb")).toEqual({
      uuid: "0000180f-0000-1000-8000-00805f9b34fb",
      name: "Battery",
    });
    expect(serviceNamed("6e400001-b5a3-f393-e0a9-e50e24dcca9e")).toEqual({
      uuid: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      name: null,
    });
  });
});

describe("the fake Bluetooth helper", () => {
  it("writes the lines the real one does, as the Hub runs it in its place", async () => {
    const lines: WatchLine[] = [];
    await windowsWatch({ helper: FAKE_HELPER })(1, (line) => lines.push(line));
    expect(lines.map((line) => (line.kind === "advert" ? line.advert.address : line.kind))).toEqual([
      "a4:c1:38:0a:1b:2c",
      "6a:1f:2e:3d:4c:5b",
      "f8:2a:53:79:ae:c7",
      "done",
    ]);
  });
});

let database: DatabaseSync;
let hub: Server | undefined;
let base: string;
let logged: string[];

const startHub = async (bluetooth: BluetoothScannerOptions, file = ":memory:"): Promise<void> => {
  database = openDatabase(file);
  const started = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database, bluetooth });
  hub = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((started.address() as AddressInfo).port)}`;
};

/** A watch that writes these lines, then ends once `release` is called, if it is given one. */
const watching =
  (lines: readonly string[], held?: Promise<void>): BluetoothWatch =>
  async (_seconds, heard) => {
    for (const line of lines) {
      const read = watchLineIn(line);
      if (read !== undefined) heard(read);
    }
    await held;
  };

const scanEnded = async (): Promise<BluetoothScan> => {
  for (;;) {
    const scan = (await (await fetch(`${base}${BLUETOOTH_PATH}`)).json()) as BluetoothScan;
    if (!scan.scanning) return scan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (hub === undefined) return;
  const stopping = hub;
  hub = undefined;
  await new Promise((resolve) => stopping.close(resolve));
  database.close();
});

describe("the Hub's Bluetooth scan", () => {
  it("lists each device heard once, with its strongest signal, maker and services, possible lights first", async () => {
    await startHub({
      watch: watching([
        advert(["6a1f2e3d4c5b", "1", "-71", "", "004c", ""]),
        advert(["f82a5379aec7", "0", "-82", Buffer.from("net").toString("hex"), "06a8", ""]),
        advert(["a4c1380a1b2c", "0", "-80", "", "0211", ""]),
        advert([
          "a4c1380a1b2c",
          "0",
          "-58",
          Buffer.from("Lepro LampUX").toString("hex"),
          "",
          "0000180f-0000-1000-8000-00805f9b34fb",
        ]),
        // A maker's address naming no company, whose maker is the IEEE's.
        advert(["0090a96a376a", "0", "-65", "", "", ""]),
      ]),
    });

    const started = await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    expect(started.status).toBe(202);
    const scan = await scanEnded();

    expect(scan).toMatchObject({ available: true, problem: null, scanning: false, seconds: 20 });
    expect(scan.devices.map(({ address }) => address)).toEqual([
      "a4:c1:38:0a:1b:2c",
      "00:90:a9:6a:37:6a",
      "6a:1f:2e:3d:4c:5b",
      "f8:2a:53:79:ae:c7",
    ]);
    const [lamp, drive, phone, aircon] = scan.devices;
    expect(lamp).toMatchObject({
      name: null,
      advertisedName: "Lepro LampUX",
      maker: "Telink Semiconductor Co. Ltd",
      signal: -58,
      maybeLight: true,
      randomAddress: false,
      services: [{ uuid: "0000180f-0000-1000-8000-00805f9b34fb", name: "Battery" }],
    });
    expect(drive).toMatchObject({ maker: "WESTERN DIGITAL", maybeLight: false });
    // A made-up address says nothing of its maker, but the company it names does.
    expect(phone).toMatchObject({ randomAddress: true, maker: "Apple, Inc." });
    expect(aircon).toMatchObject({ advertisedName: "net", maker: "GD Midea Air-Conditioning Equipment Co., Ltd." });
    expect(logged).toContain("Heard 4 Bluetooth devices");
  });

  it("names a device heard, by its Bluetooth address, keeping its name for the next scan", async () => {
    await startHub({ watch: watching([advert(["a4c1380a1b2c", "0", "-58", "", "", ""])]) });
    await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    await scanEnded();

    const named = await fetch(`${base}${bluetoothDeviceNamePath("a4:c1:38:0a:1b:2c")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kitchen bulb" }),
    });
    expect(named.status).toBe(200);
    expect(((await named.json()) as BluetoothScan).devices[0]?.name).toBe("Kitchen bulb");
    expect(database.prepare("SELECT key, name FROM network_device").all()).toEqual([
      { key: "bluetooth:a4:c1:38:0a:1b:2c", name: "Kitchen bulb" },
    ]);

    await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    expect((await scanEnded()).devices[0]?.name).toBe("Kitchen bulb");

    const unheard = await fetch(`${base}${bluetoothDeviceNamePath("00:11:22:33:44:55")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nothing" }),
    });
    expect(unheard.status).toBe(404);
  });

  it("puts a device heard in a Room, which the Rooms tab lists it in", async () => {
    await startHub({
      watch: watching([advert(["a4c1380a1b2c", "0", "-58", Buffer.from("Lepro LampUX").toString("hex"), "0211", ""])]),
    });
    const kitchen = roomStore(database).add("Kitchen");
    await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    await scanEnded();

    const put = await fetch(`${base}${bluetoothDeviceRoomPath("a4:c1:38:0a:1b:2c")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: kitchen.id }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as BluetoothScan).devices[0]?.room).toEqual({ id: kitchen.id, name: "Kitchen" });
    expect(await (await fetch(`${base}${NETWORK_ROOMS_PATH}`)).json()).toEqual({
      devices: [
        {
          key: "bluetooth:a4:c1:38:0a:1b:2c",
          kind: "bluetooth",
          roomId: kitchen.id,
          title: "Lepro LampUX",
          address: "a4:c1:38:0a:1b:2c",
          maker: "Telink Semiconductor Co. Ltd",
        },
      ],
    } satisfies RoomDevices);
  });

  it("listens once at a time, showing what it has heard so far", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await startHub({ watch: watching([advert(["a4c1380a1b2c", "0", "-58", "", "", ""])], held) });

    await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    const again = (await (await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" })).json()) as BluetoothScan;
    expect(again).toMatchObject({ scanning: true, devices: [{ address: "a4:c1:38:0a:1b:2c" }] });
    release();
    await scanEnded();
    expect(logged.filter((line) => line.startsWith("Listening for Bluetooth devices"))).toHaveLength(1);
  });

  it("says why Windows stopped listening, as when Bluetooth is switched off", async () => {
    await startHub({ watch: watching(["STOPPED\tRadioNotAvailable"]) });
    await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    expect((await scanEnded()).problem).toBe("The Hub's PC has no Bluetooth, or it is switched off.");
  });

  it("keeps what the last scan heard through a restart, so it is shown without listening again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "media-centre-bluetooth-"));
    const file = join(directory, "hub.sqlite");
    try {
      await startHub(
        {
          watch: watching([
            advert(["a4c1380a1b2c", "0", "-58", Buffer.from("Lepro LampUX").toString("hex"), "0211", ""]),
          ]),
        },
        file,
      );
      await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
      const heard = await scanEnded();

      const stopping = hub;
      hub = undefined;
      await new Promise((resolve) => stopping?.close(resolve));
      database.close();
      await startHub({ watch: watching([]) }, file);

      const kept = (await (await fetch(`${base}${BLUETOOTH_PATH}`)).json()) as BluetoothScan;
      expect(kept.finishedAt).toBe(heard.finishedAt);
      expect(kept.devices).toEqual(heard.devices);
      expect(kept.devices[0]).toMatchObject({ advertisedName: "Lepro LampUX", maybeLight: true });
    } finally {
      const stopping = hub;
      hub = undefined;
      await new Promise((resolve) => stopping?.close(resolve));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says why it can't listen where it has no way to", async () => {
    await startHub({});
    const scan = (await (await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" })).json()) as BluetoothScan;
    expect(scan).toMatchObject({
      available: false,
      scanning: false,
      problem: "The Hub can listen for Bluetooth devices only when it runs on Windows, for now.",
    });
  });

  it("listens through the fake helper, run in place of the real one", async () => {
    await startHub({ watch: windowsWatch({ helper: FAKE_HELPER }), seconds: 1 });
    await fetch(`${base}${BLUETOOTH_SCAN_PATH}`, { method: "POST" });
    const scan = await scanEnded();
    expect(scan.devices[0]).toMatchObject({ advertisedName: "Lepro LampUX", maybeLight: true });
    expect(scan.devices).toHaveLength(3);
  });
});
