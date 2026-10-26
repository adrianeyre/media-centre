import type { HubError } from "@media-centre/shared";

/**
 * The Hub refused, or couldn't be asked. The message is the one to show the
 * person: the Hub's own when it gave one, e.g. why a name was refused.
 */
export class HubRequestFailed extends Error {
  /** What the Hub needs the person to give before the request is sent again, as `HubError.needs` says. */
  readonly needs: HubError["needs"];

  constructor(message: string, needs?: HubError["needs"]) {
    super(message);
    this.name = "HubRequestFailed";
    this.needs = needs;
  }
}

/** Sends one request to the Hub's API, with a body if given: a file as it is, anything else as JSON. */
export type HubRequest = (method: string, path: string, body?: object | Blob) => Promise<Response>;

/**
 * Talks to the Hub's API. The Hub enforces every rule about what it keeps, so
 * the Remote doesn't repeat those rules; it shows the Hub's reasons instead.
 */
export const createHubRequest =
  (fetchFn: typeof fetch = fetch): HubRequest =>
  async (method, path, body) => {
    let response: Response;
    try {
      response = await fetchFn(path, {
        method,
        ...(body === undefined
          ? {}
          : body instanceof Blob
            ? { headers: { "content-type": body.type }, body }
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch {
      throw new HubRequestFailed("Can't reach the Hub");
    }
    if (!response.ok) throw await refusalFor(response);
    return response;
  };

const refusalFor = async (response: Response): Promise<HubRequestFailed> => {
  try {
    const body = (await response.json()) as Partial<HubError> | null;
    if (typeof body?.error === "string") {
      return new HubRequestFailed(body.error, body.needs === "login" ? "login" : undefined);
    }
  } catch {
    // Not the Hub's JSON, e.g. a proxy's error page.
  }
  return new HubRequestFailed(`The Hub couldn't do that (error ${String(response.status)}).`);
};

/** A message for anything a request to the Hub threw. */
export const messageFor = (error: unknown): string =>
  error instanceof HubRequestFailed ? error.message : "Something went wrong. Try again.";
