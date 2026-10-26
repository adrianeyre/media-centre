import { useEffect, useState } from "preact/hooks";

import type { LightCapabilities, LightReading } from "@media-centre/shared";

/**
 * What the Lights tab knows of each Light, by its Appliance's id: the
 * controls it reports it has, and what it last said it is doing, shared by
 * its own widget and its Room's, so that a Room-wide control or All off
 * shows on every Light it reached at once, and each Light's state shows in
 * its Room's.
 *
 * Every change sent to a Light, from either, is counted, so that a reading
 * begun before one is never shown after it.
 */
export interface LightReadings {
  readonly capabilities: (id: number) => LightCapabilities | undefined;
  readonly reading: (id: number) => LightReading | undefined;
  /** How many changes have been sent to the Light, or answered. */
  readonly changes: (id: number) => number;
  /** Notes a change sent to the Light, or answered. */
  readonly changing: (id: number) => void;
  /** Keeps what the Light reports it has, which doesn't change. */
  readonly knowCapabilities: (id: number, capabilities: LightCapabilities) => void;
  /** Keeps a reading begun when {@link changes} said `since`, unless a change has been sent since. */
  readonly read: (id: number, reading: LightReading, since: number) => void;
  /** Keeps the Light's answer to a change, which knows better than any reading begun before it. */
  readonly answered: (id: number, reading: LightReading) => void;
  /** Calls `listener` whenever anything kept changes, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
}

export const lightReadings = (): LightReadings => {
  const capabilities = new Map<number, LightCapabilities>();
  const readings = new Map<number, LightReading>();
  const changes = new Map<number, number>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  const changing = (id: number): void => {
    changes.set(id, (changes.get(id) ?? 0) + 1);
  };

  return {
    capabilities: (id) => capabilities.get(id),
    reading: (id) => readings.get(id),
    changes: (id) => changes.get(id) ?? 0,
    changing,
    knowCapabilities: (id, known) => {
      capabilities.set(id, known);
      changed();
    },
    read: (id, reading, since) => {
      if ((changes.get(id) ?? 0) !== since) return;
      readings.set(id, reading);
      changed();
    },
    answered: (id, reading) => {
      changing(id);
      readings.set(id, reading);
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** Draws the component again whenever what `readings` keeps changes. */
export const useLightReadings = (readings: LightReadings): void => {
  const [, setVersion] = useState(0);
  useEffect(
    () =>
      readings.subscribe(() => {
        setVersion((version) => version + 1);
      }),
    [readings],
  );
};
