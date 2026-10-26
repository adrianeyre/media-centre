import type { IncomingMessage, ServerResponse } from "node:http";

import type { HubError } from "@media-centre/shared";

/** More than any JSON request the Remote sends; anything bigger is refused unread. */
const MAX_BODY_BYTES = 16 * 1024;

/** A request the Hub refuses, with the status and message to answer it with. */
export class HttpRefusal extends Error {
  readonly status: number;
  /** What the Remote is to ask the person for before it tries again, as `HubError.needs` says. */
  readonly needs: HubError["needs"];

  constructor(status: number, message: string, needs?: HubError["needs"]) {
    super(message);
    this.name = "HttpRefusal";
    this.status = status;
    this.needs = needs;
  }
}

export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
};

export const sendError = (
  response: ServerResponse,
  status: number,
  message: string,
  needs?: HubError["needs"],
): void => {
  const body: HubError = { error: message, ...(needs === undefined ? {} : { needs }) };
  sendJson(response, status, body);
};

export const refuseMethod = (response: ServerResponse, allow: readonly string[]): void => {
  response.writeHead(405, { allow: allow.join(", ") }).end();
};

/**
 * Reads a JSON body. Only `application/json` is accepted: a web page elsewhere
 * can't send that to the Hub without the browser first asking the Hub, which
 * never agrees, so no other site can change the home behind the person's back.
 * A body bigger than `maxBytes` is refused unread.
 */
export const readJson = async (request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> => {
  const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpRefusal(415, "Send JSON, as application/json.");

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpRefusal(413, "That request is too big.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpRefusal(400, "That request is not valid JSON.");
  }
};

/**
 * Reads a body of bytes, such as an image, of one of the `types` given, as
 * `content-type` says it is, and returns them with that type. Any other type
 * is refused unread, as is a body bigger than `maxBytes`.
 */
export const readBytes = async (
  request: IncomingMessage,
  types: readonly string[],
  maxBytes: number,
): Promise<{ type: string; bytes: Uint8Array }> => {
  const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!types.includes(type)) throw new HttpRefusal(415, `Send one of these: ${types.join(", ")}.`);
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpRefusal(413, "That file is too big.");

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpRefusal(413, "That file is too big.");
    chunks.push(chunk);
  }
  return { type, bytes: new Uint8Array(Buffer.concat(chunks)) };
};
