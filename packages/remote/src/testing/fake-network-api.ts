import type {
  BluetoothDevice,
  BluetoothScan,
  DeviceRoom,
  NetworkDevice,
  NetworkScan,
  Room,
  RoomDevice,
} from "@media-centre/shared";

import { HubRequestFailed } from "../hub-request.ts";
import type { NetworkApi } from "../network-api.ts";

/** A device as the Hub would find it, with what isn't given made up. */
export const aNetworkDevice = (device: Partial<NetworkDevice> & Pick<NetworkDevice, "address">): NetworkDevice => ({
  name: null,
  room: null,
  macAddress: "f8:2a:53:79:ae:c6",
  vendor: "GD Midea Air-Conditioning Equipment Co.,Ltd.",
  privateMacAddress: false,
  hostname: null,
  isHub: false,
  appliance: null,
  openPorts: [],
  responseMs: 12,
  portCheck: { kind: "common", ports: 46, remembered: 0 },
  ...device,
});

/** A Bluetooth device as the Hub would hear it, with what isn't given made up. */
export const aBluetoothDevice = (
  device: Partial<BluetoothDevice> & Pick<BluetoothDevice, "address">,
): BluetoothDevice => ({
  randomAddress: false,
  name: null,
  room: null,
  advertisedName: null,
  maker: null,
  signal: -70,
  services: [],
  maybeLight: false,
  lastHeardAt: "2026-10-24T15:00:00.000Z",
  ...device,
});

export interface FakeNetworkApi extends NetworkApi {
  /** Has the Hub answer with this from now on, as a scan under way, or ended, would leave it. */
  readonly set: (scan: NetworkScan) => void;
  readonly setBluetooth: (scan: BluetoothScan) => void;
  /** Makes the next request fail with `message`, as a Hub that can't be reached, or refusing it, would. */
  readonly failNext: (message: string) => void;
  /** How many scans, and checks of every port, by address, were asked for. */
  readonly scans: () => number;
  readonly bluetoothScans: () => number;
  readonly allPortChecks: () => readonly string[];
  /** Each Room asked for a device, by its address, as asked: null for "No room". */
  readonly roomsAsked: () => readonly (readonly [string, number | null])[];
}

/** No scan yet, as a Hub just started has. */
export const NO_SCAN: NetworkScan = {
  subnet: null,
  scanning: false,
  checked: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  devices: [],
};

/** No Bluetooth scan yet, on a Hub that can listen. */
export const NO_BLUETOOTH_SCAN: BluetoothScan = {
  available: true,
  problem: null,
  scanning: false,
  seconds: 20,
  startedAt: null,
  finishedAt: null,
  devices: [],
};

/**
 * The Hub's network and Bluetooth scans kept in memory, standing in for the
 * Hub: a scan asked for starts, and stays under way until the test `set`s
 * what it found. It names whatever it is asked to: the rules are the Hub's.
 */
export const fakeNetworkApi = (
  initial: NetworkScan = NO_SCAN,
  initialBluetooth: BluetoothScan = NO_BLUETOOTH_SCAN,
  /** The Hub's Rooms, which a device put in one is said to be in, as the fake Rooms API has them. */
  roomsNow: () => readonly Room[] = () => [],
  /** The Echos and Ring devices put in a Room on their own tabs, which the Hub lists with the rest. */
  otherRoomDevices: readonly RoomDevice[] = [],
): FakeNetworkApi => {
  let current = initial;
  let bluetooth = initialBluetooth;
  let failure: string | undefined;
  let scans = 0;
  let bluetoothScans = 0;
  const checks: string[] = [];
  const asked: [string, number | null][] = [];
  const roomNamed = (roomId: number | null): DeviceRoom | null => {
    const room = roomsNow().find(({ id }) => id === roomId);
    return room === undefined ? null : { id: room.id, name: room.name };
  };

  const answer = <T>(value: () => T): Promise<T> => {
    if (failure !== undefined) {
      const message = failure;
      failure = undefined;
      return Promise.reject(new HubRequestFailed(message));
    }
    return Promise.resolve(value());
  };

  return {
    set: (scan) => {
      current = scan;
    },
    setBluetooth: (scan) => {
      bluetooth = scan;
    },
    failNext: (message) => {
      failure = message;
    },
    scans: () => scans,
    bluetoothScans: () => bluetoothScans,
    allPortChecks: () => checks,
    roomsAsked: () => asked,
    read: () => answer(() => current),
    scan: () => {
      scans += 1;
      if (!current.scanning) {
        current = { ...current, subnet: "192.168.1.0/24", scanning: true, checked: 0, total: 254 };
      }
      return answer(() => current);
    },
    checkAllPorts: (address) => {
      checks.push(address);
      current = {
        ...current,
        devices: current.devices.map((device) =>
          device.address === address
            ? { ...device, portCheck: { kind: "all", checked: 0, total: 65_535, done: false } }
            : device,
        ),
      };
      return answer(() => current);
    },
    setName: (address, name) =>
      answer(() => {
        current = {
          ...current,
          devices: current.devices.map((device) => (device.address === address ? { ...device, name } : device)),
        };
        return current;
      }),
    setRoom: (address, roomId) =>
      answer(() => {
        asked.push([address, roomId]);
        current = {
          ...current,
          devices: current.devices.map((device) =>
            device.address === address ? { ...device, room: roomNamed(roomId) } : device,
          ),
        };
        return current;
      }),
    readBluetooth: () => answer(() => bluetooth),
    scanBluetooth: () => {
      bluetoothScans += 1;
      if (!bluetooth.scanning) bluetooth = { ...bluetooth, scanning: true, problem: null };
      return answer(() => bluetooth);
    },
    setBluetoothName: (address, name) =>
      answer(() => {
        bluetooth = {
          ...bluetooth,
          devices: bluetooth.devices.map((device) => (device.address === address ? { ...device, name } : device)),
        };
        return bluetooth;
      }),
    setBluetoothRoom: (address, roomId) =>
      answer(() => {
        asked.push([address, roomId]);
        bluetooth = {
          ...bluetooth,
          devices: bluetooth.devices.map((device) =>
            device.address === address ? { ...device, room: roomNamed(roomId) } : device,
          ),
        };
        return bluetooth;
      }),
    roomDevices: () =>
      answer((): RoomDevice[] => [
        ...current.devices
          .filter((device) => device.room !== null && device.appliance === null)
          .map((device) => ({
            key: `mac:${device.macAddress ?? device.address}`,
            kind: "network" as const,
            roomId: device.room?.id ?? 0,
            title: device.name ?? device.hostname ?? device.vendor ?? "Unknown device",
            address: device.address,
            maker: device.vendor,
          })),
        ...bluetooth.devices
          .filter((device) => device.room !== null)
          .map((device) => ({
            key: `bluetooth:${device.address}`,
            kind: "bluetooth" as const,
            roomId: device.room?.id ?? 0,
            title: device.name ?? device.advertisedName ?? device.maker ?? "Unnamed Bluetooth device",
            address: device.address,
            maker: device.maker,
          })),
        ...otherRoomDevices,
      ]),
  };
};
