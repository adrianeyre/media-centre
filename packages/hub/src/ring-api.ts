import type { IncomingMessage, ServerResponse } from "node:http";

import {
  RING_CHIME_VOLUME_MAX,
  RING_CODE_PATH,
  RING_FIELD_MAX_LENGTH,
  RING_PATH,
  RING_SIGN_IN_PATH,
  type RingAction,
} from "@media-centre/shared";

import { RingFailure } from "./drivers/ring/ring-driver.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import { naming, roomIn } from "./network-api.ts";
import type { Ring } from "./ring.ts";

const DEVICE = new RegExp(
  `^${RING_PATH}/devices/([^/]+)(?:/(actions|room|snapshot|live)(?:/([^/]+))?|/events/([^/]+)/recording)?$`,
);

/** The most a WebRTC offer may be, with its candidates, which is more than any other request's. */
const MAX_OFFER_BYTES = 64 * 1024;

type Body = Record<string, unknown>;

const bodyOf = (body: unknown): Body => (typeof body === "object" && body !== null ? (body as Body) : {});

/** A field, 1 to {@link RING_FIELD_MAX_LENGTH} characters, trimmed but for a password. */
const fieldIn = (value: unknown, what: string, trim = true): string => {
  const raw = typeof value === "string" ? value : "";
  const field = trim ? raw.trim() : raw;
  if (field === "") throw new HttpRefusal(400, `Give the ${what}.`);
  if (field.length > RING_FIELD_MAX_LENGTH) throw new HttpRefusal(400, `That is too long for the ${what}.`);
  return field;
};

const onIn = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new HttpRefusal(400, "Say whether it is on.");
  return value;
};

/** The action a request asks for, which may be anything, checked before Ring is asked. */
export const actionIn = (raw: unknown): RingAction => {
  const body = bodyOf(raw);
  switch (body.kind) {
    case "light":
    case "siren":
    case "motion-detection":
      return { kind: body.kind, on: onIn(body.on) };
    case "chime-volume": {
      const { level } = body;
      if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > RING_CHIME_VOLUME_MAX) {
        throw new HttpRefusal(400, `The volume is a whole number from 0 to ${String(RING_CHIME_VOLUME_MAX)}.`);
      }
      return { kind: "chime-volume", level };
    }
    case "chime-test":
      if (body.sound !== "ding" && body.sound !== "motion") throw new HttpRefusal(400, "Say which sound to play.");
      return { kind: "chime-test", sound: body.sound };
    default:
      throw new HttpRefusal(400, "That isn't something a Ring device can be asked to do.");
  }
};

/** Answers with what `work` gives, or Ring's refusal as `502`, for the person. */
const ringSays = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await naming(() => work());
  } catch (error) {
    if (error instanceof RingFailure) throw new HttpRefusal(502, error.message);
    throw error;
  }
};

const only = (request: IncomingMessage, response: ServerResponse, methods: readonly string[]): boolean => {
  if (methods.includes(request.method ?? "")) return true;
  refuseMethod(response, methods);
  return false;
};

/**
 * Answers the Remote's requests about the owner's Ring devices (see
 * `RING_PATH` in `shared`), or returns false for a path that isn't one of
 * them.
 */
export const handleRingRequest = async (
  service: Ring,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname === RING_PATH) {
    if (only(request, response, ["GET", "HEAD"])) sendJson(response, 200, await service.home());
    return true;
  }
  if (pathname === RING_SIGN_IN_PATH) {
    if (request.method === "POST") {
      const body = bodyOf(await readJson(request));
      const email = fieldIn(body.email, "email address");
      const password = fieldIn(body.password, "password", false);
      sendJson(response, 200, await service.signIn(email, password));
    } else if (request.method === "DELETE") sendJson(response, 200, await service.signOut());
    else refuseMethod(response, ["POST", "DELETE"]);
    return true;
  }
  if (pathname === RING_CODE_PATH) {
    if (only(request, response, ["POST"])) {
      const code = fieldIn(bodyOf(await readJson(request)).code, "code");
      sendJson(response, 200, await ringSays(() => service.enterCode(code)));
    }
    return true;
  }

  const device = DEVICE.exec(pathname);
  if (device?.[1] === undefined) return false;
  const id = decodeURIComponent(device[1]);
  const [, , part, session, event] = device;

  if (event !== undefined) {
    if (only(request, response, ["GET", "HEAD"])) {
      const url = await ringSays(() => service.recordingUrl(id, decodeURIComponent(event)));
      sendJson(response, 200, { url });
    }
    return true;
  }
  if (session !== undefined && part !== "live") return false;

  switch (part) {
    case undefined:
      if (only(request, response, ["GET", "HEAD"])) sendJson(response, 200, await ringSays(() => service.state(id)));
      return true;
    case "actions":
      if (only(request, response, ["POST"])) {
        const action = actionIn(await readJson(request));
        sendJson(response, 200, await ringSays(() => service.act(id, action)));
      }
      return true;
    case "room":
      if (only(request, response, ["PUT"])) {
        const roomId = roomIn(await readJson(request));
        sendJson(response, 200, await ringSays(() => service.setRoom(id, roomId)));
      }
      return true;
    case "snapshot":
      if (only(request, response, ["GET"])) {
        const jpeg = await ringSays(() => service.snapshot(id));
        response
          .writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": jpeg.byteLength,
            "Cache-Control": "no-store",
          })
          .end(jpeg);
      }
      return true;
    default:
      if (session !== undefined) {
        if (only(request, response, ["DELETE"])) {
          await service.endLiveView(decodeURIComponent(session));
          response.writeHead(204).end();
        }
        return true;
      }
      if (only(request, response, ["POST"])) {
        const sdp = bodyOf(await readJson(request, MAX_OFFER_BYTES)).sdp;
        if (typeof sdp !== "string" || !sdp.startsWith("v=0")) throw new HttpRefusal(400, "Give the WebRTC offer.");
        sendJson(response, 200, await ringSays(() => service.startLiveView(id, sdp)));
      }
      return true;
  }
};
