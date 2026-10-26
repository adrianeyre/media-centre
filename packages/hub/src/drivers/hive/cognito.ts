/**
 * Hive's sign-in service, AWS Cognito's user pool, as Hive's app and
 * pyhiveapi (`apyhiveapi/api/hive_auth_async.py`, which Home Assistant's Hive
 * integration uses) sign in to it: the one module of the Hive Driver that
 * speaks to it, and, but for the fake Hive cloud, the only code that knows it
 * (NFR-6). Nothing here logs, and nothing it throws quotes the password, the
 * code, a token, a session or a device's key, group key or password (FR-67a).
 *
 * The exchange, each step a POST of JSON to the service with the operation
 * in `x-amz-target`:
 *
 * 1. `InitiateAuth`, `USER_SRP_AUTH`, with the email, SRP's A and the Hub's
 *    device key, if it has one; Cognito answers `PASSWORD_VERIFIER`.
 * 2. `RespondToAuthChallenge` with the password's claim (see `srp.ts`).
 *    Cognito then answers with the tokens; or, for a device it remembers,
 *    `DEVICE_SRP_AUTH`, which the device answers with its own SRP exchange,
 *    `DEVICE_PASSWORD_VERIFIER`, for the tokens; or `SMS_MFA`, asking for the
 *    code Hive texts, which Hive requires (FR-67).
 * 3. With the code, `RespondToAuthChallenge` `SMS_MFA` for the tokens and a
 *    new device's key and group key, which `ConfirmDevice` confirms, with the
 *    verifier of a password the Hub makes up for it, and
 *    `UpdateDeviceStatus` remembers, so that Cognito doesn't ask for a code
 *    again (FR-67).
 * 4. `InitiateAuth`, `REFRESH_TOKEN_AUTH`, with the refresh token and the
 *    device key, for new access and id tokens.
 *
 * None of this has been tried against the real service, which no test
 * reaches: it is proved only against the fake Hive cloud. What is uncertain,
 * to be corrected in the fake first, then here (ADR 0004):
 *
 * - the pool and client ids, which pyhiveapi reads from the `HiveSSOPoolId`
 *   and `HiveSSOPublicCognitoClientId` of `https://sso.hivehome.com/` and
 *   which are written here as it has last been seen to find them, and the
 *   pool's region, eu-west-1, from its id: Hive may change any of them;
 * - SRP's arithmetic as Cognito does it (see `srp.ts`);
 * - whether the pool remembers a device always or only when asked, so the
 *   Driver both confirms and remembers it;
 * - whether a remembered device is still let in without a code once its
 *   refresh token has expired, which the Heating PRD's open question 2 asks;
 * - whether a wrong code may be tried again within the same session, as the
 *   fake allows.
 */
import { clientEphemeral, clientKey, claimSignature, claimTime, devicePassword, deviceVerifier } from "./srp.ts";

/** Where Hive's Cognito user pool is. `HIVE_AUTH_URL` puts the fake Hive cloud in its place in tests. */
// eslint-disable-next-line media-centre/no-internet-urls -- Hive has no local API (ADR 0010)
export const HIVE_AUTH_URL = "https://cognito-idp.eu-west-1.amazonaws.com";

/** Hive's user pool, and its app's client, as pyhiveapi finds them. */
export const HIVE_POOL_ID = "eu-west-1_SamNfoWtf";
export const HIVE_CLIENT_ID = "3rl4i0ajrmtdm8sbre54p9dvd9";

/** The pool's name, as SRP hashes it: its id after the region. */
export const POOL_NAME = HIVE_POOL_ID.slice(HIVE_POOL_ID.indexOf("_") + 1);

/** Each operation the Driver asks of Cognito, as `x-amz-target` names it. */
export const COGNITO_TARGET = "AWSCognitoIdentityProviderService.";

/** The tokens Cognito issues, and how long the access and id tokens last, in seconds. */
export interface CognitoTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly expiresIn: number;
}

/** A device the Hub signs in as, once confirmed: its key and group key, from Cognito, and its own password. */
export interface CognitoDevice {
  readonly key: string;
  readonly groupKey: string;
  readonly password: string;
}

/** What signing in came to. */
export type CognitoSignIn =
  /** Let in, with the tokens and the refresh token, and the device Cognito issued, if it did, to confirm. */
  | {
      readonly signedIn: true;
      readonly tokens: CognitoTokens;
      readonly refreshToken: string;
      readonly newDevice: { readonly key: string; readonly groupKey: string } | undefined;
    }
  /** Asked for the code it texted: answer it with the session and user, before the session expires. */
  | { readonly signedIn: false; readonly session: string; readonly user: string };

/** Cognito couldn't be reached, didn't answer in time, failed, or answered as something else. */
export class CognitoUnreachable extends Error {
  constructor(options?: ErrorOptions) {
    super("Hive's sign-in service didn't answer", options);
    this.name = "CognitoUnreachable";
  }
}

/**
 * Cognito refused what it was asked, with the type of its refusal, e.g.
 * `NotAuthorizedException` for a wrong password or a revoked refresh token,
 * or `CodeMismatchException` for a wrong code. Never with its message, which
 * may quote the email.
 */
export class CognitoRefused extends Error {
  readonly type: string;
  constructor(type: string) {
    super(`Hive's sign-in service refused it, with ${type}`);
    this.name = "CognitoRefused";
    this.type = type;
  }
}

export interface CognitoOptions {
  /** {@link HIVE_AUTH_URL}, or the fake Hive cloud's. */
  readonly url: string;
  /** How long each request has to be answered. */
  readonly timeoutMs: number;
  /** The time each claim is made at; the clock, but for tests. */
  readonly now?: () => Date;
}

export interface CognitoClient {
  /**
   * Signs in with the email and password, which it uses for this alone, as
   * the `device` if it has one. Rejects with {@link CognitoRefused} for a
   * login refused, and {@link CognitoUnreachable}.
   */
  readonly signIn: (email: string, password: string, device: CognitoDevice | undefined) => Promise<CognitoSignIn>;
  /** Answers the session's `SMS_MFA` with the code. Rejects as {@link signIn} does, e.g. `CodeMismatchException`. */
  readonly answerCode: (session: string, user: string, code: string) => Promise<CognitoSignIn & { signedIn: true }>;
  /** Confirms and remembers a new device, making up its password, and resolves with it. */
  readonly confirmDevice: (
    accessToken: string,
    device: { readonly key: string; readonly groupKey: string },
  ) => Promise<CognitoDevice>;
  /** New access and id tokens for the refresh token. Rejects with {@link CognitoRefused} for one refused. */
  readonly refresh: (refreshToken: string, deviceKey: string | undefined) => Promise<CognitoTokens>;
}

type Json = Record<string, unknown>;

const stringIn = (from: unknown, name: string): string | undefined => {
  const value = typeof from === "object" && from !== null ? (from as Json)[name] : undefined;
  return typeof value === "string" ? value : undefined;
};

export const cognitoClient = ({ url, timeoutMs, now = () => new Date() }: CognitoOptions): CognitoClient => {
  const call = async (operation: string, body: Json): Promise<Json> => {
    let response: Response;
    let read: unknown;
    try {
      response = await fetch(`${url.replace(/\/$/, "")}/`, {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `${COGNITO_TARGET}${operation}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      read = await response.json();
    } catch (error) {
      // Never what JSON.parse said of the answer, which quotes it, and it may hold a token.
      throw new CognitoUnreachable(error instanceof SyntaxError ? undefined : { cause: error });
    }
    if (response.status >= 500) throw new CognitoUnreachable();
    if (!response.ok) {
      // e.g. "NotAuthorizedException", or with its namespace before a "#".
      const type = stringIn(read, "__type")?.split("#").at(-1);
      if (type === undefined) throw new CognitoUnreachable();
      throw new CognitoRefused(type);
    }
    if (typeof read !== "object" || read === null) throw new CognitoUnreachable();
    return read as Json;
  };

  /** The tokens of an `AuthenticationResult`, and the device Cognito issued with them, if it did. */
  const signedIn = (answer: Json): CognitoSignIn & { signedIn: true } => {
    const result = answer.AuthenticationResult;
    const accessToken = stringIn(result, "AccessToken");
    const idToken = stringIn(result, "IdToken");
    const refreshToken = stringIn(result, "RefreshToken");
    const expiresIn = (result as Json | undefined)?.ExpiresIn;
    if (accessToken === undefined || idToken === undefined || refreshToken === undefined) {
      throw new CognitoUnreachable();
    }
    const metadata = (result as Json).NewDeviceMetadata;
    const key = stringIn(metadata, "DeviceKey");
    const groupKey = stringIn(metadata, "DeviceGroupKey");
    return {
      signedIn: true,
      tokens: { accessToken, idToken, expiresIn: typeof expiresIn === "number" ? expiresIn : 3_600 },
      refreshToken,
      newDevice: key === undefined || groupKey === undefined ? undefined : { key, groupKey },
    };
  };

  /** Answers a `PASSWORD_VERIFIER` or `DEVICE_PASSWORD_VERIFIER` with the claim that proves the password. */
  const claim = (
    ephemeral: ReturnType<typeof clientEphemeral>,
    parameters: unknown,
    group: string,
    user: string,
    password: string,
  ): { readonly signature: string; readonly secretBlock: string; readonly time: string } => {
    const B = stringIn(parameters, "SRP_B");
    const salt = stringIn(parameters, "SALT");
    const secretBlock = stringIn(parameters, "SECRET_BLOCK");
    if (B === undefined || salt === undefined || secretBlock === undefined) throw new CognitoUnreachable();
    let key: Buffer;
    try {
      key = clientKey(ephemeral, B, salt, group, user, password);
    } catch {
      throw new CognitoUnreachable();
    }
    const time = claimTime(now());
    return { signature: claimSignature(key, group, user, secretBlock, time), secretBlock, time };
  };

  const signIn = async (email: string, password: string, device: CognitoDevice | undefined): Promise<CognitoSignIn> => {
    const ephemeral = clientEphemeral();
    const started = await call("InitiateAuth", {
      AuthFlow: "USER_SRP_AUTH",
      ClientId: HIVE_CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        SRP_A: ephemeral.A,
        ...(device === undefined ? {} : { DEVICE_KEY: device.key }),
      },
    });
    if (started.ChallengeName !== "PASSWORD_VERIFIER") throw new CognitoUnreachable();
    const user = stringIn(started.ChallengeParameters, "USER_ID_FOR_SRP");
    if (user === undefined) throw new CognitoUnreachable();
    const proof = claim(ephemeral, started.ChallengeParameters, POOL_NAME, user, password);
    let answer = await call("RespondToAuthChallenge", {
      ChallengeName: "PASSWORD_VERIFIER",
      ClientId: HIVE_CLIENT_ID,
      ...(typeof started.Session === "string" ? { Session: started.Session } : {}),
      ChallengeResponses: {
        USERNAME: user,
        PASSWORD_CLAIM_SECRET_BLOCK: proof.secretBlock,
        PASSWORD_CLAIM_SIGNATURE: proof.signature,
        TIMESTAMP: proof.time,
        ...(device === undefined ? {} : { DEVICE_KEY: device.key }),
      },
    });

    if (answer.ChallengeName === "DEVICE_SRP_AUTH" && device !== undefined) {
      const deviceEphemeral = clientEphemeral();
      const asked = await call("RespondToAuthChallenge", {
        ChallengeName: "DEVICE_SRP_AUTH",
        ClientId: HIVE_CLIENT_ID,
        ...(typeof answer.Session === "string" ? { Session: answer.Session } : {}),
        ChallengeResponses: { USERNAME: user, DEVICE_KEY: device.key, SRP_A: deviceEphemeral.A },
      });
      if (asked.ChallengeName !== "DEVICE_PASSWORD_VERIFIER") throw new CognitoUnreachable();
      const deviceProof = claim(
        deviceEphemeral,
        asked.ChallengeParameters,
        device.groupKey,
        device.key,
        device.password,
      );
      answer = await call("RespondToAuthChallenge", {
        ChallengeName: "DEVICE_PASSWORD_VERIFIER",
        ClientId: HIVE_CLIENT_ID,
        ...(typeof asked.Session === "string" ? { Session: asked.Session } : {}),
        ChallengeResponses: {
          USERNAME: user,
          DEVICE_KEY: device.key,
          PASSWORD_CLAIM_SECRET_BLOCK: deviceProof.secretBlock,
          PASSWORD_CLAIM_SIGNATURE: deviceProof.signature,
          TIMESTAMP: deviceProof.time,
        },
      });
    }

    if (answer.ChallengeName === "SMS_MFA") {
      if (typeof answer.Session !== "string") throw new CognitoUnreachable();
      return { signedIn: false, session: answer.Session, user };
    }
    if (answer.ChallengeName !== undefined) throw new CognitoUnreachable();
    return signedIn(answer);
  };

  return {
    signIn,
    answerCode: async (session, user, code) =>
      signedIn(
        await call("RespondToAuthChallenge", {
          ChallengeName: "SMS_MFA",
          ClientId: HIVE_CLIENT_ID,
          Session: session,
          ChallengeResponses: { USERNAME: user, SMS_MFA_CODE: code },
        }),
      ),
    confirmDevice: async (accessToken, { key, groupKey }) => {
      const password = devicePassword();
      const { passwordVerifier, salt } = deviceVerifier(groupKey, key, password);
      await call("ConfirmDevice", {
        AccessToken: accessToken,
        DeviceKey: key,
        DeviceName: "media-centre Hub",
        DeviceSecretVerifierConfig: { PasswordVerifier: passwordVerifier, Salt: salt },
      });
      await call("UpdateDeviceStatus", {
        AccessToken: accessToken,
        DeviceKey: key,
        DeviceRememberedStatus: "remembered",
      });
      return { key, groupKey, password };
    },
    refresh: async (refreshToken, deviceKey) => {
      const answer = await call("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: HIVE_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken, ...(deviceKey === undefined ? {} : { DEVICE_KEY: deviceKey }) },
      });
      const result = answer.AuthenticationResult;
      const accessToken = stringIn(result, "AccessToken");
      const idToken = stringIn(result, "IdToken");
      const expiresIn = (result as Json | undefined)?.ExpiresIn;
      if (accessToken === undefined || idToken === undefined) throw new CognitoUnreachable();
      return { accessToken, idToken, expiresIn: typeof expiresIn === "number" ? expiresIn : 3_600 };
    },
  };
};
