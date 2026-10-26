import { useEffect, useId, useRef, useState } from "preact/hooks";

import {
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_BRIGHTNESS_MIN,
  type Appliance,
  type ColourTemperatureRange,
  type LightChange,
  type LightColour,
  type LightState,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { useLightReadings, type LightReadings } from "./light-readings.ts";

/** How often the Remote asks the Hub again what each Light is doing, which its maker's app may have changed. */
export const LIGHT_REFRESH_MS = 3_000;

/** What the Remote says of a Light that doesn't answer (FR-57b). */
export const LIGHT_UNREACHABLE = "Can't reach this Light";

/** What it says of one that no longer answers to the Hub's key. */
export const LIGHT_KEY_REFUSED = "This Light no longer answers to the Hub's key.";

/** A percentage as the Remote writes it, e.g. "30%". */
export const percent = (value: number): string => `${String(Math.round(value))}%`;

/** A colour temperature as the Remote writes it, e.g. "2,700 K". */
export const kelvin = (value: number): string => `${Math.round(value).toLocaleString("en")} K`;

/** Where a colour temperature sits in its range, in words, for the person who can't see the slider. */
const warmth = (value: number, range: ColourTemperatureRange): string => {
  const across = (value - range.min) / Math.max(1, range.max - range.min);
  return across < 1 / 3 ? "warm" : across > 2 / 3 ? "cool" : "neutral";
};

/** The name of a hue, roughly, for the person who can't see the colour. */
const hueName = (hue: number): string => {
  const names: readonly [number, string][] = [
    [15, "red"],
    [45, "orange"],
    [70, "yellow"],
    [165, "green"],
    [195, "cyan"],
    [255, "blue"],
    [290, "purple"],
    [335, "pink"],
    [360, "red"],
  ];
  return names.find(([upTo]) => hue < upTo)?.[1] ?? "red";
};

/** A colour as CSS draws it, at its fullest. */
export const cssColour = ({ hue, saturation }: LightColour): string =>
  `hsl(${String(hue)} ${String(saturation)}% ${String(100 - saturation / 2)}%)`;

/** Two changes as one, the later winning, as the Hub would make them one after the other. */
const merged = (earlier: LightChange | undefined, later: LightChange | undefined): LightChange | undefined => {
  if (earlier === undefined || later === undefined) return earlier ?? later;
  // A Light shows white or a colour, so the later of those wins outright.
  const kept: LightChange =
    later.colourTemperature === undefined && later.colour === undefined
      ? earlier
      : {
          ...(earlier.on === undefined ? {} : { on: earlier.on }),
          ...(earlier.brightness === undefined ? {} : { brightness: earlier.brightness }),
        };
  return { ...kept, ...later };
};

/** The state as it will be once the Hub has made the change, to show while it does. */
const withChange = (state: LightState, change: LightChange | undefined): LightState =>
  change === undefined
    ? state
    : {
        ...state,
        ...(change.on === undefined ? {} : { on: change.on }),
        ...(change.brightness === undefined ? {} : { brightness: change.brightness }),
        ...(change.colourTemperature === undefined
          ? {}
          : { colourTemperature: change.colourTemperature, colour: null }),
        ...(change.colour === undefined ? {} : { colour: change.colour, colourTemperature: null }),
      };

export interface LightCardProps {
  readonly appliances: AppliancesApi;
  readonly light: Appliance;
  /** How the Remote names it: "Room · Name" (FR-9). */
  readonly title: string;
  /** What the tab knows of each Light, which this one keeps up to date, and its Room's widget shows too. */
  readonly readings: LightReadings;
  /** {@link LIGHT_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

/**
 * One Light in the Lights tab (FR-52): on/off, and the brightness, colour
 * temperature and colour where it reports it has them, and no other, so
 * that a smart plug shows on/off only; read from the Hub, never from a list
 * of a brand's. Its state is read again every few seconds, so that it
 * follows its maker's app and every other Remote.
 *
 * Each change shows at once and is sent to the Hub, only the latest once the
 * one before has gone, then the Light's answer is shown. While the Light
 * doesn't answer, it says "Can't reach this Light", and its controls are
 * disabled and show no value (FR-57b), until it answers again.
 */
export const LightCard = ({ appliances, light, title, readings, refreshMs = LIGHT_REFRESH_MS }: LightCardProps) => {
  const { id } = light;
  useLightReadings(readings);
  const capabilities = readings.capabilities(id);
  const reading = readings.reading(id);
  /** What the person asked for that the Hub has yet to answer, shown over what the Light said. */
  const [asked, setAsked] = useState<LightChange | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** The change on its way to the Hub, and the one to send once it has gone. */
  const sending = useRef<LightChange | undefined>(undefined);
  const queued = useRef<LightChange | undefined>(undefined);
  const shown = useRef(true);
  /** Reads the state now, between refreshes; set while it is shown. */
  const readNow = useRef<() => void>(() => undefined);
  /** The white and the colour it last showed, to go back to on choosing either. */
  const lastWhite = useRef<number | undefined>(undefined);
  const lastColour = useRef<LightColour | undefined>(undefined);
  const headingId = useId();

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    shown.current = true;

    const read = async (): Promise<void> => {
      const since = readings.changes(id);
      const [capabilitiesRead, stateRead] = await Promise.all([
        // The controls it has don't change, so they are read until it says them.
        readings.capabilities(id) === undefined
          ? appliances.readLightCapabilities(id).catch(() => undefined)
          : undefined,
        appliances.readLight(id).catch(() => undefined),
      ]);
      if (!current) return;
      if (capabilitiesRead?.known === true) readings.knowCapabilities(id, capabilitiesRead.capabilities);
      // A change sent since began, or not yet answered, knows better.
      if (stateRead === undefined || sending.current !== undefined) return;
      readings.read(id, stateRead, since);
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
  }, [appliances, id, readings, refreshMs]);

  /** What is queued now, which the person may have added to while a change was on its way. */
  const queuedNow = (): LightChange | undefined => queued.current;

  /** Sends what is queued, one change at a time, and shows the Light's answer to the last. */
  const sendQueued = async (): Promise<void> => {
    let failed = false;
    while (queued.current !== undefined) {
      const change = queued.current;
      queued.current = undefined;
      sending.current = change;
      try {
        const answer = await appliances.changeLight(id, change);
        if (!shown.current) return;
        setProblem(undefined);
        if (queuedNow() === undefined) readings.answered(id, answer);
        else readings.changing(id);
      } catch (error) {
        if (!shown.current) return;
        failed = true;
        readings.changing(id);
        setProblem(messageFor(error));
      }
      sending.current = undefined;
      setAsked(queuedNow());
    }
    if (failed) readNow.current();
  };

  const change = (next: LightChange): void => {
    readings.changing(id);
    queued.current = merged(queued.current, next);
    setAsked(merged(sending.current, queued.current));
    if (sending.current === undefined) void sendQueued();
  };

  const state = reading?.known === true ? withChange(reading.state, asked) : undefined;
  const answering = state !== undefined;
  if (state?.colourTemperature !== null && state?.colourTemperature !== undefined) {
    lastWhite.current = state.colourTemperature;
  }
  if (state?.colour !== null && state?.colour !== undefined) lastColour.current = state.colour;

  const range = capabilities?.colourTemperature ?? null;
  const hasColour = capabilities?.colour === true;
  /** What it shows now: white, a colour, or neither, as an effect set in its maker's app. */
  const showing =
    state === undefined
      ? undefined
      : state.colour !== null
        ? "colour"
        : state.colourTemperature !== null
          ? "white"
          : undefined;

  const summary = (): string => {
    if (reading === undefined) return "Checking…";
    if (!reading.known) return reading.why === "key-refused" ? LIGHT_KEY_REFUSED : LIGHT_UNREACHABLE;
    if (state === undefined) return "";
    if (!state.on) return "Off";
    return [
      "On",
      ...(capabilities?.brightness === true && state.brightness !== null ? [percent(state.brightness)] : []),
      ...(state.colourTemperature === null ? [] : [kelvin(state.colourTemperature)]),
      ...(state.colour === null ? [] : [`${hueName(state.colour.hue)} colour`]),
    ].join(", ");
  };

  return (
    <section class="light" aria-labelledby={headingId}>
      <header class="light-head">
        <h2 id={headingId}>{title}</h2>
        <p class={reading?.known === false ? "light-summary light-not-answering" : "light-summary"} role="status">
          {state?.colour !== null && state?.colour !== undefined && state.on && (
            <span class="light-swatch" style={{ background: cssColour(state.colour) }} aria-hidden="true" />
          )}
          {summary()}
        </p>
      </header>
      {reading?.known === false && reading.why === "key-refused" && (
        <p class="light-note">Remove it in Settings, and add it again with its new key.</p>
      )}
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      {capabilities !== undefined && (
        <div class="light-controls">
          {capabilities.onOff && (
            <button
              type="button"
              class="aircon-toggle light-power"
              aria-pressed={state === undefined ? undefined : state.on}
              disabled={!answering}
              onClick={() => {
                if (state !== undefined) change({ on: !state.on });
              }}
            >
              <Icon name="power" />
              Power
            </button>
          )}
          {capabilities.brightness && (
            <LightSlider
              label="Brightness"
              min={LIGHT_BRIGHTNESS_MIN}
              max={LIGHT_BRIGHTNESS_MAX}
              step={1}
              value={state?.brightness ?? undefined}
              said={percent}
              onChange={(brightness) => {
                change({ brightness });
              }}
            />
          )}
          {range !== null && hasColour && (
            <fieldset class="aircon-field">
              <legend>Shows</legend>
              <div class="segmented aircon-segmented">
                {(["white", "colour"] as const).map((each) => (
                  <label key={each} class="segment">
                    <input
                      type="radio"
                      name={`light-shows-${String(id)}`}
                      value={each}
                      checked={showing === each}
                      disabled={!answering}
                      onChange={() => {
                        change(
                          each === "white"
                            ? { colourTemperature: lastWhite.current ?? Math.round((range.min + range.max) / 2) }
                            : { colour: lastColour.current ?? { hue: 0, saturation: 100 } },
                        );
                      }}
                    />
                    {each === "white" ? "White" : "Colour"}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {range !== null && (!hasColour || showing !== "colour") && (
            <LightSlider
              label="Colour temperature"
              min={range.min}
              max={range.max}
              step={100}
              value={state?.colourTemperature ?? undefined}
              said={(value) => `${kelvin(value)}, ${warmth(value, range)}`}
              shown={kelvin}
              onChange={(colourTemperature) => {
                change({ colourTemperature });
              }}
            />
          )}
          {hasColour && (range === null || showing === "colour") && (
            <>
              <LightSlider
                label="Hue"
                min={0}
                max={359}
                step={1}
                value={state?.colour?.hue}
                said={(hue) => `${String(hue)}°, ${hueName(hue)}`}
                shown={(hue) => `${String(hue)}°`}
                track="hue"
                onChange={(hue) => {
                  change({ colour: { hue, saturation: state?.colour?.saturation ?? 100 } });
                }}
              />
              <LightSlider
                label="Saturation"
                min={0}
                max={100}
                step={1}
                value={state?.colour?.saturation}
                said={percent}
                onChange={(saturation) => {
                  change({ colour: { hue: state?.colour?.hue ?? 0, saturation } });
                }}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
};

interface LightSliderProps {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** What the Light says, or undefined while it can't, which disables the slider and shows no value. */
  readonly value: number | undefined;
  /** The value in words, for a screen reader. */
  readonly said: (value: number) => string;
  /** The value as it is shown beside the slider, `said` unless given. */
  readonly shown?: (value: number) => string;
  /** A track drawn in the colours it chooses between, as the hue's is. */
  readonly track?: "hue";
  readonly onChange: (value: number) => void;
}

/** One of a Light's sliders, with its value beside it, and none while the Light can't say it. */
export const LightSlider = ({
  label,
  min,
  max,
  step,
  value,
  said,
  shown = said,
  track,
  onChange,
}: LightSliderProps) => {
  const labelId = useId();
  return (
    <div class="aircon-field light-slider-field" role="group" aria-labelledby={labelId}>
      <span id={labelId} class="aircon-label">
        {label}
      </span>
      <div class="aircon-target-row">
        <input
          type="range"
          class={track === "hue" ? "aircon-slider light-hue" : "aircon-slider"}
          aria-label={label}
          min={min}
          max={max}
          step={step}
          // Never a value the Light didn't say: the slider has none while it can't.
          value={value ?? ""}
          aria-valuetext={value === undefined ? "Not known" : said(value)}
          disabled={value === undefined}
          onInput={(event) => {
            onChange(Number(event.currentTarget.value));
          }}
        />
        <output class="aircon-target-value light-value" aria-label={`${label} set`}>
          {value === undefined ? "–" : shown(value)}
        </output>
      </div>
    </div>
  );
};
