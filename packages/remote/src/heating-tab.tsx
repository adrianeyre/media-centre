import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";

import type {
  Appliance,
  HeatingChange,
  HeatingHome,
  HeatingOutcome,
  HeatingReading,
  HeatingState,
  HotWaterChange,
  RadiatorValveState,
  Room,
  TemperatureRange,
} from "@media-centre/shared";

import { degrees } from "./air-conditioner-card.tsx";
import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle } from "./appliance-names.ts";
import {
  agreed,
  BoostControl,
  duration,
  HEATING_MODE_LABELS,
  HeatingSaidNote,
  HOT_WATER_MODE_LABELS,
  minutesLeftNow,
  ModeChoice,
  TargetStepper,
  useHeatingChange,
  VALVE_UNREACHABLE,
  within,
} from "./heating-controls.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { HEATING_WIDGET_LAYOUT_KEY, type Layout, type Placement } from "./widget-layout.ts";

/** How often the Heating tab asks the Hub, and so the Hub Hive, again while it is open (FR-62). */
export const HEATING_REFRESH_MS = 30_000;

/** How often a Boost's time left counts down between one read of Hive and the next. */
const TICK_MS = 15_000;

/** What the tab says while Hive can't be reached, or no longer accepts the Hub's tokens (FR-68, FR-67b). */
export const HIVE_UNREACHABLE = "Can't reach Hive";

export interface HeatingTabProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Where this Remote remembers the tab's widgets. */
  readonly storage: RemoteStorage;
  /** Opens Settings on Heating, where Hive is signed in to, and in again. */
  readonly onOpenSettings: () => void;
  /** {@link HEATING_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

export const WHOLE_HOME_WIDGET_ID = "whole-home";

/** Each Heating's widget, by its id. */
export const heatingWidgetId = (id: number): string => `heating-${String(id)}`;

/** The Hot Water's widget, by its id. */
export const hotWaterWidgetId = (id: number): string => `hot-water-${String(id)}`;

/** A Room's Room-wide target's widget, by the Room's id, for a Room with more than one Radiator Valve. */
export const radiatorValvesWidgetId = (roomId: number): string => `radiator-valves-${String(roomId)}`;

/** Each Radiator Valve's widget, by its id. */
export const radiatorValveWidgetId = (id: number): string => `radiator-valve-${String(id)}`;

/** How a Room's Room-wide target's widget is named, in the Widgets menu and over it. */
export const radiatorValvesTitle = (room: string): string => `${room} · Radiator Valves`;

/** A Room's Radiator Valves, or those in no Room, which have no Room-wide target. */
export interface ValveGroup {
  readonly room: Room | undefined;
  readonly valves: readonly Appliance[];
}

/** The Radiator Valves by Room, in Room order, then those with no Room (FR-62). Rooms with none are left out. */
export const valveGroups = (valves: readonly Appliance[], rooms: readonly Room[]): ValveGroup[] => {
  const groups: ValveGroup[] = rooms
    .map((room) => ({ room, valves: valves.filter(({ roomId }) => roomId === room.id) }))
    .filter((group) => group.valves.length > 0);
  const roomless = valves.filter(({ roomId }) => !rooms.some(({ id }) => id === roomId));
  if (roomless.length > 0) groups.push({ room: undefined, valves: roomless });
  return groups;
};

/** How wide each widget starts, in columns: three side by side on a desktop, two on a tablet, one on a phone. */
const WIDGET_COLUMNS = 4;

/** How tall each starts, in rows of the board's grid: enough for every control it has, at a phone's width. */
const WHOLE_HOME_ROWS = 12;
const HEATING_ROWS = 12;
const HOT_WATER_ROWS = 9;
/** A Room's Room-wide target: its heading and its stepper. */
const ROOM_TARGET_ROWS = 7;
const VALVE_ROWS = 12;

/**
 * Where each widget starts, for a desktop's 12 columns, a tablet's 8 and a
 * phone's 4 (FR-58): the Whole home first, then each Heating, then the Hot
 * Water, side by side as far as the grid has room, then the Radiator
 * Valves, each on its own, by Room, in Room order, with "No room" last, each
 * Room with more than one led by its Room-wide target, starting a row of
 * their own (FR-62).
 */
export const heatingWidgetLayouts = (
  heatings: readonly Appliance[],
  hotWater: readonly Appliance[],
  groups: readonly ValveGroup[],
): Readonly<Record<number, Layout>> => {
  const top = [
    ...(heatings.length > 0 ? [{ id: WHOLE_HOME_WIDGET_ID, h: WHOLE_HOME_ROWS }] : []),
    ...heatings.map(({ id }) => ({ id: heatingWidgetId(id), h: HEATING_ROWS })),
    ...hotWater.map(({ id }) => ({ id: hotWaterWidgetId(id), h: HOT_WATER_ROWS })),
  ];
  const valves = groups.flatMap(({ room, valves: inRoom }) => [
    ...(room !== undefined && inRoom.length > 1 ? [{ id: radiatorValvesWidgetId(room.id), h: ROOM_TARGET_ROWS }] : []),
    ...inRoom.map(({ id }) => ({ id: radiatorValveWidgetId(id), h: VALVE_ROWS })),
  ]);
  return Object.fromEntries(
    [12, 8, 4].map((columns) => {
      const across = Math.floor(columns / WIDGET_COLUMNS);
      const layout: Record<string, Placement> = {};
      let y = 0;
      for (const tiles of [top, valves]) {
        for (let start = 0; start < tiles.length; start += across) {
          const row = tiles.slice(start, start + across);
          row.forEach(({ id, h }, index) => {
            layout[id] = { x: index * WIDGET_COLUMNS, y, w: WIDGET_COLUMNS, h };
          });
          y += Math.max(...row.map(({ h }) => h));
        }
      }
      return [columns, layout];
    }),
  );
};

/** What Hive last reported of one, and when it was read, for its Boost to count down from. */
export interface Known {
  readonly reading: HeatingReading;
  readonly readAt: number;
}

interface Home {
  /** Hive's Appliances, as the Hub has them. */
  readonly hive: readonly Appliance[];
  readonly rooms: readonly Room[];
  /** Whether Hive could be read, or why not. */
  readonly status: "reachable" | "unreachable" | "tokens-refused" | "signed-out";
}

/** What a widget needs of the tab: Hive's last reports, how to change them, and the time. */
interface WidgetContext {
  readonly appliances: AppliancesApi;
  readonly known: ReadonlyMap<number, Known>;
  /** Whether Hive can be reached: every control is disabled while it can't (FR-68). */
  readonly reachable: boolean;
  readonly titles: ReadonlyMap<number, string>;
  /** The Heatings, to name a Radiator Valve's Heating zone by the Hub's name for it. */
  readonly heatings: readonly Appliance[];
  readonly now: number;
  readonly onAnswer: (outcome: HeatingOutcome) => void;
  readonly onFailed: () => void;
}

const HIVE_KINDS: readonly string[] = ["heating", "radiator-valve", "hot-water"];

/**
 * The Heating tab (FR-62 to FR-66, FR-68): the Widgets menu, then a board
 * of widgets, as the TV tab has, each of which can be moved, made bigger or
 * smaller, or hidden (FR-58): the Whole home, each Heating, the Hot Water,
 * then each Room's Radiator Valves, in Room order, with "No room" last. It
 * asks the Hub every 30 seconds while it is open, which reads Hive as it is
 * asked, so that every Remote shows the same, and what Hive's app changes,
 * and once more after each change, from what the Hub answers. Where Hive
 * can't be reached, it says "Can't reach Hive", every control disabled, and
 * goes on asking, so that it comes back by itself.
 */
export const HeatingTab = ({
  appliances,
  rooms,
  storage,
  onOpenSettings,
  refreshMs = HEATING_REFRESH_MS,
}: HeatingTabProps) => {
  const { loaded, heating, known, now, problem, onAnswer, readNow } = useHeatingReads(
    appliances,
    refreshMs,
    useCallback(() => Promise.all([appliances.list(), rooms.list()]), [appliances, rooms]),
  );
  const home: Home | undefined =
    loaded === undefined || heating === undefined
      ? undefined
      : {
          hive: loaded[0].filter(({ kind }) => HIVE_KINDS.includes(kind)),
          rooms: loaded[1],
          status: heating.signedIn ? heating.hive : "signed-out",
        };

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  if (home === undefined) {
    return (
      <>
        <h1>Heating</h1>
        {problemShown || <p>Loading the Heating…</p>}
      </>
    );
  }

  if (home.status === "signed-out" || home.hive.length === 0) {
    return (
      <>
        <h1>Heating</h1>
        {problemShown}
        <section class="empty" aria-labelledby="no-heating">
          <h2 id="no-heating">{home.status === "signed-out" ? "Not signed in to Hive" : "No Heating yet"}</h2>
          <p>
            Sign in to Hive in Settings, under <strong>Heating</strong>, and its Heating, Radiator Valves and Hot Water
            appear here. Hive needs the internet.
          </p>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </section>
      </>
    );
  }

  const reachable = home.status === "reachable";
  const titles = new Map(home.hive.map((appliance) => [appliance.id, applianceTitle(appliance, home.rooms)]));
  const heatings = home.hive.filter(({ kind }) => kind === "heating");
  const hotWater = home.hive.filter(({ kind }) => kind === "hot-water");
  const groups = valveGroups(
    home.hive.filter(({ kind }) => kind === "radiator-valve"),
    home.rooms,
  );
  const context: WidgetContext = {
    appliances,
    known,
    reachable,
    titles,
    heatings,
    now,
    onAnswer,
    onFailed: readNow,
  };
  const titleOf = (appliance: Appliance): string => titles.get(appliance.id) ?? appliance.name;
  /**
   * Hive has no Rooms, so each of Hive's Appliances starts in "No room",
   * unlike a TV, an Air Conditioner or a Light, which is given its Room as
   * it is added. Until each has one, the tab says where it is given one, as
   * the widgets themselves, like every other tab's, have no Room control.
   */
  const withNoRoom = home.hive.filter(({ roomId }) => roomId === null).length;

  const widgets: WidgetDefinition[] = [
    ...(heatings.length > 0
      ? [
          {
            id: WHOLE_HOME_WIDGET_ID,
            title: "Whole home",
            ownHeading: true,
            children: <WholeHome context={context} />,
          },
        ]
      : []),
    ...heatings.map((heating) => ({
      id: heatingWidgetId(heating.id),
      title: titleOf(heating),
      ownHeading: true,
      children: <HeatingZone key={heating.id} context={context} heating={heating} title={titleOf(heating)} />,
    })),
    ...hotWater.map((each) => ({
      id: hotWaterWidgetId(each.id),
      title: titleOf(each),
      ownHeading: true,
      children: <HotWater key={each.id} context={context} hotWater={each} title={titleOf(each)} />,
    })),
    ...groups.flatMap(({ room, valves }) => [
      ...(room !== undefined && valves.length > 1
        ? [
            {
              id: radiatorValvesWidgetId(room.id),
              title: radiatorValvesTitle(room.name),
              ownHeading: true,
              children: (
                <RoomValves
                  key={room.id}
                  context={context}
                  room={room}
                  valves={valves}
                  title={radiatorValvesTitle(room.name)}
                />
              ),
            },
          ]
        : []),
      ...valves.map((valve) => ({
        id: radiatorValveWidgetId(valve.id),
        title: titleOf(valve),
        ownHeading: true,
        children: (
          <HeatingControls
            key={valve.id}
            context={context}
            appliance={valve}
            title={titleOf(valve)}
            unreachable={VALVE_UNREACHABLE}
            valve
          />
        ),
      })),
    ]),
  ];

  return (
    <>
      {problemShown}
      <WidgetBoard
        widgets={widgets}
        defaults={heatingWidgetLayouts(heatings, hotWater, groups)}
        storage={storage}
        storageKey={HEATING_WIDGET_LAYOUT_KEY}
        tab="Heating"
        toolbar={
          <>
            <h1>Heating</h1>
            {!reachable && (
              <div class="heating-unreachable" role="alert">
                <p>
                  <strong>{HIVE_UNREACHABLE}.</strong>{" "}
                  {home.status === "tokens-refused"
                    ? "Hive no longer accepts the Hub's sign-in: sign in again in Settings."
                    : "Check that the Hub is connected to the internet. The tab tries again by itself."}
                </p>
                {home.status === "tokens-refused" && (
                  <button type="button" onClick={onOpenSettings}>
                    Open Settings
                  </button>
                )}
              </div>
            )}
            {withNoRoom > 0 && (
              <div class="heating-no-room">
                <p id="heating-no-room">
                  {withNoRoom === 1 ? "One of Hive's has" : `${String(withNoRoom)} of Hive's have`} no Room yet. Give
                  each a Room, and rename it, in Settings, under Heating.
                </p>
                <button type="button" aria-describedby="heating-no-room" onClick={onOpenSettings}>
                  Give each a Room
                </button>
              </div>
            )}
          </>
        }
      />
    </>
  );
};

/**
 * Reads Hive through the Hub, with whatever else `load` reads beside it, as
 * the Heating tab does, and the Rooms tab for a Room's Heating: at once, then
 * every {@link HEATING_REFRESH_MS} while the page is in view, and again as
 * {@link HeatingReads.readNow} asks, so that Hive is read only while one of
 * them shows it (FR-62). A change's answer, as {@link HeatingReads.onAnswer}
 * is given it, is shown at once, and a read begun before it never shown
 * after it. Each Boost's time left counts down between reads.
 */
export interface HeatingReads<T> {
  readonly loaded: T | undefined;
  readonly heating: HeatingHome | undefined;
  /** What Hive last reported of each, by its id, and when. */
  readonly known: ReadonlyMap<number, Known>;
  readonly now: number;
  readonly problem: string | undefined;
  readonly onAnswer: (outcome: HeatingOutcome) => void;
  readonly readNow: () => void;
}

export const useHeatingReads = <T,>(
  appliances: AppliancesApi,
  refreshMs: number,
  load: () => Promise<T>,
): HeatingReads<T> => {
  const [loaded, setLoaded] = useState<T | undefined>(undefined);
  const [heating, setHeating] = useState<HeatingHome | undefined>(undefined);
  const [known, setKnown] = useState<ReadonlyMap<number, Known>>(new Map());
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  /** Counts every change answered, so that a read begun before one is never shown after it. */
  const answers = useRef(0);
  /** Reads Hive now, between refreshes, as after a change the Hub couldn't make; set while it is shown. */
  const readNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (): Promise<void> => {
      const answeredBefore = answers.current;
      try {
        const [also, home] = await Promise.all([load(), appliances.readHeating()]);
        if (!current) return;
        setLoaded(also);
        setHeating(home);
        setProblem(undefined);
        setNow(Date.now());
        // A change answered since this began knows better.
        if (answeredBefore !== answers.current) return;
        const readAt = Date.now();
        setKnown(
          new Map(
            home.signedIn && home.hive === "reachable"
              ? home.appliances.map((reading) => [reading.id, { reading, readAt }])
              : [],
          ),
        );
      } catch (error) {
        if (current) setProblem(messageFor(error));
      }
    };
    readNow.current = () => void read();

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking, nor the Hub Hive.
      if (document.visibilityState !== "hidden") await read();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [appliances, refreshMs, load]);

  // Each Boost's time left counts down between reads.
  useEffect(() => {
    const ticking = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(ticking);
    };
  }, []);

  const onAnswer = (outcome: HeatingOutcome): void => {
    answers.current += 1;
    const readAt = Date.now();
    setNow(readAt);
    setKnown((before) => {
      const next = new Map(before);
      for (const report of outcome.appliances) {
        const kept = before.get(report.id);
        if (kept === undefined || kept.reading.kind !== report.kind) continue;
        next.set(report.id, { reading: { ...kept.reading, state: report.state } as HeatingReading, readAt });
      }
      return next;
    });
  };

  return {
    loaded,
    heating,
    known,
    now,
    problem,
    onAnswer,
    readNow: () => {
      readNow.current();
    },
  };
};

/**
 * One Room's Heating, Radiator Valves and Hot Water, each as a card with
 * every control it has in the Heating tab, and, for a Room with more than one
 * Radiator Valve, its Room-wide target: for the Rooms tab, which reads Hive
 * for them while it shows them, as the Heating tab does (FR-62). Where Hive
 * can't be reached, each says so, its controls disabled.
 */
export const RoomHeating = ({
  appliances,
  hive,
  room,
  titles,
  refreshMs = HEATING_REFRESH_MS,
}: {
  readonly appliances: AppliancesApi;
  /** The Room's own Heating, Radiator Valves and Hot Water. */
  readonly hive: readonly Appliance[];
  /** The Room, for its Room-wide target, or undefined for those in no Room. */
  readonly room: Room | undefined;
  /** How the Remote names each of Hive's Appliances, "Room · Name". */
  readonly titles: ReadonlyMap<number, string>;
  readonly refreshMs?: number;
}) => {
  const { heating, known, now, problem, onAnswer, readNow } = useHeatingReads(appliances, refreshMs, noMore);
  // The Heating zone a Radiator Valve names may be in another Room, so every Heating the Hub has is kept.
  const [zones, setZones] = useState<readonly Appliance[]>([]);
  useEffect(() => {
    let current = true;
    appliances.list().then(
      (all) => {
        if (current) setZones(all.filter(({ kind }) => kind === "heating"));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [appliances]);
  const reachable = heating?.signedIn === true && heating.hive === "reachable";
  const context: WidgetContext = {
    appliances,
    known,
    reachable,
    titles,
    heatings: zones,
    now,
    onAnswer,
    onFailed: readNow,
  };
  const valves = hive.filter(({ kind }) => kind === "radiator-valve");
  const titleOf = (appliance: Appliance): string => titles.get(appliance.id) ?? appliance.name;
  const cards = [
    ...(heating !== undefined && !reachable
      ? [
          <div key="unreachable" class="rooms-card heating-unreachable" role="alert">
            <p>
              <strong>{HIVE_UNREACHABLE}.</strong>{" "}
              {heating.signedIn
                ? "The Heating tab tries again by itself."
                : "Sign in to Hive in Settings, under Heating."}
            </p>
          </div>,
        ]
      : []),
    ...(problem === undefined
      ? []
      : [
          <p key="problem" class="rooms-card problem" role="alert">
            {problem}
          </p>,
        ]),
    ...(room !== undefined && valves.length > 1
      ? [
          <div key="room-target" class="rooms-card">
            <RoomValves context={context} room={room} valves={valves} title={radiatorValvesTitle(room.name)} />
          </div>,
        ]
      : []),
    ...hive.map((each) => (
      <div key={each.id} class="rooms-card">
        {each.kind === "heating" ? (
          <HeatingZone context={context} heating={each} title={titleOf(each)} />
        ) : each.kind === "hot-water" ? (
          <HotWater context={context} hotWater={each} title={titleOf(each)} />
        ) : (
          <HeatingControls
            context={context}
            appliance={each}
            title={titleOf(each)}
            unreachable={VALVE_UNREACHABLE}
            valve
          />
        )}
      </div>
    )),
  ];
  return <>{cards}</>;
};

/** Nothing beside Hive, as the Rooms tab already has the Appliances. */
const noMore = (): Promise<undefined> => Promise.resolve(undefined);

/** A Heating's or a Radiator Valve's state, from what Hive last reported, if it has. */
const heatingStateOf = (known: Known | undefined): HeatingState | undefined =>
  known?.reading.kind === "heating" || known?.reading.kind === "radiator-valve" ? known.reading.state : undefined;

/** What a Boost on a Heating or a Radiator Valve says, with its time left now, or undefined for none. */
const heatingBoostSaid = (known: Known | undefined, now: number): string | undefined => {
  const state = heatingStateOf(known);
  if (state?.boost === null || state === undefined || known === undefined) return undefined;
  return `Boost to ${degrees(state.boost.target)}, ${duration(minutesLeftNow(state.boost.minutesLeft, known.readAt, now))} left`;
};

/** The targets every one of `ranges` takes. */
const sharedRange = (ranges: readonly TemperatureRange[]): TemperatureRange | undefined => {
  const [first] = ranges;
  if (first === undefined) return undefined;
  return {
    min: Math.max(...ranges.map(({ min }) => min)),
    max: Math.min(...ranges.map(({ max }) => max)),
    step: first.step,
  };
};

const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/** The temperature a Heating or a Radiator Valve reads, and for a Heating whether it is calling for heat. */
const Readings = ({ state, calling }: { readonly state: HeatingState | undefined; readonly calling: boolean }) => (
  <dl class="aircon-temperatures heating-readings">
    <div>
      <dt>Reads</dt>
      <dd>{state?.temperature === null || state === undefined ? "–" : degrees(state.temperature)}</dd>
    </div>
    {calling && (
      <div>
        <dt>Heat</dt>
        <dd class={state?.callingForHeat === true ? "heating-calling" : undefined}>
          {state === undefined ? "–" : state.callingForHeat ? "Calling for heat" : "Not calling"}
        </dd>
      </div>
    )}
  </dl>
);

/** The Whole home (FR-64): every Heating's target, mode and Boost together, "Mixed" where they differ. */
const WholeHome = ({ context }: { readonly context: WidgetContext }) => {
  const { appliances, heatings, known, reachable, titles, now } = context;
  const headingId = useId();
  const { change, asked, said } = useHeatingChange(
    (next: HeatingChange) => appliances.changeWholeHome(next),
    context.onAnswer,
    context.onFailed,
    titles,
  );
  const zones = heatings.flatMap((heating) => {
    const reading = known.get(heating.id);
    return reading?.reading.kind === "heating" ? [{ heating, known: reading, reading: reading.reading }] : [];
  });
  const states = zones.map(({ reading }) => reading.state);
  const usable = reachable && zones.length > 0;
  const mode = asked !== undefined && "mode" in asked ? asked.mode : agreed(states.map((state) => state.mode));
  const target = asked !== undefined && "target" in asked ? asked.target : agreed(states.map((state) => state.target));
  const range = sharedRange(zones.map(({ reading }) => reading.capabilities.target));
  const boostMinutes = zones[0]?.reading.capabilities.boostMinutes ?? [];
  const boosts = zones.map(({ known: each }) => heatingBoostSaid(each, now));
  const boosting = boosts.some((each) => each !== undefined)
    ? (() => {
        const all = agreed(boosts);
        return all === "mixed" || all === undefined ? "Boost: Mixed" : all;
      })()
    : undefined;

  const summary =
    asked !== undefined
      ? "Sending to Hive…"
      : !usable
        ? "–"
        : boosting !== undefined && boosts.every((each) => each !== undefined) && boosting !== "Boost: Mixed"
          ? boosting
          : mode === "mixed" || target === "mixed"
            ? "Mixed"
            : `${mode === undefined ? "" : HEATING_MODE_LABELS[mode]}, ${target === undefined ? "" : degrees(target)}`;

  return (
    <section class="aircon heating" aria-labelledby={headingId}>
      <header class="aircon-head">
        <h2 id={headingId}>Whole home</h2>
        <p class="aircon-summary" role="status">
          {summary}
        </p>
        <p class="aircon-note">Every Heating: {heatings.map((heating) => titles.get(heating.id)).join(", ")}.</p>
      </header>
      <HeatingSaidNote said={said} many />
      <div class="aircon-controls">
        <TargetStepper
          label="Target temperature"
          of="every Heating's target temperature"
          range={range}
          target={usable ? target : undefined}
          from={range === undefined ? undefined : within(range, average(states.map((state) => state.target)))}
          disabled={!usable}
          onChange={(celsius) => {
            change({ target: celsius });
          }}
        />
        <ModeChoice
          name="whole-home-mode"
          modes={["schedule", "manual", "off"]}
          labels={HEATING_MODE_LABELS}
          mode={usable ? mode : undefined}
          disabled={!usable}
          onChange={(next) => {
            change({ mode: next });
          }}
        />
        <BoostControl
          title="Whole home"
          alsoBoosts="Every Heating zone and every Radiator Valve is boosted, to the same temperature, for as long. Cancelling it cancels theirs."
          boosting={usable ? boosting : undefined}
          boostMinutes={boostMinutes}
          range={range}
          startAt={typeof target === "number" ? target + 1 : 21}
          disabled={!usable}
          onBoost={({ target: boostTarget = 21, minutes }) => {
            change({ boost: { target: boostTarget, minutes } });
          }}
          onCancel={() => {
            change({ boost: null });
          }}
        />
      </div>
    </section>
  );
};

interface HeatingControlsProps {
  readonly context: WidgetContext;
  readonly appliance: Appliance;
  readonly title: string;
  /** What the Appliance is called where Hive can't reach it (FR-68), e.g. "Can't reach this Radiator Valve". */
  readonly unreachable: string;
  /** A Radiator Valve's battery and Heating zone, beside what it reads. */
  readonly valve: boolean;
}

/** A Heating's or a Radiator Valve's target, mode and Boost (FR-63, FR-65), as Hive reports them. */
const HeatingControls = ({ context, appliance, title, unreachable, valve }: HeatingControlsProps) => {
  const { appliances, known: all, reachable, titles, heatings, now } = context;
  const headingId = useId();
  const { change, asked, said } = useHeatingChange(
    (next: HeatingChange) => appliances.changeHeating(appliance.id, next),
    context.onAnswer,
    context.onFailed,
    titles,
  );
  const known = all.get(appliance.id);
  const reading =
    known?.reading.kind === "heating" || known?.reading.kind === "radiator-valve" ? known.reading : undefined;
  const state = reading?.state;
  const offline = state?.online === false;
  const usable = reachable && state !== undefined && !offline;
  const mode = asked !== undefined && "mode" in asked ? asked.mode : state?.mode;
  const target = asked !== undefined && "target" in asked ? asked.target : state?.target;
  const boosting = heatingBoostSaid(known, now);
  const valveState = valve && state !== undefined ? (state as RadiatorValveState) : undefined;
  const zone = (() => {
    const of = valveState?.zone;
    if (of === undefined || of === null) return undefined;
    const heating = heatings.find(({ serialNumber }) => serialNumber === of.id);
    return heating === undefined ? of.name : (titles.get(heating.id) ?? heating.name);
  })();

  const summary =
    asked !== undefined
      ? "Sending to Hive…"
      : !reachable || state === undefined
        ? "–"
        : offline
          ? unreachable
          : boosting !== undefined
            ? boosting
            : `${HEATING_MODE_LABELS[state.mode]}, ${degrees(state.target)}`;

  return (
    <section class="aircon heating" aria-labelledby={headingId}>
      <header class="aircon-head">
        <h2 id={headingId}>{title}</h2>
        <p
          class={offline && asked === undefined ? "aircon-summary aircon-not-answering" : "aircon-summary"}
          role="status"
        >
          {summary}
        </p>
        <Readings state={reachable ? state : undefined} calling={!valve} />
        {reachable && zone !== undefined && (
          <dl class="aircon-temperatures heating-readings">
            <div>
              <dt>Heating zone</dt>
              <dd>{zone}</dd>
            </div>
          </dl>
        )}
        {valve && reachable && valveState?.lowBattery === true && (
          <p class="heating-warning">
            <Icon name="battery-low" />
            Low battery
          </p>
        )}
      </header>
      {/* A zone's Boost is its Radiator Valves' too, so one of them may be the one refused. */}
      <HeatingSaidNote said={said} many={said.kind === "refused" && said.names.some((name) => name !== title)} />
      <div class="aircon-controls">
        <TargetStepper
          label="Target temperature"
          of={`${title}'s target temperature`}
          range={reading?.capabilities.target}
          target={usable ? target : undefined}
          disabled={!usable}
          onChange={(celsius) => {
            change({ target: celsius });
          }}
        />
        <ModeChoice
          name={`heating-mode-${String(appliance.id)}`}
          modes={reading?.capabilities.modes ?? ["schedule", "manual", "off"]}
          labels={HEATING_MODE_LABELS}
          mode={usable ? mode : undefined}
          disabled={!usable}
          onChange={(next) => {
            change({ mode: next });
          }}
        />
        <BoostControl
          title={title}
          alsoBoosts={
            valve
              ? undefined
              : "Every Radiator Valve in this zone is boosted with it, to the same temperature, for as long. Cancelling it cancels theirs."
          }
          boosting={usable ? boosting : undefined}
          boostMinutes={reading?.capabilities.boostMinutes ?? []}
          range={reading?.capabilities.target}
          startAt={(state?.target ?? 20) + 1}
          disabled={!usable}
          onBoost={({ target: boostTarget = 21, minutes }) => {
            change({ boost: { target: boostTarget, minutes } });
          }}
          onCancel={() => {
            change({ boost: null });
          }}
        />
      </div>
    </section>
  );
};

/** One Heating zone (FR-63). */
const HeatingZone = ({
  context,
  heating,
  title,
}: {
  readonly context: WidgetContext;
  readonly heating: Appliance;
  readonly title: string;
}) => (
  <HeatingControls
    context={context}
    appliance={heating}
    title={title}
    unreachable="Can't reach this Heating"
    valve={false}
  />
);

/** The Hot Water (FR-66): its mode, Schedule, On or Off, and a Boost by duration only. */
const HotWater = ({
  context,
  hotWater,
  title,
}: {
  readonly context: WidgetContext;
  readonly hotWater: Appliance;
  readonly title: string;
}) => {
  const { appliances, known: all, reachable, titles, now } = context;
  const headingId = useId();
  const { change, asked, said } = useHeatingChange(
    (next: HotWaterChange) => appliances.changeHeating(hotWater.id, next),
    context.onAnswer,
    context.onFailed,
    titles,
  );
  const known = all.get(hotWater.id);
  const reading = known?.reading.kind === "hot-water" ? known.reading : undefined;
  const state = reading?.state;
  const offline = state?.online === false;
  const usable = reachable && state !== undefined && !offline;
  const mode = asked !== undefined && "mode" in asked ? asked.mode : state?.mode;
  const boosting =
    state?.boost === null || state === undefined || known === undefined
      ? undefined
      : `Boost, ${duration(minutesLeftNow(state.boost.minutesLeft, known.readAt, now))} left`;
  const summary =
    asked !== undefined
      ? "Sending to Hive…"
      : !reachable || state === undefined
        ? "–"
        : offline
          ? "Can't reach the Hot Water"
          : (boosting ?? HOT_WATER_MODE_LABELS[state.mode]);

  return (
    <section class="aircon heating" aria-labelledby={headingId}>
      <header class="aircon-head">
        <h2 id={headingId}>{title}</h2>
        <p
          class={offline && asked === undefined ? "aircon-summary aircon-not-answering" : "aircon-summary"}
          role="status"
        >
          {summary}
        </p>
        <p class={state?.on === true && reachable ? "heating-note heating-calling" : "heating-note"}>
          {!reachable || state === undefined ? "–" : state.on ? "Heating the water" : "Not heating the water"}
        </p>
      </header>
      <HeatingSaidNote said={said} />
      <div class="aircon-controls">
        <ModeChoice
          name={`hot-water-mode-${String(hotWater.id)}`}
          modes={reading?.capabilities.modes ?? ["schedule", "on", "off"]}
          labels={HOT_WATER_MODE_LABELS}
          mode={usable ? mode : undefined}
          disabled={!usable}
          onChange={(next) => {
            change({ mode: next });
          }}
        />
        <BoostControl
          title={title}
          boosting={usable ? boosting : undefined}
          boostMinutes={reading?.capabilities.boostMinutes ?? []}
          range={undefined}
          startAt={0}
          disabled={!usable}
          onBoost={({ minutes }) => {
            change({ boost: { minutes } });
          }}
          onCancel={() => {
            change({ boost: null });
          }}
        />
      </div>
    </section>
  );
};

/**
 * A Room's Room-wide target (FR-65), for a Room with more than one Radiator
 * Valve, each of which has a widget of its own: it sets every one, naming
 * any that didn't take it.
 */
const RoomValves = ({
  context,
  room,
  valves,
  title,
}: {
  readonly context: WidgetContext;
  readonly room: Room;
  readonly valves: readonly Appliance[];
  readonly title: string;
}) => {
  const headingId = useId();
  return (
    <section class="heating-valves" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <RoomTarget context={context} room={room} valves={valves} />
    </section>
  );
};

/** A Room's Room-wide target (FR-65): every Radiator Valve in it set to one target, "Mixed" while they differ. */
const RoomTarget = ({
  context,
  room,
  valves,
}: {
  readonly context: WidgetContext;
  readonly room: Room;
  readonly valves: readonly Appliance[];
}) => {
  const { appliances, known, reachable, titles } = context;
  const { change, asked, said } = useHeatingChange(
    (next: { readonly target: number }) => appliances.setRoomTarget(room.id, next.target),
    context.onAnswer,
    context.onFailed,
    titles,
  );
  const readings = valves.flatMap((valve) => {
    const each = known.get(valve.id)?.reading;
    return each?.kind === "radiator-valve" && each.state.online ? [each] : [];
  });
  const usable = reachable && readings.length > 0;
  const target = asked !== undefined ? asked.target : agreed(readings.map(({ state }) => state.target));
  const range = sharedRange(readings.map(({ capabilities }) => capabilities.target));
  return (
    <div class="heating-room-target">
      <TargetStepper
        label={`Every Radiator Valve in ${room.name}`}
        of={`every Radiator Valve's target in ${room.name}`}
        range={range}
        target={usable ? target : undefined}
        from={range === undefined ? undefined : within(range, average(readings.map(({ state }) => state.target)))}
        disabled={!usable}
        onChange={(celsius) => {
          change({ target: celsius });
        }}
      />
      {asked !== undefined && (
        <p class="aircon-note" role="status">
          Sending to Hive…
        </p>
      )}
      <HeatingSaidNote said={said} many />
    </div>
  );
};
