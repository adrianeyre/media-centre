import { playbackListeners, type Playback, type PlaybackState } from "./playback.ts";

/** A {@link Playback} that plays nothing, but can be told what happened, as a test or a desktop browser needs. */
export interface FakePlayback extends Playback {
  /** Every URL loaded, oldest first. */
  readonly loaded: readonly string[];
  /** Has the Media File loaded fail to play, from now on, with this message, or none with null. */
  readonly refuse: (message: string | null) => void;
  /** As if it had played to this position, in milliseconds. */
  readonly reach: (positionMs: number) => void;
  /** As if it had played to the end. */
  readonly finish: () => void;
  /** As if it had stopped partway, unable to go on, as AVPlay does with a stream it can't play. */
  readonly fail: (message: string) => void;
}

/** How long every Media File the fake playback loads is, in milliseconds. */
export const FAKE_DURATION_MS = 60_000;

export interface FakePlaybackOptions {
  /**
   * Has it play in real time, moving on this many milliseconds every this
   * many while playing, and finishing at the end, as the fake TV's fake
   * Player and a desktop browser need. Without it, it moves only when told.
   */
  readonly tickMs?: number;
}

/**
 * The fake {@link Playback} the Player's UI is tested against (ADR 0005), and
 * that it uses in a desktop browser, which has no AVPlay. Every Media File it
 * loads is {@link FAKE_DURATION_MS} long, and starts on its first audio
 * track, of as many as it is asked for: it can't tell how many it has.
 */
export const fakePlayback = ({ tickMs }: FakePlaybackOptions = {}): FakePlayback => {
  const { subscribe, emit } = playbackListeners();
  const loaded: string[] = [];
  let state: PlaybackState = "idle";
  let refusal: string | null = null;
  let position = 0;
  let audioTrack = 0;
  let ticking: ReturnType<typeof setInterval> | undefined;

  const loadedNow = (): boolean => state === "paused" || state === "playing";

  const moveTo = (positionMs: number): void => {
    position = positionMs;
    emit({ type: "position", positionMs });
  };

  const become = (next: PlaybackState): void => {
    if (next === state) return;
    state = next;
    if (state !== "playing") {
      clearInterval(ticking);
      ticking = undefined;
    } else if (tickMs !== undefined) {
      ticking = setInterval(() => {
        if (position + tickMs < FAKE_DURATION_MS) moveTo(position + tickMs);
        else finish();
      }, tickMs);
    }
    if (state === "idle" || state === "loading") {
      position = 0;
      audioTrack = 0;
    }
    emit({ type: "state", state });
  };

  const finish = (): void => {
    become("idle");
    emit({ type: "ended" });
  };

  return {
    loaded,
    refuse: (message) => {
      refusal = message;
    },
    reach: moveTo,
    finish,
    fail: (message) => {
      become("idle");
      emit({ type: "error", message });
    },
    state: () => state,
    load: async (url) => {
      loaded.push(url);
      become("loading");
      await Promise.resolve();
      if (refusal !== null) {
        become("idle");
        throw new Error(refusal);
      }
      become("paused");
    },
    play: () => {
      if (state === "paused") become("playing");
    },
    pause: () => {
      if (state === "playing") become("paused");
    },
    seekTo: async (positionMs) => {
      if (!loadedNow()) throw new Error("Nothing is loaded to seek in.");
      await Promise.resolve();
      moveTo(Math.min(Math.max(0, positionMs), FAKE_DURATION_MS));
    },
    positionMs: () => (loadedNow() ? position : 0),
    durationMs: () => (loadedNow() ? FAKE_DURATION_MS : null),
    audioTrack: () => (loadedNow() ? audioTrack : null),
    selectAudioTrack: (track) => {
      if (!loadedNow()) throw new Error("Nothing is loaded to choose an audio track of.");
      audioTrack = track;
    },
    stop: () => {
      become("idle");
    },
    subscribe,
  };
};
