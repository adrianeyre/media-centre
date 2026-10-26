import { useId, useRef, useState } from "preact/hooks";

import type {
  HeatingChange,
  HeatingMode,
  HeatingOutcome,
  HotWaterChange,
  HotWaterMode,
  TemperatureRange,
} from "@media-centre/shared";

import { degrees } from "./air-conditioner-card.tsx";
import { Dialog } from "./dialog.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { inWords } from "./room-lights.tsx";

/** What the Remote says of a Radiator Valve Hive reports offline (FR-68). */
export const VALVE_UNREACHABLE = "Can't reach this Radiator Valve";

/** What the Remote says of a change Hive refused (FR-68). */
export const HIVE_REFUSED = "Hive refused this";

export const HEATING_MODE_LABELS: Readonly<Record<HeatingMode, string>> = {
  schedule: "Schedule",
  manual: "Manual",
  off: "Off",
};

export const HOT_WATER_MODE_LABELS: Readonly<Record<HotWaterMode, string>> = {
  schedule: "Schedule",
  on: "On",
  off: "Off",
};

/** A duration in minutes as the Remote writes it: "45 min", "1 h", "1 h 30 min". */
export const duration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
};

/**
 * How long a Boost has left now: the minutes Hive reported, less the whole
 * minutes since, counting down between one read of Hive and the next.
 */
export const minutesLeftNow = (reported: number, readAt: number, now: number): number =>
  Math.max(0, reported - Math.floor(Math.max(0, now - readAt) / 60_000));

/** The target nearest `celsius` that `range` takes, in its steps. */
export const within = (range: TemperatureRange, celsius: number): number => {
  const steps = Math.round((celsius - range.min) / range.step);
  return Math.min(range.max, Math.max(range.min, range.min + steps * range.step));
};

/** The one value every one has, or "mixed" where they differ, or undefined for none (FR-64). */
export const agreed = <Value,>(values: readonly Value[]): Value | "mixed" | undefined => {
  const [first] = values;
  if (first === undefined) return undefined;
  return values.every((value) => value === first) ? first : "mixed";
};

/** What a change said last: nothing yet, those Hive refused it for, or why the Hub couldn't make it. */
export type HeatingSaid =
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly names: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

/** Two changes of the same thing, e.g. two targets, are one: the later. */
const sameThing = (one: object, other: object): boolean => Object.keys(one)[0] === Object.keys(other)[0];

/**
 * Sends one control's changes to the Hub, one at a time, in the order they
 * were made, a change of the same thing as the one still waiting replacing
 * it, so that only the latest target is sent once the one before has gone.
 * Each answer goes to `onAnswer`, with what Hive then reports, and what was
 * refused is said by `titles` (FR-68). A change the Hub couldn't make, as
 * where Hive can't be reached, calls `onFailed`, for the tab to read Hive
 * again at once.
 */
export const useHeatingChange = <Change extends HeatingChange | HotWaterChange>(
  send: (change: Change) => Promise<HeatingOutcome>,
  onAnswer: (outcome: HeatingOutcome) => void,
  onFailed: () => void,
  titles: ReadonlyMap<number, string>,
): {
  readonly change: (change: Change) => void;
  /** The latest change still on its way, which the control shows it is sending. */
  readonly asked: Change | undefined;
  readonly said: HeatingSaid;
} => {
  const [asked, setAsked] = useState<Change | undefined>(undefined);
  const [said, setSaid] = useState<HeatingSaid>({ kind: "none" });
  const queued = useRef<Change[]>([]);
  const sending = useRef<Change | undefined>(undefined);
  const latest = useRef({ send, onAnswer, onFailed, titles });
  latest.current = { send, onAnswer, onFailed, titles };

  const sendQueued = async (): Promise<void> => {
    for (let next = queued.current.shift(); next !== undefined; next = queued.current.shift()) {
      sending.current = next;
      try {
        const outcome = await latest.current.send(next);
        latest.current.onAnswer(outcome);
        setSaid(
          outcome.refused.length === 0
            ? { kind: "none" }
            : {
                kind: "refused",
                names: outcome.refused.map((id) => latest.current.titles.get(id) ?? "one since removed"),
              },
        );
      } catch (error) {
        setSaid({ kind: "failed", message: messageFor(error) });
        latest.current.onFailed();
      }
      sending.current = undefined;
      setAsked(queued.current.at(-1));
    }
  };

  return {
    change: (next) => {
      const last = queued.current.at(-1);
      if (last !== undefined && sameThing(last, next)) queued.current[queued.current.length - 1] = next;
      else queued.current.push(next);
      setAsked(next);
      if (sending.current === undefined) void sendQueued();
    },
    asked,
    said,
  };
};

/**
 * How a change went: "Hive refused this", for one Appliance, and for many
 * which, so that the control, which shows what Hive reports, is read as
 * refused (FR-68); or why the Hub couldn't make it.
 */
export const HeatingSaidNote = ({ said, many = false }: { readonly said: HeatingSaid; readonly many?: boolean }) => {
  if (said.kind === "failed") {
    return (
      <p class="problem" role="alert">
        {said.message}
      </p>
    );
  }
  if (said.kind === "refused") {
    return (
      <p class="problem" role="alert">
        {many ? `${HIVE_REFUSED} for ${inWords(said.names)}.` : `${HIVE_REFUSED}. It shows what Hive reports.`}
      </p>
    );
  }
  return null;
};

export interface TargetStepperProps {
  /** What the group is called, e.g. "Target temperature". */
  readonly label: string;
  /** What the buttons and value say it is of, e.g. "the target temperature". */
  readonly of: string;
  readonly range: TemperatureRange | undefined;
  /** What Hive reports, "mixed" where many differ (FR-64), or undefined while it can't say. */
  readonly target: number | "mixed" | undefined;
  /** What a step goes from where many differ. */
  readonly from?: number | undefined;
  readonly disabled: boolean;
  readonly onChange: (celsius: number) => void;
}

/** A target temperature: lower and raise by one of Hive's half-degree steps, within its range (FR-63). */
export const TargetStepper = ({ label, of, range, target, from, disabled, onChange }: TargetStepperProps) => {
  const labelId = useId();
  const base = target === "mixed" ? from : target;
  const usable = disabled || range === undefined || base === undefined ? undefined : { range, base };
  const by = (steps: number): void => {
    if (usable !== undefined) onChange(within(usable.range, usable.base + steps * usable.range.step));
  };
  return (
    <div class="aircon-field heating-target" role="group" aria-labelledby={labelId}>
      <span id={labelId} class="aircon-label">
        {label}
      </span>
      <div class="aircon-target-row">
        <button
          type="button"
          class="button-icon"
          aria-label={`Lower ${of}`}
          disabled={usable === undefined || (target !== "mixed" && usable.base <= usable.range.min)}
          onClick={() => {
            by(-1);
          }}
        >
          <Icon name="minus" />
        </button>
        <output class="heating-target-value" aria-label={`${label} set`}>
          {target === undefined ? "–" : target === "mixed" ? "Mixed" : degrees(target)}
        </output>
        <button
          type="button"
          class="button-icon"
          aria-label={`Raise ${of}`}
          disabled={usable === undefined || (target !== "mixed" && usable.base >= usable.range.max)}
          onClick={() => {
            by(1);
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      {range !== undefined && (
        <p class="aircon-note">
          {degrees(range.min)} to {degrees(range.max)}, in half degrees.
        </p>
      )}
    </div>
  );
};

export interface ModeChoiceProps<Mode extends string> {
  /** Unique on the page, for the radios' name. */
  readonly name: string;
  readonly modes: readonly Mode[];
  readonly labels: Readonly<Record<Mode, string>>;
  /** What Hive reports, "mixed" where many differ, or undefined while it can't say. */
  readonly mode: Mode | "mixed" | undefined;
  readonly disabled: boolean;
  readonly onChange: (mode: Mode) => void;
}

/** A mode, as a segmented control: Schedule, Manual and Off, or the Hot Water's Schedule, On and Off. */
export const ModeChoice = <Mode extends string>({
  name,
  modes,
  labels,
  mode,
  disabled,
  onChange,
}: ModeChoiceProps<Mode>) => (
  <fieldset class="aircon-field">
    <legend>Mode{mode === "mixed" ? ": Mixed" : ""}</legend>
    <div class="segmented heating-segmented">
      {modes.map((each) => (
        <label key={each} class="segment">
          <input
            type="radio"
            name={name}
            value={each}
            checked={mode === each}
            disabled={disabled}
            onChange={() => {
              onChange(each);
            }}
          />
          {labels[each]}
        </label>
      ))}
    </div>
  </fieldset>
);

export interface BoostControlProps {
  /** The widget's name, which the dialog's title says it boosts. */
  readonly title: string;
  /** The Boost on now, what it says of it, e.g. "Boost to 22°, 45 min left", or undefined for none. */
  readonly boosting: string | undefined;
  /** The durations Hive's app offers, in minutes. */
  readonly boostMinutes: readonly number[];
  /** The targets it takes, for a Heating's or a Radiator Valve's Boost, or undefined for the Hot Water's, by duration only. */
  readonly range: TemperatureRange | undefined;
  /** Where the Boost's target starts, as the dialog opens. */
  readonly startAt: number;
  readonly disabled: boolean;
  readonly onBoost: (boost: { readonly target?: number; readonly minutes: number }) => void;
  readonly onCancel: () => void;
  /** What else the Boost is made of, said in its dialog, e.g. a Heating zone's Radiator Valves. */
  readonly alsoBoosts?: string | undefined;
}

/** How long a Boost lasts unless chosen otherwise: an hour, as Hive's app offers first. */
const DEFAULT_BOOST_MINUTES = 60;

/**
 * A Boost (FR-63, FR-66): what is on now, with its time left and Cancel
 * Boost, or Boost…, which asks in a dialog for its temperature, but for the
 * Hot Water, and how long, in the steps Hive's app offers.
 */
export const BoostControl = ({
  title,
  boosting,
  boostMinutes,
  range,
  startAt,
  disabled,
  onBoost,
  onCancel,
  alsoBoosts,
}: BoostControlProps) => {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(startAt);
  const [minutes, setMinutes] = useState(DEFAULT_BOOST_MINUTES);
  const formId = useId();

  return (
    <div class="heating-boost">
      <p class="heating-boost-status" role="status">
        {boosting ?? "No Boost"}
      </p>
      <div class="heating-boost-buttons">
        <button
          type="button"
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => {
            setTarget(range === undefined ? startAt : within(range, startAt));
            setMinutes(boostMinutes.includes(DEFAULT_BOOST_MINUTES) ? DEFAULT_BOOST_MINUTES : (boostMinutes[0] ?? 60));
            setOpen(true);
          }}
        >
          <Icon name="flame" />
          Boost…
        </button>
        {boosting !== undefined && (
          <button type="button" disabled={disabled} onClick={onCancel}>
            <Icon name="x" />
            Cancel Boost
          </button>
        )}
      </div>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={`Boost ${title}`}
        closeLabel={`Close Boost ${title}`}
        footer={
          <button type="submit" form={formId} class="button-primary">
            Boost
          </button>
        }
      >
        <form
          id={formId}
          class="heating-boost-form"
          aria-label={`Boost ${title}`}
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
            onBoost(range === undefined ? { minutes } : { target, minutes });
          }}
        >
          {alsoBoosts !== undefined && <p class="heating-boost-also">{alsoBoosts}</p>}
          {range !== undefined && (
            <TargetStepper
              label="Boost temperature"
              of="the Boost temperature"
              range={range}
              target={target}
              disabled={false}
              onChange={setTarget}
            />
          )}
          <label class="aircon-choice">
            For
            <select
              value={String(minutes)}
              onChange={(event) => {
                setMinutes(Number(event.currentTarget.value));
              }}
            >
              {boostMinutes.map((each) => (
                <option key={each} value={String(each)}>
                  {duration(each)}
                </option>
              ))}
            </select>
          </label>
        </form>
      </Dialog>
    </div>
  );
};
