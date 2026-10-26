import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AMAZON_ANNOUNCE_PATH,
  AMAZON_DOMAINS,
  AMAZON_PATH,
  AMAZON_QUICK_ACTIONS,
  AMAZON_SIGN_IN_PATH,
  AMAZON_TEXT_MAX_LENGTH,
  type AmazonAction,
  type AmazonDomain,
  type AmazonQuickAction,
} from "@media-centre/shared";

import type { Amazon } from "./amazon.ts";
import { AmazonFailure } from "./drivers/amazon/amazon-driver.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import { naming, roomIn } from "./network-api.ts";

const DEVICE = new RegExp(`^${AMAZON_PATH}/devices/([^/]+)(?:/(actions|room))?$`);

type Body = Record<string, unknown>;

const bodyOf = (body: unknown): Body => (typeof body === "object" && body !== null ? (body as Body) : {});

/** Text to say, announce or ask, 1 to {@link AMAZON_TEXT_MAX_LENGTH} characters once trimmed. */
const textIn = (value: unknown): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new HttpRefusal(400, "Give the words for Alexa.");
  if (text.length > AMAZON_TEXT_MAX_LENGTH) {
    throw new HttpRefusal(400, `Alexa takes at most ${String(AMAZON_TEXT_MAX_LENGTH)} characters at once.`);
  }
  return text;
};

const wholeIn = (value: unknown, min: number, max: number, what: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpRefusal(400, `${what} is a whole number from ${String(min)} to ${String(max)}.`);
  }
  return value;
};

const idIn = (value: unknown): string => {
  if (typeof value !== "string" || value === "") throw new HttpRefusal(400, "Say which one.");
  return value;
};

/** The action a request asks for, which may be anything, checked before Amazon is asked. */
export const actionIn = (raw: unknown): AmazonAction => {
  const body = bodyOf(raw);
  switch (body.kind) {
    case "play":
    case "pause":
    case "next":
    case "previous":
      return { kind: body.kind };
    case "volume":
      return { kind: "volume", level: wholeIn(body.level, 0, 100, "The volume") };
    case "speak":
    case "announce":
    case "ask":
      return { kind: body.kind, text: textIn(body.text) };
    case "quick":
      if (!AMAZON_QUICK_ACTIONS.includes(body.action as never))
        throw new HttpRefusal(400, "That isn't a quick action.");
      return { kind: "quick", action: body.action as AmazonQuickAction };
    case "routine":
      return { kind: "routine", routineId: idIn(body.routineId) };
    case "do-not-disturb":
      if (typeof body.on !== "boolean") throw new HttpRefusal(400, "Say whether Do Not Disturb is on.");
      return { kind: "do-not-disturb", on: body.on };
    case "music":
      return { kind: "music", providerId: idIn(body.providerId), search: textIn(body.search) };
    case "equaliser":
      return {
        kind: "equaliser",
        bass: wholeIn(body.bass, -6, 6, "Bass"),
        midrange: wholeIn(body.midrange, -6, 6, "Midrange"),
        treble: wholeIn(body.treble, -6, 6, "Treble"),
      };
    case "alarm-volume":
      return { kind: "alarm-volume", level: wholeIn(body.level, 0, 100, "The alarm volume") };
    case "notification-on":
      if (typeof body.on !== "boolean") throw new HttpRefusal(400, "Say whether it is on.");
      return { kind: "notification-on", id: idIn(body.id), on: body.on };
    case "notification-delete":
      return { kind: "notification-delete", id: idIn(body.id) };
    case "bluetooth":
      if (typeof body.connect !== "boolean") throw new HttpRefusal(400, "Say whether to connect.");
      return { kind: "bluetooth", address: idIn(body.address), connect: body.connect };
    default:
      throw new HttpRefusal(400, "That isn't something an Echo can be asked to do.");
  }
};

/** Whether the Remote reached the Hub at its own PC's loopback address, e.g. `localhost:41080`. */
const isLoopback = (request: IncomingMessage): boolean => {
  const host = (request.headers.host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
};

/** Answers with what `work` gives, or Amazon's refusal as `502`, for the person. */
const amazonSays = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await naming(() => work());
  } catch (error) {
    if (error instanceof AmazonFailure) throw new HttpRefusal(502, error.message);
    throw error;
  }
};

/**
 * Answers the Remote's requests about the owner's Echo devices (see
 * `AMAZON_PATH` in `shared`), or returns false for a path that isn't one of
 * them.
 */
export const handleAmazonRequest = async (
  service: Amazon,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname === AMAZON_PATH) {
    if (request.method === "GET" || request.method === "HEAD") sendJson(response, 200, await service.home());
    else refuseMethod(response, ["GET", "HEAD"]);
    return true;
  }
  if (pathname === AMAZON_SIGN_IN_PATH) {
    if (request.method === "POST") {
      const domain = bodyOf(await readJson(request)).domain;
      if (!AMAZON_DOMAINS.includes(domain as AmazonDomain))
        throw new HttpRefusal(400, "Choose the Amazon site the account is on.");
      sendJson(response, 202, await service.signIn(domain as AmazonDomain, isLoopback(request)));
    } else if (request.method === "DELETE") sendJson(response, 200, await service.signOut());
    else refuseMethod(response, ["POST", "DELETE"]);
    return true;
  }
  if (pathname === AMAZON_ANNOUNCE_PATH) {
    if (request.method !== "POST") {
      refuseMethod(response, ["POST"]);
      return true;
    }
    const text = textIn(bodyOf(await readJson(request)).text);
    await amazonSays(() => service.announce(text));
    response.writeHead(204).end();
    return true;
  }
  const device = DEVICE.exec(pathname);
  if (device?.[1] === undefined) return false;
  const serial = decodeURIComponent(device[1]);
  switch (device[2]) {
    case undefined:
      if (request.method !== "GET" && request.method !== "HEAD") refuseMethod(response, ["GET", "HEAD"]);
      else sendJson(response, 200, await amazonSays(() => service.state(serial)));
      return true;
    case "actions": {
      if (request.method !== "POST") {
        refuseMethod(response, ["POST"]);
        return true;
      }
      const action = actionIn(await readJson(request));
      sendJson(response, 200, await amazonSays(() => service.act(serial, action)));
      return true;
    }
    default: {
      if (request.method !== "PUT") {
        refuseMethod(response, ["PUT"]);
        return true;
      }
      const roomId = roomIn(await readJson(request));
      sendJson(response, 200, await amazonSays(() => service.setRoom(serial, roomId)));
      return true;
    }
  }
};
