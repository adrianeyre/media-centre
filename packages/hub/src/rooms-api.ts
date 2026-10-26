import type { IncomingMessage, ServerResponse } from "node:http";

import {
  FLOOR_PLAN_DRAWING_PATH,
  FLOOR_PLAN_IMAGE_MAX_BYTES,
  FLOOR_PLAN_IMAGE_PATH,
  FLOOR_PLAN_IMAGE_TYPES,
  FLOOR_PLAN_PATH,
  ROOM_ORDER_PATH,
  ROOMS_PATH,
  type Room,
} from "@media-centre/shared";

import type { FloorPlanStore } from "./floor-plan.ts";
import { HttpRefusal, readBytes, readJson, refuseMethod, sendJson } from "./http.ts";
import { RoomRefusal, type RoomStore } from "./rooms.ts";

/** More than a layout of the most places with the most corners takes as JSON. */
const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

const ROOM_PATH = new RegExp(`^${ROOMS_PATH}/([1-9][0-9]{0,15})$`);

const REFUSAL_STATUS: Readonly<Record<RoomRefusal["reason"], number>> = {
  invalid: 400,
  taken: 409,
  missing: 404,
  stale: 409,
};

/**
 * Answers the Remote's requests about Rooms (see `ROOMS_PATH` in `shared`), or
 * returns false for a path that isn't one of them.
 */
export const handleRoomsRequest = async (
  rooms: RoomStore,
  floorPlan: FloorPlanStore,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  try {
    if (pathname === ROOMS_PATH) {
      await roomsCollection(rooms, request, response);
      return true;
    }
    if (pathname === ROOM_ORDER_PATH) {
      await roomOrder(rooms, request, response);
      return true;
    }
    if (pathname === FLOOR_PLAN_DRAWING_PATH) {
      await floorPlanDrawing(floorPlan, request, response);
      return true;
    }
    if (pathname === FLOOR_PLAN_IMAGE_PATH) {
      await floorPlanImage(floorPlan, request, response);
      return true;
    }
    if (pathname === FLOOR_PLAN_PATH) {
      if (request.method === "GET" || request.method === "HEAD") sendJson(response, 200, rooms.floorPlan());
      else refuseMethod(response, ["GET", "HEAD"]);
      return true;
    }
    if (pathname.startsWith(`${FLOOR_PLAN_PATH}/`)) {
      await floorPlanPlace(rooms, pathname.slice(FLOOR_PLAN_PATH.length + 1), request, response);
      return true;
    }
    const id = ROOM_PATH.exec(pathname)?.[1];
    if (id !== undefined) {
      await oneRoom(rooms, Number(id), request, response);
      return true;
    }
    if (pathname.startsWith(`${ROOMS_PATH}/`)) throw new HttpRefusal(404, "That Room no longer exists.");
    return false;
  } catch (error) {
    if (error instanceof RoomRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    throw error;
  }
};

const roomsCollection = async (rooms: RoomStore, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  switch (request.method) {
    case "GET":
    case "HEAD":
      sendJson(response, 200, rooms.list());
      return;
    case "POST": {
      const room: Room = rooms.add(nameIn(await readJson(request)));
      sendJson(response, 201, room);
      return;
    }
    default:
      refuseMethod(response, ["GET", "HEAD", "POST"]);
  }
};

const oneRoom = async (
  rooms: RoomStore,
  id: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "PATCH":
      sendJson(response, 200, rooms.rename(id, nameIn(await readJson(request))));
      return;
    case "DELETE":
      rooms.remove(id);
      response.writeHead(204).end();
      return;
    default:
      refuseMethod(response, ["PATCH", "DELETE"]);
  }
};

const roomOrder = async (rooms: RoomStore, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  if (request.method !== "PUT") {
    refuseMethod(response, ["PUT"]);
    return;
  }
  sendJson(response, 200, rooms.reorder(roomIdsIn(await readJson(request))));
};

const nameIn = (body: unknown): string => {
  if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") return body.name;
  throw new HttpRefusal(400, "Give the Room a name.");
};

const roomIdsIn = (body: unknown): number[] => {
  if (
    typeof body === "object" &&
    body !== null &&
    "roomIds" in body &&
    Array.isArray(body.roomIds) &&
    body.roomIds.every((id) => Number.isSafeInteger(id))
  ) {
    return body.roomIds as number[];
  }
  throw new HttpRefusal(400, "Give the order as a list of Room ids.");
};

const floorPlanPlace = async (
  rooms: RoomStore,
  place: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "PUT": {
      const body = await readJson(request);
      const roomId = typeof body === "object" && body !== null ? (body as Record<string, unknown>).roomId : undefined;
      if (typeof roomId !== "number" || !Number.isSafeInteger(roomId) || roomId < 1) {
        throw new HttpRefusal(400, 'Send the Room, e.g. {"roomId": 1}.');
      }
      sendJson(response, 200, rooms.place(place, roomId));
      return;
    }
    case "DELETE":
      sendJson(response, 200, rooms.unplace(place));
      return;
    default:
      refuseMethod(response, ["PUT", "DELETE"]);
  }
};

const floorPlanDrawing = async (
  floorPlan: FloorPlanStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "GET":
    case "HEAD":
      sendJson(response, 200, floorPlan.drawing());
      return;
    case "PUT":
      sendJson(response, 200, floorPlan.setLayout(await readJson(request, MAX_LAYOUT_BYTES)));
      return;
    case "DELETE":
      sendJson(response, 200, floorPlan.reset());
      return;
    default:
      refuseMethod(response, ["GET", "HEAD", "PUT", "DELETE"]);
  }
};

/**
 * The image is sent as it was given, but sandboxed: an SVG may hold a
 * script, which must never run as the Hub's own page would.
 */
const floorPlanImage = async (
  floorPlan: FloorPlanStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (request.method) {
    case "GET":
    case "HEAD": {
      const image = floorPlan.image();
      if (image === undefined) throw new HttpRefusal(404, "The floor plan is the built-in one.");
      const etag = `"v${String(image.version)}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag }).end();
        return;
      }
      response.writeHead(200, {
        "content-type": image.type,
        "content-length": image.bytes.byteLength,
        "cache-control": "no-cache",
        etag,
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : image.bytes);
      return;
    }
    case "PUT": {
      const { type, bytes } = await readBytes(request, FLOOR_PLAN_IMAGE_TYPES, FLOOR_PLAN_IMAGE_MAX_BYTES);
      if (bytes.byteLength === 0) throw new HttpRefusal(400, "That image is empty.");
      sendJson(response, 200, floorPlan.setImage(type, bytes));
      return;
    }
    default:
      refuseMethod(response, ["GET", "HEAD", "PUT"]);
  }
};
