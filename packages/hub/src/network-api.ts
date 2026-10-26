import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import { NETWORK_PATH, NETWORK_ROOMS_PATH, NETWORK_SCAN_PATH, type RoomDevices } from "@media-centre/shared";

import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import type { NetworkScanner } from "./network.ts";
import { ApplianceRefusal } from "./appliances.ts";
import { REFUSAL_STATUS } from "./appliances-api.ts";
import { NetworkDeviceNameRefusal, NetworkDeviceRoomRefusal, type NetworkDeviceStore } from "./network-devices.ts";

const DEVICE_PORTS = new RegExp(`^${NETWORK_PATH}/devices/([^/]+)/ports$`);
const DEVICE_NAME = new RegExp(`^${NETWORK_PATH}/devices/([^/]+)/name$`);
const DEVICE_ROOM = new RegExp(`^${NETWORK_PATH}/devices/([^/]+)/room$`);

/** The Room a `NetworkDeviceRoomRequest` gives, which may be anything. */
export const roomIn = (body: unknown): number | null => {
  const roomId = typeof body === "object" && body !== null && "roomId" in body ? body.roomId : undefined;
  if (roomId !== null && !Number.isInteger(roomId)) {
    throw new HttpRefusal(400, "Give the Room's id, or null for no Room.");
  }
  return roomId as number | null;
};

/** The name a `NetworkDeviceNameRequest` gives, which may be anything. */
export const nameIn = (body: unknown): string | null => {
  const name = typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
  if (name !== null && typeof name !== "string") throw new HttpRefusal(400, "Give the device's name, or null.");
  return name;
};

/** Names a device with what the request asks, refusing a name too long as the Hub's rules say. */
export const naming = <T>(name: () => T): T => {
  try {
    return name();
  } catch (error) {
    if (error instanceof NetworkDeviceNameRefusal) throw new HttpRefusal(400, error.message);
    if (error instanceof NetworkDeviceRoomRefusal) throw new HttpRefusal(409, error.message);
    if (error instanceof ApplianceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    throw error;
  }
};

/**
 * Answers the Remote's requests about the devices on the home network (see
 * `NETWORK_PATH` in `shared`), or returns false for a path that isn't one of
 * them. A scan, or a check of every port, starts and is answered at once; the
 * Remote asks again to see how far it has got.
 */
export const handleNetworkRequest = async (
  scanner: NetworkScanner,
  devices: NetworkDeviceStore,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname === NETWORK_ROOMS_PATH) {
    if (request.method === "GET" || request.method === "HEAD") {
      const answer: RoomDevices = { devices: devices.inRooms() };
      sendJson(response, 200, answer);
    } else refuseMethod(response, ["GET", "HEAD"]);
    return true;
  }
  const roomed = DEVICE_ROOM.exec(pathname);
  if (roomed?.[1] !== undefined) {
    if (request.method !== "PUT") {
      refuseMethod(response, ["PUT"]);
      return true;
    }
    const address = decodeURIComponent(roomed[1]);
    const roomId = roomIn(await readJson(request));
    const scan = naming(() => scanner.setRoom(address, roomId));
    if (scan === undefined) throw new HttpRefusal(404, `No device was found at ${address}. Scan the network again.`);
    sendJson(response, 200, scan);
    return true;
  }
  const named = DEVICE_NAME.exec(pathname);
  if (named?.[1] !== undefined) {
    if (request.method !== "PUT") {
      refuseMethod(response, ["PUT"]);
      return true;
    }
    const address = decodeURIComponent(named[1]);
    const name = nameIn(await readJson(request));
    const scan = naming(() => scanner.setName(address, name));
    if (scan === undefined) throw new HttpRefusal(404, `No device was found at ${address}. Scan the network again.`);
    sendJson(response, 200, scan);
    return true;
  }
  if (pathname === NETWORK_PATH) {
    if (request.method === "GET" || request.method === "HEAD") sendJson(response, 200, scanner.read());
    else refuseMethod(response, ["GET", "HEAD"]);
    return true;
  }
  if (pathname === NETWORK_SCAN_PATH) {
    if (request.method === "POST") sendJson(response, 202, scanner.scan());
    else refuseMethod(response, ["POST"]);
    return true;
  }
  const ports = DEVICE_PORTS.exec(pathname);
  if (ports?.[1] !== undefined) {
    if (request.method !== "POST") {
      refuseMethod(response, ["POST"]);
      return true;
    }
    const address = decodeURIComponent(ports[1]);
    if (isIP(address) !== 4) throw new HttpRefusal(400, `"${address}" isn't an IPv4 address.`);
    const scan = scanner.checkAllPorts(address);
    if (scan === undefined) throw new HttpRefusal(404, `No device was found at ${address}. Scan the network again.`);
    sendJson(response, 202, scan);
    return true;
  }
  return false;
};
