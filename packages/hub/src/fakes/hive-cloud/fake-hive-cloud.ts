import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { NODES_PATH } from "../../drivers/hive/beekeeper.ts";
import { COGNITO_TARGET, HIVE_CLIENT_ID, POOL_NAME } from "../../drivers/hive/cognito.ts";
import { HIVE_MODES, PRODUCT_TYPES } from "../../drivers/hive/nodes.ts";
import {
  claimSignature,
  serverEphemeral,
  serverKey,
  verifierFor,
  verifierFromBase64,
  type ServerEphemeral,
} from "../../drivers/hive/srp.ts";

/**
 * A fake of Hive's cloud, as far as the Hive Driver uses it (FR-68a): Hive's
 * sign-in service, AWS Cognito's user pool, for one account, and Hive's API,
 * "beekeeper", for the Heating zones, Radiator Valves and Hot Water on it.
 * No test reaches the real one. When the real one turns out to behave
 * differently, change this first, then the Hive Driver (ADR 0004).
 *
 * It signs the account in as Cognito does, checking the password's SRP
 * claim with the same arithmetic as the Driver's (`srp.ts`), so that a slip
 * in it shows only against the real Cognito; then, when it is given a
 * `code`, asks for it, as Hive's two-step verification does, within 3
 * minutes of its clock; issues the new device a key and group key, which it
 * trusts once it is confirmed and remembered, letting it in by its own SRP
 * claim with no code from then on; and renews the access and id tokens,
 * which last 60 minutes of its clock, with the refresh token, until they are
 * revoked. It lists its products and devices as beekeeper does to an id
 * token it issued, and takes changes to each product as Hive does: a Boost
 * counts its minutes down on its clock, which a test moves on, and goes back
 * to the mode and target it had before.
 *
 * It records each request it answers, with whether it took it and, for a
 * change, what it asked, but never a password, code, token or device key,
 * nor prints one.
 */

/** Which of a Heating zone, a Radiator Valve and the Hot Water a product is. */
export type FakeHiveKind = keyof typeof PRODUCT_TYPES;

export const FAKE_HIVE_KINDS: readonly FakeHiveKind[] = ["heating", "radiator-valve", "hot-water"];

/** A product the fake Hive cloud has, as a test gives it, its state as Hive's app would show it. */
export interface FakeHiveProduct {
  readonly kind: FakeHiveKind;
  readonly name: string;
  /** Hive's id for it; by default one made from its kind and name, the same each time. */
  readonly id?: string;
  /** A Radiator Valve's Heating, by its name. */
  readonly zone?: string;
  /** "schedule", the default, "manual" or "off"; for the Hot Water, "schedule", "on" or "off". */
  readonly mode?: FakeHiveMode;
  /** In °C; 20 by default, and none for the Hot Water. */
  readonly target?: number;
  /** The temperature it reads, in °C; 19.5 by default, and none for the Hot Water. */
  readonly temperature?: number | null;
  /** Whether it is calling for heat, or the Hot Water is heating; false by default. */
  readonly working?: boolean;
  /** Whether Hive can reach it; true by default. */
  readonly online?: boolean;
  /** A Radiator Valve's battery, in percent; 100 by default. */
  readonly battery?: number;
  /** The targets it takes, 5° to 32° by default. */
  readonly min?: number;
  readonly max?: number;
}

/** A product's mode, as Hive's app shows it: during a Boost, "boost". */
export type FakeHiveMode = "schedule" | "manual" | "on" | "off" | "boost";

/** A product as `GET /_fake/state` says it is now. */
export interface FakeHiveProductState {
  readonly id: string;
  readonly kind: FakeHiveKind;
  readonly name: string;
  readonly mode: FakeHiveMode;
  /** In °C, or null for the Hot Water. */
  readonly target: number | null;
  /** The minutes its Boost has left, or null for none. */
  readonly boost: number | null;
  readonly temperature: number | null;
  readonly working: boolean;
  readonly online: boolean;
  /** A Radiator Valve's, or null. */
  readonly battery: number | null;
  /** A Radiator Valve's Heating, by its name, or null. */
  readonly zone: string | null;
  /** Whether it refuses every change, as Hive refuses one it won't take. */
  readonly refusesChanges: boolean;
}

/** One request the fake answered, oldest first. */
export interface FakeHiveRequest {
  /** When it answered it, in milliseconds since the epoch. */
  readonly receivedAt: number;
  /** Its clock then, in minutes. */
  readonly minute: number;
  /** A sign-in step, by Cognito's operation and its flow or challenge, e.g. "RespondToAuthChallenge SMS_MFA", or the API's method and path. */
  readonly request: string;
  readonly outcome:
    | "accepted"
    | "wrong-login"
    | "wrong-code"
    | "expired-session"
    | "wrong-device"
    | "not-signed-in"
    | "refused"
    | "unknown-product"
    | "not-found"
    /** Its connection dropped unanswered, while it is down, as Hive's cloud is with the internet down. */
    | "dropped";
  /** For a change to a product, which, by its id. */
  readonly product?: string;
  /** For a change to a product, what it asked, as Hive's API was sent it. */
  readonly change?: Readonly<Record<string, unknown>>;
}

export interface FakeHiveCloudOptions {
  readonly host?: string;
  /** 0, the default, picks a free one. */
  readonly port?: number;
  /** The one account it signs in: the Hive account owner's email and password. */
  readonly account: string;
  readonly password: string;
  /** The code it asks for at sign-in, as Hive texts it; left out, it asks for none. */
  readonly code?: string;
  /** Its Heating zones, Radiator Valves and Hot Water; by default {@link FAKE_HIVE_HOME}. */
  readonly products?: readonly FakeHiveProduct[];
}

/** Two Heating zones, three Radiator Valves and the Hot Water, as the household's Hive has. */
export const FAKE_HIVE_HOME: readonly FakeHiveProduct[] = [
  { kind: "heating", name: "Downstairs" },
  { kind: "heating", name: "Upstairs", target: 19 },
  { kind: "radiator-valve", name: "Bedroom", zone: "Upstairs", target: 18 },
  { kind: "radiator-valve", name: "Study", zone: "Upstairs", battery: 15 },
  { kind: "radiator-valve", name: "Living Room", zone: "Downstairs", target: 21 },
  { kind: "hot-water", name: "Hot Water" },
];

export interface FakeHiveCloud {
  readonly host: string;
  readonly port: number;
  /** What to give the Hive Driver, and the Hub, as both `HIVE_URL` and `HIVE_AUTH_URL`. */
  readonly url: string;
  readonly products: () => FakeHiveProductState[];
  /** Changes a product as Hive's app, or the weather, would; see `POST /_fake/state`. Throws for one it hasn't. */
  readonly setProduct: (id: string, change: Readonly<Record<string, unknown>>) => void;
  /** Replaces its products. */
  readonly setProducts: (products: readonly FakeHiveProduct[]) => void;
  /** Refuses every token it issued from now on, and with `devices`, forgets the devices it trusts too. */
  readonly revoke: (devices?: boolean) => void;
  /** Moves its clock on, counting Boosts down and expiring tokens and sessions. */
  readonly advance: (minutes: number) => void;
  /**
   * Takes it down, or brings it back: while it is down, every request but a
   * test's, to `/_fake/`, has its connection dropped unanswered, as Hive's
   * cloud is with the internet down, and it keeps its products, tokens and
   * trusted devices, so that coming back is as Hive coming back.
   */
  readonly setDown: (down: boolean) => void;
  readonly requests: readonly FakeHiveRequest[];
  readonly clear: () => void;
  readonly stop: () => Promise<void>;
}

/** `GET` says each product's state, and `POST` changes one, or a list of them, by `id`. */
export const FAKE_HIVE_STATE_PATH = "/_fake/state";
/** `PUT` a list of {@link FakeHiveProduct} replaces the products. */
export const FAKE_HIVE_PRODUCTS_PATH = "/_fake/products";
/** `POST` refuses every token from now on, and with `{"devices": true}` forgets the trusted devices too. */
export const FAKE_HIVE_REVOKE_PATH = "/_fake/revoke";
/** `GET` lists the requests answered, and `DELETE` forgets them. */
export const FAKE_HIVE_REQUESTS_PATH = "/_fake/requests";
/** `GET` says its clock, in minutes, and `POST` with `{"minutes": 30}` moves it on. */
export const FAKE_HIVE_CLOCK_PATH = "/_fake/clock";
/** `GET` says whether it is down, and `POST` with `{"down": true}` or `{"down": false}` takes it down or brings it back. */
export const FAKE_HIVE_OUTAGE_PATH = "/_fake/outage";

/** How long the access and id tokens last, and a session waits for its code, in minutes of its clock. */
const TOKEN_MINUTES = 60;
const SESSION_MINUTES = 3;

/** An id made from what it's for, the same each time, in the form of Hive's. */
const stableId = (...parts: string[]): string => {
  const hex = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** A product as the fake holds it, in Hive's terms. */
interface Product {
  id: string;
  kind: FakeHiveKind;
  name: string;
  /** Hive's zone id: a Heating's own, and a Radiator Valve's Heating's. */
  zone: string | null;
  zoneName: string | null;
  mode: string;
  target: number;
  boostEndsAt: number | null;
  previous: { mode: string; target: number } | null;
  temperature: number | null;
  working: boolean;
  online: boolean;
  battery: number | null;
  min: number;
  max: number;
  refusesChanges: boolean;
}

const HIVE_MODE_OF: Readonly<Record<string, string>> = {
  schedule: HIVE_MODES.schedule,
  manual: HIVE_MODES.manual,
  on: HIVE_MODES.manual,
  off: HIVE_MODES.off,
};

/** The products in a `PUT /_fake/products`, or a message saying what is wrong with them. */
export const fakeHiveProductsIn = (read: unknown): FakeHiveProduct[] | string => {
  if (!Array.isArray(read)) return 'Send a list of products, e.g. [{"kind": "heating", "name": "Downstairs"}]';
  const products: FakeHiveProduct[] = [];
  for (const each of read as unknown[]) {
    const given = (each ?? {}) as Record<string, unknown>;
    const { kind, name } = given;
    if (typeof kind !== "string" || !(FAKE_HIVE_KINDS as readonly string[]).includes(kind)) {
      return `Each product's kind is one of ${FAKE_HIVE_KINDS.join(", ")}`;
    }
    if (typeof name !== "string" || name.trim() === "") return "Each product has a name";
    for (const field of ["target", "temperature", "battery", "min", "max"] as const) {
      if (given[field] !== undefined && given[field] !== null && typeof given[field] !== "number") {
        return `A product's ${field} is a number`;
      }
    }
    if (given.mode !== undefined && (typeof given.mode !== "string" || !Object.hasOwn(HIVE_MODE_OF, given.mode))) {
      return "A product's mode is schedule, manual, on or off";
    }
    products.push(given as unknown as FakeHiveProduct);
  }
  const heatings = new Set(products.filter(({ kind }) => kind === "heating").map(({ name }) => name));
  for (const { kind, zone } of products) {
    if (kind === "radiator-valve" && zone !== undefined && !heatings.has(zone)) {
      return `No Heating is called "${zone}"`;
    }
  }
  return products;
};

const productFrom = (given: FakeHiveProduct, all: readonly FakeHiveProduct[]): Product => {
  // A Heating is its own zone, and a Radiator Valve is in its Heating's.
  const heating =
    given.kind === "heating"
      ? given
      : given.kind === "radiator-valve"
        ? all.find(({ kind, name }) => kind === "heating" && name === given.zone)
        : undefined;
  return {
    id: given.id ?? stableId(given.kind, given.name),
    kind: given.kind,
    name: given.name,
    zone: heating === undefined ? null : `zone-${heating.id ?? stableId(heating.kind, heating.name)}`,
    zoneName: given.kind === "radiator-valve" ? (heating?.name ?? null) : null,
    mode: HIVE_MODE_OF[given.mode ?? "schedule"] ?? HIVE_MODES.schedule,
    target: given.target ?? 20,
    boostEndsAt: null,
    previous: null,
    temperature: given.kind === "hot-water" ? null : given.temperature === undefined ? 19.5 : given.temperature,
    working: given.working ?? false,
    online: given.online ?? true,
    battery: given.kind === "radiator-valve" ? (given.battery ?? 100) : null,
    min: given.min ?? 5,
    max: given.max ?? 32,
    refusesChanges: false,
  };
};

class CognitoError extends Error {
  readonly type: string;
  readonly outcome: FakeHiveRequest["outcome"];
  constructor(type: string, message: string, outcome: FakeHiveRequest["outcome"]) {
    super(message);
    this.type = type;
    this.outcome = outcome;
  }
}

/** Matches a claim's time, e.g. "Tue Oct 21 15:08:35 UTC 2026", as Cognito takes it. */
const CLAIM_TIME = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} [1-9][0-9]? \d{2}:\d{2}:\d{2} UTC \d{4}$/;

const token = (): string => randomBytes(48).toString("base64url");

/** Starts a fake Hive cloud listening on loopback, by default on a free port. */
export const startFakeHiveCloud = async ({
  host = "127.0.0.1",
  port = 0,
  account,
  password,
  code,
  products: initial = FAKE_HIVE_HOME,
}: FakeHiveCloudOptions): Promise<FakeHiveCloud> => {
  let products = initial.map((each) => productFrom(each, initial));
  const requests: FakeHiveRequest[] = [];
  const hubId = stableId("hub", account);
  const userId = stableId("user", account);
  let minute = 0;
  let down = false;

  /** The sign-ins waiting for the password's claim, by their secret block. */
  const passwordClaims = new Map<
    string,
    { A: string; server: ServerEphemeral; verifier: bigint; deviceKey?: string }
  >();
  /** The sign-ins waiting for a code, a device's SRP, or its claim, by their session. */
  const sessions = new Map<
    string,
    | { step: "SMS_MFA"; until: number }
    | { step: "DEVICE_SRP_AUTH"; deviceKey: string; until: number }
    | {
        step: "DEVICE_PASSWORD_VERIFIER";
        deviceKey: string;
        A: string;
        server: ServerEphemeral;
        secretBlock: string;
        until: number;
      }
  >();
  /** The devices it issued, by key: trusted once confirmed with a verifier and remembered. */
  const devices = new Map<
    string,
    { groupKey: string; verifier?: bigint; salt?: string; remembered: boolean; issuedWith: string }
  >();
  /** The tokens it issued, each with when, and the device it was issued to, if any. */
  const accessTokens = new Map<string, { at: number; deviceKey?: string }>();
  const idTokens = new Map<string, { at: number }>();
  const refreshTokens = new Map<string, { deviceKey?: string }>();

  const record = (entry: Omit<FakeHiveRequest, "receivedAt" | "minute">): void => {
    requests.push({ receivedAt: Date.now(), minute, ...entry });
  };

  /** Ends each Boost whose time is up, back to the mode and target it had. */
  const tick = (): void => {
    for (const product of products) {
      if (product.boostEndsAt !== null && product.boostEndsAt <= minute) endBoost(product);
    }
  };

  const endBoost = (product: Product): void => {
    product.mode = product.previous?.mode ?? HIVE_MODES.schedule;
    product.target = product.previous?.target ?? product.target;
    product.boostEndsAt = null;
  };

  const issueTokens = (deviceKey: string | undefined, newDevice: boolean): Record<string, unknown> => {
    const accessToken = token();
    const idToken = token();
    const refreshToken = token();
    let metadata: Record<string, string> | undefined;
    let bound = deviceKey;
    if (newDevice) {
      const key = `eu-west-1_${randomBytes(16).toString("hex")}`;
      const groupKey = `-${randomBytes(8).toString("base64url")}`;
      devices.set(key, { groupKey, remembered: false, issuedWith: accessToken });
      metadata = { DeviceKey: key, DeviceGroupKey: groupKey };
      bound = key;
    }
    accessTokens.set(accessToken, { at: minute, ...(bound === undefined ? {} : { deviceKey: bound }) });
    idTokens.set(idToken, { at: minute });
    refreshTokens.set(refreshToken, bound === undefined ? {} : { deviceKey: bound });
    return {
      AuthenticationResult: {
        AccessToken: accessToken,
        IdToken: idToken,
        RefreshToken: refreshToken,
        ExpiresIn: TOKEN_MINUTES * 60,
        TokenType: "Bearer",
        ...(metadata === undefined ? {} : { NewDeviceMetadata: metadata }),
      },
      ChallengeParameters: {},
    };
  };

  const current = (tokens: Map<string, { at: number }>, given: unknown): boolean => {
    const issued = typeof given === "string" ? tokens.get(given) : undefined;
    return issued !== undefined && minute - issued.at < TOKEN_MINUTES;
  };

  const refused = (): CognitoError =>
    new CognitoError("NotAuthorizedException", "Incorrect username or password.", "wrong-login");

  /** Answers one of Cognito's operations, or throws a {@link CognitoError}. */
  const cognito = (operation: string, body: Record<string, unknown>): { step: string; answer: unknown } => {
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    if (operation === "InitiateAuth" || operation === "RespondToAuthChallenge") {
      if (body.ClientId !== HIVE_CLIENT_ID) {
        throw new CognitoError("ResourceNotFoundException", "User pool client does not exist.", "not-found");
      }
    }

    if (operation === "InitiateAuth") {
      const parameters = record(body.AuthParameters);
      if (body.AuthFlow === "USER_SRP_AUTH") {
        if (parameters.USERNAME !== account) throw refused();
        const salt = randomBytes(16).toString("hex");
        const verifier = verifierFor(POOL_NAME, userId, password, salt);
        const server = serverEphemeral(verifier);
        const secretBlock = randomBytes(64).toString("base64");
        const deviceKey = text(parameters.DEVICE_KEY);
        passwordClaims.set(secretBlock, {
          A: text(parameters.SRP_A),
          server,
          verifier,
          ...(deviceKey === "" ? {} : { deviceKey }),
        });
        return {
          step: "USER_SRP_AUTH",
          answer: {
            ChallengeName: "PASSWORD_VERIFIER",
            ChallengeParameters: {
              SALT: salt,
              SECRET_BLOCK: secretBlock,
              SRP_B: server.B,
              USERNAME: userId,
              USER_ID_FOR_SRP: userId,
            },
          },
        };
      }
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        const issued = refreshTokens.get(text(parameters.REFRESH_TOKEN));
        if (issued === undefined || (issued.deviceKey !== undefined && issued.deviceKey !== parameters.DEVICE_KEY)) {
          throw new CognitoError("NotAuthorizedException", "Invalid Refresh Token", "not-signed-in");
        }
        const accessToken = token();
        const idToken = token();
        accessTokens.set(accessToken, { at: minute, ...(issued.deviceKey === undefined ? {} : issued) });
        idTokens.set(idToken, { at: minute });
        return {
          step: "REFRESH_TOKEN_AUTH",
          answer: {
            AuthenticationResult: {
              AccessToken: accessToken,
              IdToken: idToken,
              ExpiresIn: TOKEN_MINUTES * 60,
              TokenType: "Bearer",
            },
            ChallengeParameters: {},
          },
        };
      }
      throw new CognitoError("InvalidParameterException", "Unknown auth flow.", "not-found");
    }

    if (operation === "RespondToAuthChallenge") {
      const responses = record(body.ChallengeResponses);
      const challenge = text(body.ChallengeName);
      const proved = (
        A: string,
        server: ServerEphemeral,
        verifier: bigint,
        group: string,
        user: string,
        secretBlock: string,
      ): boolean => {
        const time = text(responses.TIMESTAMP);
        if (!CLAIM_TIME.test(time)) return false;
        try {
          return (
            claimSignature(serverKey(A, server, verifier), group, user, secretBlock, time) ===
            responses.PASSWORD_CLAIM_SIGNATURE
          );
        } catch {
          return false;
        }
      };
      const newSession = (): string => randomBytes(96).toString("base64");

      if (challenge === "PASSWORD_VERIFIER") {
        const secretBlock = text(responses.PASSWORD_CLAIM_SECRET_BLOCK);
        const waiting = passwordClaims.get(secretBlock);
        passwordClaims.delete(secretBlock);
        if (waiting === undefined || (responses.USERNAME !== userId && responses.USERNAME !== account)) {
          throw refused();
        }
        if (!proved(waiting.A, waiting.server, waiting.verifier, POOL_NAME, userId, secretBlock)) throw refused();
        const device = waiting.deviceKey === undefined ? undefined : devices.get(waiting.deviceKey);
        if (waiting.deviceKey !== undefined && device?.remembered === true && device.verifier !== undefined) {
          const session = newSession();
          sessions.set(session, {
            step: "DEVICE_SRP_AUTH",
            deviceKey: waiting.deviceKey,
            until: minute + SESSION_MINUTES,
          });
          return {
            step: challenge,
            answer: { ChallengeName: "DEVICE_SRP_AUTH", Session: session, ChallengeParameters: {} },
          };
        }
        if (code !== undefined) {
          const session = newSession();
          sessions.set(session, { step: "SMS_MFA", until: minute + SESSION_MINUTES });
          return {
            step: challenge,
            answer: {
              ChallengeName: "SMS_MFA",
              Session: session,
              ChallengeParameters: {
                CODE_DELIVERY_DELIVERY_MEDIUM: "SMS",
                CODE_DELIVERY_DESTINATION: "+*******0000",
                USER_ID_FOR_SRP: userId,
              },
            },
          };
        }
        return { step: challenge, answer: issueTokens(undefined, true) };
      }

      const session = text(body.Session);
      const waiting = sessions.get(session);
      if (waiting?.step !== challenge || waiting.until < minute) {
        sessions.delete(session);
        throw new CognitoError(
          "NotAuthorizedException",
          "Invalid session for the user, session is expired.",
          "expired-session",
        );
      }

      if (waiting.step === "SMS_MFA") {
        if (responses.SMS_MFA_CODE !== code) {
          throw new CognitoError("CodeMismatchException", "Invalid code received for user", "wrong-code");
        }
        sessions.delete(session);
        return { step: challenge, answer: issueTokens(undefined, true) };
      }

      if (waiting.step === "DEVICE_SRP_AUTH") {
        sessions.delete(session);
        const device = devices.get(waiting.deviceKey);
        if (responses.DEVICE_KEY !== waiting.deviceKey || device?.verifier === undefined || device.salt === undefined) {
          throw new CognitoError("NotAuthorizedException", "Device does not exist.", "wrong-device");
        }
        const server = serverEphemeral(device.verifier);
        const secretBlock = randomBytes(64).toString("base64");
        const next = newSession();
        sessions.set(next, {
          step: "DEVICE_PASSWORD_VERIFIER",
          deviceKey: waiting.deviceKey,
          A: text(responses.SRP_A),
          server,
          secretBlock,
          until: minute + SESSION_MINUTES,
        });
        return {
          step: challenge,
          answer: {
            ChallengeName: "DEVICE_PASSWORD_VERIFIER",
            Session: next,
            ChallengeParameters: {
              SRP_B: server.B,
              SALT: device.salt,
              SECRET_BLOCK: secretBlock,
              USERNAME: userId,
              DEVICE_KEY: waiting.deviceKey,
            },
          },
        };
      }

      sessions.delete(session);
      const device = devices.get(waiting.deviceKey);
      if (
        device?.verifier === undefined ||
        responses.PASSWORD_CLAIM_SECRET_BLOCK !== waiting.secretBlock ||
        !proved(waiting.A, waiting.server, device.verifier, device.groupKey, waiting.deviceKey, waiting.secretBlock)
      ) {
        throw new CognitoError("NotAuthorizedException", "Incorrect username or password.", "wrong-device");
      }
      return { step: challenge, answer: issueTokens(waiting.deviceKey, false) };
    }

    if (operation === "ConfirmDevice" || operation === "UpdateDeviceStatus") {
      if (!current(accessTokens, body.AccessToken)) {
        throw new CognitoError("NotAuthorizedException", "Access Token has been revoked", "not-signed-in");
      }
      const device = devices.get(text(body.DeviceKey));
      if (device === undefined || device.issuedWith !== body.AccessToken) {
        throw new CognitoError("ResourceNotFoundException", "Device does not exist.", "wrong-device");
      }
      if (operation === "ConfirmDevice") {
        const config = record(body.DeviceSecretVerifierConfig);
        device.verifier = verifierFromBase64(text(config.PasswordVerifier));
        device.salt = Buffer.from(text(config.Salt), "base64").toString("hex");
        return { step: "", answer: { UserConfirmationNecessary: true } };
      }
      device.remembered = body.DeviceRememberedStatus === "remembered";
      return { step: "", answer: {} };
    }

    throw new CognitoError("UnknownOperationException", "Unknown operation.", "not-found");
  };

  /** A product as `GET /nodes/all` lists it. */
  const node = (product: Product): Record<string, unknown> => ({
    id: product.id,
    type: PRODUCT_TYPES[product.kind],
    parent: hubId,
    props: {
      online: product.online,
      working: product.working,
      ...(product.kind === "hot-water" ? {} : { temperature: product.temperature, min: product.min, max: product.max }),
      ...(product.zone === null ? {} : { zone: product.zone }),
      ...(product.zoneName === null ? {} : { zoneName: product.zoneName }),
      ...(product.battery === null ? {} : { battery: product.battery }),
      ...(product.previous === null
        ? {}
        : { previous: product.kind === "hot-water" ? { mode: product.previous.mode } : product.previous }),
    },
    state: {
      name: product.name,
      mode: product.mode,
      boost: product.boostEndsAt === null ? null : product.boostEndsAt - minute,
      ...(product.kind === "hot-water" ? {} : { target: product.target, frostProtection: 7 }),
    },
  });

  /** The hardware behind the products, as Hive lists it beside them: its hub, its receiver, and each zone's thermostat and each valve, by Hive's names for them. */
  const deviceNodes = (): Record<string, unknown>[] => [
    { id: hubId, type: "hub", props: { online: true }, state: { name: "Hive Hub" } },
    {
      id: stableId("boilermodule", account),
      type: "boilermodule",
      props: { online: true },
      state: { name: "Receiver" },
    },
    ...products.flatMap((product) =>
      product.kind === "heating"
        ? [
            {
              id: stableId("thermostatui", product.id),
              type: "thermostatui",
              props: { online: product.online },
              state: { name: product.name },
            },
          ]
        : product.kind === "radiator-valve"
          ? [
              {
                id: stableId("trv", product.id),
                type: "trv",
                props: { online: product.online, battery: product.battery },
                state: { name: product.name },
              },
            ]
          : [],
    ),
  ];

  /** Whether `body` is a change Hive takes for `product`, and makes it if so. */
  const change = (product: Product, body: Record<string, unknown>): boolean => {
    const allowed = product.kind === "hot-water" ? ["mode", "boost"] : ["mode", "target", "boost"];
    if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) return false;
    const { mode, target, boost } = body;
    const modes: unknown[] = [HIVE_MODES.schedule, HIVE_MODES.manual, HIVE_MODES.off, HIVE_MODES.boost];
    if (mode !== undefined && !modes.includes(mode)) return false;
    if (
      target !== undefined &&
      (typeof target !== "number" || target < product.min || target > product.max || !Number.isInteger(target * 2))
    ) {
      return false;
    }
    if (mode === HIVE_MODES.boost) {
      if (typeof boost !== "number" || !Number.isInteger(boost) || boost < 1 || boost > 360) return false;
      if (product.mode !== HIVE_MODES.boost) product.previous = { mode: product.mode, target: product.target };
      product.mode = HIVE_MODES.boost;
      product.boostEndsAt = minute + boost;
      if (typeof target === "number") product.target = target;
      return true;
    }
    if (boost !== undefined) return false;
    if (typeof mode === "string") {
      // Leaving a Boost, it goes back to the target it had, as a Boost that ends does, unless given another.
      if (product.mode === HIVE_MODES.boost && target === undefined && product.previous !== null) {
        product.target = product.previous.target;
      }
      product.mode = mode;
      product.boostEndsAt = null;
    }
    if (typeof target === "number") product.target = target;
    return true;
  };

  const stateOf = (product: Product): FakeHiveProductState => ({
    id: product.id,
    kind: product.kind,
    name: product.name,
    mode:
      product.mode === HIVE_MODES.boost
        ? "boost"
        : product.mode === HIVE_MODES.manual
          ? product.kind === "hot-water"
            ? "on"
            : "manual"
          : product.mode === HIVE_MODES.off
            ? "off"
            : "schedule",
    target: product.kind === "hot-water" ? null : product.target,
    boost: product.boostEndsAt === null ? null : product.boostEndsAt - minute,
    temperature: product.temperature,
    working: product.working,
    online: product.online,
    battery: product.battery,
    zone: product.zoneName,
    refusesChanges: product.refusesChanges,
  });

  /** Changes a product as Hive's app would, or throws a message saying what is wrong with the change. */
  const setProduct = (id: string, given: Readonly<Record<string, unknown>>): void => {
    tick();
    const product = products.find((each) => each.id === id);
    if (product === undefined) throw new Error(`There is no product with id "${id}"`);
    const { mode, target, boost, temperature, working, online, battery, refusesChanges } = given;
    if (boost !== undefined) {
      if (boost === null) {
        if (product.mode === HIVE_MODES.boost) endBoost(product);
      } else if (!change(product, { mode: HIVE_MODES.boost, boost, ...(target === undefined ? {} : { target }) })) {
        throw new Error("A Boost is a number of minutes, from 1 to 360, with a target in range where it has one");
      }
    } else if (mode !== undefined || target !== undefined) {
      const hiveMode = typeof mode === "string" ? HIVE_MODE_OF[mode] : undefined;
      if (mode !== undefined && hiveMode === undefined) throw new Error("A mode is schedule, manual, on or off");
      if (
        !change(product, {
          ...(hiveMode === undefined ? {} : { mode: hiveMode }),
          ...(target === undefined ? {} : { target }),
        })
      ) {
        throw new Error("That target is out of its range");
      }
    }
    if (temperature !== undefined) {
      if (temperature !== null && typeof temperature !== "number") throw new Error("A temperature is a number or null");
      product.temperature = temperature;
    }
    if (working !== undefined) {
      if (typeof working !== "boolean") throw new Error("working is true or false");
      product.working = working;
    }
    if (online !== undefined) {
      if (typeof online !== "boolean") throw new Error("online is true or false");
      product.online = online;
    }
    if (battery !== undefined) {
      if (typeof battery !== "number" || product.kind !== "radiator-valve")
        throw new Error("Only a Radiator Valve has a battery, in percent");
      product.battery = battery;
    }
    if (refusesChanges !== undefined) {
      if (typeof refusesChanges !== "boolean") throw new Error("refusesChanges is true or false");
      product.refusesChanges = refusesChanges;
    }
  };

  const revoke = (forgetDevices = false): void => {
    accessTokens.clear();
    idTokens.clear();
    refreshTokens.clear();
    if (forgetDevices) devices.clear();
  };

  const advance = (minutes: number): void => {
    minute += minutes;
    tick();
  };

  const NODE_PATH = /^\/nodes\/([^/]+)\/([^/]+)$/;

  const server = createServer((request, response) => {
    if (down && !(request.url ?? "/").startsWith("/_fake/")) {
      const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
      record({ request: `${request.method ?? "GET"} ${pathname}`, outcome: "dropped" });
      request.socket.destroy();
      return;
    }
    void readBody(request)
      .then((text) => {
        answer(request, response, text);
      })
      .catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: "INTERNAL_ERROR" });
      });
  });

  const answer = (request: IncomingMessage, response: ServerResponse, text: string): void => {
    {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const given = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

      // What a test asks of the fake itself.
      if (url.pathname.startsWith("/_fake/")) {
        tick();
        switch (url.pathname) {
          case FAKE_HIVE_STATE_PATH: {
            if (request.method === "POST") {
              try {
                for (const each of Array.isArray(body) ? (body as unknown[]) : [body]) {
                  const one = (each ?? {}) as Record<string, unknown>;
                  setProduct(typeof one.id === "string" ? one.id : "", one);
                }
              } catch (error) {
                sendJson(response, 400, { message: error instanceof Error ? error.message : String(error) });
                return;
              }
            }
            sendJson(response, 200, products.map(stateOf));
            return;
          }
          case FAKE_HIVE_PRODUCTS_PATH: {
            if (request.method === "PUT") {
              const read = fakeHiveProductsIn(body);
              if (typeof read === "string") {
                sendJson(response, 400, { message: read });
                return;
              }
              products = read.map((each) => productFrom(each, read));
            }
            sendJson(response, 200, products.map(stateOf));
            return;
          }
          case FAKE_HIVE_REVOKE_PATH:
            if (request.method !== "POST") break;
            revoke(given.devices === true);
            sendJson(response, 200, { revoked: true, devices: given.devices === true });
            return;
          case FAKE_HIVE_REQUESTS_PATH:
            if (request.method === "DELETE") requests.length = 0;
            sendJson(response, 200, requests);
            return;
          case FAKE_HIVE_CLOCK_PATH:
            if (request.method === "POST") {
              if (typeof given.minutes !== "number" || !Number.isInteger(given.minutes) || given.minutes < 0) {
                sendJson(response, 400, { message: 'Send how many minutes to move on, e.g. {"minutes": 30}' });
                return;
              }
              advance(given.minutes);
            }
            sendJson(response, 200, { minutes: minute });
            return;
          case FAKE_HIVE_OUTAGE_PATH:
            if (request.method === "POST") {
              if (typeof given.down !== "boolean") {
                sendJson(response, 400, { message: 'Send whether it is down, e.g. {"down": true}' });
                return;
              }
              down = given.down;
            }
            sendJson(response, 200, { down });
            return;
        }
        sendJson(response, 404, { message: "No such path" });
        return;
      }

      tick();
      // Hive's sign-in service: Cognito, which says the operation in a header.
      const target = request.headers["x-amz-target"];
      if (typeof target === "string") {
        const operation = target.startsWith(COGNITO_TARGET) ? target.slice(COGNITO_TARGET.length) : target;
        const step = (answer: string): string => `${operation}${answer === "" ? "" : ` ${answer}`}`;
        const asked =
          typeof given.AuthFlow === "string"
            ? given.AuthFlow
            : typeof given.ChallengeName === "string"
              ? given.ChallengeName
              : "";
        try {
          const { answer } = cognito(operation, given);
          record({ request: step(asked), outcome: "accepted" });
          sendJson(response, 200, answer, "application/x-amz-json-1.1");
        } catch (error) {
          if (!(error instanceof CognitoError)) throw error;
          record({ request: step(asked), outcome: error.outcome });
          sendJson(response, 400, { __type: error.type, message: error.message }, "application/x-amz-json-1.1");
        }
        return;
      }

      // Hive's API, beekeeper, which takes only an id token it issued.
      const path = `${request.method ?? "GET"} ${url.pathname}`;
      if (!current(idTokens, request.headers.authorization)) {
        record({ request: path, outcome: "not-signed-in" });
        sendJson(response, 401, { error: "NOT_AUTHORIZED" });
        return;
      }
      if (request.method === "GET" && `${url.pathname}${url.search}` === NODES_PATH) {
        record({ request: path, outcome: "accepted" });
        sendJson(response, 200, { products: products.map(node), devices: deviceNodes(), actions: [] });
        return;
      }
      const match = NODE_PATH.exec(url.pathname);
      if (request.method === "POST" && match !== null) {
        const [, type = "", id = ""] = match.map(decodeURIComponent);
        const product = products.find((each) => each.id === id && PRODUCT_TYPES[each.kind] === type);
        if (product === undefined) {
          record({ request: path, outcome: "unknown-product", product: id, change: given });
          sendJson(response, 404, { error: "NOT_FOUND" });
          return;
        }
        if (product.refusesChanges || !change(product, given)) {
          record({ request: path, outcome: "refused", product: id, change: given });
          sendJson(response, 400, { error: "INVALID_REQUEST" });
          return;
        }
        record({ request: path, outcome: "accepted", product: id, change: given });
        sendJson(response, 200, node(product));
        return;
      }
      record({ request: path, outcome: "not-found" });
      sendJson(response, 404, { error: "NOT_FOUND" });
    }
  };

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
    products: () => {
      tick();
      return products.map(stateOf);
    },
    setProduct,
    setProducts: (given) => {
      products = given.map((each) => productFrom(each, given));
    },
    revoke,
    advance,
    setDown: (given) => {
      down = given;
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

const sendJson = (response: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
  response.writeHead(status, { "content-type": `${type}; charset=utf-8` }).end(JSON.stringify(body));
};
