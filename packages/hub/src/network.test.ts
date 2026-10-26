import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NETWORK_PATH,
  NETWORK_ROOMS_PATH,
  NETWORK_SCAN_PATH,
  networkDeviceNamePath,
  networkDevicePortsPath,
  networkDeviceRoomPath,
  type NetworkScan,
  type RoomDevices,
} from "@media-centre/shared";

import { applianceStore } from "./appliances.ts";
import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";
import {
  isPrivateMac,
  neighboursIn,
  normaliseMac,
  probePort,
  vendorOf,
  type NetworkScannerOptions,
  type ProbePort,
} from "./network.ts";
import { roomStore } from "./rooms.ts";

describe("an ARP table", () => {
  it("is read as Windows' arp -a lists it, leaving out broadcast and multicast", () => {
    const table = [
      "Interface: 192.168.1.250 --- 0xa",
      "  Internet Address      Physical Address      Type",
      "  192.168.1.50          00-90-a9-6a-37-6a     dynamic",
      "  192.168.1.255         ff-ff-ff-ff-ff-ff     static",
      "  224.0.0.22            01-00-5e-00-00-16     static",
    ].join("\r\n");
    expect([...neighboursIn(table)]).toEqual([["192.168.1.50", "00:90:a9:6a:37:6a"]]);
  });

  it("is read as Linux's /proc/net/arp lists it, leaving out an address with no MAC address yet", () => {
    const table = [
      "IP address       HW type     Flags       HW address            Mask     Device",
      "192.168.1.254    0x1         0x2         04:70:56:a5:ea:4c     *        eth0",
      "192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0",
    ].join("\n");
    expect([...neighboursIn(table)]).toEqual([["192.168.1.254", "04:70:56:a5:ea:4c"]]);
  });

  it("is read as macOS's arp -a lists it, with each part's leading zero left off", () => {
    expect([...neighboursIn("? (192.168.1.254) at 4:70:56:a5:ea:4c on en0 ifscope [ethernet]")]).toEqual([
      ["192.168.1.254", "04:70:56:a5:ea:4c"],
    ]);
  });
});

describe("a MAC address", () => {
  it("is written lower case, with colons", () => {
    expect(normaliseMac("4-70-56-A5-EA-4C")).toBe("04:70:56:a5:ea:4c");
  });

  it("says who made the device, from the IEEE's registry", () => {
    expect(vendorOf("f8:2a:53:79:ae:c6")).toBe("GD Midea Air-Conditioning Equipment Co.,Ltd.");
    expect(vendorOf("00:00:5e:ff:ff:ff")).not.toBeNull();
  });

  it("says nothing of who made a device that made its own up, as a phone does for each Wi-Fi network", () => {
    expect(isPrivateMac("3a:1b:2c:3d:4e:5f")).toBe(true);
    expect(isPrivateMac("38:22:e2:b7:f2:e8")).toBe(false);
    expect(vendorOf("3a:1b:2c:3d:4e:5f")).toBeNull();
  });
});

describe("trying a port", () => {
  it("tells one that accepts from one that refuses", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await probePort("127.0.0.1", port, 1_000)).toMatchObject({ answer: "open" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await probePort("127.0.0.1", port, 1_000)).toMatchObject({ answer: "closed" });
  });
});

/** A home network: each address's open ports, and those that refuse; any other address says nothing. */
const HOME: Readonly<Record<string, { open: readonly number[] }>> = {
  "192.168.1.5": { open: [41_080] },
  "192.168.1.50": { open: [22, 80, 445] },
  "192.168.1.74": { open: [1883] },
  "192.168.1.192": { open: [8008, 8009, 45_678] },
};

const homeProbe: ProbePort = (host, port) => {
  const device = HOME[host];
  if (device === undefined) return Promise.resolve({ answer: "silent", ms: 800 });
  return Promise.resolve({ answer: device.open.includes(port) ? "open" : "closed", ms: 3 });
};

let database: DatabaseSync;
let hub: Server | undefined;
let base: string;
let logged: string[];

const startHub = async (network: NetworkScannerOptions = {}, file = ":memory:"): Promise<void> => {
  database = openDatabase(file);
  const started = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    networkInterfaces: () => ({
      eth0: [
        {
          address: "192.168.1.5",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "02:00:00:00:00:01",
          internal: false,
          cidr: "192.168.1.5/24",
        },
      ],
    }),
    network: {
      probe: homeProbe,
      // A Hive hub, which answers only to the Hub's ARP.
      neighbours: () =>
        Promise.resolve(
          new Map([
            ["192.168.1.50", "00:90:a9:6a:37:6a"],
            ["192.168.1.74", "f8:2a:53:79:ae:c6"],
            ["192.168.1.103", "00:1c:2b:54:50:05"],
            ["10.0.0.1", "00:11:22:33:44:55"],
          ]),
        ),
      lookUpName: (address) => Promise.resolve(address === "192.168.1.50" ? "nas.home" : null),
      allPorts: { from: 45_670, to: 45_689 },
      ...network,
    },
  });
  hub = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((started.address() as AddressInfo).port)}`;
};

/** Asks the Hub how its scan is getting on until it has ended. */
const scanEnded = async (): Promise<NetworkScan> => {
  for (;;) {
    const scan = (await (await fetch(`${base}${NETWORK_PATH}`)).json()) as NetworkScan;
    if (!scan.scanning && scan.devices.every(({ portCheck }) => portCheck.kind === "common" || portCheck.done)) {
      return scan;
    }
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

describe("the Hub's network scan", () => {
  it("has found nothing before it is first asked to scan", async () => {
    await startHub();
    expect(await (await fetch(`${base}${NETWORK_PATH}`)).json()).toEqual({
      subnet: null,
      scanning: false,
      checked: 0,
      total: 0,
      startedAt: null,
      finishedAt: null,
      devices: [],
    });
  });

  it("finds every device on the Hub's /24, with its MAC address, maker, name, Appliance and open common ports", async () => {
    await startHub();
    const rooms = roomStore(database);
    const lounge = rooms.add("Lounge");
    applianceStore(database).add(
      {
        kind: "air-conditioner",
        name: "Aircon",
        roomId: lounge.id,
        address: "192.168.1.74",
        model: "Midea",
        macAddress: "",
      },
      "{}",
    );

    const started = await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ subnet: "192.168.1.0/24", scanning: true, total: 254 });
    const scan = await scanEnded();

    expect(scan).toMatchObject({ subnet: "192.168.1.0/24", scanning: false, checked: 254, total: 254 });
    expect(scan.finishedAt).not.toBeNull();
    expect(scan.devices.map(({ address }) => address)).toEqual([
      "192.168.1.5",
      "192.168.1.50",
      "192.168.1.74",
      "192.168.1.103",
      "192.168.1.192",
    ]);
    const [own, nas, aircon, hive, tv] = scan.devices;
    expect(own).toMatchObject({
      isHub: true,
      macAddress: "02:00:00:00:00:01",
      privateMacAddress: true,
      vendor: null,
      openPorts: [{ port: 41_080, service: "media-centre Hub" }],
    });
    expect(nas).toEqual({
      address: "192.168.1.50",
      name: null,
      room: null,
      macAddress: "00:90:a9:6a:37:6a",
      vendor: "WESTERN DIGITAL",
      privateMacAddress: false,
      hostname: "nas.home",
      isHub: false,
      appliance: null,
      openPorts: [
        { port: 22, service: "SSH" },
        { port: 80, service: "HTTP" },
        { port: 445, service: "SMB file sharing" },
      ],
      responseMs: 3,
      portCheck: { kind: "common", ports: 46, remembered: 0 },
    });
    expect(aircon).toMatchObject({
      appliance: { kind: "air-conditioner", name: "Aircon", room: "Lounge" },
      room: { id: lounge.id, name: "Lounge" },
      openPorts: [{ port: 1883, service: "MQTT" }],
    });
    // Found by the Hub's ARP alone, as it accepts and refuses nothing.
    expect(hive).toMatchObject({ vendor: "Hive", responseMs: null, openPorts: [] });
    // Only the common ports, not 45678, until every port is checked.
    expect(tv?.openPorts.map(({ port }) => port)).toEqual([8008, 8009]);
    expect(logged).toContain("Scanned the network, 192.168.1.0/24, and found 5 devices");
  });

  it("checks every port of one device on asking, finding one no common port is", async () => {
    await startHub();
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    await scanEnded();

    const checking = await fetch(`${base}${networkDevicePortsPath("192.168.1.192")}`, { method: "POST" });
    expect(checking.status).toBe(202);
    const scan = await scanEnded();

    const tv = scan.devices.find(({ address }) => address === "192.168.1.192");
    expect(tv?.portCheck).toEqual({ kind: "all", checked: 20, total: 20, done: true });
    expect(tv?.openPorts).toEqual([
      { port: 8008, service: "Google Cast" },
      { port: 8009, service: "Google Cast" },
      { port: 45_678, service: null },
    ]);
  });

  it("remembers the ports checking every port found open, and checks them each scan after", async () => {
    await startHub();
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    await scanEnded();
    await fetch(`${base}${networkDevicePortsPath("192.168.1.192")}`, { method: "POST" });
    await scanEnded();

    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    const tv = (await scanEnded()).devices.find(({ address }) => address === "192.168.1.192");
    expect(tv?.openPorts.map(({ port }) => port)).toEqual([8008, 8009, 45_678]);
    expect(tv?.portCheck).toEqual({ kind: "common", ports: 46, remembered: 1 });
  });

  it("names a device, by its MAC address, or its IP address where it has none, and forgets its name", async () => {
    await startHub();
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    await scanEnded();
    const name = (address: string, value: string | null) =>
      fetch(`${base}${networkDeviceNamePath(address)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: value }),
      });

    const named = await name("192.168.1.50", "  Media NAS ");
    expect(named.status).toBe(200);
    expect(((await named.json()) as NetworkScan).devices.find(({ address }) => address === "192.168.1.50")?.name).toBe(
      "Media NAS",
    );
    // The TV has no MAC address in the Hub's ARP table, so is named by its IP address.
    await name("192.168.1.192", "Lounge TV");
    expect(database.prepare("SELECT key, name FROM network_device ORDER BY key").all()).toEqual([
      { key: "ip:192.168.1.192", name: "Lounge TV" },
      { key: "mac:00:90:a9:6a:37:6a", name: "Media NAS" },
    ]);

    // Kept through another scan, and forgotten when emptied.
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    expect((await scanEnded()).devices.find(({ address }) => address === "192.168.1.50")?.name).toBe("Media NAS");
    await name("192.168.1.50", " ");
    expect((await scanEnded()).devices.find(({ address }) => address === "192.168.1.50")?.name).toBeNull();

    const tooLong = await name("192.168.1.50", "x".repeat(41));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "A device's name is at most 40 characters." });
    expect((await name("192.168.1.99", "Nothing")).status).toBe(404);
    expect((await name("192.168.1.50", 42 as unknown as string)).status).toBe(400);
  });

  it("puts a device in a Room, by its MAC address, which the Rooms tab lists it in between scans, and in No room once the Room is deleted", async () => {
    await startHub();
    const study = roomStore(database).add("Study");
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    await scanEnded();
    const put = (address: string, roomId: unknown) =>
      fetch(`${base}${networkDeviceRoomPath(address)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      });

    const answer = await put("192.168.1.50", study.id);
    expect(answer.status).toBe(200);
    const nas = ((await answer.json()) as NetworkScan).devices.find(({ address }) => address === "192.168.1.50");
    expect(nas?.room).toEqual({ id: study.id, name: "Study" });

    // Listed for the Rooms tab, with what the scan saw it as.
    expect(await (await fetch(`${base}${NETWORK_ROOMS_PATH}`)).json()).toEqual({
      devices: [
        {
          key: "mac:00:90:a9:6a:37:6a",
          kind: "network",
          roomId: study.id,
          title: "nas.home",
          address: "192.168.1.50",
          maker: "WESTERN DIGITAL",
        },
      ],
    } satisfies RoomDevices);

    // Kept through another scan; then in No room once the Room is deleted.
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    expect((await scanEnded()).devices.find(({ address }) => address === "192.168.1.50")?.room?.name).toBe("Study");
    roomStore(database).remove(study.id);
    expect((await scanEnded()).devices.find(({ address }) => address === "192.168.1.50")?.room).toBeNull();
    expect(((await (await fetch(`${base}${NETWORK_ROOMS_PATH}`)).json()) as RoomDevices).devices).toEqual([]);

    // A Room deleted since the Remote showed it, an address not found, and what isn't a Room, are refused.
    const deleted = await put("192.168.1.50", study.id);
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toEqual({ error: "That Room has been deleted. Choose another." });
    expect((await put("192.168.1.99", null)).status).toBe(404);
    expect((await put("192.168.1.50", "Study")).status).toBe(400);
  });

  it("moves a device that is an Appliance, as Settings does, refusing a name taken in that Room", async () => {
    await startHub();
    const rooms = roomStore(database);
    const lounge = rooms.add("Lounge");
    const bedroom = rooms.add("Bedroom");
    const store = applianceStore(database);
    const aircon = store.add(
      {
        kind: "air-conditioner",
        name: "Aircon",
        roomId: lounge.id,
        address: "192.168.1.74",
        model: "Midea",
        macAddress: "",
      },
      "{}",
    );
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    await scanEnded();
    const put = (roomId: number | null) =>
      fetch(`${base}${networkDeviceRoomPath("192.168.1.74")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      });

    const moved = (await (await put(bedroom.id)).json()) as NetworkScan;
    expect(moved.devices.find(({ address }) => address === "192.168.1.74")?.room).toEqual({
      id: bedroom.id,
      name: "Bedroom",
    });
    expect(store.get(aircon.id).roomId).toBe(bedroom.id);
    // Kept with the Appliance, not the device, so not listed for the Rooms tab twice.
    expect(((await (await fetch(`${base}${NETWORK_ROOMS_PATH}`)).json()) as RoomDevices).devices).toEqual([]);

    store.add(
      {
        kind: "air-conditioner",
        name: "Aircon",
        roomId: lounge.id,
        address: "192.168.1.75",
        model: "Midea",
        macAddress: "",
      },
      "{}",
    );
    const taken = await put(lounge.id);
    expect(taken.status).toBe(409);
    expect(store.get(aircon.id).roomId).toBe(bedroom.id);
  });

  it("refuses to check the ports of an address it didn't find, or of what isn't an address", async () => {
    await startHub();
    const notFound = await fetch(`${base}${networkDevicePortsPath("192.168.1.99")}`, { method: "POST" });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "No device was found at 192.168.1.99. Scan the network again." });
    const notAnAddress = await fetch(`${base}${networkDevicePortsPath("nas.home")}`, { method: "POST" });
    expect(notAnAddress.status).toBe(400);
  });

  it("starts one scan at a time, leaving one under way as it is", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await startHub({ probe: async (host, port, timeoutMs) => (await held, homeProbe(host, port, timeoutMs)) });

    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    const again = (await (await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" })).json()) as NetworkScan;
    expect(again).toMatchObject({ scanning: true, checked: 0 });
    release();
    expect((await scanEnded()).devices).toHaveLength(5);
    expect(logged.filter((line) => line.startsWith("Scanning the network"))).toHaveLength(1);
  });

  it("checks and names each Driver's own ports, as only the Driver knows its Appliances'", async () => {
    await startHub({ services: new Map([[45_678, "A Driver's Appliance"]]) });
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    const scan = await scanEnded();
    const tv = scan.devices.find(({ address }) => address === "192.168.1.192");
    expect(tv?.portCheck).toEqual({ kind: "common", ports: 43, remembered: 0 });
    expect(tv?.openPorts).toContainEqual({ port: 45_678, service: "A Driver's Appliance" });
  });

  it("keeps the last scan through a restart, so it is shown without scanning again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "media-centre-network-"));
    const file = join(directory, "hub.sqlite");
    try {
      await startHub({}, file);
      await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
      const scanned = await scanEnded();

      const stopping = hub;
      hub = undefined;
      await new Promise((resolve) => stopping?.close(resolve));
      database.close();
      await startHub({ probe: () => Promise.reject(new Error("no scan after a restart")) }, file);

      const kept = (await (await fetch(`${base}${NETWORK_PATH}`)).json()) as NetworkScan;
      expect(kept).toMatchObject({ subnet: "192.168.1.0/24", scanning: false, finishedAt: scanned.finishedAt });
      expect(kept.devices.map(({ address, openPorts }) => [address, openPorts.length])).toEqual(
        scanned.devices.map(({ address, openPorts }) => [address, openPorts.length]),
      );
    } finally {
      const stopping = hub;
      hub = undefined;
      await new Promise((resolve) => stopping?.close(resolve));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("scans only the addresses it is given, as against the fakes", async () => {
    await startHub({ targets: ["192.168.1.50", "192.168.1.60"] });
    await fetch(`${base}${NETWORK_SCAN_PATH}`, { method: "POST" });
    const scan = await scanEnded();
    expect(scan).toMatchObject({ subnet: "192.168.1.50, 192.168.1.60", total: 2 });
    expect(scan.devices.map(({ address }) => address)).toEqual(["192.168.1.50"]);
  });

  it("refuses methods it doesn't take", async () => {
    await startHub();
    expect((await fetch(`${base}${NETWORK_PATH}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}${NETWORK_SCAN_PATH}`)).status).toBe(405);
  });
});
