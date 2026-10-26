import { useEffect, useMemo, useState } from "preact/hooks";

import type { Appliance, LightScene, Room } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle } from "./appliance-names.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { LIGHT_REFRESH_MS, LightCard } from "./light-card.tsx";
import { lightReadings } from "./light-readings.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import { RoomLightScenes, roomLightScenesTitle } from "./room-light-scenes.tsx";
import { LightsSaidNote, RoomLights, roomLightsTitle, useLightsChange } from "./room-lights.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { LIGHTS_WIDGET_LAYOUT_KEY, type Layout, type Placement } from "./widget-layout.ts";

/** How often the Lights tab asks the Hub again for the Lights and the Rooms. */
export const LIGHTS_REFRESH_MS = 3_000;

export interface LightsTabProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Where this Remote remembers the tab's widgets. */
  readonly storage: RemoteStorage;
  readonly onOpenSettings: () => void;
  /** {@link LIGHTS_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  /** {@link LIGHT_REFRESH_MS} but in tests. */
  readonly lightRefreshMs?: number;
}

/** Each Light's widget, by its id. */
export const lightWidgetId = (id: number): string => `light-${String(id)}`;

/** Each Room's Room-wide widget, by the Room's id. */
export const roomLightsWidgetId = (roomId: number): string => `room-lights-${String(roomId)}`;

/** Each Room's Light Scenes widget, by the Room's id. */
export const lightScenesWidgetId = (roomId: number): string => `light-scenes-${String(roomId)}`;

/** How wide each Light's widget starts, in columns: three side by side on a desktop, two on a tablet, one on a phone. */
const LIGHT_COLUMNS = 4;

/** How tall each Light's widget starts, in rows of the board's grid: enough for a colour Light's every control. */
const LIGHT_ROWS = 13;

/** How tall each Room's Room-wide widget, and its Light Scenes widget, starts, above its Lights. */
const ROOM_ROWS = 9;

/** A Room's Lights, or those in no Room, which have no Room-wide control. */
export interface LightGroup {
  readonly room: Room | undefined;
  readonly lights: readonly Appliance[];
}

/** The Lights by Room, in Room order, then those with no Room (FR-8, FR-10). Rooms with none are left out. */
export const lightGroups = (lights: readonly Appliance[], rooms: readonly Room[]): LightGroup[] => {
  const groups: LightGroup[] = rooms
    .map((room) => ({ room, lights: lights.filter(({ roomId }) => roomId === room.id) }))
    .filter((group) => group.lights.length > 0);
  const roomless = lights.filter(({ roomId }) => !rooms.some(({ id }) => id === roomId));
  if (roomless.length > 0) groups.push({ room: undefined, lights: roomless });
  return groups;
};

/**
 * Where each widget starts, for a desktop's 12 columns, a tablet's 8 and a
 * phone's 4: in Room order, with "No room" last (FR-52), each Room starting
 * a row of its own with its Room-wide widget and its Light Scenes side by
 * side across the grid, one above the other on a phone, then its Lights
 * side by side as far as the grid has room.
 */
export const lightsWidgetLayouts = (groups: readonly LightGroup[]): Readonly<Record<number, Layout>> =>
  Object.fromEntries(
    [12, 8, 4].map((columns) => {
      const across = Math.floor(columns / LIGHT_COLUMNS);
      const layout: Record<string, Placement> = {};
      let y = 0;
      for (const { room, lights } of groups) {
        if (room !== undefined) {
          const half = columns / 2;
          if (half >= LIGHT_COLUMNS) {
            layout[roomLightsWidgetId(room.id)] = { x: 0, y, w: half, h: ROOM_ROWS };
            layout[lightScenesWidgetId(room.id)] = { x: half, y, w: half, h: ROOM_ROWS };
            y += ROOM_ROWS;
          } else {
            layout[roomLightsWidgetId(room.id)] = { x: 0, y, w: columns, h: ROOM_ROWS };
            layout[lightScenesWidgetId(room.id)] = { x: 0, y: y + ROOM_ROWS, w: columns, h: ROOM_ROWS };
            y += 2 * ROOM_ROWS;
          }
        }
        lights.forEach(({ id }, index) => {
          layout[lightWidgetId(id)] = {
            x: (index % across) * LIGHT_COLUMNS,
            y: y + Math.floor(index / across) * LIGHT_ROWS,
            w: LIGHT_COLUMNS,
            h: LIGHT_ROWS,
          };
        });
        y += Math.ceil(lights.length / across) * LIGHT_ROWS;
      }
      return [columns, layout];
    }),
  );

interface Home {
  readonly lights: readonly Appliance[];
  readonly rooms: readonly Room[];
  readonly lightScenes: readonly LightScene[];
}

/**
 * The Lights tab (FR-52, FR-53, FR-57b): All off and the Widgets menu, then
 * a board of widgets, as the TV tab has, each of which can be moved, made
 * bigger or smaller, or hidden (FR-58): for each Room in Room order its
 * Room-wide on/off and brightness, then one for each of its Lights, named
 * Room · Name (FR-9), with the controls it reports it has, then the Lights
 * with no Room. Each Room has its Light Scenes too, saved, recalled,
 * renamed and deleted there (FR-56). A Light that doesn't answer says "Can't reach this Light";
 * Room-wide control and All off reach every Light that answers, and say
 * which didn't. It asks the Hub again every few seconds while it is open,
 * so that every Remote shows the same, and follows Lights and Light Scenes
 * added, renamed, moved or removed on another Remote. With none, it shows how to add one
 * (FR-6).
 */
export const LightsTab = ({
  appliances,
  rooms,
  storage,
  onOpenSettings,
  refreshMs = LIGHTS_REFRESH_MS,
  lightRefreshMs = LIGHT_REFRESH_MS,
}: LightsTabProps) => {
  const [home, setHome] = useState<Home | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Counted up to ask the Hub again at once, as after a Light Scene is saved here. */
  const [listAgain, setListAgain] = useState(0);
  const readings = useMemo(lightReadings, [appliances]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") {
        try {
          const [all, inOrder, lightScenes] = await Promise.all([
            appliances.list(),
            rooms.list(),
            appliances.lightScenes(),
          ]);
          if (!current) return;
          setHome({ lights: all.filter(({ kind }) => kind === "light"), rooms: inOrder, lightScenes });
          setProblem(undefined);
        } catch (error) {
          if (!current) return;
          setProblem(messageFor(error));
        }
      }
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [appliances, rooms, refreshMs, listAgain]);

  const lights = home?.lights ?? [];
  const titles = new Map(lights.map((light) => [light.id, applianceTitle(light, home?.rooms ?? [])]));
  const allOff = useLightsChange(appliances, readings, undefined, lights, titles);

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  if (home === undefined) {
    return (
      <>
        <h1>Lights</h1>
        {problemShown || <p>Loading the Lights…</p>}
      </>
    );
  }

  if (home.lights.length === 0) {
    return (
      <>
        <h1>Lights</h1>
        {problemShown}
        <section class="empty" aria-labelledby="no-lights">
          <h2 id="no-lights">No Lights yet</h2>
          <p>
            Add a Light in Settings: tap <strong>Find Lights</strong> to look for the Lights on your home network, or
            add one by its address.
          </p>
          <p>It has to be switched on, and on the same network as the Hub.</p>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </section>
      </>
    );
  }

  const groups = lightGroups(home.lights, home.rooms);
  const widgets: WidgetDefinition[] = groups.flatMap(({ room, lights: inGroup }) => [
    ...(room === undefined
      ? []
      : [
          {
            id: roomLightsWidgetId(room.id),
            title: roomLightsTitle(room.name),
            ownHeading: true,
            children: (
              <RoomLights
                key={room.id}
                appliances={appliances}
                readings={readings}
                roomId={room.id}
                room={room.name}
                lights={inGroup}
                titles={titles}
              />
            ),
          },
          {
            id: lightScenesWidgetId(room.id),
            title: roomLightScenesTitle(room.name),
            ownHeading: true,
            children: (
              <RoomLightScenes
                key={room.id}
                appliances={appliances}
                readings={readings}
                roomId={room.id}
                room={room.name}
                lights={inGroup}
                lightScenes={home.lightScenes.filter(({ roomId }) => roomId === room.id)}
                titles={titles}
                onChange={() => {
                  setListAgain((count) => count + 1);
                }}
              />
            ),
          },
        ]),
    ...inGroup.map((light) => {
      const title = titles.get(light.id) ?? light.name;
      return {
        id: lightWidgetId(light.id),
        title,
        ownHeading: true,
        children: (
          <LightCard
            key={light.id}
            appliances={appliances}
            light={light}
            title={title}
            readings={readings}
            refreshMs={lightRefreshMs}
          />
        ),
      };
    }),
  ]);

  return (
    <>
      {problemShown}
      <WidgetBoard
        widgets={widgets}
        defaults={lightsWidgetLayouts(groups)}
        storage={storage}
        storageKey={LIGHTS_WIDGET_LAYOUT_KEY}
        tab="Lights"
        toolbar={
          <>
            <h1>Lights</h1>
            <button
              type="button"
              class="lights-all-off"
              onClick={() => {
                allOff.send({ on: false });
              }}
            >
              <Icon name="power" />
              All off
            </button>
            <div class="lights-all-off-said">
              <LightsSaidNote said={allOff.said} allOff />
            </div>
          </>
        }
      />
    </>
  );
};
