import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import {
  PLAYBACK_SKIPS_MS,
  type Appliance,
  type NowPlaying,
  type PlaybackControl,
  type QueueControl,
  type QueueRepeat,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { Dialog } from "./dialog.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { formatAudioTrack, formatDuration, formatSubtitleTrack } from "./media-format.ts";

/**
 * How often the Remote asks the Hub again what the Selected TV's Player is
 * playing, which another Remote, or the TV's own remote, may have changed.
 * The Player tells the Hub its position every second, so it is no use asking
 * more often.
 */
export const NOW_PLAYING_REFRESH_MS = 1_000;

export interface TvNowPlayingProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV. */
  readonly tv: Appliance;
  /** Shown in its place while there is nothing to show, e.g. on the TV tab's grid; nothing, if not given. */
  readonly idle?: ComponentChildren;
  /** {@link NOW_PLAYING_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

/** Whole seconds, as the seek bar moves in them. */
const toSeconds = (ms: number): number => Math.floor(ms / 1_000);

/** Each way a Queue repeats, as the person reads it (FR-48). */
const REPEATS: readonly (readonly [QueueRepeat, string])[] = [
  ["off", "Off"],
  ["one", "One"],
  ["all", "All"],
];

/** "Back 10 seconds" or "Forward 30 seconds". */
const skipName = (byMs: number): string => `${byMs < 0 ? "Back" : "Forward"} ${String(Math.abs(byMs) / 1_000)} seconds`;

/**
 * The now-playing bar (FR-36), on every TV screen of the Remote while the
 * Selected TV's Player plays a Media File: its name, a seek bar with the
 * position and length, play/pause, the skips back and forward, stop, and the
 * Media File's audio tracks and subtitle tracks, its own and its sidecar
 * files, to switch between, or "Off" for subtitles, whatever its Route.
 * Image subtitles, which the Hub burns into the picture by Full Conversion
 * (FR-45), it warns of first, unless the Media File plays by Full Conversion
 * already, and switches to only once the person agrees. It
 * shows what the Player last told the Hub (ADR 0003), read again every
 * second, so every Remote on that TV sees the same, and so does one whose
 * person used the TV's own remote (FR-37). It is gone while nothing plays,
 * and once stopped.
 *
 * While the TV plays a Queue, as when a folder is played, it has previous,
 * next, shuffle and repeat (off, one, all) too, and shows the Queue, in the
 * order it plays, with the current Media File marked (FR-48). The Hub holds
 * the Queue, so every Remote on that TV sees the same.
 *
 * Each control goes to the Hub in the order tapped, and the bar shows what
 * the Player says once it has done it. While the seek bar is dragged it
 * shows where it is dragged to, and seeks there once let go.
 */
export const TvNowPlaying = ({
  appliances,
  tv,
  idle = null,
  refreshMs = NOW_PLAYING_REFRESH_MS,
}: TvNowPlayingProps) => {
  const [read, setRead] = useState<NowPlaying | null>(null);
  /** Why the last control couldn't be done, until the next is. */
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Where the seek bar is being dragged to, in seconds, until the Player has seeked there. */
  const [dragged, setDragged] = useState<number | undefined>(undefined);
  /** The subtitle track chosen that needs Full Conversion, by its place, and its name, until the person agrees or not. */
  const [burning, setBurning] = useState<{ readonly track: number; readonly name: string } | undefined>(undefined);
  /** The last control tapped, settled either way, which the next waits for. */
  const controlling = useRef<Promise<void>>(Promise.resolve());
  /** Counts every reading and control begun, so that one answered late is never shown after a later one. */
  const readings = useRef(0);
  const headingId = useId();
  const queueHeadingId = useId();

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const readPlayback = async (): Promise<void> => {
      readings.current += 1;
      const reading = readings.current;
      try {
        const playing = await appliances.readPlayback(tv.id);
        if (current && reading === readings.current) setRead(playing);
      } catch {
        // Nothing is shown that can't be read; the TV tab says when the Hub can't be reached.
        if (current && reading === readings.current) setRead(null);
      }
    };

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await readPlayback();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [appliances, tv.id, refreshMs]);

  /** Sends the control, of playback or of the Queue, once the last has settled, and shows what the Player plays then. */
  const send = (sent: () => Promise<NowPlaying | null>): Promise<void> => {
    const next = controlling.current.then(async () => {
      readings.current += 1;
      const reading = readings.current;
      try {
        const playing = await sent();
        setProblem(undefined);
        if (reading === readings.current) setRead(playing);
      } catch (error) {
        setProblem(messageFor(error));
      }
    });
    controlling.current = next;
    return next;
  };
  const control = (sent: PlaybackControl): Promise<void> => send(() => appliances.controlPlayback(tv.id, sent));
  const controlQueue = (sent: QueueControl): Promise<void> => send(() => appliances.controlQueue(tv.id, sent));

  const seek = (seconds: number): void => {
    setDragged(seconds);
    void control({ action: "seek", positionMs: seconds * 1_000 }).then(() => {
      setDragged((shown) => (shown === seconds ? undefined : shown));
    });
  };

  if (read === null) return <>{idle}</>;

  const loading = read.state === "loading";
  const { queue } = read;
  const duration = read.durationMs === null ? undefined : toSeconds(read.durationMs);
  const position = dragged ?? Math.min(toSeconds(read.positionMs), duration ?? Number.POSITIVE_INFINITY);
  const canSeek = !loading && duration !== undefined;
  const skipButton = (byMs: number) => (
    <button
      key={byMs}
      type="button"
      class={`now-playing-skip skip-${byMs < 0 ? "back" : "forward"}`}
      aria-label={skipName(byMs)}
      disabled={!canSeek}
      onClick={() => void control({ action: "skip", byMs })}
    >
      {byMs < 0 && <Icon name="rewind" />}
      {String(Math.abs(byMs) / 1_000)}
      {byMs > 0 && <Icon name="fast-forward" />}
    </button>
  );

  return (
    <section class="now-playing" aria-labelledby={headingId}>
      <div class="now-playing-header">
        <h2 id={headingId}>Now playing</h2>
        <p class="now-playing-name">{read.name}</p>
      </div>
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="now-playing-seek">
        <span class="now-playing-time now-playing-position">{loading ? "Loading…" : formatDuration(position)}</span>
        <input
          type="range"
          class="now-playing-slider"
          aria-label="Seek"
          min={0}
          max={duration ?? 0}
          step={1}
          value={canSeek ? position : 0}
          aria-valuetext={
            canSeek ? `${formatDuration(position)} of ${formatDuration(duration)}` : "Length not known yet"
          }
          disabled={!canSeek}
          onInput={(event) => {
            setDragged(Number(event.currentTarget.value));
          }}
          onChange={(event) => {
            seek(Number(event.currentTarget.value));
          }}
        />
        <span class="now-playing-time now-playing-duration">
          {duration === undefined ? "–:––" : formatDuration(duration)}
        </span>
      </div>
      <div class="now-playing-controls" role="group" aria-label="Playback">
        {PLAYBACK_SKIPS_MS.filter((byMs) => byMs < 0).map(skipButton)}
        <button
          type="button"
          class="now-playing-play"
          aria-label={read.state === "playing" ? "Pause" : "Play"}
          disabled={loading}
          onClick={() => void control({ action: read.state === "playing" ? "pause" : "play" })}
        >
          <Icon name={read.state === "playing" ? "pause" : "play"} />
        </button>
        {PLAYBACK_SKIPS_MS.filter((byMs) => byMs > 0).map(skipButton)}
        <button
          type="button"
          class="now-playing-stop"
          aria-label="Stop"
          onClick={() => void control({ action: "stop" })}
        >
          <Icon name="stop" />
        </button>
      </div>
      {queue !== null && (
        <>
          <div class="now-playing-queue-controls" role="group" aria-label="Queue">
            <button
              type="button"
              class="now-playing-previous"
              aria-label="Previous"
              disabled={queue.current === 0 && queue.repeat !== "all"}
              onClick={() => void controlQueue({ action: "previous" })}
            >
              <Icon name="skip-back" />
            </button>
            <button
              type="button"
              class="now-playing-next"
              aria-label="Next"
              disabled={queue.current === queue.mediaFiles.length - 1 && queue.repeat !== "all"}
              onClick={() => void controlQueue({ action: "next" })}
            >
              <Icon name="skip-forward" />
            </button>
            <button
              type="button"
              class="now-playing-shuffle"
              aria-pressed={queue.shuffle}
              onClick={() => void controlQueue({ action: "shuffle", shuffle: !queue.shuffle })}
            >
              <Icon name="shuffle" />
              Shuffle
            </button>
            <label class="now-playing-repeat">
              <Icon name="repeat" />
              Repeat
              <select
                value={queue.repeat}
                onChange={(event) => {
                  void controlQueue({ action: "repeat", repeat: event.currentTarget.value as QueueRepeat });
                }}
              >
                {REPEATS.map(([repeat, name]) => (
                  <option key={repeat} value={repeat}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div class="now-playing-queue">
            <h3 id={queueHeadingId}>
              Queue{" "}
              <span class="now-playing-queue-place">
                {String(queue.current + 1)} of {String(queue.mediaFiles.length)}
              </span>
            </h3>
            <ol aria-labelledby={queueHeadingId}>
              {queue.mediaFiles.map((name, place) => (
                <li
                  key={`${String(place)}:${name}`}
                  class={place === queue.current ? "now-playing-queue-current" : undefined}
                  aria-current={place === queue.current ? "true" : undefined}
                >
                  {name}
                  {place === queue.current && <span class="visually-hidden"> (playing)</span>}
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
      {read.audioTracks.length > 0 && (
        <label class="now-playing-audio">
          Audio
          <select
            value={read.audioTrack === null ? "" : String(read.audioTrack)}
            disabled={loading}
            onChange={(event) => {
              void control({ action: "audio-track", track: Number(event.currentTarget.value) });
            }}
          >
            {read.audioTrack === null && (
              <option value="" disabled>
                Not known yet
              </option>
            )}
            {read.audioTracks.map((track, place) => (
              <option key={place} value={String(place)}>
                {formatAudioTrack(track, place)}
              </option>
            ))}
          </select>
        </label>
      )}
      {read.subtitleTracks.length > 0 && (
        <label class="now-playing-subtitles">
          Subtitles
          <select
            value={read.subtitleTrack === null ? "" : String(read.subtitleTrack)}
            disabled={loading}
            onChange={(event) => {
              const { value } = event.currentTarget;
              const track = value === "" ? null : Number(value);
              const chosen = track === null ? undefined : read.subtitleTracks[track];
              if (track !== null && chosen?.burnedIn === true && read.route !== "full-conversion") {
                // Shown as it was until the person agrees.
                event.currentTarget.value = read.subtitleTrack === null ? "" : String(read.subtitleTrack);
                // Named as the warning says what it needs.
                setBurning({ track, name: formatSubtitleTrack({ ...chosen, burnedIn: false }, track) });
                return;
              }
              void control({ action: "subtitle-track", track });
            }}
          >
            <option value="">Off</option>
            {read.subtitleTracks.map((track, place) => (
              <option key={place} value={String(place)}>
                {formatSubtitleTrack(track, place)}
              </option>
            ))}
          </select>
        </label>
      )}
      <Dialog
        open={burning !== undefined}
        onClose={() => {
          setBurning(undefined);
        }}
        title="These subtitles need Full Conversion"
        closeLabel="Close, keeping the subtitles as they are"
        footer={
          burning !== undefined && (
            <>
              <button
                type="button"
                onClick={() => {
                  setBurning(undefined);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                class="button-primary"
                onClick={() => {
                  setBurning(undefined);
                  void control({ action: "subtitle-track", track: burning.track });
                }}
              >
                Use Full Conversion
              </button>
            </>
          )
        }
      >
        {burning !== undefined && (
          <>
            <p>
              {burning.name} are image subtitles, which the TV can't show itself, so the Hub burns them into the picture
              by Full Conversion, re-encoding the video. That uses a lot of the Hub's CPU, and on a low-power NAS may
              not keep up. Playback starts again from where it is.
            </p>
            <p>Choosing "Off" or a text subtitle track afterwards goes back to how it plays now.</p>
          </>
        )}
      </Dialog>
    </section>
  );
};
