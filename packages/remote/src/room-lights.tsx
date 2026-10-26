import { useId, useRef, useState } from "preact/hooks";

import {
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_BRIGHTNESS_MIN,
  type Appliance,
  type LightsChange,
  type LightsOutcome,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { LightSlider, percent } from "./light-card.tsx";
import { useLightReadings, type LightReadings } from "./light-readings.ts";

/** Names as a sentence lists them: "A", "A and B", "A, B and C". */
export const inWords = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/** What a Room-wide control or All off said last: nothing yet, how it went, or why the Hub refused it. */
export type LightsSaid =
  | { readonly kind: "none" }
  | { readonly kind: "done"; readonly unreached: readonly string[] }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Sends a Room-wide change, or with no Room All off (FR-53), as one request
 * to the Hub, only the latest once the one before has gone, and shows each
 * Light's answer in its own widget at once. Says which Lights, by
 * `titles`, didn't answer (FR-57b).
 */
export const useLightsChange = (
  appliances: AppliancesApi,
  readings: LightReadings,
  roomId: number | undefined,
  lights: readonly Appliance[],
  titles: ReadonlyMap<number, string>,
): {
  readonly send: (change: LightsChange) => void;
  readonly asked: LightsChange | undefined;
  readonly said: LightsSaid;
} => {
  const [asked, setAsked] = useState<LightsChange | undefined>(undefined);
  const [said, setSaid] = useState<LightsSaid>({ kind: "none" });
  const sending = useRef<LightsChange | undefined>(undefined);
  const queued = useRef<LightsChange | undefined>(undefined);
  // The Lights as the tab last listed them, for a change still on its way when they changed.
  const latest = useRef({ lights, titles });
  latest.current = { lights, titles };

  const sendQueued = async (): Promise<void> => {
    while (queued.current !== undefined) {
      const change = queued.current;
      queued.current = undefined;
      sending.current = change;
      const ids = latest.current.lights.map(({ id }) => id);
      for (const id of ids) readings.changing(id);
      let outcome: LightsOutcome | undefined;
      try {
        outcome = await appliances.changeLights(roomId, change);
      } catch (error) {
        setSaid({ kind: "refused", message: messageFor(error) });
      }
      for (const id of ids) readings.changing(id);
      if (outcome !== undefined) {
        for (const { id, reading } of outcome.lights) readings.answered(id, reading);
        setSaid({
          kind: "done",
          unreached: outcome.unreached.map((id) => latest.current.titles.get(id) ?? "a Light since removed"),
        });
      }
      sending.current = undefined;
      setAsked(queued.current);
    }
  };

  return {
    send: (change) => {
      queued.current = { ...queued.current, ...change };
      setAsked({ ...sending.current, ...queued.current });
      if (sending.current === undefined) void sendQueued();
    },
    asked,
    said,
  };
};

/** How a Room's Room-wide widget is named, in the Widgets menu and over it. */
export const roomLightsTitle = (room: string): string => `${room} Lights`;

export interface RoomLightsProps {
  readonly appliances: AppliancesApi;
  readonly readings: LightReadings;
  readonly roomId: number;
  /** The Room's name. */
  readonly room: string;
  /** Every Light in the Room. */
  readonly lights: readonly Appliance[];
  /** How the Remote names each, "Room · Name" (FR-9), by its id. */
  readonly titles: ReadonlyMap<number, string>;
}

/**
 * A Room's Room-wide control (FR-53): every Light in it switched on or off,
 * or set to one brightness, with one request, which the Hub makes of each
 * Light at once. It says how many of the Room's Lights are on, as each
 * says, and after a change which didn't answer (FR-57b). Brightness is for
 * the Lights that dim, which it also switches on, as the Room's slider dims
 * them: its value is theirs, as near as one value can be.
 */
export const RoomLights = ({ appliances, readings, roomId, room, lights, titles }: RoomLightsProps) => {
  useLightReadings(readings);
  const headingId = useId();
  const { send, asked, said } = useLightsChange(appliances, readings, roomId, lights, titles);

  const readingsOf = lights.map(({ id }) => readings.reading(id));
  const states = readingsOf.map((reading) => (reading?.known === true ? reading.state : undefined));
  const count = (what: string, how: number): string[] => (how > 0 ? [`${String(how)} ${what}`] : []);
  const summary = readingsOf.every((reading) => reading === undefined)
    ? "Checking…"
    : [
        ...count("on", states.filter((state) => state?.on === true).length),
        ...count("off", states.filter((state) => state?.on === false).length),
        ...count("can't be reached", readingsOf.filter((reading) => reading?.known === false).length),
      ].join(", ");

  const dims = lights.some(({ id }) => readings.capabilities(id)?.brightness === true);
  const dimmed = lights
    .map(({ id }, index) => (readings.capabilities(id)?.brightness === true ? states[index] : undefined))
    .filter((state) => state !== undefined && state.brightness !== null);
  const lit = dimmed.filter((state) => state?.on === true);
  const among = lit.length > 0 ? lit : dimmed;
  const brightness =
    asked?.brightness ??
    (among.length === 0
      ? undefined
      : Math.round(among.reduce((sum, state) => sum + (state?.brightness ?? 0), 0) / among.length));

  return (
    <section class="room-lights" aria-labelledby={headingId}>
      <header class="light-head">
        <h2 id={headingId}>{roomLightsTitle(room)}</h2>
        <p class="light-summary" role="status">
          {summary}
        </p>
      </header>
      <div class="room-lights-switches" role="group" aria-label={`Every Light in ${room}`}>
        <button
          type="button"
          onClick={() => {
            send({ on: true });
          }}
        >
          <Icon name="sun" />
          On
        </button>
        <button
          type="button"
          onClick={() => {
            send({ on: false });
          }}
        >
          <Icon name="power" />
          Off
        </button>
      </div>
      {dims && (
        <LightSlider
          label="Brightness"
          min={LIGHT_BRIGHTNESS_MIN}
          max={LIGHT_BRIGHTNESS_MAX}
          step={1}
          value={brightness}
          said={percent}
          onChange={(value) => {
            send({ brightness: value });
          }}
        />
      )}
      <LightsSaidNote said={said} />
    </section>
  );
};

/** How a Room-wide control or All off went: nothing while it went to every Light, and which didn't answer otherwise. */
export const LightsSaidNote = ({ said, allOff = false }: { readonly said: LightsSaid; readonly allOff?: boolean }) => {
  if (said.kind === "refused") {
    return (
      <p class="problem" role="alert">
        {said.message}
      </p>
    );
  }
  if (said.kind === "done" && said.unreached.length > 0) {
    return (
      <p class="problem" role="alert">
        Couldn't reach {inWords(said.unreached)}.{allOff ? " Every other Light is off." : ""}
      </p>
    );
  }
  if (said.kind === "done" && allOff) {
    return (
      <p class="lights-done" role="status">
        Every Light is off.
      </p>
    );
  }
  return null;
};
