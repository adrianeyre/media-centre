import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";

import {
  ROOM_NAME_MAX_LENGTH,
  type Appliance,
  type ApplianceKind,
  type FloorPlanDrawing,
  type FloorPlanPlaces,
  type PowerState,
  type Room,
  type AmazonHome,
  type RingHome,
  type RoomDevice,
} from "@media-centre/shared";

import { AirConditionerCard } from "./air-conditioner-card.tsx";
import type { AmazonApi } from "./amazon-api.ts";
import { AMAZON_DEVICE_REFRESH_MS, EchoCard } from "./amazon-tab.tsx";
import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, NO_ROOM } from "./appliance-names.ts";
import { Dialog } from "./dialog.tsx";
import { floorPlanOf, labelSize, middleOf, type FloorPlan } from "./floor-plan.ts";
import { FloorPlanEditor } from "./floor-plan-editor.tsx";
import { HEATING_REFRESH_MS, RoomHeating } from "./heating-tab.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon, type IconName } from "./icons.tsx";
import { LightCard } from "./light-card.tsx";
import { lightReadings } from "./light-readings.ts";
import type { NetworkApi } from "./network-api.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RingApi } from "./ring-api.ts";
import { browserPeerConnection, RING_DEVICE_REFRESH_MS, RingCard, type CreatePeerConnection } from "./ring-tab.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { saveSelectedTv } from "./selected-tv.ts";
import type { SettingsSection } from "./settings-sections.ts";
import { TvPower } from "./tv-power.tsx";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { roomWidgetLayoutKey, type Layout, type Placement } from "./widget-layout.ts";

/** How often the Rooms tab asks each TV in the Room again whether it is on. */
export const ROOMS_TV_REFRESH_MS = 3_000;

/** Where the Remote remembers the Room the Rooms tab last showed: in the browser, as its last tab. */
export const ROOMS_TAB_ROOM_KEY = "media-centre:rooms-tab-room";

/** The choice for the Appliances in no Room, which the Room list offers last where there are any. */
const NO_ROOM_CHOICE = "none";

/** The order the Room's Appliances are shown in: as the tabs are. */
const KIND_ORDER: readonly ApplianceKind[] = [
  "tv",
  "air-conditioner",
  "light",
  "heating",
  "radiator-valve",
  "hot-water",
];

/** How each kind of device the Rooms tab lists is shown: its icon, and where it was found. */
const DEVICE_KINDS: Readonly<Record<RoomDevice["kind"], { readonly icon: IconName; readonly label: string }>> = {
  network: { icon: "network", label: "Network" },
  bluetooth: { icon: "bluetooth", label: "Bluetooth" },
  amazon: { icon: "speaker", label: "Amazon" },
  ring: { icon: "doorbell", label: "Ring" },
};

/** The kinds of Appliance that are Hive's, shown together, with the Room-wide target where there is one. */
const HIVE_KINDS: readonly ApplianceKind[] = ["heating", "radiator-valve", "hot-water"];

/** How wide each widget starts, in columns: three across a desktop's 12, two across a tablet's 8, one on a phone. */
const WIDGET_COLUMNS = 4;

/**
 * How tall each starts, in rows of the board's grid, as tall as on its own
 * tab, and taller on a phone's 4 columns where its own tab is: enough for
 * every control it has. Each can be made bigger or smaller, as on any tab.
 */
const ROWS = {
  tv: 8,
  airConditioner: 42,
  light: 13,
  heating: 12,
  hotWater: 9,
  roomTarget: 7,
  heatingNotice: 3,
  echo: { wide: 30, phone: 34 },
  camera: { wide: 34, phone: 38 },
  chime: { wide: 16, phone: 18 },
  devicesHead: 3,
  device: 2,
} as const;

/** A widget's id and how tall it starts, at a desktop's or tablet's width and at a phone's. */
interface Tile {
  readonly id: string;
  readonly wide: number;
  readonly phone: number;
}

const tile = (id: string, rows: number | { readonly wide: number; readonly phone: number }): Tile =>
  typeof rows === "number" ? { id, wide: rows, phone: rows } : { id, ...rows };

/**
 * Where each of a Room's widgets starts, for a desktop's 12 columns, a
 * tablet's 8 and a phone's 4 (FR-58): in the order of the tabs, side by side
 * as far as the grid has room, each row as tall as its tallest.
 */
export const roomWidgetLayouts = (tiles: readonly Tile[]): Readonly<Record<number, Layout>> =>
  Object.fromEntries(
    [12, 8, 4].map((columns) => {
      const across = Math.floor(columns / WIDGET_COLUMNS);
      const height = (each: Tile): number => (columns === 4 ? each.phone : each.wide);
      const layout: Record<string, Placement> = {};
      let y = 0;
      for (let start = 0; start < tiles.length; start += across) {
        const row = tiles.slice(start, start + across);
        row.forEach((each, index) => {
          layout[each.id] = { x: index * WIDGET_COLUMNS, y, w: WIDGET_COLUMNS, h: height(each) };
        });
        y += Math.max(...row.map(height));
      }
      return [columns, layout];
    }),
  );

const POWER_LABELS: Readonly<Record<PowerState, string>> = {
  on: "On",
  standby: "Standby",
  unreachable: "Unreachable",
};

export interface RoomsTabProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** The devices put in a Room from the Network tab, which each Room shows beside its Appliances. */
  readonly network: NetworkApi;
  /** The owner's Echos and Ring devices, each shown in its Room with every control its own tab has. */
  readonly amazon: AmazonApi;
  readonly ring: RingApi;
  /** Where this Remote remembers the Room it last showed. */
  readonly storage: RemoteStorage;
  /** Opens the TV tab on a TV, or the Heating tab, for what this tab doesn't control itself. */
  readonly onOpenTab: (tab: "tv") => void;
  readonly onOpenSettings: (section: SettingsSection) => void;
  /** {@link ROOMS_TV_REFRESH_MS} but in tests. */
  readonly tvRefreshMs?: number;
  /** {@link HEATING_REFRESH_MS} but in tests. */
  readonly heatingRefreshMs?: number;
  /** {@link AMAZON_DEVICE_REFRESH_MS} and {@link RING_DEVICE_REFRESH_MS} but in tests. */
  readonly deviceRefreshMs?: number;
  readonly createPeerConnection?: CreatePeerConnection;
}

const loadRoomChoice = (storage: RemoteStorage): string | undefined => {
  try {
    return storage.getItem(ROOMS_TAB_ROOM_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const saveRoomChoice = (storage: RemoteStorage, choice: string): void => {
  try {
    storage.setItem(ROOMS_TAB_ROOM_KEY, choice);
  } catch {
    // A browser that refuses storage, e.g. in private browsing, just forgets.
  }
};

/**
 * The Rooms tab: the home's floor plan, and a Room, chosen on it or from a
 * list, and every Appliance in it, in the order of the tabs, so that a room
 * is controlled from one place. A place on the plan that is no Room yet is
 * made one as it is first tapped: one the Hub has, or a new one, named
 * there; "Edit floor plan" changes which Room a place is, or makes it none,
 * and opens the editor that draws the plan itself: its image and places.
 * Its Air Conditioners and Lights have every control they have in their own
 * tabs; a TV has its power, and the way to the TV tab for the rest; and
 * Hive's Appliances every control they have in the Heating tab, with the
 * Room-wide target, read from Hive while they are shown (FR-62). Its Echos
 * and Ring devices have every control they have in the Amazon and Ring tabs,
 * while the Hub is signed in to them; the other devices put in the Room, on
 * the network or Bluetooth, are listed beside them. Each Remote remembers the
 * Room it last showed.
 */
export const RoomsTab = ({
  appliances,
  rooms,
  network,
  amazon,
  ring,
  storage,
  onOpenTab,
  onOpenSettings,
  tvRefreshMs = ROOMS_TV_REFRESH_MS,
  heatingRefreshMs = HEATING_REFRESH_MS,
  deviceRefreshMs,
  createPeerConnection = browserPeerConnection,
}: RoomsTabProps) => {
  const [home, setHome] = useState<
    | {
        rooms: readonly Room[];
        appliances: readonly Appliance[];
        places: FloorPlanPlaces;
        drawing: FloorPlanDrawing;
        devices: readonly RoomDevice[];
        /** The Hub's Amazon and Ring, where it is signed in to them, to show their devices with their controls. */
        amazon: AmazonHome | undefined;
        ring: RingHome | undefined;
      }
    | undefined
  >();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<string | undefined>(() => loadRoomChoice(storage));
  /** Whether a tap on the plan changes which Room a place is, rather than showing it. */
  const [editing, setEditing] = useState(false);
  /** The place on the plan being made a Room, in its dialog. */
  const [asking, setAsking] = useState<string | undefined>(undefined);
  /** Whether the plan itself is being drawn, in its editor. */
  const [drawing, setDrawing] = useState(false);
  const readings = useMemo(lightReadings, [appliances]);
  const selectId = useId();
  /** The chosen Room's Appliances, brought into view as a Room is tapped on the floor plan, which may be above them. */
  const shownRoom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    Promise.all([
      rooms.list(),
      appliances.list(),
      rooms.floorPlan(),
      rooms.drawing(),
      // The Room's devices are a nicety: a Hub that can't list them still shows its Appliances.
      network.roomDevices().catch(() => []),
      // So are their controls: an Echo or Ring device the Hub can't reach is still listed.
      amazon.home().catch(() => undefined),
      ring.home().catch(() => undefined),
    ]).then(
      ([inOrder, all, places, drawn, devices, echos, rings]) => {
        if (current) {
          setHome({
            rooms: inOrder,
            appliances: all,
            places,
            drawing: drawn,
            devices,
            amazon: echos?.status.state === "signed-in" ? echos : undefined,
            ring: rings?.status.state === "signed-in" ? rings : undefined,
          });
        }
      },
      (error: unknown) => {
        if (current) setProblem(messageFor(error));
      },
    );
    return () => {
      current = false;
    };
  }, [rooms, appliances, network, amazon, ring]);

  if (home === undefined) {
    return (
      <>
        <h1>Rooms</h1>
        <p role={problem === undefined ? "status" : "alert"}>{problem ?? "Loading…"}</p>
      </>
    );
  }

  const roomless = home.appliances.filter(({ roomId }) => !home.rooms.some(({ id }) => id === roomId));
  const choices = [
    ...home.rooms.map((room) => ({ value: String(room.id), label: room.name })),
    ...(roomless.length > 0 ? [{ value: NO_ROOM_CHOICE, label: NO_ROOM }] : []),
  ];
  const chosen = choices.find(({ value }) => value === choice) ?? choices[0];
  const inRoom =
    chosen === undefined
      ? []
      : [
          ...(chosen.value === NO_ROOM_CHOICE
            ? roomless
            : home.appliances.filter(({ roomId }) => String(roomId) === chosen.value)),
        ].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const titleOf = (appliance: Appliance): string => applianceTitle(appliance, home.rooms);
  const hiveInRoom = inRoom.filter(({ kind }) => HIVE_KINDS.includes(kind));
  const devicesInRoom =
    chosen === undefined ? [] : home.devices.filter(({ roomId }) => String(roomId) === chosen.value);
  const echoHome = home.amazon;
  // Each Echo and Ring device with its controls, where the Hub is signed in to it; the rest are listed.
  const echosInRoom = (home.amazon?.devices ?? []).filter(({ serial }) =>
    devicesInRoom.some(({ key }) => key === `amazon:${serial}`),
  );
  const ringsInRoom = (home.ring?.devices ?? []).filter(({ id }) =>
    devicesInRoom.some(({ key }) => key === `ring:${id}`),
  );
  const listedInRoom = devicesInRoom.filter(
    ({ key }) =>
      !echosInRoom.some(({ serial }) => key === `amazon:${serial}`) &&
      !ringsInRoom.some(({ id }) => key === `ring:${id}`),
  );
  const roomOfChosen = home.rooms.find(({ id }) => String(id) === chosen?.value);
  const widgets: (WidgetDefinition & { readonly tile: Tile })[] = [
    ...inRoom
      .filter(({ kind }) => !HIVE_KINDS.includes(kind))
      .flatMap((appliance) => {
        const id = `room-appliance-${String(appliance.id)}`;
        const title = titleOf(appliance);
        if (appliance.kind === "air-conditioner") {
          return [
            {
              id,
              title,
              ownHeading: true,
              tile: tile(id, ROWS.airConditioner),
              children: (
                <AirConditionerCard
                  appliances={appliances}
                  airConditioner={appliance}
                  title={title}
                  onOpenSettings={() => {
                    onOpenSettings("aircon");
                  }}
                />
              ),
            },
          ];
        }
        if (appliance.kind === "light") {
          return [
            {
              id,
              title,
              ownHeading: true,
              tile: tile(id, ROWS.light),
              children: <LightCard appliances={appliances} light={appliance} title={title} readings={readings} />,
            },
          ];
        }
        if (appliance.kind === "tv") {
          return [
            {
              id,
              title,
              ownHeading: true,
              tile: tile(id, ROWS.tv),
              children: (
                <RoomTv
                  appliances={appliances}
                  tv={appliance}
                  title={title}
                  refreshMs={tvRefreshMs}
                  onOpen={() => {
                    saveSelectedTv(storage, appliance.id);
                    onOpenTab("tv");
                  }}
                />
              ),
            },
          ];
        }
        return [];
      }),
    // Hive's, read together, as one widget: its Heating, Radiator Valves and Hot Water, and the Room-wide target.
    ...(hiveInRoom.length > 0
      ? [
          {
            id: "room-heating",
            title: "Heating",
            ownHeading: true,
            tile: tile(
              "room-heating",
              ROWS.heatingNotice +
                hiveInRoom.reduce((rows, { kind }) => rows + (kind === "hot-water" ? ROWS.hotWater : ROWS.heating), 0) +
                (hiveInRoom.filter(({ kind }) => kind === "radiator-valve").length > 1 ? ROWS.roomTarget : 0),
            ),
            children: (
              <RoomHeating
                appliances={appliances}
                hive={hiveInRoom}
                room={roomOfChosen}
                titles={new Map(hiveInRoom.map((each) => [each.id, titleOf(each)]))}
                refreshMs={heatingRefreshMs}
              />
            ),
          },
        ]
      : []),
    ...(echoHome === undefined
      ? []
      : echosInRoom.map((device) => {
          const id = `room-echo-${device.serial}`;
          return {
            id,
            title: device.name,
            ownHeading: true,
            tile: tile(id, ROWS.echo),
            children: (
              <EchoCard
                amazon={amazon}
                device={device}
                home={echoHome}
                refreshMs={deviceRefreshMs ?? AMAZON_DEVICE_REFRESH_MS}
              />
            ),
          };
        })),
    ...ringsInRoom.map((device) => {
      const id = `room-ring-${device.id}`;
      return {
        id,
        title: device.name,
        ownHeading: true,
        tile: tile(id, device.capabilities.video ? ROWS.camera : ROWS.chime),
        children: (
          <RingCard
            ring={ring}
            device={device}
            refreshMs={deviceRefreshMs ?? RING_DEVICE_REFRESH_MS}
            createPeerConnection={createPeerConnection}
          />
        ),
      };
    }),
    ...(listedInRoom.length > 0
      ? [
          {
            id: "room-devices",
            title: "Devices",
            ownHeading: true,
            tile: tile("room-devices", ROWS.devicesHead + ROWS.device * listedInRoom.length),
            children: <RoomDevicesCard devices={listedInRoom} />,
          },
        ]
      : []),
  ];
  const choose = (next: string): void => {
    setChoice(next);
    saveRoomChoice(storage, next);
  };
  /** Shows a Room chosen on the plan, bringing its Appliances into view where they start low on the screen, as on a phone. */
  const chooseOnPlan = (next: string): void => {
    choose(next);
    requestAnimationFrame(() => {
      const room = shownRoom.current;
      if (room === null || room.getBoundingClientRect().top < window.innerHeight * 0.6) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      room.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    });
  };

  return (
    <>
      <div class="rooms-toolbar">
        <h1>Rooms</h1>
        <div class="rooms-toolbar-end">
          <button
            type="button"
            class="rooms-edit-plan"
            aria-pressed={editing}
            onClick={() => {
              setEditing((was) => !was);
            }}
          >
            <Icon name={editing ? "check" : "layout-grid"} />
            {editing ? "Done" : "Edit floor plan"}
          </button>
          {chosen !== undefined && (
            <label class="rooms-picker" for={selectId}>
              <span>Room</span>
              <select
                id={selectId}
                value={chosen.value}
                onChange={(event) => {
                  choose(event.currentTarget.value);
                }}
              >
                {choices.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {editing && (
        <div class="rooms-plan-hint">
          <p role="status">Tap a room on the plan to choose which Room it is, or to take it off the plan.</p>
          <button
            type="button"
            onClick={() => {
              setDrawing(true);
            }}
          >
            <Icon name="pencil" />
            Draw the plan
          </button>
        </div>
      )}
      {drawing && (
        <FloorPlanEditor
          roomsApi={rooms}
          onClose={() => {
            setDrawing(false);
          }}
          onSaved={(drawn) => {
            setDrawing(false);
            void rooms.floorPlan().then((places) => {
              setHome((was) => (was === undefined ? was : { ...was, places, drawing: drawn }));
            });
          }}
        />
      )}
      <FloorPlanPicker
        plan={floorPlanOf(home.drawing)}
        rooms={home.rooms}
        places={home.places}
        chosen={chosen?.value}
        editing={editing}
        onChoose={chooseOnPlan}
        onAsk={setAsking}
      />
      {asking !== undefined && (
        <PlaceDialog
          place={asking}
          rooms={home.rooms}
          places={home.places}
          roomsApi={rooms}
          onClose={() => {
            setAsking(undefined);
          }}
          onPlaced={(next, roomId) => {
            setHome({ ...home, ...next });
            setAsking(undefined);
            if (roomId !== undefined) chooseOnPlan(String(roomId));
          }}
        />
      )}
      {chosen === undefined && (
        <section class="empty" aria-labelledby="no-rooms">
          <h2 id="no-rooms">No Rooms yet</h2>
          <p>Tap a room on the floor plan to name it, or add Rooms in Settings.</p>
          <button
            type="button"
            onClick={() => {
              onOpenSettings("rooms");
            }}
          >
            Open Settings
          </button>
        </section>
      )}
      <div ref={shownRoom} class="rooms-shown">
        {chosen === undefined ? null : widgets.length === 0 ? (
          <section class="empty" aria-labelledby="room-empty">
            <h2 id="room-empty">Nothing in {chosen.label} yet</h2>
            <p>
              Give {chosen.label} its TVs, Air Conditioners, Lights and Heating in Settings, its Echos and Ring devices
              on the Amazon and Ring tabs, and any other device on the Network tab.
            </p>
          </section>
        ) : (
          <WidgetBoard
            key={chosen.value}
            widgets={widgets}
            defaults={roomWidgetLayouts(widgets.map(({ tile: each }) => each))}
            storage={storage}
            storageKey={roomWidgetLayoutKey(chosen.value)}
            tab="Rooms"
            toolbar={<h2 class="rooms-board-title">{chosen.label}</h2>}
          />
        )}
      </div>
    </>
  );
};

/**
 * The devices put in the Room that aren't Appliances, nor an Echo or Ring
 * device the Hub is signed in to: on the network or Bluetooth, or an Echo or
 * Ring device while signed out. What each is, its address and maker.
 */
const RoomDevicesCard = ({ devices }: { readonly devices: readonly RoomDevice[] }) => {
  const headingId = useId();
  return (
    <section class="rooms-card rooms-device" aria-labelledby={headingId}>
      <div class="rooms-device-head">
        <Icon name="network" />
        <h2 id={headingId}>Devices</h2>
        <span class="count">{devices.length}</span>
      </div>
      <ul class="rooms-devices">
        {devices.map((device) => (
          <li key={device.key}>
            <Icon name={DEVICE_KINDS[device.kind].icon} />
            <span class="rooms-devices-text">
              <span class="rooms-devices-name">{device.title}</span>
              <span class="rooms-devices-meta">
                {DEVICE_KINDS[device.kind].label}
                {device.address === null ? "" : ` · ${device.address}`}
                {device.maker === null ? "" : ` · ${device.maker}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** A TV in the Room: whether it is on, its Power button, and the way to the TV tab for the rest. */
const RoomTv = ({
  appliances,
  tv,
  title,
  refreshMs,
  onOpen,
}: {
  readonly appliances: AppliancesApi;
  readonly tv: Appliance;
  readonly title: string;
  readonly refreshMs: number;
  readonly onOpen: () => void;
}) => {
  const headingId = useId();
  const [power, setPower] = useState<PowerState | undefined>(undefined);
  const readNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const state = await appliances.readPower(tv.id).catch(() => undefined);
      if (current && state !== undefined) setPower(state);
    };
    readNow.current = () => void read();
    const refresh = async (): Promise<void> => {
      if (document.visibilityState !== "hidden") await read();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [appliances, tv.id, refreshMs]);

  return (
    <section class="rooms-device" aria-labelledby={headingId}>
      <div class="rooms-device-head">
        <Icon name="tv" />
        <h2 id={headingId}>{title}</h2>
      </div>
      <p class="rooms-device-kind">TV · {power === undefined ? "Checking…" : POWER_LABELS[power]}</p>
      <TvPower
        appliances={appliances}
        tv={tv}
        title={title}
        power={power}
        onSwitched={() => {
          readNow.current();
        }}
      />
      <button type="button" onClick={onOpen}>
        Open in the TV tab
      </button>
    </section>
  );
};

/**
 * The home's floor plan, a floor at a time, each place on it a button: one
 * that is a Room shows it, and is marked while it is shown, as the list is;
 * one that is no Room yet asks which it is. While editing, each asks.
 */
const FloorPlanPicker = ({
  plan,
  rooms,
  places,
  chosen,
  editing,
  onChoose,
  onAsk,
}: {
  readonly plan: FloorPlan;
  readonly rooms: readonly Room[];
  readonly places: FloorPlanPlaces;
  readonly chosen: string | undefined;
  readonly editing: boolean;
  readonly onChoose: (choice: string) => void;
  readonly onAsk: (place: string) => void;
}) => (
  <div class={`floor-plan${editing ? " floor-plan-editing" : ""}`} role="group" aria-label="Floor plan">
    {plan.layout.floors.map(({ name: floor, viewBox, places: outlines }) => (
      <figure key={floor} class="floor-plan-floor">
        <svg viewBox={viewBox} role="group" aria-label={floor}>
          <image
            class="floor-plan-art"
            href={plan.url}
            width={plan.layout.width}
            height={plan.layout.height}
            aria-hidden="true"
          />
          {outlines.map(({ id, points }) => {
            const room = rooms.find((each) => each.id === places[id]);
            const { x, y, width } = middleOf(points);
            const [, , floorWidth = plan.layout.width] = viewBox.split(" ").map(Number);
            const label = room?.name ?? "Name this room";
            const tap = (): void => {
              if (room === undefined || editing) onAsk(id);
              else onChoose(String(room.id));
            };
            return (
              <g key={id} class={`floor-plan-room${room === undefined ? " floor-plan-room-unnamed" : ""}`}>
                <polygon
                  points={points}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    room === undefined
                      ? `Name a room ${floor.toLowerCase()}`
                      : editing
                        ? `Change ${room.name} on the plan`
                        : room.name
                  }
                  aria-pressed={room !== undefined && !editing ? String(room.id) === chosen : undefined}
                  onClick={tap}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    tap();
                  }}
                />
                <text x={x} y={y} font-size={labelSize(label, width, floorWidth / 29)} aria-hidden="true">
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
        <figcaption aria-hidden="true">{floor}</figcaption>
      </figure>
    ))}
  </div>
);

/**
 * Asks which Room a place on the plan is: one the Hub has, or a new one,
 * named here and added as it is saved; or, for a place that is one, none.
 * A Room in another place moves here, as a Room is in one place.
 */
const PlaceDialog = ({
  place,
  rooms,
  places,
  roomsApi,
  onClose,
  onPlaced,
}: {
  readonly place: string;
  readonly rooms: readonly Room[];
  readonly places: FloorPlanPlaces;
  readonly roomsApi: RoomsApi;
  readonly onClose: () => void;
  /** Called with the Rooms and places as they now are, and the Room the place now is, if any. */
  readonly onPlaced: (next: { rooms: readonly Room[]; places: FloorPlanPlaces }, roomId: number | undefined) => void;
}) => {
  const current = rooms.find(({ id }) => id === places[place]);
  const placedElsewhere = new Set(
    Object.entries(places)
      .filter(([at]) => at !== place)
      .map(([, id]) => id),
  );
  // An existing Room first: this place's, else the first not on the plan yet.
  const firstFree = current ?? rooms.find(({ id }) => !placedElsewhere.has(id));
  const [mode, setMode] = useState<"existing" | "new">(firstFree === undefined ? "new" : "existing");
  const [roomId, setRoomId] = useState<number | undefined>(firstFree?.id ?? rooms[0]?.id);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const formId = useId();
  const nameId = useId();

  const done = async (work: () => Promise<{ places: FloorPlanPlaces; roomId: number | undefined }>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { places: next, roomId: placed } = await work();
      onPlaced({ rooms: await roomsApi.list(), places: next }, placed);
    } catch (error) {
      setProblem(messageFor(error));
      setBusy(false);
    }
  };

  const save = (): void => {
    if (mode === "new") {
      const proposed = name.trim();
      if (proposed === "") {
        setProblem("Give the Room a name.");
        return;
      }
      void done(async () => {
        const room = await roomsApi.add(proposed);
        return { places: await roomsApi.place(place, room.id), roomId: room.id };
      });
      return;
    }
    if (roomId === undefined) return;
    void done(async () => ({ places: await roomsApi.place(place, roomId), roomId }));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={current === undefined ? "Which Room is this?" : `Change ${current.name} on the plan`}
      closeLabel="Close without changing the plan"
      footer={
        <div class="place-actions">
          {current !== undefined && (
            <button
              type="button"
              class="button-danger"
              disabled={busy}
              onClick={() => {
                void done(async () => ({ places: await roomsApi.unplace(place), roomId: undefined }));
              }}
            >
              Take off the plan
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} class="button-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <form
        id={formId}
        class="place-form"
        aria-label="Which Room this is"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {rooms.length > 0 && (
          <div class="place-choice">
            <label class="place-option">
              <input
                type="radio"
                name="place-mode"
                checked={mode === "existing"}
                onChange={() => {
                  setMode("existing");
                }}
              />
              A Room you have
            </label>
            <select
              aria-label="Room"
              value={roomId === undefined ? "" : String(roomId)}
              onFocus={() => {
                setMode("existing");
              }}
              onChange={(event) => {
                setRoomId(Number(event.currentTarget.value));
              }}
            >
              {rooms.map((room) => (
                <option key={room.id} value={String(room.id)}>
                  {placedElsewhere.has(room.id) ? `${room.name} (moves here)` : room.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div class="place-choice">
          {rooms.length > 0 && (
            <label class="place-option">
              <input
                type="radio"
                name="place-mode"
                checked={mode === "new"}
                onChange={() => {
                  setMode("new");
                }}
              />
              A new Room
            </label>
          )}
          <label class={rooms.length > 0 ? "visually-hidden" : "place-option"} for={nameId}>
            {rooms.length > 0 ? "New Room's name" : "Name this Room"}
          </label>
          <input
            id={nameId}
            type="text"
            value={name}
            maxLength={ROOM_NAME_MAX_LENGTH}
            placeholder="e.g. Kitchen"
            onFocus={() => {
              setMode("new");
            }}
            onInput={(event) => {
              setName(event.currentTarget.value);
            }}
          />
        </div>
        {problem !== undefined && (
          <p class="problem" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Dialog>
  );
};
