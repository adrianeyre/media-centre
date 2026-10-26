import type { IncomingMessage, ServerResponse } from "node:http";

import { HIVE_CODE_MAX_LENGTH, HIVE_CODE_PATH, HIVE_PATH, HIVE_SIGN_IN_PATH } from "@media-centre/shared";

import { loginIn } from "./air-conditioners.ts";
import { DRIVER_FAILURE_STATUS } from "./appliances-api.ts";
import { DriverFailure } from "./drivers/driver.ts";
import type { Hive } from "./hive.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";

/**
 * Answers the Remote's requests about the Hub's sign-in to Hive (see
 * `HIVE_PATH` in `shared`), or returns false for a path that isn't one of
 * them. Nothing it answers holds a token, a device key or Hive's sign-in
 * session, nor quotes the login or the code back (FR-67a).
 */
export const handleHiveRequest = async (
  hive: Hive,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  try {
    switch (pathname) {
      case HIVE_PATH:
        if (request.method === "GET" || request.method === "HEAD") {
          sendJson(response, 200, await hive.check());
        } else if (request.method === "DELETE") {
          hive.signOut();
          response.writeHead(204).end();
        } else refuseMethod(response, ["GET", "HEAD", "DELETE"]);
        return true;
      case HIVE_SIGN_IN_PATH:
        if (request.method === "POST") {
          const login = loginIn(await readJson(request));
          if (login === undefined) throw new HttpRefusal(400, "Give the Hive account's email address and password.");
          sendJson(response, 200, await hive.signIn(login));
        } else refuseMethod(response, ["POST"]);
        return true;
      case HIVE_CODE_PATH:
        if (request.method === "POST") {
          sendJson(response, 200, await hive.enterCode(codeIn(await readJson(request))));
        } else refuseMethod(response, ["POST"]);
        return true;
      default:
        if (pathname.startsWith(`${HIVE_PATH}/`)) throw new HttpRefusal(404, "Not found");
        return false;
    }
  } catch (error) {
    if (error instanceof DriverFailure) throw new HttpRefusal(DRIVER_FAILURE_STATUS[error.reason], error.message);
    throw error;
  }
};

/** The code in a request, which is never quoted back. */
const codeIn = (body: unknown): string => {
  const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
  if (typeof code !== "string" || code.trim() === "" || code.length > HIVE_CODE_MAX_LENGTH) {
    throw new HttpRefusal(400, "Give the code Hive texted the account's owner.");
  }
  return code.trim();
};
