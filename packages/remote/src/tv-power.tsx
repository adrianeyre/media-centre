import { useEffect, useState } from "preact/hooks";

import type { Appliance, PowerState, PowerSwitch } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";

/** How long a TV has to show it has switched, after the Hub has sent the switch, before the person is told it hasn't. */
export const POWER_SWITCH_WAIT_MS = 30_000;

const SWITCHING: Readonly<Record<PowerSwitch["switching"], string>> = {
  on: "Switching on…",
  off: "Switching off…",
};

export interface TvPowerProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV, which the Power button switches. */
  readonly tv: Appliance;
  /** It as the Remote names it, "Room · Name" (FR-9). */
  readonly title: string;
  /** Its power state, as the TV tab last read it, or undefined before the first read. */
  readonly power: PowerState | undefined;
  /** Asks the TV tab to read its power state again now, rather than at its next refresh. */
  readonly onSwitched: () => void;
  /** {@link POWER_SWITCH_WAIT_MS} but in tests. */
  readonly waitMs?: number;
}

/**
 * The Power button for the Selected TV (FR-17). The Hub decides which way to
 * switch it, from whether it is on now: on with Wake-on-LAN, off with its
 * power key. Until the TV's power state shows the change (FR-16), the button
 * says it is switching, and waits for the Hub, which for a Frame TV takes a
 * few seconds of holding its power key. A TV that hasn't changed after
 * {@link POWER_SWITCH_WAIT_MS} is reported, as is a switch the Hub couldn't send.
 */
export const TvPower = ({ appliances, tv, title, power, onSwitched, waitMs = POWER_SWITCH_WAIT_MS }: TvPowerProps) => {
  const [sending, setSending] = useState(false);
  const [switching, setSwitching] = useState<PowerSwitch["switching"] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  // Done once the TV says so: on, or no longer on.
  const switched = switching !== undefined && power !== undefined && (switching === "on") === (power === "on");
  useEffect(() => {
    if (switched) setSwitching(undefined);
  }, [switched]);

  useEffect(() => {
    if (switching === undefined) return;
    const timer = setTimeout(() => {
      setSwitching(undefined);
      setProblem(
        switching === "on"
          ? `${title} hasn't switched on. Check that it is plugged in, and on the same network as the Hub.`
          : `${title} hasn't switched off.`,
      );
    }, waitMs);
    return () => {
      clearTimeout(timer);
    };
  }, [switching, title, waitMs]);

  const press = (): void => {
    setSending(true);
    setProblem(undefined);
    appliances.switchPower(tv.id).then(
      ({ switching: which }) => {
        setSending(false);
        setSwitching(which);
        onSwitched();
      },
      (error: unknown) => {
        setSending(false);
        setProblem(messageFor(error));
      },
    );
  };

  return (
    <section class="tv-power" aria-label="Power">
      <button type="button" class="key key-power" disabled={sending} onClick={press}>
        <Icon name="power" />
        Power
      </button>
      <p class="power-status" role="status">
        {switching === undefined ? (sending ? "Switching…" : "") : SWITCHING[switching]}
      </p>
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
};
