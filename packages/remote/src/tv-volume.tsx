import { useEffect, useRef, useState } from "preact/hooks";

import { VOLUME_MAX, type Appliance, type ApplianceVolume, type RemoteKey } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";

/** How often the Remote asks the Hub again for the Selected TV's volume, which its own remote may have changed. */
export const VOLUME_REFRESH_MS = 3_000;

export interface TvVolumeProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV, whose volume this is. */
  readonly tv: Appliance;
  /** {@link VOLUME_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

/**
 * The Selected TV's volume (FR-19): a 0–100 slider and a mute toggle, both
 * showing what the TV itself says, read again every few seconds so that they
 * follow its own remote, and volume up and down, which are keys.
 *
 * While the slider is dragged, it sends the Hub each volume in turn, only the
 * latest once the one before has gone, and shows where it was dragged to
 * rather than what the TV said before. When the TV can't say its volume, e.g.
 * in standby, the slider and the mute toggle are disabled and show no value
 * (FR-25), and volume up and down still work.
 */
export const TvVolume = ({ appliances, tv, refreshMs = VOLUME_REFRESH_MS }: TvVolumeProps) => {
  const [read, setRead] = useState<ApplianceVolume | undefined>(undefined);
  /** Where the person dragged the slider to, shown until the Hub has set it. */
  const [dragged, setDragged] = useState<number | undefined>(undefined);
  const [muting, setMuting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Counts every change sent, so that a reading begun before one is never shown after it. */
  const changesSent = useRef(0);
  /** How many changes the Hub has yet to answer. */
  const changing = useRef(0);
  /** The volume dragged to that is still to be sent, once the one before it has gone. */
  const wanted = useRef<number | undefined>(undefined);
  const sendingVolume = useRef(false);
  /** The last volume key tapped, settled either way, which the next waits for. */
  const pressing = useRef<Promise<void>>(Promise.resolve());
  /** Reads the volume now, between refreshes; set while it is shown. */
  const readNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const readVolume = async (): Promise<void> => {
      const sentBefore = changesSent.current;
      const volume = await appliances.readVolume(tv.id).catch(() => undefined);
      // A change sent since began, or not yet answered, knows better.
      if (!current || volume === undefined || sentBefore !== changesSent.current || changing.current > 0) return;
      setRead(volume);
    };
    readNow.current = () => void readVolume();

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await readVolume();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [appliances, tv.id, refreshMs]);

  /** Sends one change, and shows the TV's answer to it, unless another is on its way. */
  const change = async (send: () => Promise<ApplianceVolume>): Promise<void> => {
    changesSent.current += 1;
    changing.current += 1;
    try {
      const answer = await send();
      changing.current -= 1;
      setProblem(undefined);
      if (changing.current === 0) setRead(answer);
    } catch (error) {
      changing.current -= 1;
      setProblem(messageFor(error));
      readNow.current();
    }
  };

  const sendWanted = (): void => {
    const volume = wanted.current;
    if (sendingVolume.current || volume === undefined) return;
    wanted.current = undefined;
    sendingVolume.current = true;
    void change(() => appliances.changeVolume(tv.id, { volume })).then(() => {
      sendingVolume.current = false;
      if (wanted.current === undefined) setDragged(undefined);
      else sendWanted();
    });
  };

  const drag = (volume: number): void => {
    setDragged(volume);
    wanted.current = volume;
    sendWanted();
  };

  const toggleMute = (muted: boolean): void => {
    setMuting(true);
    void change(() => appliances.changeVolume(tv.id, { muted })).then(() => {
      setMuting(false);
    });
  };

  const press = (key: RemoteKey): void => {
    pressing.current = pressing.current.then(() =>
      appliances.pressKey(tv.id, key).then(
        () => {
          setProblem(undefined);
          readNow.current();
        },
        (error: unknown) => {
          setProblem(messageFor(error));
        },
      ),
    );
  };

  const known = read?.known === true ? read : undefined;
  const shown = dragged ?? known?.volume;

  return (
    <section class="tv-volume" aria-label="Volume">
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="volume-row">
        <button
          type="button"
          class="key key-volume-down"
          aria-label="Volume down"
          onClick={() => {
            press("volume-down");
          }}
        >
          <Icon name="minus" />
        </button>
        <input
          type="range"
          class={shown === undefined ? "volume-slider volume-unknown" : "volume-slider"}
          aria-label="Volume"
          min={0}
          max={VOLUME_MAX}
          step={1}
          // Never a value the TV didn't say: the slider has none while it can't (FR-25).
          value={shown ?? ""}
          aria-valuetext={shown === undefined ? "Not known" : undefined}
          disabled={known === undefined}
          onInput={(event) => {
            drag(Number(event.currentTarget.value));
          }}
        />
        <button
          type="button"
          class="key key-volume-up"
          aria-label="Volume up"
          onClick={() => {
            press("volume-up");
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div class="volume-row">
        <output class="volume-level" aria-label="Volume level">
          {shown === undefined ? "–" : String(shown)}
        </output>
        <button
          type="button"
          class="key key-mute"
          aria-pressed={known === undefined ? undefined : known.muted}
          disabled={known === undefined || muting}
          onClick={() => {
            if (known !== undefined) toggleMute(!known.muted);
          }}
        >
          {/* Shown by its icon as well as its colour while it is on. */}
          {known?.muted === true && <Icon name="volume-mute" />}
          Mute
        </button>
      </div>
      {read?.known === false && (
        <p class="volume-note">
          The TV can't say its volume now, as when it is in standby. Volume up and down still work.
        </p>
      )}
    </section>
  );
};
