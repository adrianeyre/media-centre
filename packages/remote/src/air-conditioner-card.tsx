import { useEffect, useId, useRef, useState } from "preact/hooks";

import type {
  AirConditionerCapabilities,
  AirConditionerChange,
  AirConditionerFunction,
  AirConditionerMode,
  AirConditionerPreset,
  AirConditionerReading,
  AirConditionerState,
  AirConditionerSwing,
  Appliance,
  FanSpeed,
  TemperatureRange,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";

/** How often the Remote asks the Hub again what each Air Conditioner is doing, which its own remote may have changed. */
export const AIR_CONDITIONER_REFRESH_MS = 3_000;

/** What the Remote says of an Air Conditioner that doesn't answer (FR-51a). */
export const UNREACHABLE = "Can't reach this Air Conditioner";

const MODE_LABELS: Readonly<Record<AirConditionerMode, string>> = {
  cool: "Cool",
  heat: "Heat",
  dry: "Dry",
  fan: "Fan",
  auto: "Auto",
};

const FAN_LABELS: Readonly<Record<FanSpeed | "auto", string>> = {
  silent: "Silent",
  low: "Low",
  medium: "Medium",
  high: "High",
  full: "Full",
  auto: "Auto",
};

const PRESET_LABELS: Readonly<Record<AirConditionerPreset, string>> = { eco: "Eco", turbo: "Turbo", sleep: "Sleep" };

const SWING_LABELS: Readonly<Record<keyof AirConditionerSwing, string>> = {
  vertical: "Up and down",
  horizontal: "Side to side",
};

/** A temperature in °C as the Remote writes it, e.g. "21.5°", or "21°" in whole degrees. */
export const degrees = (celsius: number): string => `${String(Math.round(celsius * 10) / 10)}°`;

/** A temperature the unit reports, or a dash while it doesn't say. */
const temperature = (celsius: number | null | undefined): string =>
  celsius === null || celsius === undefined ? "–" : degrees(celsius);

/** Two changes as one, the later winning, as the Hub would make them one after the other. */
const merged = (
  earlier: AirConditionerChange | undefined,
  later: AirConditionerChange | undefined,
): AirConditionerChange | undefined => {
  if (earlier === undefined || later === undefined) return earlier ?? later;
  const swing =
    earlier.swing === undefined && later.swing === undefined ? {} : { swing: { ...earlier.swing, ...later.swing } };
  const functions =
    earlier.functions === undefined && later.functions === undefined
      ? {}
      : { functions: { ...earlier.functions, ...later.functions } };
  return { ...earlier, ...later, ...swing, ...functions };
};

/** The state as it will be once the Hub has made the change, to show while it does. */
const withChange = (state: AirConditionerState, change: AirConditionerChange | undefined): AirConditionerState =>
  change === undefined
    ? state
    : {
        ...state,
        ...(change.power === undefined ? {} : { power: change.power }),
        ...(change.mode === undefined ? {} : { mode: change.mode }),
        ...(change.targetTemperature === undefined ? {} : { targetTemperature: change.targetTemperature }),
        ...(change.fanSpeed === undefined ? {} : { fanSpeed: change.fanSpeed }),
        ...(change.preset === undefined ? {} : { preset: change.preset }),
        ...(change.display === undefined ? {} : { display: change.display }),
        swing: { ...state.swing, ...change.swing },
        functions: { ...state.functions, ...change.functions },
      };

/** The target temperature nearest `celsius` that the range takes, in its steps. */
const within = (range: TemperatureRange, celsius: number): number => {
  const steps = Math.round((celsius - range.min) / range.step);
  return Math.min(range.max, Math.max(range.min, range.min + steps * range.step));
};

export interface AirConditionerCardProps {
  readonly appliances: AppliancesApi;
  readonly airConditioner: Appliance;
  /** How the Remote names it: "Room · Name" (FR-9). */
  readonly title: string;
  /** Opens Settings, where "Fetch again" is, for one that refuses the Hub's token and key (FR-51). */
  readonly onOpenSettings: () => void;
  /** {@link AIR_CONDITIONER_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

/**
 * One Air Conditioner in the Aircon tab (FR-49 to FR-51a): its power, mode,
 * target temperature and the room temperature it reports, and every control
 * it reports it has and no other (FR-50), read from the Hub, never from a
 * list of a brand's. Its state is read again every few seconds, so that it
 * follows the unit's own remote and every other Remote.
 *
 * Each change shows at once and is sent to the Hub, only the latest once the
 * one before has gone, then the unit's answer is shown. While the unit
 * doesn't answer, it says "Can't reach this Air Conditioner", and its
 * controls are disabled and show no value (FR-51a), until it answers again.
 */
export const AirConditionerCard = ({
  appliances,
  airConditioner,
  title,
  onOpenSettings,
  refreshMs = AIR_CONDITIONER_REFRESH_MS,
}: AirConditionerCardProps) => {
  const { id } = airConditioner;
  const [capabilities, setCapabilities] = useState<AirConditionerCapabilities | undefined>(undefined);
  const [reading, setReading] = useState<AirConditionerReading | undefined>(undefined);
  /** What the person asked for that the Hub has yet to answer, shown over what the unit said. */
  const [asked, setAsked] = useState<AirConditionerChange | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Counts every change sent and answered, so that a reading begun before one is never shown after it. */
  const changesSent = useRef(0);
  /** The change on its way to the Hub, and the one to send once it has gone. */
  const sending = useRef<AirConditionerChange | undefined>(undefined);
  const queued = useRef<AirConditionerChange | undefined>(undefined);
  const shown = useRef(true);
  /** Reads the state now, between refreshes; set while it is shown. */
  const readNow = useRef<() => void>(() => undefined);
  const headingId = useId();

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let capabilitiesKnown = false;
    shown.current = true;

    const read = async (): Promise<void> => {
      const sentBefore = changesSent.current;
      const [capabilitiesRead, stateRead] = await Promise.all([
        // The controls it has don't change, so they are read until it says them.
        capabilitiesKnown ? undefined : appliances.readAirConditionerCapabilities(id).catch(() => undefined),
        appliances.readAirConditioner(id).catch(() => undefined),
      ]);
      if (!current) return;
      if (capabilitiesRead?.known === true) {
        capabilitiesKnown = true;
        setCapabilities(capabilitiesRead.capabilities);
      }
      // A change sent since began, or not yet answered, knows better.
      if (stateRead === undefined || sentBefore !== changesSent.current || sending.current !== undefined) return;
      setReading(stateRead);
    };
    readNow.current = () => void read();

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await read();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      shown.current = false;
      clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [appliances, id, refreshMs]);

  /** Sends what is queued, one change at a time, and shows the unit's answer to the last. */
  /** What is queued now, which the person may have added to while a change was on its way. */
  const queuedNow = (): AirConditionerChange | undefined => queued.current;

  const sendQueued = async (): Promise<void> => {
    let failed = false;
    while (queued.current !== undefined) {
      const change = queued.current;
      queued.current = undefined;
      sending.current = change;
      try {
        const answer = await appliances.changeAirConditioner(id, change);
        if (!shown.current) return;
        setProblem(undefined);
        if (queuedNow() === undefined) setReading(answer);
      } catch (error) {
        if (!shown.current) return;
        failed = true;
        setProblem(messageFor(error));
      }
      changesSent.current += 1;
      sending.current = undefined;
      setAsked(queuedNow());
    }
    if (failed) readNow.current();
  };

  const change = (next: AirConditionerChange): void => {
    changesSent.current += 1;
    queued.current = merged(queued.current, next);
    setAsked(merged(sending.current, queued.current));
    if (sending.current === undefined) void sendQueued();
  };

  const state = reading?.known === true ? withChange(reading.state, asked) : undefined;
  const answering = state !== undefined;
  const range =
    state === undefined ? undefined : capabilities?.modes.find(({ mode }) => mode === state.mode)?.temperature;
  const target =
    state === undefined || range === undefined || range === null ? undefined : within(range, state.targetTemperature);

  const summary = (): string => {
    if (reading === undefined) return "Checking…";
    if (state === undefined) return reading.known ? "" : UNREACHABLE;
    if (!state.power) return "Off";
    return [MODE_LABELS[state.mode], ...(target === undefined ? [] : [`set to ${degrees(target)}`])].join(", ");
  };

  const name = (what: string): string => `${what}-${String(id)}`;

  return (
    <section class="aircon" aria-labelledby={headingId}>
      <header class="aircon-head">
        <h2 id={headingId}>{title}</h2>
        <p class={reading?.known === false ? "aircon-summary aircon-not-answering" : "aircon-summary"} role="status">
          {reading?.known === false && reading.why === "fetch-again"
            ? "This Air Conditioner no longer accepts the Hub's token and key."
            : summary()}
        </p>
        {capabilities?.temperatures.room !== false && (
          <dl class="aircon-temperatures">
            <div>
              <dt>Room</dt>
              <dd>{temperature(state?.roomTemperature)}</dd>
            </div>
            {capabilities?.temperatures.outdoor === true && (
              <div>
                <dt>Outdoor</dt>
                <dd>{temperature(state?.outdoorTemperature)}</dd>
              </div>
            )}
          </dl>
        )}
      </header>
      {reading?.known === false && reading.why === "fetch-again" && (
        <p class="aircon-fetch-again">
          Fetch its token and key again in Settings.{" "}
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </p>
      )}
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      {capabilities !== undefined && (
        <div class="aircon-controls">
          {capabilities.power && (
            <button
              type="button"
              class="aircon-toggle aircon-power"
              aria-pressed={state === undefined ? undefined : state.power}
              disabled={!answering}
              onClick={() => {
                if (state !== undefined) change({ power: !state.power });
              }}
            >
              <Icon name="power" />
              Power
            </button>
          )}
          {capabilities.modes.length > 0 && (
            <fieldset class="aircon-field">
              <legend>Mode</legend>
              <div class="segmented aircon-segmented">
                {capabilities.modes.map(({ mode }) => (
                  <label key={mode} class="segment">
                    <input
                      type="radio"
                      name={name("mode")}
                      value={mode}
                      checked={state?.mode === mode}
                      disabled={!answering}
                      onChange={() => {
                        change({ mode });
                      }}
                    />
                    {MODE_LABELS[mode]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {capabilities.modes.some(({ temperature }) => temperature !== null) && (
            <TargetTemperature
              range={range}
              target={target}
              disabled={!answering}
              mode={state?.mode}
              onChange={(targetTemperature) => {
                change({ targetTemperature });
              }}
            />
          )}
          {capabilities.fan.speeds.length + (capabilities.fan.auto ? 1 : 0) > 0 && (
            <fieldset class="aircon-field">
              <legend>Fan speed</legend>
              <div class="segmented aircon-segmented">
                {[...capabilities.fan.speeds, ...(capabilities.fan.auto ? (["auto"] as const) : [])].map((speed) => (
                  <label key={speed} class="segment">
                    <input
                      type="radio"
                      name={name("fan")}
                      value={speed}
                      checked={state?.fanSpeed === speed}
                      disabled={!answering}
                      onChange={() => {
                        change({ fanSpeed: speed });
                      }}
                    />
                    {FAN_LABELS[speed]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {(capabilities.swing.vertical || capabilities.swing.horizontal) && (
            <fieldset class="aircon-field">
              <legend>Swing</legend>
              <div class="aircon-toggles">
                {(["vertical", "horizontal"] as const)
                  .filter((way) => capabilities.swing[way])
                  .map((way) => (
                    <Toggle
                      key={way}
                      label={SWING_LABELS[way]}
                      on={state?.swing[way]}
                      onChange={(on) => {
                        change({ swing: { [way]: on } });
                      }}
                    />
                  ))}
              </div>
            </fieldset>
          )}
          {capabilities.presets.length > 0 && (
            <fieldset class="aircon-field">
              <legend>Preset</legend>
              <div class="aircon-toggles">
                {capabilities.presets.map((preset) => (
                  <Toggle
                    key={preset}
                    label={PRESET_LABELS[preset]}
                    on={state === undefined ? undefined : state.preset === preset}
                    onChange={(on) => {
                      change({ preset: on ? preset : null });
                    }}
                  />
                ))}
              </div>
            </fieldset>
          )}
          {(capabilities.display || capabilities.functions.length > 0) && (
            <fieldset class="aircon-field">
              <legend>More</legend>
              <div class="aircon-toggles">
                {capabilities.display && (
                  <Toggle
                    label="Display"
                    on={state?.display}
                    onChange={(display) => {
                      change({ display });
                    }}
                  />
                )}
                {capabilities.functions
                  .filter((each) => each.kind === "on-off")
                  .map((each) => (
                    <Toggle
                      key={each.id}
                      label={each.name}
                      on={state === undefined ? undefined : state.functions[each.id] === true}
                      onChange={(on) => {
                        change({ functions: { [each.id]: on } });
                      }}
                    />
                  ))}
              </div>
              {capabilities.functions
                .filter((each): each is Extract<AirConditionerFunction, { kind: "choice" }> => each.kind === "choice")
                .map((each) => {
                  const value = state?.functions[each.id];
                  return (
                    <label key={each.id} class="aircon-choice">
                      {each.name}
                      <select
                        value={typeof value === "string" ? value : ""}
                        disabled={!answering}
                        onChange={(event) => {
                          change({ functions: { [each.id]: event.currentTarget.value } });
                        }}
                      >
                        {typeof value !== "string" && <option value="">Not known</option>}
                        {each.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
};

interface ToggleProps {
  readonly label: string;
  /** Whether it is on, or undefined while the unit can't say, which disables it. */
  readonly on: boolean | undefined;
  readonly onChange: (on: boolean) => void;
}

/** An on/off, shown by its tick and outline as well as its colour while it is on. */
const Toggle = ({ label, on, onChange }: ToggleProps) => (
  <button
    type="button"
    class="aircon-toggle"
    aria-pressed={on}
    disabled={on === undefined}
    onClick={() => {
      if (on !== undefined) onChange(!on);
    }}
  >
    {on === true && <Icon name="check" />}
    {label}
  </button>
);

interface TargetTemperatureProps {
  /** The current mode's target temperatures, null for a mode that takes none, as fan, or undefined while not known. */
  readonly range: TemperatureRange | null | undefined;
  readonly target: number | undefined;
  readonly mode: AirConditionerMode | undefined;
  readonly disabled: boolean;
  readonly onChange: (celsius: number) => void;
}

/**
 * The target temperature: lower and raise by one of the unit's steps, and a
 * slider across the current mode's range, in those steps (FR-50).
 */
const TargetTemperature = ({ range, target, mode, disabled, onChange }: TargetTemperatureProps) => {
  const labelId = useId();
  const usable =
    disabled || range === undefined || range === null || target === undefined ? undefined : { range, target };
  const by = (steps: number): void => {
    if (usable !== undefined) onChange(within(usable.range, usable.target + steps * usable.range.step));
  };
  return (
    <div class="aircon-field aircon-target" role="group" aria-labelledby={labelId}>
      <span id={labelId} class="aircon-label">
        Target temperature
      </span>
      <div class="aircon-target-row">
        <button
          type="button"
          class="button-icon"
          aria-label="Lower the target temperature"
          disabled={usable === undefined || usable.target <= usable.range.min}
          onClick={() => {
            by(-1);
          }}
        >
          <Icon name="minus" />
        </button>
        <input
          type="range"
          class="aircon-slider"
          aria-label="Target temperature"
          min={range?.min ?? 0}
          max={range?.max ?? 0}
          step={range?.step ?? 1}
          // Never a value the unit didn't say: the slider has none while it can't.
          value={target ?? ""}
          aria-valuetext={target === undefined ? "Not known" : degrees(target)}
          disabled={usable === undefined}
          onInput={(event) => {
            onChange(Number(event.currentTarget.value));
          }}
        />
        <button
          type="button"
          class="button-icon"
          aria-label="Raise the target temperature"
          disabled={usable === undefined || usable.target >= usable.range.max}
          onClick={() => {
            by(1);
          }}
        >
          <Icon name="plus" />
        </button>
        <output class="aircon-target-value" aria-label="Target temperature set">
          {target === undefined ? "–" : degrees(target)}
        </output>
      </div>
      {mode !== undefined && range === null && (
        <p class="aircon-note">{MODE_LABELS[mode]} mode takes no target temperature.</p>
      )}
      {mode !== undefined && range !== undefined && range !== null && (
        <p class="aircon-note">
          {degrees(range.min)} to {degrees(range.max)} in {MODE_LABELS[mode].toLowerCase()} mode, in{" "}
          {range.step === 1 ? "whole" : "half"} degrees.
        </p>
      )}
    </div>
  );
};
