import { useEffect, useState } from "preact/hooks";

import type { Appliance, Room } from "@media-centre/shared";

import { AIR_CONDITIONER_REFRESH_MS, AirConditionerCard } from "./air-conditioner-card.tsx";
import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, groupByRoom, type RoomGroup } from "./appliance-names.ts";
import { messageFor } from "./hub-request.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { AIRCON_WIDGET_LAYOUT_KEY, type Layout, type Placement } from "./widget-layout.ts";

/** How often the Aircon tab asks the Hub again for the Air Conditioners and the Rooms. */
export const AIRCON_REFRESH_MS = 3_000;

export interface AirconTabProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Where this Remote remembers the tab's widgets. */
  readonly storage: RemoteStorage;
  readonly onOpenSettings: () => void;
  /** {@link AIRCON_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  /** {@link AIR_CONDITIONER_REFRESH_MS} but in tests. */
  readonly airConditionerRefreshMs?: number;
}

/** Each Air Conditioner's widget, by its id. */
export const airConditionerWidgetId = (id: number): string => `air-conditioner-${String(id)}`;

/** How wide each Air Conditioner's widget starts, in columns: three side by side on a desktop, two on a tablet, one on a phone. */
const WIDGET_COLUMNS: Readonly<Record<number, number>> = { 12: 4, 8: 4, 4: 4 };

/**
 * How tall each starts, in rows of the board's grid: enough for one with
 * every control a Midea unit can report, at a phone's or a tablet's width,
 * so that none is out of sight. One with fewer can be made shorter.
 */
const WIDGET_ROWS = 42;

/**
 * Where each Air Conditioner's widget starts, for a desktop's 12 columns, a
 * tablet's 8 and a phone's 4: side by side as far as the grid has room, in
 * Room order, with "No room" last (FR-49), each named by its Room, so that
 * Rooms with one each don't leave a row each half empty.
 */
export const airconWidgetLayouts = (groups: readonly RoomGroup[]): Readonly<Record<number, Layout>> =>
  Object.fromEntries(
    Object.entries(WIDGET_COLUMNS).map(([columns, w]) => {
      const across = Math.floor(Number(columns) / w);
      const layout: Record<string, Placement> = {};
      groups
        .flatMap(({ appliances }) => appliances)
        .forEach(({ id }, index) => {
          layout[airConditionerWidgetId(id)] = {
            x: (index % across) * w,
            y: Math.floor(index / across) * WIDGET_ROWS,
            w,
            h: WIDGET_ROWS,
          };
        });
      return [columns, layout];
    }),
  );

interface Home {
  readonly airConditioners: readonly Appliance[];
  readonly rooms: readonly Room[];
}

/**
 * The Aircon tab (FR-49): the Widgets menu, then a board of widgets, as the
 * TV tab has, each of which can be moved, made bigger or smaller, or hidden
 * (FR-58): one for each Air Conditioner, named Room · Name (FR-9), starting
 * in Room order, with "No room" last (FR-10), each with the controls it
 * reports it has (FR-50), and "Can't reach this Air Conditioner" while it
 * doesn't answer (FR-51a). It asks the Hub again every few seconds while it
 * is open, as the TV tab does, so that every Remote shows the same, and
 * follows Air Conditioners added, renamed, moved or removed on another
 * Remote. With none, it shows how to add one (FR-6).
 */
export const AirconTab = ({
  appliances,
  rooms,
  storage,
  onOpenSettings,
  refreshMs = AIRCON_REFRESH_MS,
  airConditionerRefreshMs = AIR_CONDITIONER_REFRESH_MS,
}: AirconTabProps) => {
  const [home, setHome] = useState<Home | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") {
        try {
          const [all, inOrder] = await Promise.all([appliances.list(), rooms.list()]);
          if (!current) return;
          setHome({ airConditioners: all.filter(({ kind }) => kind === "air-conditioner"), rooms: inOrder });
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
  }, [appliances, rooms, refreshMs]);

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  if (home === undefined) {
    return (
      <>
        <h1>Aircon</h1>
        {problemShown || <p>Loading the Air Conditioners…</p>}
      </>
    );
  }

  if (home.airConditioners.length === 0) {
    return (
      <>
        <h1>Aircon</h1>
        {problemShown}
        <section class="empty" aria-labelledby="no-air-conditioners">
          <h2 id="no-air-conditioners">No Air Conditioners yet</h2>
          <p>
            Add an Air Conditioner in Settings: tap <strong>Find Air Conditioners</strong> to look for the Midea units
            on your home network, or add one by its IP address.
          </p>
          <p>It has to be switched on, and on the same network as the Hub.</p>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </section>
      </>
    );
  }

  const groups = groupByRoom(home.airConditioners, home.rooms);
  const widgets: WidgetDefinition[] = groups.flatMap((group) =>
    group.appliances.map((airConditioner) => {
      const title = applianceTitle(airConditioner, home.rooms);
      return {
        id: airConditionerWidgetId(airConditioner.id),
        title,
        ownHeading: true,
        children: (
          <AirConditionerCard
            key={airConditioner.id}
            appliances={appliances}
            airConditioner={airConditioner}
            title={title}
            onOpenSettings={onOpenSettings}
            refreshMs={airConditionerRefreshMs}
          />
        ),
      };
    }),
  );

  return (
    <>
      {problemShown}
      <WidgetBoard
        widgets={widgets}
        defaults={airconWidgetLayouts(groups)}
        storage={storage}
        storageKey={AIRCON_WIDGET_LAYOUT_KEY}
        tab="Aircon"
        toolbar={<h1>Aircon</h1>}
      />
    </>
  );
};
