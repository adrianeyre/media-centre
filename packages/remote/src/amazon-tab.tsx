import {
  AMAZON_DOMAINS,
  AMAZON_TEXT_MAX_LENGTH,
  type AmazonAction,
  type AmazonDevice,
  type AmazonDeviceState,
  type AmazonDomain,
  type AmazonHome,
  type AmazonNotification,
  type AmazonQuickAction,
  type Room,
} from "@media-centre/shared";
import { useEffect, useId, useState } from "preact/hooks";

import type { AmazonApi } from "./amazon-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { RoomPicker } from "./network-tab.tsx";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { AMAZON_WIDGET_LAYOUT_KEY, type Layout, type Placement } from "./widget-layout.ts";

/** How often the tab asks the Hub again, while signing in, and how often each Echo's widget reads it. */
export const AMAZON_SIGN_IN_POLL_MS = 2_000;
export const AMAZON_DEVICE_REFRESH_MS = 5_000;

export interface AmazonTabProps {
  readonly amazon: AmazonApi;
  readonly rooms: RoomsApi;
  /** Where this Remote remembers the tab's widgets. */
  readonly storage: RemoteStorage;
  /** {@link AMAZON_DEVICE_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  /** {@link AMAZON_SIGN_IN_POLL_MS} but in tests. */
  readonly signInPollMs?: number;
}

const QUICK_LABELS: Readonly<Record<AmazonQuickAction, string>> = {
  weather: "Weather",
  traffic: "Traffic",
  news: "News",
  "good-morning": "Good morning",
  "fun-fact": "Fun fact",
  joke: "Joke",
  story: "Story",
  song: "Sing a song",
  calendar: "Today's calendar",
  stop: "Stop",
};

const NOTIFICATION_LABELS: Readonly<Record<AmazonNotification["type"], string>> = {
  alarm: "Alarm",
  timer: "Timer",
  reminder: "Reminder",
};

/** Each Echo's widget, by its serial number. */
export const amazonWidgetId = (serial: string): string => `amazon-${serial}`;

/** How tall each starts, in rows, for a desktop's 12 columns, a tablet's 8 and a phone's 4. */
const WIDGET_ROWS: Readonly<Record<number, number>> = { 12: 30, 8: 30, 4: 34 };

const widgetLayouts = (ids: readonly string[]): Readonly<Record<number, Layout>> =>
  Object.fromEntries(
    [12, 8, 4].map((columns) => {
      const w = 4;
      const across = columns / w;
      const rows = WIDGET_ROWS[columns] ?? 30;
      const layout: Record<string, Placement> = {};
      ids.forEach((id, index) => {
        layout[id] = { x: (index % across) * w, y: Math.floor(index / across) * rows, w, h: rows };
      });
      return [columns, layout];
    }),
  );

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

const durationOf = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The Amazon tab: the owner's Echo devices, each a widget, as on the other
 * tabs, with everything the Alexa app lets the Hub do with it: what it is
 * playing and its controls and volume, Do Not Disturb, asking Alexa, saying
 * or announcing words, Alexa's quick actions and the account's routines,
 * music from each service, its alarms, timers and reminders, its equaliser
 * and alarm volume, its Bluetooth, and its Room. Above them, the account it
 * is signed in to, with Sign out, and an announcement on every Echo. Signed
 * out, it signs in through Amazon's own sign-in page (ADR 0011).
 */
export const AmazonTab = ({
  amazon,
  rooms,
  storage,
  refreshMs = AMAZON_DEVICE_REFRESH_MS,
  signInPollMs = AMAZON_SIGN_IN_POLL_MS,
}: AmazonTabProps) => {
  const [home, setHome] = useState<AmazonHome>();
  const [problem, setProblem] = useState<string>();
  const [roomList, setRoomList] = useState<readonly Room[]>([]);

  const take = (asked: Promise<AmazonHome>): Promise<void> =>
    asked.then(
      (next) => {
        setHome(next);
        setProblem(undefined);
      },
      (error: unknown) => {
        setProblem(messageFor(error));
      },
    );
  const reloadRooms = (): Promise<void> => rooms.list().then(setRoomList, () => undefined);

  useEffect(() => {
    void take(amazon.home());
    void reloadRooms();
  }, [amazon, rooms]);

  const signingIn = home?.status.state === "signing-in";
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => {
      void take(amazon.home());
    }, signInPollMs);
    return () => {
      clearInterval(timer);
    };
  }, [signingIn, amazon, signInPollMs]);

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  if (home === undefined) {
    return (
      <>
        <h1>Amazon</h1>
        {problemShown || <p role="status">Loading…</p>}
      </>
    );
  }

  if (home.status.state !== "signed-in") {
    return (
      <>
        <h1>Amazon</h1>
        {problemShown}
        <SignIn
          home={home}
          onSignIn={(domain) => take(amazon.signIn(domain))}
          onCancel={() => take(amazon.signOut())}
        />
      </>
    );
  }

  const { status } = home;
  const widgets: WidgetDefinition[] = home.devices.map((device) => ({
    id: amazonWidgetId(device.serial),
    title: device.name,
    ownHeading: true,
    children: (
      <EchoCard
        amazon={amazon}
        device={device}
        home={home}
        refreshMs={refreshMs}
        roomPicker={
          <RoomPicker
            device={device.name}
            room={device.room}
            rooms={roomList}
            onCreate={async (name) => {
              const room = await rooms.add(name);
              await reloadRooms();
              return room;
            }}
            onChoose={(roomId) => amazon.setRoom(device.serial, roomId).then(setHome)}
          />
        }
      />
    ),
  }));

  const toolbar = (
    <>
      <h1>Amazon</h1>
      <div class="network-controls">
        <div class="amazon-account">
          <p class="network-lead">
            Signed in to <strong>{status.domain}</strong>, through the Alexa app's own service, which Amazon may change
            at any time.
          </p>
          <button
            type="button"
            onClick={() => {
              void take(amazon.signOut());
            }}
          >
            Sign out
          </button>
        </div>
        {problemShown}
        {status.problem !== null && (
          <p class="problem" role="alert">
            {status.problem}
          </p>
        )}
        {home.devices.length > 0 && (
          <Speak
            label="Announce to every Echo"
            buttons={[["announce", "Announce everywhere"]]}
            onSend={async (_, text) => {
              await amazon.announce(text);
            }}
          />
        )}
        {home.devices.length === 0 && status.problem === null && (
          <p class="network-none">No Echo devices are on this Amazon account yet.</p>
        )}
      </div>
    </>
  );

  if (widgets.length === 0) return <div class="widget-toolbar network-alone">{toolbar}</div>;
  return (
    <WidgetBoard
      widgets={widgets}
      defaults={widgetLayouts(widgets.map(({ id }) => id))}
      storage={storage}
      storageKey={AMAZON_WIDGET_LAYOUT_KEY}
      tab="Amazon"
      toolbar={toolbar}
    />
  );
};

/** The Hub's port, as this Remote reached it, for the address to open on the Hub's PC. */
const HUB_PORT_HINT = typeof location === "undefined" || location.port === "" ? "41080" : location.port;

/** Whether the sign-in page is at the Hub's PC's own `localhost`, where a browser lets Amazon's page encrypt. */
const isLocal = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");
  } catch {
    return false;
  }
};

/** Signing in: the Amazon site the account is on, then the page to sign in to Amazon on, until the Hub is. */
const SignIn = ({
  home,
  onSignIn,
  onCancel,
}: {
  readonly home: AmazonHome;
  readonly onSignIn: (domain: AmazonDomain) => Promise<unknown>;
  readonly onCancel: () => Promise<unknown>;
}) => {
  const [domain, setDomain] = useState<AmazonDomain>("amazon.co.uk");
  const [busy, setBusy] = useState(false);
  const selectId = useId();
  const { status } = home;

  if (status.state === "signing-in") {
    return (
      <section class="empty amazon-sign-in" aria-labelledby="amazon-signing-in">
        <h2 id="amazon-signing-in">Sign in to Amazon</h2>
        {status.signInUrl === null ? (
          <p role="status">Opening Amazon's sign-in page…</p>
        ) : (
          <>
            <p>
              Open Amazon's sign-in page, and sign in with the Amazon account your Echo devices are on, with its
              two-step code if it asks for one. It is amazon.com's page, as Amazon gives the Hub its sign-in only there,
              but your account and Echos are the same. The Hub never sees your password. This page carries on once you
              have.
            </p>
            <a class="button-primary" href={status.signInUrl} target="_blank" rel="noreferrer">
              Open Amazon's sign-in page (opens in a new tab)
            </a>
            <p class="network-note">
              It is served by the Hub, at <code>{status.signInUrl}</code>.
            </p>
            {!isLocal(status.signInUrl) && (
              <p class="network-note">
                Amazon's page encrypts your password before sending it, which a browser allows only on the Hub's PC
                itself. If Amazon refuses your password, cancel, open the Remote in a browser on the Hub's PC at{" "}
                <code>http://localhost:{HUB_PORT_HINT}</code>, and sign in from this tab there.
              </p>
            )}
          </>
        )}
        <p role="status" class="network-note">
          Waiting for you to sign in to {status.domain}…
        </p>
        <button
          type="button"
          onClick={() => {
            void onCancel();
          }}
        >
          Cancel
        </button>
      </section>
    );
  }

  return (
    <section class="empty amazon-sign-in" aria-labelledby="amazon-signed-out">
      <h2 id="amazon-signed-out">Sign in to Amazon</h2>
      <p>
        Sign the Hub in to the Amazon account your Echo devices are on, to see and control each of them here: what it
        plays, its volume, asking Alexa, announcements, routines, alarms, timers and reminders, and more.
      </p>
      <p class="network-note">
        The Hub reaches them through the Alexa app's own service, which Amazon doesn't offer to others, so it may stop
        working without warning. It needs the internet, and Amazon's terms don't allow it: it is for you to decide.
      </p>
      {status.state === "signed-out" && status.problem !== null && (
        <p class="problem" role="alert">
          {status.problem}
        </p>
      )}
      <form
        class="amazon-sign-in-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void onSignIn(domain).finally(() => {
            setBusy(false);
          });
        }}
      >
        <label class="amazon-field" for={selectId}>
          <span>Amazon site</span>
          <select
            id={selectId}
            value={domain}
            onChange={(event) => {
              setDomain(event.currentTarget.value as AmazonDomain);
            }}
          >
            {AMAZON_DOMAINS.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Sign in to Amazon
        </button>
      </form>
    </section>
  );
};

/** Words for Alexa: a field, and a button for each thing to do with them, e.g. Ask, Say or Announce. */
const Speak = ({
  label,
  buttons,
  onSend,
}: {
  readonly label: string;
  readonly buttons: readonly (readonly ["ask" | "speak" | "announce", string])[];
  readonly onSend: (kind: "ask" | "speak" | "announce", text: string) => Promise<unknown>;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  const fieldId = useId();
  const send = (kind: "ask" | "speak" | "announce"): void => {
    setBusy(true);
    setSaid(undefined);
    setRefusal(undefined);
    onSend(kind, text).then(
      () => {
        setBusy(false);
        setSaid("Sent.");
        setText("");
      },
      (error: unknown) => {
        setBusy(false);
        setRefusal(messageFor(error));
      },
    );
  };
  return (
    <form
      class="amazon-speak"
      onSubmit={(event) => {
        event.preventDefault();
        const first = buttons[0];
        if (first !== undefined) send(first[0]);
      }}
    >
      <label class="amazon-field" for={fieldId}>
        <span>{label}</span>
        <input
          id={fieldId}
          type="text"
          value={text}
          maxLength={AMAZON_TEXT_MAX_LENGTH}
          placeholder="e.g. Dinner is ready"
          onInput={(event) => {
            setText(event.currentTarget.value);
          }}
        />
      </label>
      <div class="network-name-actions">
        {buttons.map(([kind, name], index) => (
          <button
            key={kind}
            type={index === 0 ? "submit" : "button"}
            disabled={busy || text.trim() === ""}
            onClick={
              index === 0
                ? undefined
                : () => {
                    send(kind);
                  }
            }
          >
            {name}
          </button>
        ))}
      </div>
      <p class="network-note" role="status">
        {said ?? ""}
      </p>
      {refusal !== undefined && (
        <p class="problem" role="alert">
          {refusal}
        </p>
      )}
    </form>
  );
};

/** One Echo: what it is, then each thing it can do, read from Amazon every few seconds while shown, here and on the Rooms tab. */
export const EchoCard = ({
  amazon,
  device,
  home,
  refreshMs,
  roomPicker,
}: {
  readonly amazon: AmazonApi;
  readonly device: AmazonDevice;
  readonly home: AmazonHome;
  readonly refreshMs: number;
  /** Its Room picker, on the Amazon tab; none on the Rooms tab, which shows it in its Room. */
  readonly roomPicker?: preact.ComponentChildren;
}) => {
  const [state, setState] = useState<AmazonDeviceState>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const ids = { routine: useId(), provider: useId(), search: useId(), volume: useId() };
  const [routineId, setRoutineId] = useState(home.routines[0]?.id ?? "");
  const [providerId, setProviderId] = useState(home.musicProviders[0]?.id ?? "");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      if (document.visibilityState !== "hidden") {
        try {
          const read = await amazon.state(device.serial);
          if (current) {
            setState(read);
            setProblem(undefined);
          }
        } catch (error) {
          if (current) setProblem(messageFor(error));
        }
      }
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [amazon, device.serial, refreshMs]);

  const act = (action: AmazonAction): Promise<void> => {
    setBusy(true);
    return amazon.act(device.serial, action).then(
      (next) => {
        setState(next);
        setProblem(undefined);
        setBusy(false);
      },
      (error: unknown) => {
        setProblem(messageFor(error));
        setBusy(false);
      },
    );
  };

  const player = state?.player ?? null;
  const playing = player?.state === "playing";
  const { capabilities } = device;

  return (
    <article class="network-device amazon-echo" aria-labelledby={headingId}>
      <div class="device-row">
        <span class="device-icon">
          <Icon name="speaker" />
        </span>
        <div class="device-text">
          <h2 class="device-name network-device-name" id={headingId}>
            {device.name}
          </h2>
          <span class="device-meta">
            <span>{device.family}</span>
            <span class={device.online ? "chip chip-good" : "chip chip-warning"}>
              {device.online ? "Online" : "Offline"}
            </span>
            {device.room !== null && <span class="chip chip-good">{device.room.name}</span>}
          </span>
        </div>
      </div>
      {roomPicker}
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}

      {capabilities.music && (
        <section class="amazon-section" aria-label={`Now playing on ${device.name}`}>
          <div class="amazon-now">
            {player?.artUrl != null && <img class="amazon-art" src={player.artUrl} alt="" width={64} height={64} />}
            <div class="amazon-now-text">
              <span class="amazon-title">
                {player?.title ?? (state === undefined ? "Reading…" : "Nothing playing")}
              </span>
              {player?.subtitle != null && <span class="network-note">{player.subtitle}</span>}
              {player?.provider != null && <span class="network-note">{player.provider}</span>}
              {player?.progress != null && player.length != null && (
                <span class="network-note">
                  {durationOf(player.progress)} / {durationOf(player.length)}
                </span>
              )}
            </div>
          </div>
          <div class="amazon-transport">
            <button
              type="button"
              class="button-icon"
              aria-label="Previous"
              disabled={busy}
              onClick={() => void act({ kind: "previous" })}
            >
              <Icon name="skip-back" />
            </button>
            <button
              type="button"
              class="button-icon button-primary"
              aria-label={playing ? "Pause" : "Play"}
              disabled={busy}
              onClick={() => void act({ kind: playing ? "pause" : "play" })}
            >
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <button
              type="button"
              class="button-icon"
              aria-label="Next"
              disabled={busy}
              onClick={() => void act({ kind: "next" })}
            >
              <Icon name="skip-forward" />
            </button>
          </div>
        </section>
      )}

      {capabilities.volume && (
        <Level
          label="Volume"
          value={state?.volume ?? null}
          min={0}
          max={100}
          onChange={(level) => void act({ kind: "volume", level })}
        />
      )}

      <div class="amazon-toggles">
        <button
          type="button"
          class="aircon-toggle"
          aria-pressed={state?.doNotDisturb ?? undefined}
          disabled={state?.doNotDisturb == null || busy}
          onClick={() => void act({ kind: "do-not-disturb", on: !(state?.doNotDisturb ?? false) })}
        >
          {state?.doNotDisturb === true && <Icon name="check" />}
          Do Not Disturb
        </button>
      </div>

      <Speak
        label="Ask Alexa, or have it say or announce something"
        buttons={[
          ["ask", "Ask Alexa"],
          ["speak", "Say it"],
          ["announce", "Announce"],
        ]}
        onSend={(kind, text) => act({ kind, text })}
      />

      <section class="amazon-section" aria-label={`Quick actions on ${device.name}`}>
        <h3>Quick actions</h3>
        <div class="amazon-quick">
          {(Object.keys(QUICK_LABELS) as AmazonQuickAction[]).map((action) => (
            <button key={action} type="button" disabled={busy} onClick={() => void act({ kind: "quick", action })}>
              {QUICK_LABELS[action]}
            </button>
          ))}
        </div>
      </section>

      {home.routines.length > 0 && (
        <details class="amazon-details">
          <summary>Routines</summary>
          <form
            class="amazon-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (routineId !== "") void act({ kind: "routine", routineId });
            }}
          >
            <label class="amazon-field" for={ids.routine}>
              <span>Routine</span>
              <select
                id={ids.routine}
                value={routineId}
                onChange={(event) => {
                  setRoutineId(event.currentTarget.value);
                }}
              >
                {home.routines.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy}>
              Run it here
            </button>
          </form>
        </details>
      )}

      {capabilities.music && home.musicProviders.length > 0 && (
        <details class="amazon-details">
          <summary>Play music</summary>
          <form
            class="amazon-music"
            onSubmit={(event) => {
              event.preventDefault();
              if (search.trim() !== "") {
                void act({ kind: "music", providerId, search }).then(() => {
                  setSearch("");
                });
              }
            }}
          >
            <label class="amazon-field" for={ids.provider}>
              <span>From</span>
              <select
                id={ids.provider}
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.currentTarget.value);
                }}
              >
                {home.musicProviders.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label class="amazon-field" for={ids.search}>
              <span>Song, artist, album, playlist or station</span>
              <input
                id={ids.search}
                type="text"
                value={search}
                maxLength={AMAZON_TEXT_MAX_LENGTH}
                onInput={(event) => {
                  setSearch(event.currentTarget.value);
                }}
              />
            </label>
            <button type="submit" disabled={busy || search.trim() === ""}>
              Play music
            </button>
          </form>
        </details>
      )}

      {capabilities.alarms && (
        <details class="amazon-details">
          <summary>
            Alarms, timers and reminders <span class="count">{state?.notifications.length ?? 0}</span>
          </summary>
          {state === undefined || state.notifications.length === 0 ? (
            <p class="network-note">None set. Ask Alexa above to set one, e.g. “set a timer for 10 minutes”.</p>
          ) : (
            <ul class="amazon-list">
              {state.notifications.map((each) => (
                <li key={each.id}>
                  <span class="amazon-list-text">
                    <span class="rooms-devices-name">
                      {NOTIFICATION_LABELS[each.type]}
                      {each.label === null ? "" : `: ${each.label}`}
                    </span>
                    <span class="network-note">
                      {each.remaining !== null
                        ? `${durationOf(each.remaining)} left`
                        : each.at === null
                          ? ""
                          : timeOf(each.at)}
                    </span>
                  </span>
                  {each.type !== "timer" && (
                    <button
                      type="button"
                      class="aircon-toggle"
                      aria-pressed={each.on}
                      aria-label={`${NOTIFICATION_LABELS[each.type]} ${each.label ?? ""} on`.replace("  ", " ")}
                      disabled={busy}
                      onClick={() => void act({ kind: "notification-on", id: each.id, on: !each.on })}
                    >
                      {each.on && <Icon name="check" />}
                      On
                    </button>
                  )}
                  <button
                    type="button"
                    class="button-icon"
                    aria-label={`Delete ${NOTIFICATION_LABELS[each.type].toLowerCase()}${each.label === null ? "" : ` ${each.label}`}`}
                    disabled={busy}
                    onClick={() => void act({ kind: "notification-delete", id: each.id })}
                  >
                    <Icon name="trash" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {(state?.equaliser != null || state?.alarmVolume != null) && (
        <details class="amazon-details">
          <summary>Sound</summary>
          {state.equaliser != null &&
            (["bass", "midrange", "treble"] as const).map((band) => (
              <Level
                key={band}
                label={band.charAt(0).toUpperCase() + band.slice(1)}
                value={state.equaliser?.[band] ?? null}
                min={-6}
                max={6}
                onChange={(value) => {
                  const current = state.equaliser ?? { bass: 0, midrange: 0, treble: 0 };
                  void act({ kind: "equaliser", ...current, [band]: value });
                }}
              />
            ))}
          {state.alarmVolume != null && (
            <Level
              label="Alarm volume"
              value={state.alarmVolume}
              min={0}
              max={100}
              onChange={(level) => void act({ kind: "alarm-volume", level })}
            />
          )}
        </details>
      )}

      {state !== undefined && state.bluetooth.length > 0 && (
        <details class="amazon-details">
          <summary>
            Bluetooth <span class="count">{state.bluetooth.length}</span>
          </summary>
          <ul class="amazon-list">
            {state.bluetooth.map((each) => (
              <li key={each.address}>
                <span class="amazon-list-text">
                  <span class="rooms-devices-name">{each.name}</span>
                  <span class="network-note">{each.connected ? "Connected" : "Paired"}</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ kind: "bluetooth", address: each.address, connect: !each.connected })}
                >
                  {each.connected ? `Disconnect ${each.name}` : `Connect ${each.name}`}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
};

/** A level, e.g. the volume, set as the slider is let go, with its value beside it. */
export const Level = ({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) => {
  const [dragging, setDragging] = useState<number>();
  const id = useId();
  const shown = dragging ?? value;
  return (
    <div class="amazon-level">
      <label class="amazon-field" for={id}>
        <span>{label}</span>
        <input
          id={id}
          type="range"
          class="volume-slider"
          min={min}
          max={max}
          step={1}
          value={shown ?? Math.round((min + max) / 2)}
          disabled={value === null}
          onInput={(event) => {
            setDragging(Number(event.currentTarget.value));
          }}
          onChange={(event) => {
            setDragging(undefined);
            onChange(Number(event.currentTarget.value));
          }}
        />
      </label>
      <output for={id}>{shown === null ? "–" : String(shown)}</output>
    </div>
  );
};
