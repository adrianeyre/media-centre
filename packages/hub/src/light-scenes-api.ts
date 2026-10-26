import type { IncomingMessage, ServerResponse } from "node:http";

import { LIGHT_SCENES_PATH, type SaveLightSceneRequest } from "@media-centre/shared";

import { ApplianceRefusal, type ApplianceStore } from "./appliances.ts";
import type { Drivers, LightDriver } from "./drivers/driver.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import { LightSceneRefusal, recallLightScene, saveLightScene, type LightSceneStore } from "./light-scenes.ts";

const LIGHT_SCENE_PATH = new RegExp(`^${LIGHT_SCENES_PATH}/([1-9][0-9]{0,15})(/recall)?$`);

const REFUSAL_STATUS: Readonly<Record<LightSceneRefusal["reason"], number>> = {
  invalid: 400,
  taken: 409,
  missing: 404,
  stale: 409,
};

export interface LightScenesApi {
  readonly scenes: LightSceneStore;
  readonly appliances: ApplianceStore;
  readonly drivers: Drivers;
  /** Hears the Lights a person is about to set back by recalling a Light Scene, as a change by hand (FR-57). */
  readonly onLightsChanged?: (ids: readonly number[]) => void;
}

/**
 * Answers the Remote's requests about Light Scenes (see `LIGHT_SCENES_PATH`
 * in `shared`), or returns false for a path that isn't one of them. Saving
 * and recalling one reach each Light through its Driver (NFR-6).
 */
export const handleLightScenesRequest = async (
  { scenes, appliances, drivers, onLightsChanged }: LightScenesApi,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  try {
    if (pathname === LIGHT_SCENES_PATH) {
      if (request.method === "GET" || request.method === "HEAD") {
        sendJson(response, 200, scenes.list());
      } else if (request.method === "POST") {
        const asked = saveRequestIn(await readJson(request));
        sendJson(response, 201, await saveLightScene(appliances, scenes, driverOf(drivers), asked));
      } else refuseMethod(response, ["GET", "HEAD", "POST"]);
      return true;
    }
    const match = LIGHT_SCENE_PATH.exec(pathname);
    if (match?.[1] !== undefined) {
      const id = Number(match[1]);
      if (match[2] !== undefined) {
        if (request.method === "POST") {
          const driver = driverOf(drivers);
          onLightsChanged?.(scenes.get(id).lights.map(({ id: lightId }) => lightId));
          sendJson(response, 200, await recallLightScene(appliances, scenes, driver, id));
        } else refuseMethod(response, ["POST"]);
      } else if (request.method === "PATCH") {
        sendJson(response, 200, scenes.rename(id, nameIn(await readJson(request))));
      } else if (request.method === "DELETE") {
        scenes.remove(id);
        response.writeHead(204).end();
      } else refuseMethod(response, ["PATCH", "DELETE"]);
      return true;
    }
    if (pathname.startsWith(`${LIGHT_SCENES_PATH}/`)) throw new HttpRefusal(404, "That Light Scene has been deleted.");
    return false;
  } catch (error) {
    if (error instanceof LightSceneRefusal || error instanceof ApplianceRefusal) {
      throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    }
    throw error;
  }
};

const driverOf = (drivers: Drivers): LightDriver => {
  if (drivers.light === undefined) throw new HttpRefusal(400, "The Hub has no Lights to save or recall.");
  return drivers.light;
};

const nameIn = (body: unknown): string => {
  if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") return body.name;
  throw new HttpRefusal(400, "Give the Light Scene a name.");
};

const saveRequestIn = (body: unknown): SaveLightSceneRequest => {
  const name = nameIn(body);
  const { roomId } = body as Record<string, unknown>;
  if (!Number.isSafeInteger(roomId)) throw new HttpRefusal(400, "Give the Room whose Lights to save, as its id.");
  return { roomId: roomId as number, name };
};
