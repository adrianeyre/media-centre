import type { IncomingMessage, ServerResponse } from "node:http";

import { HEATING_PATH, WHOLE_HOME_PATH, type HeatingChange, type HotWaterChange } from "@media-centre/shared";

import { DRIVER_FAILURE_STATUS, REFUSAL_STATUS } from "./appliances-api.ts";
import { ApplianceRefusal } from "./appliances.ts";
import { DriverFailure } from "./drivers/driver.ts";
import type { Heating } from "./heating.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";

/** One Heating, Radiator Valve or Hot Water, by its Appliance id. */
const ONE_PATH = new RegExp(`^${HEATING_PATH}/([1-9][0-9]{0,15})$`);

/** A Room's Room-wide target, by the Room's id. */
const ROOM_TARGET_PATH = new RegExp(`^${HEATING_PATH}/rooms/([1-9][0-9]{0,15})/target$`);

/**
 * Answers the Heating tab's requests (see `HEATING_PATH` in `shared`), or
 * returns false for a path that isn't one of them. Each reads or changes
 * Hive as it is asked, and nothing it answers holds a token or a key
 * (FR-67a).
 */
export const handleHeatingRequest = async (
  heating: Heating,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname !== HEATING_PATH && !pathname.startsWith(`${HEATING_PATH}/`)) return false;
  try {
    if (pathname === HEATING_PATH) {
      if (request.method === "GET" || request.method === "HEAD") sendJson(response, 200, await heating.read());
      else refuseMethod(response, ["GET", "HEAD"]);
      return true;
    }
    if (pathname === WHOLE_HOME_PATH) {
      if (request.method === "POST") {
        sendJson(response, 200, await heating.changeWholeHome(changeIn(await readJson(request)) as HeatingChange));
      } else refuseMethod(response, ["POST"]);
      return true;
    }
    const room = ROOM_TARGET_PATH.exec(pathname);
    if (room?.[1] !== undefined) {
      if (request.method === "POST") {
        sendJson(response, 200, await heating.setRoomTarget(Number(room[1]), targetIn(await readJson(request))));
      } else refuseMethod(response, ["POST"]);
      return true;
    }
    const one = ONE_PATH.exec(pathname);
    if (one?.[1] !== undefined) {
      if (request.method === "POST") {
        sendJson(response, 200, await heating.change(Number(one[1]), changeIn(await readJson(request))));
      } else refuseMethod(response, ["POST"]);
      return true;
    }
    throw new HttpRefusal(404, "Not found");
  } catch (error) {
    if (error instanceof DriverFailure) throw new HttpRefusal(DRIVER_FAILURE_STATUS[error.reason], error.message);
    if (error instanceof ApplianceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    throw error;
  }
};

/**
 * A change, as the Hive Driver checks it, refusing one it can't take
 * before anything is sent (FR-63, FR-66): here only that it is one.
 */
const changeIn = (body: unknown): HeatingChange | HotWaterChange => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpRefusal(400, "Send one change: a target, a mode or a Boost.");
  }
  return body as HeatingChange | HotWaterChange;
};

const targetIn = (body: unknown): number => {
  const target = typeof body === "object" && body !== null && "target" in body ? body.target : undefined;
  if (typeof target !== "number" || !Number.isFinite(target)) {
    throw new HttpRefusal(400, "Send the Room's target temperature, in °C.");
  }
  return target;
};
