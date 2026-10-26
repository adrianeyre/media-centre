/**
 * The Samsung TV Driver's side of a TV's apps (FR-21), as far as we know
 * them. The TV lists its installed apps, and gives each one's icon, on its
 * control socket. It launches and closes an app, and says whether one is
 * running and visible, which is how the Hub tells which is in front (FR-26),
 * on its REST API at `http://<tv>:8001/api/v2/applications/<appId>`,
 * which needs no pairing. Only the Driver knows this protocol (NFR-6).
 */
import { SAMSUNG_REST_PORT } from "./device-info.ts";

/** Where a TV's REST API answers for one app. */
export const applicationPath = (appId: string): string => `/api/v2/applications/${encodeURIComponent(appId)}`;

/** The event the Driver emits on the control socket to have the TV list its installed apps, and the TV answers with. */
export const INSTALLED_APPS_EVENT = "ed.installedApp.get";

/** The event the Driver emits for one app's icon, by its `iconPath`, and the TV answers with. */
export const APP_ICON_EVENT = "ed.apps.icon";

/**
 * The event the Driver emits on the control socket to launch an app with
 * data for it, which the TV answers with, as far as we know: the TV's REST
 * API launches an app, but gives it nothing. The Player is launched this way
 * with the Hub's address (FR-35).
 */
export const APP_LAUNCH_EVENT = "ed.apps.launch";

/**
 * The `data` of {@link APP_LAUNCH_EVENT}. A web app launched as a deep link
 * is given `metaTag` as its launch data's `PAYLOAD`, as `{"values": metaTag}`.
 */
export interface SamsungAppLaunch {
  readonly appId: string;
  readonly action_type: "DEEP_LINK" | "NATIVE_LAUNCH";
  readonly metaTag?: string;
}

/**
 * The `data` of the TV's answer to {@link APP_LAUNCH_EVENT}, as far as we know:
 * 200 once it has launched the app, and 404 for an app it hasn't got.
 */
export type SamsungAppLaunchAnswer = number;

/**
 * Whether the TV's answer to {@link APP_LAUNCH_EVENT} says it hasn't got the
 * app. Any other answer is taken to be that it launched it, as nothing else
 * is known of what a TV may say.
 */
export const isNoSuchAppAnswer = (data: unknown): boolean => data === 404;

/** One installed app, as a TV lists it on its control socket. */
export interface SamsungInstalledApp {
  readonly appId: string;
  /** 2 for a web app, 4 for a native one, as far as we know. */
  readonly app_type: number;
  /** Where the icon is on the TV, to ask for with {@link APP_ICON_EVENT}, or empty for none. */
  readonly icon: string;
  readonly is_lock: number;
  readonly name: string;
}

/** The `data` of the TV's answer to {@link INSTALLED_APPS_EVENT}. */
export interface SamsungInstalledApps {
  readonly data: readonly SamsungInstalledApp[];
}

/** The `data` of the TV's answer to {@link APP_ICON_EVENT}: the image, in base64, or empty for none. */
export interface SamsungAppIcon {
  readonly iconPath: string;
  readonly imageBase64: string;
}

/** What the TV's REST API says about one app. */
export interface SamsungAppStatus {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  readonly version: string;
  readonly visible: boolean;
}

/** An installed app, in the Driver's terms, with where to ask for its icon. */
export interface InstalledApp {
  readonly id: string;
  readonly name: string;
  readonly iconPath: string | undefined;
}

/** The TV has no app with that id. */
export class NoSuchApp extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSuchApp";
  }
}

/** The TV didn't answer for its apps, e.g. in standby. */
export class AppsUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppsUnavailable";
  }
}

export interface ApplicationOptions {
  readonly port?: number;
  readonly timeoutMs: number;
}

/**
 * Whether the app is in front on the TV, as its app status says: running and
 * visible. An app the TV has no status for is not. Rejects with
 * {@link AppsUnavailable} when the TV doesn't answer for it, or answers in a
 * way that can't be read.
 */
export const isApplicationVisible = async (
  host: string,
  appId: string,
  { port = SAMSUNG_REST_PORT, timeoutMs }: ApplicationOptions,
): Promise<boolean> => {
  let status: unknown;
  try {
    const response = await fetch(`${restUrl(host, port)}${applicationPath(appId)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppsUnavailable(`The TV at ${host} answered for app ${appId} with ${String(response.status)}`);
    }
    status = await response.json();
  } catch (error) {
    if (error instanceof AppsUnavailable) throw error;
    throw new AppsUnavailable(`The TV at ${host} didn't answer for app ${appId}`, { cause: error });
  }
  if (typeof status !== "object" || status === null || !("visible" in status) || typeof status.visible !== "boolean") {
    throw new AppsUnavailable(`The TV at ${host} answered for app ${appId} in a way the Hub can't read`);
  }
  // An app that isn't running, whatever else it says, isn't in front.
  return status.visible && (!("running" in status) || status.running !== false);
};

/** Launches the app, which the TV brings to the front, as choosing it on the TV does. */
export const launchApplication = (host: string, appId: string, options: ApplicationOptions): Promise<void> =>
  application("POST", host, appId, options);

/** Closes the app, if it is running. */
export const closeApplication = (host: string, appId: string, options: ApplicationOptions): Promise<void> =>
  application("DELETE", host, appId, options);

const application = async (
  method: "POST" | "DELETE",
  host: string,
  appId: string,
  { port = SAMSUNG_REST_PORT, timeoutMs }: ApplicationOptions,
): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(`${restUrl(host, port)}${applicationPath(appId)}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new AppsUnavailable(`The TV at ${host} didn't answer for its apps`, { cause: error });
  }
  await response.body?.cancel();
  if (response.status === 404) throw new NoSuchApp(`The TV at ${host} has no app ${appId}`);
  if (!response.ok)
    throw new AppsUnavailable(`The TV at ${host} answered for its apps with ${String(response.status)}`);
};

const restUrl = (host: string, port: number): string =>
  `http://${host.includes(":") ? `[${host}]` : host}:${String(port)}`;

/**
 * The apps in the TV's answer to {@link INSTALLED_APPS_EVENT}, each once, or
 * undefined for an answer that isn't a list of them. An app without an id or
 * a name is left out.
 */
export const installedAppsIn = (data: unknown): InstalledApp[] | undefined => {
  const list = typeof data === "object" && data !== null && "data" in data ? data.data : undefined;
  if (!Array.isArray(list)) return undefined;
  const apps = new Map<string, InstalledApp>();
  for (const each of list as unknown[]) {
    if (typeof each !== "object" || each === null) continue;
    const { appId, name, icon } = each as Partial<Record<keyof SamsungInstalledApp, unknown>>;
    if (typeof appId !== "string" || appId === "" || typeof name !== "string" || name.trim() === "") continue;
    if (!apps.has(appId)) {
      apps.set(appId, {
        id: appId,
        name: name.trim(),
        iconPath: typeof icon === "string" && icon !== "" ? icon : undefined,
      });
    }
  }
  return [...apps.values()];
};

/** Whether this is the TV's answer to {@link APP_ICON_EVENT} for the icon at `iconPath`. */
export const isIconFor =
  (iconPath: string) =>
  (data: unknown): boolean =>
    typeof data === "object" && data !== null && "iconPath" in data && data.iconPath === iconPath;

/** The image in the TV's answer to {@link APP_ICON_EVENT}, or undefined for none. */
export const iconImageIn = (data: unknown): Buffer | undefined => {
  const image = typeof data === "object" && data !== null && "imageBase64" in data ? data.imageBase64 : undefined;
  if (typeof image !== "string" || image === "") return undefined;
  const bytes = Buffer.from(image, "base64");
  return bytes.length === 0 ? undefined : bytes;
};
