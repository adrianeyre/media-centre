import {
  BLUETOOTH_PATH,
  BLUETOOTH_SCAN_PATH,
  bluetoothDeviceNamePath,
  bluetoothDeviceRoomPath,
  NETWORK_PATH,
  NETWORK_ROOMS_PATH,
  NETWORK_SCAN_PATH,
  networkDeviceNamePath,
  networkDevicePortsPath,
  networkDeviceRoomPath,
  type BluetoothScan,
  type NetworkDeviceNameRequest,
  type NetworkDeviceRoomRequest,
  type NetworkScan,
  type RoomDevice,
  type RoomDevices,
} from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/** The devices on the home network, and the Bluetooth devices near the Hub, as it finds them, for the Network tab. */
export interface NetworkApi {
  /** The last scan, or the one under way, with how far it has got. */
  readonly read: () => Promise<NetworkScan>;
  /** Starts a scan of the home network, unless one is under way. */
  readonly scan: () => Promise<NetworkScan>;
  /** Starts checking every port of the device found at `address`, remembering those open. */
  readonly checkAllPorts: (address: string) => Promise<NetworkScan>;
  /** Names the device found at `address`, or with null forgets its name. */
  readonly setName: (address: string, name: string | null) => Promise<NetworkScan>;
  /** Puts the device found at `address` in a Room, or in "No room" given null. An Appliance is moved, as in Settings. */
  readonly setRoom: (address: string, roomId: number | null) => Promise<NetworkScan>;
  /** The last Bluetooth scan, or the one under way, with what it has heard. */
  readonly readBluetooth: () => Promise<BluetoothScan>;
  /** Starts listening for Bluetooth devices, unless the Hub is. */
  readonly scanBluetooth: () => Promise<BluetoothScan>;
  /** Names the Bluetooth device heard at `address`, or with null forgets its name. */
  readonly setBluetoothName: (address: string, name: string | null) => Promise<BluetoothScan>;
  /** Puts the Bluetooth device heard at `address` in a Room, or in "No room" given null. */
  readonly setBluetoothRoom: (address: string, roomId: number | null) => Promise<BluetoothScan>;
  /** Every device put in a Room, but Appliances, for the Rooms tab. */
  readonly roomDevices: () => Promise<readonly RoomDevice[]>;
}

/** Talks to the Hub about the home network. A refusal fails with a `HubRequestFailed` giving the Hub's reason. */
export const createNetworkApi = (fetchFn: typeof fetch = fetch): NetworkApi => {
  const request = createHubRequest(fetchFn);
  const answer = async <T>(response: Promise<Response>): Promise<T> => (await (await response).json()) as T;
  const naming = (name: string | null): NetworkDeviceNameRequest => ({ name });
  const rooming = (roomId: number | null): NetworkDeviceRoomRequest => ({ roomId });

  return {
    read: () => answer(request("GET", NETWORK_PATH)),
    scan: () => answer(request("POST", NETWORK_SCAN_PATH)),
    checkAllPorts: (address) => answer(request("POST", networkDevicePortsPath(address))),
    setName: (address, name) => answer(request("PUT", networkDeviceNamePath(address), naming(name))),
    setRoom: (address, roomId) => answer(request("PUT", networkDeviceRoomPath(address), rooming(roomId))),
    readBluetooth: () => answer(request("GET", BLUETOOTH_PATH)),
    scanBluetooth: () => answer(request("POST", BLUETOOTH_SCAN_PATH)),
    setBluetoothName: (address, name) => answer(request("PUT", bluetoothDeviceNamePath(address), naming(name))),
    setBluetoothRoom: (address, roomId) => answer(request("PUT", bluetoothDeviceRoomPath(address), rooming(roomId))),
    roomDevices: async () => (await answer<RoomDevices>(request("GET", NETWORK_ROOMS_PATH))).devices,
  };
};
