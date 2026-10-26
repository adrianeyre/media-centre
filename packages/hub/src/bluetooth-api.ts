import type { IncomingMessage, ServerResponse } from "node:http";

import { BLUETOOTH_PATH, BLUETOOTH_SCAN_PATH } from "@media-centre/shared";

import type { BluetoothScanner } from "./bluetooth.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import { nameIn, naming, roomIn } from "./network-api.ts";

const DEVICE_NAME = new RegExp(`^${BLUETOOTH_PATH}/devices/([^/]+)/name$`);
const DEVICE_ROOM = new RegExp(`^${BLUETOOTH_PATH}/devices/([^/]+)/room$`);

/**
 * Answers the Remote's requests about the Bluetooth devices near the Hub
 * (see `BLUETOOTH_PATH` in `shared`), or returns false for a path that isn't
 * one of them. A scan starts and is answered at once; the Remote asks again
 * to see what it has heard.
 */
export const handleBluetoothRequest = async (
  scanner: BluetoothScanner,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname === BLUETOOTH_PATH) {
    if (request.method === "GET" || request.method === "HEAD") sendJson(response, 200, scanner.read());
    else refuseMethod(response, ["GET", "HEAD"]);
    return true;
  }
  if (pathname === BLUETOOTH_SCAN_PATH) {
    if (request.method === "POST") sendJson(response, 202, scanner.scan());
    else refuseMethod(response, ["POST"]);
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
    if (scan === undefined) throw new HttpRefusal(404, `No Bluetooth device was heard at ${address}. Scan again.`);
    sendJson(response, 200, scan);
    return true;
  }
  const named = DEVICE_NAME.exec(pathname);
  if (named?.[1] === undefined) return false;
  if (request.method !== "PUT") {
    refuseMethod(response, ["PUT"]);
    return true;
  }
  const address = decodeURIComponent(named[1]);
  const name = nameIn(await readJson(request));
  const scan = naming(() => scanner.setName(address, name));
  if (scan === undefined) throw new HttpRefusal(404, `No Bluetooth device was heard at ${address}. Scan again.`);
  sendJson(response, 200, scan);
  return true;
};
