import { useEffect, useRef, useState } from "preact/hooks";

import type { Appliance, ApplianceApp, ApplianceApps, PowerState } from "@media-centre/shared";

import { AppIcon } from "./app-icon.tsx";
import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";

/**
 * How often the Remote asks the Hub again for the Selected TV's apps: seldom,
 * as apps are rarely installed or removed. It asks at once when the TV's
 * power state changes.
 */
export const APPS_REFRESH_MS = 30_000;

export interface TvAppsProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV, whose apps these are. */
  readonly tv: Appliance;
  /** It as the Remote names it, "Room · Name" (FR-9). */
  readonly title: string;
  /** Its power state, as the TV tab last read it, or undefined before the first read. */
  readonly power: PowerState | undefined;
  /** {@link APPS_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

/** What the person last had the Hub do with an app, to say so. */
interface Done {
  readonly app: ApplianceApp;
  readonly what: "launch" | "close";
}

const DONE: Readonly<Record<Done["what"], (name: string) => string>> = {
  launch: (name) => `Launched ${name}.`,
  close: (name) => `Closed ${name}.`,
};

/**
 * The Selected TV's installed apps (FR-21), with their names and, where the
 * TV gives them, their icons, each of which can be launched or closed. A TV
 * in standby or not answering says so, rather than showing no apps. The list
 * is read again when the TV's power state changes, and every so often.
 */
export const TvApps = ({ appliances, tv, title, power, refreshMs = APPS_REFRESH_MS }: TvAppsProps) => {
  const [read, setRead] = useState<ApplianceApps | undefined>(undefined);
  /** Why the apps couldn't be read, until they next are. */
  const [readProblem, setReadProblem] = useState<string | undefined>(undefined);
  /** Why the Hub couldn't launch or close an app, until the person next taps one. */
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** The app the Hub is launching or closing, whose buttons wait for it. */
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<Done | undefined>(undefined);
  /** Reads the apps now, between refreshes; set while they are shown. */
  const readNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Counts every reading begun, so that one answered late is never shown after a later one. */
    let readings = 0;

    const readApps = async (): Promise<void> => {
      readings += 1;
      const reading = readings;
      try {
        const apps = await appliances.listApps(tv.id);
        if (!current || reading !== readings) return;
        setRead(apps);
        setReadProblem(undefined);
      } catch (error) {
        if (current && reading === readings) setReadProblem(messageFor(error));
      }
    };
    readNow.current = () => void readApps();

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await readApps();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [appliances, tv.id, refreshMs, power]);

  const act = (app: ApplianceApp, what: Done["what"]): void => {
    setBusy(app.id);
    setDone(undefined);
    setProblem(undefined);
    void (what === "launch" ? appliances.launchApp(tv.id, app.id) : appliances.closeApp(tv.id, app.id)).then(
      () => {
        setBusy(undefined);
        setDone({ app, what });
      },
      (error: unknown) => {
        setBusy(undefined);
        setProblem(messageFor(error));
        // E.g. a TV gone into standby, which the list then says.
        readNow.current();
      },
    );
  };

  const shownProblem = problem ?? readProblem;

  return (
    <section class="tv-apps" aria-labelledby="tv-apps-heading">
      <h2 id="tv-apps-heading">Apps</h2>
      {shownProblem !== undefined && (
        <p class="problem" role="alert">
          {shownProblem}
        </p>
      )}
      <p class="apps-status" role="status">
        {done === undefined ? "" : DONE[done.what](done.app.name)}
      </p>
      {read === undefined ? (
        readProblem === undefined && <p class="apps-note">Loading the apps…</p>
      ) : !read.known ? (
        <p class="apps-note">
          {read.why === "standby"
            ? `${title} is in standby. Switch it on to see its apps.`
            : `${title} isn't answering, so its apps can't be listed. Check that it is switched on and on the same network as the Hub.`}
        </p>
      ) : read.apps.length === 0 ? (
        <p class="apps-note">{title} has no apps installed.</p>
      ) : (
        <ul class="apps">
          {read.apps.map((app) => (
            <li key={app.id} class="app" aria-label={app.name}>
              <button
                type="button"
                class="app-launch"
                aria-label={`Launch ${app.name}`}
                disabled={busy === app.id}
                onClick={() => {
                  act(app, "launch");
                }}
              >
                <AppIcon applianceId={tv.id} app={app} />
                <span class="app-name">{app.name}</span>
              </button>
              <button
                type="button"
                class="app-close"
                aria-label={`Close ${app.name}`}
                disabled={busy === app.id}
                onClick={() => {
                  act(app, "close");
                }}
              >
                Close
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
