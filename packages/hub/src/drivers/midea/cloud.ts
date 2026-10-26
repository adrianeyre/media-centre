/**
 * Midea's clouds, as the MSmartHome and Midea Air apps sign in to them, which the Midea Driver
 * asks once for a v3 unit's token and key, as it is added or as they are
 * fetched again, and never again for that unit (ADR 0009). Nothing controls
 * a unit through it (ADR 0007). Only the Midea Driver and the fake Midea
 * cloud know this (NFR-6).
 *
 * It is written from msmart-ng's `SmartHomeCloud`, which signs in as the
 * MSmartHome app does, and midea-local's, which first asks Midea's router
 * which of its regional servers holds the account, as the app does: an
 * account made in the UK or Europe is held on Europe's, and every other
 * server answers 3102, "account does not exist", for it. Then the account's
 * login id from `/v1/user/login/id/get`,
 * then `/mj/user/login` with the password hashed with that id, for an access
 * token, then `/v1/iot/secure/getToken` with the unit's UDP id, for its token
 * and key. No test ever reaches the real endpoint, so what follows is
 * uncertain where a real account may prove msmart-ng wrong, and is to be
 * corrected in the fake first, then here:
 *
 * - the app's id, key, IoT key and HMAC key, which msmart-ng publishes, and
 *   which Midea could change with a new version of its app;
 * - the router, which midea-local asks by the account encrypted, then, if
 *   that doesn't answer, by the account as it is, and which answers the
 *   server to use as `masUrl`; asked neither way, or answering neither, the
 *   Hub signs in to the server it was given, as before;
 * - which of the request's fields the cloud checks, and its error codes: any
 *   code but 0 in signing in is taken as the login refused;
 * - whether the cloud answers a UDP id it doesn't know with an error or an
 *   empty list, both taken as having no token for it;
 * - which byte order the unit's id is hashed in for its UDP id: msmart-ng
 *   tries little-endian first, then big, and so does the Driver, keeping the
 *   first token and key the unit accepts.
 *
 * Midea Air, and NetHome Plus, whose accounts it shares, sign in to Midea's
 * older cloud instead, with accounts of their own: one the other has never
 * heard of. It is written from midea-beautiful-air's and msmart-ng's
 * `NetHomePlusCloud`: the same login id, then `/v1/user/login` with the
 * password hashed with that id and the app's key, for a session id, then the
 * same token path. Every request is a form, signed with a SHA-256 of its
 * path, its fields in order and the app's key, and every answer has
 * `errorCode` and `result` where MSmartHome's has `code` and `data`. The
 * same is uncertain of it as of MSmartHome's, but its login id has been
 * seen to answer as written here, for an account it knows and one it
 * doesn't.
 *
 * Nothing here logs but what Midea's router answered, by its code or the
 * server it named, and nothing logged or thrown quotes the login, the access
 * token or session id, or a unit's token or key (FR-51).
 */
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import { xor } from "./security.ts";

/**
 * The MSmartHome app's API, as msmart-ng reaches it: each path is appended to
 * this, as the proxy's `alias`. `MIDEA_CLOUD_URL` puts the fake cloud in its
 * place in tests.
 */
// eslint-disable-next-line media-centre/no-internet-urls -- asked once per v3 unit as it is added, never to control one (ADR 0009)
export const MIDEA_CLOUD_URL = "https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=";

/** Where Midea's router says which regional server holds an account, asked by the account encrypted. */
export const ROUTER_PATH = "/v1/unitcenter/router/user/name";
/** The router as it was asked before, by the account as it is, which midea-local asks if the other doesn't answer. */
export const LEGACY_ROUTER_PATH = "/v1/multicloud/platform/user/route";
export const LOGIN_ID_PATH = "/v1/user/login/id/get";
export const LOGIN_PATH = "/mj/user/login";
export const TOKEN_PATH = "/v1/iot/secure/getToken";
/** Where MSmartHome lists the appliances paired to the account, each by the id the account knows it by. */
export const APPLIANCE_LIST_PATH = "/v1/appliance/user/list/get";

/**
 * Midea's older cloud, which the Midea Air and NetHome Plus apps sign in to.
 * `MIDEA_AIR_CLOUD_URL` puts the fake cloud in its place in tests.
 */
// eslint-disable-next-line media-centre/no-internet-urls -- asked once per v3 unit as it is added, never to control one (ADR 0009)
export const MIDEA_AIR_CLOUD_URL = "https://mapp.appsmb.com";

/** Where Midea Air signs in, with the password hashed, for a session id. */
export const MIDEA_AIR_LOGIN_PATH = "/v1/user/login";

/** The Midea Air app's id and key, as midea-beautiful-air publishes them. */
export const MIDEA_AIR_APP_ID = "1117";
const MIDEA_AIR_APP_KEY = "ff0cf6f5f0c3471de36341cab3f7a9af";

/** The MSmartHome app's id and keys, as msmart-ng publishes them. */
export const CLOUD_APP_ID = "1010";
const APP_KEY = "ac21b9f9cbfe4ca5a88562ef25e2b768";
const IOT_KEY = "meicloud";
const HMAC_KEY = "PROD_VnoClJI9aikS8dyy";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "ascii").digest("hex");
const md5Hex = (text: string): string => createHash("md5").update(text, "ascii").digest("hex");

/** The `sign` header of a request: an HMAC of its body and its `random` header. */
export const signCloudRequest = (body: string, random: string): string =>
  createHmac("sha256", HMAC_KEY).update(`${IOT_KEY}${body}${random}`, "utf8").digest("hex");

/**
 * The account as the router takes it: AES-128-CBC, its key and IV the first
 * and second 16 hex digits of the SHA-256 of the app's key, in hex.
 */
export const encryptCloudAccount = (account: string): string => {
  const digest = sha256Hex(APP_KEY);
  const cipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from(digest.slice(0, 16), "ascii"),
    Buffer.from(digest.slice(16, 32), "ascii"),
  );
  return Buffer.concat([cipher.update(account, "utf8"), cipher.final()]).toString("hex");
};

/** The password as `/mj/user/login` takes it, hashed with the account's login id. */
export const cloudPassword = (loginId: string, password: string): string =>
  sha256Hex(`${loginId}${sha256Hex(password)}${APP_KEY}`);

/**
 * The `sign` field of a request to Midea Air's cloud: the SHA-256 of its
 * path, its fields as `name=value` in order of name, joined by `&`, as they
 * are and not URL-encoded, and the app's key.
 */
export const signMideaAirRequest = (path: string, fields: Readonly<Record<string, string>>): string =>
  sha256Hex(
    `${path}${Object.keys(fields)
      .sort()
      .map((name) => `${name}=${fields[name] ?? ""}`)
      .join("&")}${MIDEA_AIR_APP_KEY}`,
  );

/** The password as Midea Air's `/v1/user/login` takes it, hashed with the account's login id. */
export const mideaAirPassword = (loginId: string, password: string): string =>
  sha256Hex(`${loginId}${sha256Hex(password)}${MIDEA_AIR_APP_KEY}`);

/** The password as `/mj/user/login` takes it a second time, as `iampwd`. */
export const cloudIamPassword = (loginId: string, password: string): string =>
  sha256Hex(`${loginId}${md5Hex(md5Hex(password))}${APP_KEY}`);

/**
 * The id the cloud knows a unit by: the SHA-256 of its 6-byte id, its two
 * halves XORed together, in lower-case hex.
 */
export const cloudUdpId = (id: number, byteOrder: "little" | "big"): string => {
  const bytes = Buffer.alloc(6);
  if (byteOrder === "little") bytes.writeUIntLE(id, 0, 6);
  else bytes.writeUIntBE(id, 0, 6);
  const digest = createHash("sha256").update(bytes).digest();
  return xor(digest.subarray(0, 16), digest.subarray(16)).toString("hex");
};

/** What the cloud answers every request with: `code` 0, as a number or text, and `data`, or another code and why. */
export interface CloudAnswer {
  readonly code: number | string;
  readonly msg?: string;
  readonly data?: unknown;
}

/** The cloud couldn't be reached, or answered as something else. */
export class CloudUnreachable extends Error {
  constructor(options?: ErrorOptions) {
    super("Midea's cloud didn't answer", options);
    this.name = "CloudUnreachable";
  }
}

/** The cloud refused the login, with the code it gave, which says nothing of the login. */
export class CloudLoginRefused extends Error {
  readonly code: string | undefined;
  constructor(code?: string) {
    super(`Midea's cloud refused the login${code === undefined ? "" : ` with code ${code}`}`);
    this.name = "CloudLoginRefused";
    this.code = code;
  }
}

/**
 * The cloud has no token and key for that UDP id: `why` says what it
 * answered instead, never a token, and `code` is its code, where it gave one.
 */
export class CloudHasNoToken extends Error {
  readonly why: string;
  readonly code: string | undefined;
  constructor(answered: boolean, code: string | undefined, issued: number) {
    const why = answered
      ? `it answered ${String(issued)} tokens, none for that id`
      : `it answered code ${code ?? "unknown"}`;
    super(`Midea's cloud has no token for that unit: ${why}`);
    this.name = "CloudHasNoToken";
    this.why = why;
    this.code = answered ? undefined : code;
  }
}

/**
 * What Midea Air's cloud has answered every token request with since Midea
 * stopped issuing tokens to its accounts, signing them in all the same: its
 * "system error", for every unit and every library that asks.
 */
export const TOKENS_RETIRED_CODE = "9999";

export interface CloudOptions {
  /** {@link MIDEA_CLOUD_URL}, or the fake cloud's. */
  readonly baseUrl: string;
  /** How long the cloud has to answer each request. */
  readonly timeoutMs: number;
  /** Told what Midea's router answered: the server it named, or its code. */
  readonly log?: (line: string) => void;
}

/**
 * The MSmartHome app's `authorization` header, which midea-local sends with
 * every request, and without which the router answers 40400, "request
 * invalid".
 */
const APP_AUTHORIZATION = `Basic ${Buffer.from(`${APP_KEY}:${IOT_KEY}`).toString("base64")}`;

/** The token and key the cloud issued for a unit, in lower-case hex. */
export interface IssuedKeys {
  readonly token: string;
  readonly key: string;
}

/** A signed-in session with the cloud, which asks it for each unit's token and key. */
export interface CloudSession {
  /**
   * The token and key for the unit with `udpId`, which MSmartHome issues only
   * when asked with `applianceCode` too, the unit's id as the account knows
   * it, in decimal. Rejects with {@link CloudHasNoToken} when it has none,
   * and {@link CloudUnreachable} as signing in does.
   */
  readonly tokenFor: (udpId: string, applianceCode: string) => Promise<IssuedKeys>;
  /**
   * The ids, in decimal, the account knows its Air Conditioners by, which may
   * not be their own, or none where the cloud doesn't list them.
   */
  readonly airConditionerCodes: () => Promise<string[]>;
}

const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

/**
 * Signs in to Midea's cloud with the owner's login, which is used for this
 * alone and kept nowhere. Rejects with {@link CloudLoginRefused} for a login
 * it refuses, and {@link CloudUnreachable} when it can't be reached.
 */
export const signInToMideaCloud = async (
  login: { readonly account: string; readonly password: string },
  { baseUrl, timeoutMs, log = () => undefined }: CloudOptions,
): Promise<CloudSession> => {
  // The app's own id for the phone it runs on, which msmart-ng makes up.
  const deviceId = randomBytes(8).toString("hex");
  /** Given once signed in, and sent with each request after. */
  const session: { accessToken?: string } = {};
  /** The code of the last answer that wasn't 0, which says why. */
  let refusedWith: string | undefined;
  /** {@link refusedWith}, read after an answer has set it. */
  const lastRefusal = (): string | undefined => refusedWith;
  /** The server that holds the account, as the router says, else the one given. */
  let server = baseUrl;

  const common = (): Record<string, unknown> => ({
    appId: CLOUD_APP_ID,
    format: 2,
    clientType: 1,
    language: "en_US",
    src: CLOUD_APP_ID,
    stamp: stamp(),
    deviceId,
    reqId: randomBytes(16).toString("hex"),
    // Without it, the legacy router answers 3004, "platformId can't be empty".
    platformId: "1",
  });

  /** The answer's `data`, or undefined for any code but 0. */
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    const text = JSON.stringify(body);
    const random = String(Math.floor(Date.now() / 1000));
    let read: unknown;
    try {
      const response = await fetch(`${server}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          secretVersion: "1",
          sign: signCloudRequest(text, random),
          random,
          "x-recipe-app": CLOUD_APP_ID,
          authorization: APP_AUTHORIZATION,
          ...(session.accessToken === undefined ? {} : { accessToken: session.accessToken }),
        },
        body: text,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      read = await response.json();
    } catch (error) {
      // Never what JSON.parse said of the answer, which quotes it, and it may hold a token.
      throw new CloudUnreachable(error instanceof SyntaxError ? undefined : { cause: error });
    }
    if (typeof read !== "object" || read === null || !("code" in read)) throw new CloudUnreachable();
    const answer = read as CloudAnswer;
    if (Number(answer.code) !== 0) {
      refusedWith = String(answer.code);
      return undefined;
    }
    return typeof answer.data === "object" && answer.data !== null ? (answer.data as Record<string, unknown>) : {};
  };

  /**
   * The server the router says holds the account, if it answers one by the
   * same protocol as the one given, so that a real one is only ever https.
   * Nothing is lost where it doesn't: the server given is asked, as before.
   */
  const routed = async (path: string, body: Record<string, unknown>): Promise<string | undefined> => {
    try {
      refusedWith = undefined;
      const answer = await post(path, body);
      const code = lastRefusal();
      const masUrl = answer?.masUrl;
      if (typeof masUrl === "string" && new URL(masUrl).protocol === new URL(baseUrl).protocol) {
        log(`Midea's router at ${path} says the MSmartHome account is held at ${new URL(masUrl).host}`);
        return masUrl;
      }
      log(`Midea's router at ${path} named no server for the MSmartHome account: it answered code ${code ?? "0"}`);
    } catch {
      // The router not answering is no reason not to try the server given.
      log(`Midea's router at ${path} didn't answer`);
    }
    return undefined;
  };
  server =
    (await routed(ROUTER_PATH, {
      ...common(),
      clientType: 8,
      clientSrc: 8,
      userType: "0",
      userName: encryptCloudAccount(login.account),
    })) ??
    (await routed(LEGACY_ROUTER_PATH, { ...common(), userType: "0", userName: login.account })) ??
    baseUrl;
  refusedWith = undefined;

  const loginId = (await post(LOGIN_ID_PATH, { ...common(), loginAccount: login.account }))?.loginId;
  if (typeof loginId !== "string") throw new CloudLoginRefused(refusedWith);

  const signedIn = await post(LOGIN_PATH, {
    data: { platform: 2, deviceId },
    iotData: {
      appId: CLOUD_APP_ID,
      clientType: 1,
      iampwd: cloudIamPassword(loginId, login.password),
      loginAccount: login.account,
      password: cloudPassword(loginId, login.password),
      pushToken: randomBytes(90).toString("base64url"),
      reqId: randomBytes(16).toString("hex"),
      src: CLOUD_APP_ID,
      stamp: stamp(),
    },
    timestamp: stamp(),
    stamp: stamp(),
    reqId: randomBytes(16).toString("hex"),
  });
  const mdata = signedIn?.mdata as { accessToken?: unknown } | undefined;
  if (typeof mdata?.accessToken !== "string") throw new CloudLoginRefused(refusedWith);
  session.accessToken = mdata.accessToken;

  return {
    tokenFor: async (udpId, applianceCode) => {
      refusedWith = undefined;
      // Without the id the account knows the unit by, it answers 3004, "value is illegal".
      const data = await post(TOKEN_PATH, { ...common(), udpid: udpId, applianceCodes: applianceCode });
      const list = Array.isArray(data?.tokenlist) ? (data.tokenlist as unknown[]) : [];
      for (const each of list) {
        const { udpId: id, token, key } = (each ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || id.toLowerCase() !== udpId) continue;
        if (typeof token !== "string" || typeof key !== "string") continue;
        return { token: token.toLowerCase(), key: key.toLowerCase() };
      }
      throw new CloudHasNoToken(data !== undefined, refusedWith, list.length);
    },
    airConditionerCodes: async () => {
      const data = await post(APPLIANCE_LIST_PATH, common());
      const list = Array.isArray(data?.list) ? (data.list as unknown[]) : [];
      const codes: string[] = [];
      for (const each of list) {
        const { id, type } = (each ?? {}) as Record<string, unknown>;
        if (typeof type !== "string" || type.toLowerCase() !== "0xac") continue;
        if ((typeof id === "string" && /^\d+$/.test(id)) || (typeof id === "number" && Number.isSafeInteger(id))) {
          codes.push(String(id));
        }
      }
      return codes;
    },
  };
};

/** What Midea Air's cloud answers every request with: `errorCode` 0, as text or a number, and `result`, or another code and why. */
export interface MideaAirCloudAnswer {
  readonly errorCode: number | string;
  readonly msg?: string;
  readonly result?: unknown;
}

/**
 * Signs in to Midea's older cloud as the Midea Air app does, with the
 * owner's login, which is used for this alone and kept nowhere. Rejects with
 * {@link CloudLoginRefused} for a login it refuses, as for an account only
 * MSmartHome knows, and {@link CloudUnreachable} when it can't be reached.
 */
export const signInToMideaAirCloud = async (
  login: { readonly account: string; readonly password: string },
  { baseUrl, timeoutMs }: CloudOptions,
): Promise<CloudSession> => {
  /** Given once signed in, and sent with each request after. */
  const session: { sessionId?: string } = {};
  let refusedWith: string | undefined;

  /** The answer's `result`, or undefined for any code but 0. */
  const post = async (path: string, given: Record<string, string>): Promise<Record<string, unknown> | undefined> => {
    const fields: Record<string, string> = {
      appId: MIDEA_AIR_APP_ID,
      format: "2",
      clientType: "1",
      language: "en_US",
      src: MIDEA_AIR_APP_ID,
      stamp: stamp(),
      ...given,
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
    };
    let read: unknown;
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, sign: signMideaAirRequest(path, fields) }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      read = await response.json();
    } catch (error) {
      // Never what JSON.parse said of the answer, which quotes it, and it may hold a token.
      throw new CloudUnreachable(error instanceof SyntaxError ? undefined : { cause: error });
    }
    if (typeof read !== "object" || read === null || !("errorCode" in read)) throw new CloudUnreachable();
    const answer = read as MideaAirCloudAnswer;
    if (Number(answer.errorCode) !== 0) {
      refusedWith = String(answer.errorCode);
      return undefined;
    }
    return typeof answer.result === "object" && answer.result !== null
      ? (answer.result as Record<string, unknown>)
      : {};
  };

  const loginId = (await post(LOGIN_ID_PATH, { loginAccount: login.account }))?.loginId;
  if (typeof loginId !== "string") throw new CloudLoginRefused(refusedWith);

  const signedIn = await post(MIDEA_AIR_LOGIN_PATH, {
    loginAccount: login.account,
    password: mideaAirPassword(loginId, login.password),
  });
  if (typeof signedIn?.sessionId !== "string") throw new CloudLoginRefused(refusedWith);
  session.sessionId = signedIn.sessionId;

  return {
    // It takes no appliance code, and lists nothing: neither has been seen to help it.
    tokenFor: async (udpId) => {
      refusedWith = undefined;
      const result = await post(TOKEN_PATH, { udpid: udpId });
      const list = Array.isArray(result?.tokenlist) ? (result.tokenlist as unknown[]) : [];
      for (const each of list) {
        const { udpId: id, token, key } = (each ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || id.toLowerCase() !== udpId) continue;
        if (typeof token !== "string" || typeof key !== "string") continue;
        return { token: token.toLowerCase(), key: key.toLowerCase() };
      }
      throw new CloudHasNoToken(result !== undefined, refusedWith, list.length);
    },
    airConditionerCodes: () => Promise.resolve([]),
  };
};
