import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  APPLIANCE_LIST_PATH,
  cloudIamPassword,
  cloudPassword,
  CLOUD_APP_ID,
  cloudUdpId,
  encryptCloudAccount,
  LEGACY_ROUTER_PATH,
  LOGIN_ID_PATH,
  LOGIN_PATH,
  MIDEA_AIR_LOGIN_PATH,
  mideaAirPassword,
  signCloudRequest,
  ROUTER_PATH,
  signMideaAirRequest,
  TOKEN_PATH,
  TOKENS_RETIRED_CODE,
} from "../../drivers/midea/cloud.ts";

/**
 * A fake of Midea's cloud, as far as the Midea Driver uses it (FR-51b): it
 * signs in an MSmartHome account as msmart-ng says the real one does, or,
 * as `app: "Midea Air"`, a Midea Air account as Midea's older cloud does, and
 * issues each unit it knows its token and key, those the fake Midea Air
 * Conditioner expects, by the UDP id the cloud knows a unit by. No test
 * reaches the real one. When the real one turns out to behave differently,
 * change this first, then the Midea Driver.
 *
 * As MSmartHome's, it answers Midea's router with the server that holds the
 * account: itself, or, given a `region`, itself under that region's path,
 * as an account made in the UK or Europe is held on Europe's server, and
 * every other answers it doesn't exist.
 *
 * It checks each request's signature, refuses a wrong account or password
 * as it signs in, and an access token it didn't issue as it is asked for a
 * token. It records each request it answers, but never a password, nor
 * prints a token or key.
 */

/** The MSmartHome app's key and IoT key, as its `authorization` header carries them, in base64. */
const APP_CREDENTIALS = Buffer.from("ac21b9f9cbfe4ca5a88562ef25e2b768:meicloud").toString("base64");

/** Which app's cloud a fake is. */
export type FakeCloudApp = "MSmartHome" | "Midea Air";

/** A unit the fake cloud issues a token and key for: its id, and the token and key, in hex. */
export interface FakeCloudUnit {
  readonly id: number;
  readonly token: string;
  readonly key: string;
  /**
   * The id, in decimal, the account knows it by, which MSmartHome lists it
   * by and is asked for its token with: by default its own id, as for most
   * units, though some accounts know a unit by another.
   */
  readonly applianceCode?: string;
}

/** One request the fake cloud answered, oldest first. */
export interface FakeCloudRequest {
  /** When it answered it, in milliseconds since the epoch. */
  readonly receivedAt: number;
  /** One of `/v1/user/login/id/get`, `/mj/user/login` (`/v1/user/login` for Midea Air) and `/v1/iot/secure/getToken`, or whatever else was asked. */
  readonly path: string;
  /**
   * "accepted", or "refused" with why: a bad signature, a wrong login, an
   * access token it didn't issue, a unit it doesn't know, a token asked for
   * without the unit's appliance code or with another's, or tokens retired.
   */
  readonly outcome:
    | "accepted"
    | "bad-signature"
    | "wrong-login"
    | "not-signed-in"
    | "unknown-unit"
    | "no-appliance-code"
    | "not-permitted"
    | "retired"
    | "bad-request"
    | "not-found";
}

export interface FakeMideaCloudOptions {
  readonly host?: string;
  /** 0, the default, picks a free one. */
  readonly port?: number;
  /** Which app's cloud it is: MSmartHome's, the default, or Midea Air's, Midea's older cloud, with accounts of its own. */
  readonly app?: FakeCloudApp;
  /** The account it signs in, of that app. */
  readonly account: string;
  /**
   * As Midea Air's, whether it answers every token request with Midea's
   * "system error", 9999, as the real one has since Midea stopped issuing
   * tokens to its accounts, signing them in all the same.
   */
  readonly tokensRetired?: boolean;
  readonly password: string;
  readonly units?: readonly FakeCloudUnit[];
  /**
   * As MSmartHome's, the path of the regional server that holds the account,
   * e.g. "eu", which the router answers and which alone knows it; by
   * default the server itself does.
   */
  readonly region?: string;
  /**
   * As MSmartHome's, which of Midea's routers answers: both, the default;
   * the legacy one alone, asked by the account as it is; or neither.
   */
  readonly routers?: "both" | "legacy" | "none";
}

export interface FakeMideaCloud {
  readonly host: string;
  readonly port: number;
  /** What to give the Midea Driver as `MIDEA_CLOUD_URL`. */
  readonly url: string;
  /** Replaces the units it issues tokens and keys for, as after a unit is factory reset and paired again in Midea's app. */
  readonly setUnits: (units: readonly FakeCloudUnit[]) => void;
  readonly requests: readonly FakeCloudRequest[];
  readonly clear: () => void;
  readonly stop: () => Promise<void>;
}

/** Where `GET /_fake/requests` lists the requests answered, and `DELETE` forgets them. */
export const FAKE_CLOUD_REQUESTS_PATH = "/_fake/requests";
/**
 * Where `PUT /_fake/units` with `[{"id": 1234, "token": "…", "key": "…"}]`
 * replaces the units issued tokens and keys, and `GET` lists their ids.
 */
export const FAKE_CLOUD_UNITS_PATH = "/_fake/units";

/** The units in a `PUT /_fake/units`, or undefined if it isn't a list of them. */
export const fakeCloudUnitsIn = (read: unknown): FakeCloudUnit[] | undefined => {
  if (!Array.isArray(read)) return undefined;
  const units: FakeCloudUnit[] = [];
  for (const each of read as unknown[]) {
    const { id, token, key, applianceCode } = (each ?? {}) as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id >= 2 ** 48) return undefined;
    if (typeof token !== "string" || !/^[0-9a-fA-F]{128}$/.test(token)) return undefined;
    if (typeof key !== "string" || !/^[0-9a-fA-F]{64}$/.test(key)) return undefined;
    if (applianceCode !== undefined && (typeof applianceCode !== "string" || !/^\d+$/.test(applianceCode)))
      return undefined;
    units.push({ id, token, key, ...(applianceCode === undefined ? {} : { applianceCode }) });
  }
  return units;
};

/** Starts a fake Midea cloud listening on loopback, by default on a free port. */
export const startFakeMideaCloud = async ({
  host = "127.0.0.1",
  port = 0,
  app = "MSmartHome",
  tokensRetired = false,
  account,
  password,
  units: initial = [],
  region,
  routers = "both",
}: FakeMideaCloudOptions): Promise<FakeMideaCloud> => {
  let units = [...initial];
  const requests: FakeCloudRequest[] = [];
  const loginId = randomUUID();
  const accessTokens = new Set<string>();
  const sessionIds = new Set<string>();

  /** The id, in decimal, the account knows a unit by. */
  const codeOf = (unit: FakeCloudUnit): string => unit.applianceCode ?? String(unit.id);

  /** The unit it knows by this UDP id, as far as anyone knows hashed little-endian, or undefined. */
  const unitFor = (udpId: string): FakeCloudUnit | undefined =>
    units.find(({ id }) => cloudUdpId(id, "little") === udpId);

  /** As Midea's older cloud answers a form, signed its way, with `errorCode` and `result`. */
  const answerMideaAir = (path: string, fields: Readonly<Record<string, string>>) => {
    const refuse = (outcome: FakeCloudRequest["outcome"], errorCode: number, msg: string) => ({
      outcome,
      reply: { errorCode: String(errorCode), msg },
    });
    const accept = (result: unknown) => ({
      outcome: "accepted" as const,
      reply: { errorCode: "0", msg: "ok", result },
    });
    switch (path) {
      case LOGIN_ID_PATH:
        if (fields.loginAccount !== account) return refuse("wrong-login", 3102, "this account does not exist");
        return accept({ loginId });
      case MIDEA_AIR_LOGIN_PATH: {
        if (fields.loginAccount !== account || fields.password !== mideaAirPassword(loginId, password)) {
          return refuse("wrong-login", 3105, "password error");
        }
        const sessionId = randomBytes(16).toString("hex");
        sessionIds.add(sessionId);
        return accept({ sessionId, accessToken: randomBytes(32).toString("hex") });
      }
      case TOKEN_PATH: {
        if (fields.sessionId === undefined || !sessionIds.has(fields.sessionId)) {
          return refuse("not-signed-in", 3106, "invalid session");
        }
        if (tokensRetired) return refuse("retired", Number(TOKENS_RETIRED_CODE), "system error");
        const udpId = fields.udpid ?? "";
        const unit = unitFor(udpId);
        if (unit === undefined) return refuse("unknown-unit", 3176, "device not found");
        return accept({ tokenlist: [{ udpId, token: unit.token.toUpperCase(), key: unit.key.toUpperCase() }] });
      }
      default:
        return refuse("not-found", 404, "no such path");
    }
  };

  const answer = (
    path: string,
    body: Record<string, unknown>,
    headers: IncomingMessage["headers"],
    /** Whether it was asked as the server that holds the account. */
    holder: boolean,
  ) => {
    const refuse = (outcome: FakeCloudRequest["outcome"], code: number, msg: string) => ({
      outcome,
      reply: { code, msg },
    });
    const accept = (data: unknown) => ({ outcome: "accepted" as const, reply: { code: "0", msg: "ok", data } });
    /** The server that holds the account, as its router answers it. */
    const masUrl = `http://${headers.host ?? host}${region === undefined ? "" : `/${region}`}?alias=`;
    switch (path) {
      // As the real routers answer: without the app's headers, or its platform's id, they refuse the request itself.
      case ROUTER_PATH:
        if (routers !== "both") return refuse("not-found", 404, "no such path");
        if (headers["x-recipe-app"] !== CLOUD_APP_ID || headers.authorization !== `Basic ${APP_CREDENTIALS}`)
          return refuse("bad-request", 40400, "request invalid");
        if (body.userName !== encryptCloudAccount(account))
          return refuse("wrong-login", 10004, "The user router is not exist");
        return accept({ masUrl });
      case LEGACY_ROUTER_PATH:
        if (routers === "none") return refuse("not-found", 404, "no such path");
        if (body.platformId === undefined) return refuse("bad-request", 3004, "platformId can't be empty");
        if (body.userName !== account) return refuse("wrong-login", 10004, "user route does not exist");
        return accept({ masUrl });
      case LOGIN_ID_PATH:
        if (!holder || body.loginAccount !== account) return refuse("wrong-login", 3102, "account does not exist");
        return accept({ loginId });
      case LOGIN_PATH: {
        const iot = (body.iotData ?? {}) as Record<string, unknown>;
        if (
          iot.loginAccount !== account ||
          iot.password !== cloudPassword(loginId, password) ||
          iot.iampwd !== cloudIamPassword(loginId, password)
        ) {
          return refuse("wrong-login", 3101, "password error");
        }
        const accessToken = randomBytes(32).toString("hex");
        accessTokens.add(accessToken);
        return accept({ mdata: { accessToken } });
      }
      case TOKEN_PATH: {
        const given = headers.accesstoken;
        if (typeof given !== "string" || !accessTokens.has(given))
          return refuse("not-signed-in", 40001, "not logged in");
        const udpId = typeof body.udpid === "string" ? body.udpid : "";
        // Without the id the account knows the unit by, as msmart's own users found.
        if (typeof body.applianceCodes !== "string" || body.applianceCodes === "") {
          return refuse("no-appliance-code", 3004, "value is illegal.");
        }
        // As far as anyone knows, the cloud hashes the id little-endian.
        const unit = unitFor(udpId);
        if (unit === undefined) return refuse("unknown-unit", 3176, "device not found");
        if (codeOf(unit) !== body.applianceCodes) return refuse("not-permitted", 3201, "You have no permissions");
        // In upper case, as msmart-ng's examples show the cloud's.
        return accept({ tokenlist: [{ udpId, token: unit.token.toUpperCase(), key: unit.key.toUpperCase() }] });
      }
      case APPLIANCE_LIST_PATH: {
        const given = headers.accesstoken;
        if (typeof given !== "string" || !accessTokens.has(given))
          return refuse("not-signed-in", 40001, "not logged in");
        return accept({ list: units.map((unit) => ({ id: codeOf(unit), type: "0xAC", name: "Air Conditioner" })) });
      }
      default:
        return refuse("not-found", 404, "no such path");
    }
  };

  const server = createServer((request, response) => {
    void readBody(request).then((text) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === FAKE_CLOUD_REQUESTS_PATH) {
        if (request.method === "DELETE") requests.length = 0;
        sendJson(response, 200, requests);
        return;
      }
      if (url.pathname === FAKE_CLOUD_UNITS_PATH) {
        if (request.method === "PUT") {
          let read: unknown;
          try {
            read = JSON.parse(text);
          } catch {
            read = undefined;
          }
          const given = fakeCloudUnitsIn(read);
          if (given === undefined) {
            sendJson(response, 400, {
              message: 'Send the units, e.g. [{"id": 1234, "token": "<128 hex digits>", "key": "<64 hex digits>"}]',
            });
            return;
          }
          units = given;
        }
        sendJson(
          response,
          200,
          units.map(({ id }) => ({ id })),
        );
        return;
      }

      // The real API is reached through a proxy, with the path as its `alias`.
      const path = url.searchParams.get("alias") ?? url.pathname;
      const record = (outcome: FakeCloudRequest["outcome"]): void => {
        requests.push({ receivedAt: Date.now(), path, outcome });
      };
      if (app === "Midea Air") {
        const fields = Object.fromEntries(new URLSearchParams(text));
        const { sign, ...signed } = fields;
        if (request.method !== "POST" || sign !== signMideaAirRequest(url.pathname, signed)) {
          record("bad-signature");
          sendJson(response, 200, { errorCode: "3301", msg: "sign illegal" });
          return;
        }
        const { outcome, reply } = answerMideaAir(url.pathname, signed);
        record(outcome);
        sendJson(response, 200, reply);
        return;
      }
      const random = request.headers.random;
      if (
        request.method !== "POST" ||
        typeof random !== "string" ||
        request.headers.sign !== signCloudRequest(text, random)
      ) {
        record("bad-signature");
        sendJson(response, 200, { code: 1001, msg: "sign illegal" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
      const { outcome, reply } = answer(
        path,
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
        request.headers,
        region === undefined || url.pathname === `/${region}`,
      );
      record(outcome);
      sendJson(response, 200, reply);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const listening = (server.address() as AddressInfo).port;
  let stopped: Promise<void> | undefined;

  return {
    host,
    port: listening,
    url: `http://${host}:${String(listening)}`,
    setUnits: (given) => {
      units = [...given];
    },
    requests,
    clear: () => {
      requests.length = 0;
    },
    stop: () =>
      (stopped ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      })),
  };
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk as string;
  return body;
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
};
