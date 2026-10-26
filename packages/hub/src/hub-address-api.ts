import type { IncomingMessage, ServerResponse } from "node:http";

import { HUB_ADDRESS_PATH } from "@media-centre/shared";

import { HubAddressRefusal, type HubAddressStore } from "./hub-address.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";

/**
 * Answers the Remote's requests about the Hub's own address (see
 * `HUB_ADDRESS_PATH` in `shared`), or returns false for a path that isn't one
 * of them. A change is logged, as the person made it in Settings.
 */
export const handleHubAddressRequest = async (
  addresses: HubAddressStore,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname !== HUB_ADDRESS_PATH) return false;
  switch (request.method) {
    case "GET":
    case "HEAD":
      sendJson(response, 200, addresses.read());
      return true;
    case "PUT": {
      const asked = overrideIn(await readJson(request));
      let changed;
      try {
        changed = addresses.setOverride(asked);
      } catch (error) {
        if (error instanceof HubAddressRefusal) throw new HttpRefusal(400, error.message);
        throw error;
      }
      console.log(
        changed.override === null
          ? `The Hub's IP address is the one it finds, ${changed.found ?? "none"}`
          : `The Hub's IP address is set to ${changed.override}`,
      );
      sendJson(response, 200, changed);
      return true;
    }
    default:
      refuseMethod(response, ["GET", "HEAD", "PUT"]);
      return true;
  }
};

/** The address a `HubAddressRequest` gives, which may be anything. */
const overrideIn = (body: unknown): string | null => {
  const override = typeof body === "object" && body !== null && "override" in body ? body.override : undefined;
  if (override !== null && typeof override !== "string") {
    throw new HttpRefusal(400, "Give the Hub's IP address, or null to use the one it finds.");
  }
  return override;
};
