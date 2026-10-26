/**
 * Hive's API, "beekeeper", as Hive's app and pyhiveapi (`apyhiveapi/api/
 * hive_async_api.py`) reach it, with the id token Hive's sign-in service
 * issued in `authorization`: `GET /nodes/all` for every product and device
 * on the account, and `POST /nodes/<type>/<id>` to change one product. Only
 * the Hive Driver and the fake Hive cloud know this (NFR-6). Nothing here
 * logs, and nothing it throws quotes a token or what Hive answered.
 *
 * What is uncertain, as no test reaches the real API: whether Hive answers a
 * token it no longer takes with 401 or 403, both taken as refused; what it
 * answers a change it won't take with, any other 4xx being taken as that; and
 * what the body of a change's answer is, which the Driver doesn't read,
 * reading every node again instead.
 */

/** Hive's API, in the UK. `HIVE_URL` puts the fake Hive cloud in its place in tests. */
// eslint-disable-next-line media-centre/no-internet-urls -- Hive has no local API (ADR 0010)
export const HIVE_URL = "https://beekeeper-uk.hivehome.com/1.0";

/** Every product, device and action on the account, in one request. */
export const NODES_PATH = "/nodes/all?products=true&devices=true&actions=true";

/** Where a product of `type` with `id` is changed. */
export const nodePath = (type: string, id: string): string =>
  `/nodes/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;

/** A product or a device, as Hive lists it: what it is in `type`, what it reads in `props`, and what is set in `state`. */
export interface HiveNode {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly state: Readonly<Record<string, unknown>>;
}

/** Everything on the account, as `GET /nodes/all` lists it. */
export interface HiveNodes {
  readonly products: readonly HiveNode[];
  readonly devices: readonly HiveNode[];
}

/** Hive's API couldn't be reached, didn't answer in time, failed (5xx), or answered as something else. */
export class BeekeeperUnreachable extends Error {
  constructor(options?: ErrorOptions) {
    super("Hive didn't answer", options);
    this.name = "BeekeeperUnreachable";
  }
}

/** Hive refused the id token: 401 or 403. */
export class BeekeeperUnauthorised extends Error {
  constructor() {
    super("Hive refused the Hub's token");
    this.name = "BeekeeperUnauthorised";
  }
}

/** Hive refused a change, with its status. */
export class BeekeeperRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Hive refused the change with ${String(status)}`);
    this.name = "BeekeeperRefused";
    this.status = status;
  }
}

export interface BeekeeperOptions {
  /** {@link HIVE_URL}, or the fake Hive cloud's. */
  readonly url: string;
  readonly timeoutMs: number;
}

export interface BeekeeperClient {
  readonly readNodes: (idToken: string) => Promise<HiveNodes>;
  /** Changes one product, and resolves once Hive has taken it. */
  readonly setNode: (
    idToken: string,
    product: Pick<HiveNode, "type" | "id">,
    body: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}

const nodesIn = (list: unknown): HiveNode[] =>
  (Array.isArray(list) ? (list as unknown[]) : []).flatMap((each) => {
    const { id, type, props, state } = (each ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof type !== "string") return [];
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    return [{ id, type, props: record(props), state: record(state) }];
  });

export const beekeeperClient = ({ url, timeoutMs }: BeekeeperOptions): BeekeeperClient => {
  const base = url.replace(/\/$/, "");
  const request = async (path: string, idToken: string, body?: unknown): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          accept: "*/*",
          authorization: idToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BeekeeperUnreachable({ cause: error });
    }
    if (response.status === 401 || response.status === 403) throw new BeekeeperUnauthorised();
    if (response.status >= 500) throw new BeekeeperUnreachable();
    return response;
  };

  return {
    readNodes: async (idToken) => {
      const response = await request(NODES_PATH, idToken);
      if (!response.ok) throw new BeekeeperUnreachable();
      let read: unknown;
      try {
        read = await response.json();
      } catch (error) {
        // Never what JSON.parse said of the answer, which quotes it.
        throw new BeekeeperUnreachable(error instanceof SyntaxError ? undefined : { cause: error });
      }
      if (typeof read !== "object" || read === null) throw new BeekeeperUnreachable();
      const { products, devices } = read as Record<string, unknown>;
      if (!Array.isArray(products)) throw new BeekeeperUnreachable();
      return { products: nodesIn(products), devices: nodesIn(devices) };
    },
    setNode: async (idToken, { type, id }, body) => {
      const response = await request(nodePath(type, id), idToken, body);
      // Read to its end, so the connection is free again; what it says isn't needed.
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) throw new BeekeeperRefused(response.status);
    },
  };
};
