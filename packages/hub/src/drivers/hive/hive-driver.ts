import type { CloudLogin } from "@media-centre/shared";

import { CredentialsRefused, DriverFailure, type HeatingDriver, type HeatingSignIn } from "../driver.ts";
import {
  BeekeeperRefused,
  beekeeperClient,
  BeekeeperUnauthorised,
  BeekeeperUnreachable,
  HIVE_URL,
  type HiveNodes,
} from "./beekeeper.ts";
import {
  cognitoClient,
  CognitoRefused,
  CognitoUnreachable,
  HIVE_AUTH_URL,
  type CognitoDevice,
  type CognitoSignIn,
  type CognitoTokens,
} from "./cognito.ts";
import { appliancesIn, changeBody, productWithId, statesIn } from "./nodes.ts";

/**
 * What the Hive Driver keeps of the account, as the credentials it hands the
 * Hub: the tokens Hive issued, when the access and id tokens expire, and the
 * Hub's device, which Hive trusts so that it doesn't ask for a code again
 * (FR-67). Never the password. They are secret: never logged, nor sent to
 * the Remote (FR-67a).
 */
interface HiveCredentials {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  /** In milliseconds since the epoch. */
  readonly expiresAt: number;
  readonly device: CognitoDevice | null;
}

/** What the Driver keeps between asking for a code and being given it: Hive's session, never the password. */
interface HivePending {
  readonly session: string;
  readonly user: string;
  readonly device: CognitoDevice | null;
}

/** Hive's cloud couldn't be reached, didn't answer in time, or failed: "Can't reach Hive" (FR-68). */
export class HiveUnreachableError extends DriverFailure {
  constructor(options?: ErrorOptions) {
    super("unreachable", "Can't reach Hive. Check that the Hub is connected to the internet.", options);
    this.name = "HiveUnreachableError";
  }
}

/**
 * Hive refused the Hub's tokens, and renewing them failed, as when they have
 * expired on Hive's own schedule or were revoked: Settings offers to sign in
 * again (FR-67b). The Hub tells it from {@link HiveUnreachableError}.
 */
export class HiveAuthError extends CredentialsRefused {
  constructor(options?: ErrorOptions) {
    super("Hive no longer accepts the Hub's sign-in. Sign in to Hive again in Settings.", options);
    this.name = "HiveAuthError";
  }
}

/** Hive refused a change to one Appliance (FR-68), which `applianceId` says, by the id the Driver lists it by. */
export class HiveRefusedError extends DriverFailure {
  readonly applianceId: string;
  constructor(applianceId: string, name: string, options?: ErrorOptions) {
    super("refused", `Hive refused the change to ${name}.`, options);
    this.name = "HiveRefusedError";
    this.applianceId = applianceId;
  }
}

/**
 * Hive refused to sign the Hub in: `what` says whether it was the email or
 * password, the code, or a code given after the time Hive allows for it.
 */
export class HiveSignInRefused extends DriverFailure {
  readonly what: "login" | "code" | "expired";
  constructor(what: HiveSignInRefused["what"]) {
    super(
      "refused",
      what === "login"
        ? "Hive refused the email or password. Use the Hive account owner's."
        : what === "code"
          ? "That isn't the code Hive sent. Try it again."
          : "Hive's code has expired. Sign in again for a new one.",
    );
    this.name = "HiveSignInRefused";
    this.what = what;
  }
}

export interface HiveDriverOptions {
  /** Where Hive's API is: {@link HIVE_URL}, or in tests the fake Hive cloud's. */
  readonly apiUrl?: string;
  /** Where Hive's sign-in service is: {@link HIVE_AUTH_URL}, or in tests the fake Hive cloud's. */
  readonly authUrl?: string;
  /** How long Hive has to answer each request. */
  readonly timeoutMs?: number;
  /** The time, in milliseconds since the epoch; the clock, but for tests. */
  readonly now?: () => number;
  /** Where the Driver writes what it did, a line at a time. Never the password, a code, a token or a key (FR-67a). */
  readonly log?: (line: string) => void;
}

/** How long before its tokens expire the Driver renews them. */
const RENEW_BEFORE_MS = 60_000;

/**
 * The Hive Driver: controls the home's Heating zones, Radiator Valves and
 * Hot Water through Hive's cloud, the one exception to controlling
 * Appliances locally (ADR 0010). It signs in once, with the code Hive texts,
 * as a device Hive then trusts, keeps Hive's tokens and its device's keys in
 * the credentials it hands the Hub, never the password, renews the tokens
 * itself before they expire or once Hive refuses them, and lists, reads and
 * changes each Appliance in the Appliance's terms, so that nothing outside
 * it knows Hive's API (NFR-6). Every Appliance's state is read in one
 * request.
 */
export const hiveDriver = ({
  apiUrl = HIVE_URL,
  authUrl = HIVE_AUTH_URL,
  timeoutMs = 15_000,
  now = Date.now,
  log = console.log,
}: HiveDriverOptions = {}): HeatingDriver => {
  const cognito = cognitoClient({ url: authUrl, timeoutMs, now: () => new Date(now()) });
  const beekeeper = beekeeperClient({ url: apiUrl, timeoutMs });

  const unreachable = (cause?: unknown): HiveUnreachableError => {
    log("Couldn't reach Hive");
    return new HiveUnreachableError(cause === undefined ? undefined : { cause });
  };

  const credentialsOf = (tokens: CognitoTokens, refreshToken: string, device: CognitoDevice | null): string =>
    JSON.stringify({
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken,
      expiresAt: now() + tokens.expiresIn * 1_000,
      device,
    } satisfies HiveCredentials);

  /** A device as the Driver kept it, or null. */
  const deviceIn = (value: unknown): CognitoDevice | null => {
    const { key, groupKey, password } = (value ?? {}) as Partial<Record<keyof CognitoDevice, unknown>>;
    return typeof key === "string" && typeof groupKey === "string" && typeof password === "string"
      ? { key, groupKey, password }
      : null;
  };

  /** The credentials the Hub kept, which come from outside the Driver, or undefined. Never quotes them. */
  const credentialsIn = (credentials: string | undefined): HiveCredentials | undefined => {
    if (credentials === undefined) return undefined;
    let read: unknown;
    try {
      read = JSON.parse(credentials);
    } catch {
      return undefined;
    }
    const { accessToken, idToken, refreshToken, expiresAt, device } = (read ?? {}) as Record<string, unknown>;
    if (typeof accessToken !== "string" || typeof idToken !== "string" || typeof refreshToken !== "string") {
      return undefined;
    }
    return {
      accessToken,
      idToken,
      refreshToken,
      expiresAt: typeof expiresAt === "number" ? expiresAt : 0,
      device: deviceIn(device),
    };
  };

  /** Signed in: trusts the Hub as Hive's new device, if Hive issued one, and resolves with the credentials to keep. */
  const signedIn = async (answer: CognitoSignIn & { signedIn: true }, kept: CognitoDevice | null): Promise<string> => {
    let device = kept;
    if (answer.newDevice !== undefined) {
      try {
        device = await cognito.confirmDevice(answer.tokens.accessToken, answer.newDevice);
        log("Hive trusts the Hub as a device from now on, so won't ask it for a code again");
      } catch (error) {
        if (error instanceof CognitoUnreachable) throw unreachable(error);
        // Signed in all the same; Hive will ask for a code at the next sign-in.
        log(`Hive didn't trust the Hub as a device${error instanceof CognitoRefused ? `: ${error.type}` : ""}`);
        device = null;
      }
    }
    log("Signed in to Hive");
    return credentialsOf(answer.tokens, answer.refreshToken, device);
  };

  /** Renews the tokens, or rejects with {@link HiveAuthError} where Hive refuses the refresh token. */
  const renew = async (kept: HiveCredentials): Promise<HiveCredentials> => {
    let tokens: CognitoTokens;
    try {
      tokens = await cognito.refresh(kept.refreshToken, kept.device?.key);
    } catch (error) {
      if (error instanceof CognitoRefused) {
        log(`Hive refused to renew the Hub's tokens, with ${error.type}: sign in to Hive again`);
        throw new HiveAuthError();
      }
      throw unreachable(error);
    }
    log("Renewed the Hub's tokens for Hive");
    return {
      ...kept,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      expiresAt: now() + tokens.expiresIn * 1_000,
    };
  };

  /**
   * Does `work` with the id token, renewing the tokens first if they are
   * about to expire, or once, if Hive refuses them, and resolves with what it
   * came to and the credentials to keep.
   */
  const withTokens = async <T>(
    credentials: string,
    work: (idToken: string) => Promise<T>,
  ): Promise<{ readonly credentials: string; readonly value: T }> => {
    let kept = credentialsIn(credentials);
    if (kept === undefined) {
      log("The Hub's credentials for Hive aren't the Hive Driver's: sign in to Hive again");
      throw new HiveAuthError();
    }
    let renewed = false;
    if (now() >= kept.expiresAt - RENEW_BEFORE_MS) {
      kept = await renew(kept);
      renewed = true;
    }
    for (;;) {
      try {
        const value = await work(kept.idToken);
        return { credentials: JSON.stringify(kept), value };
      } catch (error) {
        if (error instanceof BeekeeperUnreachable) throw unreachable(error);
        if (!(error instanceof BeekeeperUnauthorised)) throw error;
        if (renewed) {
          log("Hive refused the Hub's renewed tokens: sign in to Hive again");
          throw new HiveAuthError();
        }
        kept = await renew(kept);
        renewed = true;
      }
    }
  };

  const readNodes = (idToken: string): Promise<HiveNodes> => beekeeper.readNodes(idToken);

  /** The login, which comes from outside the Hub. */
  const loginIn = (login: unknown): { readonly email: string; readonly password: string } => {
    const { account, password } = (login ?? {}) as Partial<Record<keyof CloudLogin, unknown>>;
    if (typeof account !== "string" || account.trim() === "" || typeof password !== "string" || password === "") {
      throw new HiveSignInRefused("login");
    }
    return { email: account.trim(), password };
  };

  return {
    signIn: async (login, kept) => {
      const { email, password } = loginIn(login);
      const device = credentialsIn(kept)?.device ?? null;
      let answer: CognitoSignIn;
      try {
        // The password goes no further than this call.
        answer = await cognito.signIn(email, password, device ?? undefined);
      } catch (error) {
        if (error instanceof CognitoRefused) {
          log(`Hive refused the sign-in, with ${error.type}`);
          throw new HiveSignInRefused("login");
        }
        throw unreachable(error);
      }
      if (!answer.signedIn) {
        log("Hive asked for the code it texted the account's owner");
        return {
          signedIn: false,
          needs: "code",
          pending: JSON.stringify({ session: answer.session, user: answer.user, device } satisfies HivePending),
        } satisfies HeatingSignIn;
      }
      return { signedIn: true, credentials: await signedIn(answer, device) };
    },

    enterCode: async (pending, code) => {
      let read: Partial<Record<keyof HivePending, unknown>> = {};
      try {
        read = (JSON.parse(pending) ?? {}) as typeof read;
      } catch {
        // As a session Hive no longer knows.
      }
      const { session, user, device } = read;
      if (typeof session !== "string" || typeof user !== "string") throw new HiveSignInRefused("expired");
      if (typeof code !== "string" || code.trim() === "") throw new HiveSignInRefused("code");
      let answer: CognitoSignIn & { signedIn: true };
      try {
        answer = await cognito.answerCode(session, user, code.trim());
      } catch (error) {
        if (error instanceof CognitoRefused) {
          log(`Hive refused the code, with ${error.type}`);
          throw new HiveSignInRefused(error.type === "CodeMismatchException" ? "code" : "expired");
        }
        throw unreachable(error);
      }
      return signedIn(answer, deviceIn(device));
    },

    refresh: async (credentials) => {
      const kept = credentialsIn(credentials);
      if (kept === undefined) throw new HiveAuthError();
      return JSON.stringify(await renew(kept));
    },

    listAppliances: async (credentials) => {
      const { credentials: renewed, value } = await withTokens(credentials, readNodes);
      return { credentials: renewed, appliances: appliancesIn(value) };
    },

    readStates: async (credentials) => {
      const { credentials: renewed, value } = await withTokens(credentials, readNodes);
      return { credentials: renewed, states: statesIn(value), appliances: appliancesIn(value) };
    },

    setState: async (credentials, id, change) => {
      const { credentials: renewed, value } = await withTokens(credentials, async (idToken) => {
        const found = productWithId(await readNodes(idToken), id);
        if (found === undefined) {
          throw new DriverFailure("not-recognised", "Hive has no such Heating, Radiator Valve or Hot Water.");
        }
        const { kind, product } = found;
        const body = changeBody(kind, product, change);
        if (body !== undefined) {
          try {
            await beekeeper.setNode(idToken, product, body);
          } catch (error) {
            if (!(error instanceof BeekeeperRefused)) throw error;
            const name = typeof product.state.name === "string" ? product.state.name : "it";
            log(`Hive refused the change to ${name}, with ${String(error.status)}`);
            throw new HiveRefusedError(id, name, { cause: error });
          }
        }
        const state = statesIn(await readNodes(idToken)).find((each) => each.id === id);
        if (state === undefined) throw new BeekeeperUnreachable();
        return state;
      });
      return { credentials: renewed, state: value };
    },
  };
};

/**
 * The Hive Driver, with `HIVE_URL` and `HIVE_AUTH_URL` from the Hub's
 * environment, for Hive's API and its sign-in service: the fake Hive
 * cloud's, in place of Hive's, which only tests set. One is never set
 * without the other, so that a test never reaches Hive (ADR 0010).
 */
export const hiveDriverFromEnvironment = (env: Readonly<Record<string, string | undefined>>): HeatingDriver => {
  const apiUrl = env.HIVE_URL;
  const authUrl = env.HIVE_AUTH_URL;
  for (const [variable, url] of [
    ["HIVE_URL", apiUrl],
    ["HIVE_AUTH_URL", authUrl],
  ] as const) {
    if (url !== undefined && !/^https?:\/\/./.test(url)) {
      throw new Error(`${variable} must be an http:// or https:// URL, not "${url}"`);
    }
  }
  if ((apiUrl === undefined) !== (authUrl === undefined)) {
    throw new Error("HIVE_URL and HIVE_AUTH_URL are set together, or neither is");
  }
  return hiveDriver({
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(authUrl === undefined ? {} : { authUrl }),
  });
};
