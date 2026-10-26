import {
  RING_CHIME_VOLUME_MAX,
  RING_FIELD_MAX_LENGTH,
  type RingAction,
  type RingDevice,
  type RingDeviceState,
  type RingEvent,
  type RingHome,
  type Room,
} from "@media-centre/shared";
import { useEffect, useId, useRef, useState } from "preact/hooks";

import { Level } from "./amazon-tab.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon, type IconName } from "./icons.tsx";
import { RoomPicker } from "./network-tab.tsx";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RingApi } from "./ring-api.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { RING_WIDGET_LAYOUT_KEY, type Layout, type Placement } from "./widget-layout.ts";

/** How often each device's widget reads it from Ring. */
export const RING_DEVICE_REFRESH_MS = 5_000;

/** How long after the doorbell is pressed its widget says so. */
export const RING_DING_SHOWN_MS = 2 * 60_000;

/** How long the browser gathers its network addresses for live view, as Ring takes them all in the offer. */
const ICE_GATHERING_MS = 3_000;

/** A public STUN server, for the browser to learn its own internet address, so Ring's video can reach it. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** Makes the browser's end of a live view. Tests give their own, as jsdom has no WebRTC. */
export type CreatePeerConnection = () => RTCPeerConnection;

export const browserPeerConnection: CreatePeerConnection = () => new RTCPeerConnection({ iceServers: ICE_SERVERS });

export interface RingTabProps {
  readonly ring: RingApi;
  readonly rooms: RoomsApi;
  /** Where this Remote remembers the tab's widgets. */
  readonly storage: RemoteStorage;
  /** {@link RING_DEVICE_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  readonly createPeerConnection?: CreatePeerConnection;
}

const KINDS: Readonly<Record<RingDevice["kind"], { readonly icon: IconName; readonly label: string }>> = {
  doorbell: { icon: "doorbell", label: "Doorbell" },
  camera: { icon: "video", label: "Camera" },
  chime: { icon: "bell", label: "Chime" },
};

const EVENT_LABELS: Readonly<Record<RingEvent["kind"], string>> = {
  ding: "Doorbell pressed",
  motion: "Motion",
  "live-view": "Live view",
  other: "Event",
};

/** Each device's widget, by Ring's id for it. */
export const ringWidgetId = (id: string): string => `ring-${id}`;

/** How tall each starts, in rows, for a desktop's 12 columns, a tablet's 8 and a phone's 4: a chime's shorter. */
const WIDGET_ROWS: Readonly<Record<number, { readonly video: number; readonly chime: number }>> = {
  12: { video: 34, chime: 16 },
  8: { video: 34, chime: 16 },
  4: { video: 38, chime: 18 },
};

const widgetLayouts = (devices: readonly RingDevice[]): Readonly<Record<number, Layout>> =>
  Object.fromEntries(
    [12, 8, 4].map((columns) => {
      const w = 4;
      const across = columns / w;
      const rows = WIDGET_ROWS[columns] ?? { video: 34, chime: 16 };
      const tallest = Math.max(...devices.map(({ capabilities }) => (capabilities.video ? rows.video : rows.chime)));
      const layout: Record<string, Placement> = {};
      devices.forEach((device, index) => {
        const h = device.capabilities.video ? rows.video : rows.chime;
        layout[ringWidgetId(device.id)] = { x: (index % across) * w, y: Math.floor(index / across) * tallest, w, h };
      });
      return [columns, layout];
    }),
  );

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The Ring tab: the owner's Ring doorbells, cameras and chimes, each a
 * widget, as on the other tabs, with everything the Ring app lets the Hub do
 * with it: a camera's latest snapshot, its live video, whether the doorbell
 * was just pressed, its light, siren and motion detection, its battery and
 * Wi-Fi, and its last events, each recorded one to watch; a chime's volume,
 * and its sounds to hear. Above them, Sign out. Signed out, it signs in with
 * the Ring account's email and password, then the two-step code Ring sends
 * (ADR 0014).
 */
export const RingTab = ({
  ring,
  rooms,
  storage,
  refreshMs = RING_DEVICE_REFRESH_MS,
  createPeerConnection = browserPeerConnection,
}: RingTabProps) => {
  const [home, setHome] = useState<RingHome>();
  const [problem, setProblem] = useState<string>();
  const [roomList, setRoomList] = useState<readonly Room[]>([]);

  const take = (asked: Promise<RingHome>): Promise<void> =>
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
    void take(ring.home());
    void reloadRooms();
  }, [ring, rooms]);

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  if (home === undefined) {
    return (
      <>
        <h1>Ring</h1>
        {problemShown || <p role="status">Loading…</p>}
      </>
    );
  }

  if (home.status.state !== "signed-in") {
    return (
      <>
        <h1>Ring</h1>
        {problemShown}
        <SignIn
          home={home}
          onSignIn={(email, password) => take(ring.signIn(email, password))}
          onCode={(code) => take(ring.enterCode(code))}
          onCancel={() => take(ring.signOut())}
        />
      </>
    );
  }

  const { status } = home;
  const widgets: WidgetDefinition[] = home.devices.map((device) => {
    const roomPicker = (
      <RoomPicker
        device={device.name}
        room={device.room}
        rooms={roomList}
        onCreate={async (name) => {
          const room = await rooms.add(name);
          await reloadRooms();
          return room;
        }}
        onChoose={(roomId) => ring.setRoom(device.id, roomId).then(setHome)}
      />
    );
    return {
      id: ringWidgetId(device.id),
      title: device.name,
      ownHeading: true,
      children: (
        <RingCard
          ring={ring}
          device={device}
          refreshMs={refreshMs}
          roomPicker={roomPicker}
          createPeerConnection={createPeerConnection}
        />
      ),
    };
  });

  const toolbar = (
    <>
      <h1>Ring</h1>
      <div class="network-controls">
        <div class="amazon-account">
          <p class="network-lead">
            Signed in to Ring, through the Ring app's own service, which Ring may change at any time.
          </p>
          <button
            type="button"
            onClick={() => {
              void take(ring.signOut());
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
        {home.devices.length === 0 && status.problem === null && (
          <p class="network-none">No Ring doorbells, cameras or chimes are on this Ring account yet.</p>
        )}
      </div>
    </>
  );

  if (widgets.length === 0) return <div class="widget-toolbar network-alone">{toolbar}</div>;
  return (
    <WidgetBoard
      widgets={widgets}
      defaults={widgetLayouts(home.devices)}
      storage={storage}
      storageKey={RING_WIDGET_LAYOUT_KEY}
      tab="Ring"
      toolbar={toolbar}
    />
  );
};

/** Signing in: the Ring account's email and password, then the two-step code Ring sends. */
const SignIn = ({
  home,
  onSignIn,
  onCode,
  onCancel,
}: {
  readonly home: RingHome;
  readonly onSignIn: (email: string, password: string) => Promise<unknown>;
  readonly onCode: (code: string) => Promise<unknown>;
  readonly onCancel: () => Promise<unknown>;
}) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = { email: useId(), password: useId(), code: useId() };
  const { status } = home;
  const busyWhile = (work: Promise<unknown>): void => {
    setBusy(true);
    void work.finally(() => {
      setBusy(false);
    });
  };

  if (status.state === "code-needed") {
    return (
      <section class="empty amazon-sign-in" aria-labelledby="ring-code">
        <h2 id="ring-code">Enter Ring's code</h2>
        <p>
          Ring has sent a code to sign in to {status.email}, {status.prompt}. Enter it here.
        </p>
        {status.problem !== null && (
          <p class="problem" role="alert">
            {status.problem}
          </p>
        )}
        <form
          class="amazon-sign-in-form"
          onSubmit={(event) => {
            event.preventDefault();
            busyWhile(
              onCode(code).then(() => {
                setCode("");
              }),
            );
          }}
        >
          <label class="amazon-field" for={ids.code}>
            <span>Code</span>
            <input
              id={ids.code}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              maxLength={RING_FIELD_MAX_LENGTH}
              onInput={(event) => {
                setCode(event.currentTarget.value);
              }}
            />
          </label>
          <div class="network-name-actions">
            <button type="submit" disabled={busy || code.trim() === ""}>
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                void onCancel();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section class="empty amazon-sign-in" aria-labelledby="ring-signed-out">
      <h2 id="ring-signed-out">Sign in to Ring</h2>
      <p>
        Sign the Hub in to the Ring account your doorbell is on, to see and control each Ring device here: snapshots and
        live video, who rang and when, recordings, lights, sirens, motion detection and chimes.
      </p>
      <p class="network-note">
        The Hub reaches them through the Ring app's own service, which Ring doesn't offer to others, so it may stop
        working without warning. It needs the internet. The Hub uses your password once, to sign in, and never keeps it:
        it keeps only the sign-in Ring gives it.
      </p>
      {status.problem !== null && (
        <p class="problem" role="alert">
          {status.problem}
        </p>
      )}
      <form
        class="amazon-sign-in-form"
        onSubmit={(event) => {
          event.preventDefault();
          busyWhile(
            onSignIn(email, password).then(() => {
              setPassword("");
            }),
          );
        }}
      >
        <label class="amazon-field" for={ids.email}>
          <span>Email address</span>
          <input
            id={ids.email}
            type="email"
            autoComplete="username"
            value={email}
            maxLength={RING_FIELD_MAX_LENGTH}
            onInput={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
        </label>
        <label class="amazon-field" for={ids.password}>
          <span>Password</span>
          <input
            id={ids.password}
            type="password"
            autoComplete="current-password"
            value={password}
            maxLength={RING_FIELD_MAX_LENGTH}
            onInput={(event) => {
              setPassword(event.currentTarget.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy || email.trim() === "" || password === ""}>
          Sign in to Ring
        </button>
      </form>
    </section>
  );
};

/** What a camera's widget shows: its latest snapshot, its live video, or a recording. */
type View =
  | { readonly kind: "snapshot"; readonly url: string }
  | { readonly kind: "live"; readonly stream: MediaStream | null }
  | { readonly kind: "recording"; readonly event: RingEvent; readonly url: string };

/** One device: what it is, then each thing it can do, read from Ring every few seconds while shown, here and on the Rooms tab. */
export const RingCard = ({
  ring,
  device,
  refreshMs,
  roomPicker,
  createPeerConnection,
}: {
  readonly ring: RingApi;
  readonly device: RingDevice;
  readonly refreshMs: number;
  /** Its Room picker, on the Ring tab; none on the Rooms tab, which shows it in its Room. */
  readonly roomPicker?: preact.ComponentChildren;
  readonly createPeerConnection: CreatePeerConnection;
}) => {
  const [state, setState] = useState<RingDeviceState>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      if (document.visibilityState !== "hidden") {
        try {
          const read = await ring.state(device.id);
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
  }, [ring, device.id, refreshMs]);

  const act = (action: RingAction): Promise<void> => {
    setBusy(true);
    return ring.act(device.id, action).then(
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

  const kind = KINDS[device.kind];
  const online = state?.online ?? device.online;
  const battery = state?.battery ?? device.battery;
  const ding =
    state?.lastDing != null && Date.now() - new Date(state.lastDing).getTime() < RING_DING_SHOWN_MS
      ? state.lastDing
      : null;

  return (
    <article class="network-device amazon-echo" aria-labelledby={headingId}>
      <div class="device-row">
        <span class="device-icon">
          <Icon name={kind.icon} />
        </span>
        <div class="device-text">
          <h2 class="device-name network-device-name" id={headingId}>
            {device.name}
          </h2>
          <span class="device-meta">
            <span>{device.model}</span>
            <span class={online ? "chip chip-good" : "chip chip-warning"}>{online ? "Online" : "Offline"}</span>
            {battery !== null && (
              <span class={battery <= 20 ? "chip chip-warning" : "chip"}>
                Battery {String(battery)}%{state?.charging === true ? ", charging" : ""}
              </span>
            )}
            {device.room !== null && <span class="chip chip-good">{device.room.name}</span>}
          </span>
        </div>
      </div>
      {roomPicker}
      {ding !== null && (
        <p class="ring-ding" role="alert">
          <Icon name="bell" />
          Someone rang the doorbell at {new Date(ding).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
        </p>
      )}
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}

      {device.capabilities.video && (
        <CameraView ring={ring} device={device} state={state} createPeerConnection={createPeerConnection} />
      )}

      {(device.capabilities.light || device.capabilities.siren || state?.motionDetection != null) && (
        <div class="amazon-toggles">
          {device.capabilities.light && (
            <Toggle label="Light" on={state?.light ?? null} busy={busy} onToggle={(on) => act({ kind: "light", on })} />
          )}
          {device.capabilities.siren && (
            <Toggle label="Siren" on={state?.siren ?? null} busy={busy} onToggle={(on) => act({ kind: "siren", on })} />
          )}
          {state?.motionDetection != null && (
            <Toggle
              label="Motion detection"
              on={state.motionDetection}
              busy={busy}
              onToggle={(on) => act({ kind: "motion-detection", on })}
            />
          )}
        </div>
      )}

      {device.kind === "chime" && (
        <>
          <Level
            label="Volume"
            value={state?.volume ?? null}
            min={0}
            max={RING_CHIME_VOLUME_MAX}
            onChange={(level) => void act({ kind: "chime-volume", level })}
          />
          <div class="amazon-toggles">
            <button type="button" disabled={busy} onClick={() => void act({ kind: "chime-test", sound: "ding" })}>
              Play the doorbell sound
            </button>
            <button type="button" disabled={busy} onClick={() => void act({ kind: "chime-test", sound: "motion" })}>
              Play the motion sound
            </button>
          </div>
        </>
      )}

      {state?.wifi != null && (
        <p class="network-note">
          Wi-Fi {state.wifi.quality}, {String(state.wifi.rssi)} dBm
          {state.lastMotion !== null && ` · Motion last seen ${timeOf(state.lastMotion)}`}
        </p>
      )}
    </article>
  );
};

/** A switch, e.g. the light, pressed while on, unknown until Ring says. */
const Toggle = ({
  label,
  on,
  busy,
  onToggle,
}: {
  readonly label: string;
  readonly on: boolean | null;
  readonly busy: boolean;
  readonly onToggle: (on: boolean) => Promise<void>;
}) => (
  <button
    type="button"
    class="aircon-toggle"
    aria-pressed={on ?? undefined}
    disabled={on === null || busy}
    onClick={() => void onToggle(!(on ?? false))}
  >
    {on === true && <Icon name="check" />}
    {label}
  </button>
);

/**
 * A camera's picture: its latest snapshot, which the Hub fetches from Ring,
 * or its live video, which the browser receives from Ring itself, or a
 * recording; and its last events, each recorded one to watch.
 */
const CameraView = ({
  ring,
  device,
  state,
  createPeerConnection,
}: {
  readonly ring: RingApi;
  readonly device: RingDevice;
  readonly state: RingDeviceState | undefined;
  readonly createPeerConnection: CreatePeerConnection;
}) => {
  const [view, setView] = useState<View>(() => ({ kind: "snapshot", url: ring.snapshotUrl(device.id) }));
  const [viewProblem, setViewProblem] = useState<string>();
  const [starting, setStarting] = useState(false);
  const live = useRef<{ readonly peer: RTCPeerConnection; sessionId: string | null } | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null);

  const stopLive = (): void => {
    const now = live.current;
    live.current = undefined;
    if (now === undefined) return;
    now.peer.close();
    if (now.sessionId !== null) void ring.endLiveView(device.id, now.sessionId).catch(() => undefined);
  };

  useEffect(() => stopLive, []);

  useEffect(() => {
    if (video.current !== null && view.kind === "live") video.current.srcObject = view.stream;
  }, [view]);

  const snapshot = (): void => {
    stopLive();
    setViewProblem(undefined);
    setView({ kind: "snapshot", url: ring.snapshotUrl(device.id) });
  };

  const watchLive = async (): Promise<void> => {
    stopLive();
    setViewProblem(undefined);
    setStarting(true);
    const peer = createPeerConnection();
    const started = { peer, sessionId: null as string | null };
    live.current = started;
    try {
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.addTransceiver("audio", { direction: "recvonly" });
      peer.ontrack = (event) => {
        if (live.current === started) setView({ kind: "live", stream: event.streams[0] ?? null });
      };
      await peer.setLocalDescription(await peer.createOffer());
      // Ring takes no addresses after the offer, so it waits for them all, or a few seconds.
      await new Promise<void>((resolve) => {
        if (peer.iceGatheringState === "complete") {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ICE_GATHERING_MS);
        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const offer = peer.localDescription?.sdp ?? "";
      const answer = await ring.startLiveView(device.id, offer);
      started.sessionId = answer.sessionId;
      if (live.current !== started) {
        void ring.endLiveView(device.id, answer.sessionId).catch(() => undefined);
        return;
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      setView((now) => (now.kind === "live" ? now : { kind: "live", stream: null }));
    } catch (error) {
      if (live.current === started) {
        stopLive();
        setViewProblem(messageFor(error));
      }
    } finally {
      setStarting(false);
    }
  };

  const watchRecording = async (event: RingEvent): Promise<void> => {
    setViewProblem(undefined);
    try {
      const { url } = await ring.recording(device.id, event.id);
      stopLive();
      setView({ kind: "recording", event, url });
    } catch (error) {
      setViewProblem(messageFor(error));
    }
  };

  const events = state?.events ?? [];

  return (
    <section class="amazon-section" aria-label={`${device.name}'s camera`}>
      <div class="ring-view">
        {view.kind === "snapshot" ? (
          <img
            key={view.url}
            src={view.url}
            alt={`The latest snapshot from ${device.name}`}
            onError={() => {
              setViewProblem("Ring gave no snapshot. A battery camera takes one only every few minutes.");
            }}
          />
        ) : view.kind === "live" ? (
          <video ref={video} aria-label={`Live from ${device.name}`} autoPlay muted playsInline controls />
        ) : (
          // Ring's recordings have no captions to give.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            key={view.url}
            src={view.url}
            aria-label={`${EVENT_LABELS[view.event.kind]} at ${timeOf(view.event.at)}, recorded by ${device.name}`}
            autoPlay
            controls
            playsInline
          />
        )}
      </div>
      {starting && <p role="status">Starting live view…</p>}
      {viewProblem !== undefined && (
        <p class="problem" role="alert">
          {viewProblem}
        </p>
      )}
      <div class="amazon-transport">
        {view.kind === "live" || starting ? (
          <button type="button" class="button-primary" onClick={snapshot}>
            Stop live view
          </button>
        ) : (
          <button type="button" class="button-primary" disabled={starting} onClick={() => void watchLive()}>
            <Icon name="play" />
            Watch live
          </button>
        )}
        <button type="button" onClick={snapshot}>
          {view.kind === "snapshot" ? "New snapshot" : "Back to the snapshot"}
        </button>
      </div>

      <details class="amazon-details">
        <summary>
          Recent events <span class="count">{events.length}</span>
        </summary>
        {events.length === 0 ? (
          <p class="network-note">None yet.</p>
        ) : (
          <ul class="amazon-list">
            {events.map((event) => (
              <li key={event.id}>
                <span class="amazon-list-text">
                  <span class="rooms-devices-name">{EVENT_LABELS[event.kind]}</span>
                  <span class="network-note">{timeOf(event.at)}</span>
                </span>
                {event.recorded && (
                  <button type="button" onClick={() => void watchRecording(event)}>
                    Watch
                    <span class="visually-hidden">
                      {" "}
                      {EVENT_LABELS[event.kind].toLowerCase()} at {timeOf(event.at)}
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
};
