/**
 * The Player's playback interface (FR-38, ADR 0005): everything the Player
 * does with a Media File goes through this, so that AVPlay is one
 * implementation of it, a fake for tests is another, and a Player for another
 * brand of TV can bring its own.
 */

import type { PlaybackState } from "@media-centre/shared";

/**
 * - `idle`: nothing loaded, as at the start and after {@link Playback.stop}.
 * - `loading`: a Media File is being opened.
 * - `paused`: loaded and ready, or paused.
 * - `playing`.
 *
 * The same states the Player reports to the Hub.
 */
export type { PlaybackState };

export type PlaybackEvent =
  | { readonly type: "state"; readonly state: PlaybackState }
  /** How far it has played, in milliseconds. */
  | { readonly type: "position"; readonly positionMs: number }
  /** It played to the end, and is idle again. */
  | { readonly type: "ended" }
  /** It couldn't play the Media File, and is idle again. */
  | { readonly type: "error"; readonly message: string };

export interface Playback {
  readonly state: () => PlaybackState;
  /**
   * Opens the Media File at the URL, stopping anything playing first, and
   * resolves once it is ready to play from the start, paused. It rejects if
   * the file can't be played, and is idle again.
   */
  readonly load: (url: string) => Promise<void>;
  readonly play: () => void;
  readonly pause: () => void;
  /** Resolves once it has moved to the position, in milliseconds. */
  readonly seekTo: (positionMs: number) => Promise<void>;
  /** How far into what is loaded it is, in milliseconds, or 0 when nothing is. */
  readonly positionMs: () => number;
  /** The length of what is loaded, in milliseconds, or null when nothing is or it doesn't say. */
  readonly durationMs: () => number | null;
  /**
   * The audio track of what is loaded that it plays, by its place among
   * the audio tracks, in the order they are in the Media File, or null when
   * nothing is loaded or it doesn't say.
   */
  readonly audioTrack: () => number | null;
  /**
   * Plays the audio track at this place among the audio tracks, in the order
   * they are in the Media File, from where it is (FR-36). It throws when
   * nothing is loaded or it has no such track.
   */
  readonly selectAudioTrack: (track: number) => void;
  /** Stops and unloads, leaving it idle. */
  readonly stop: () => void;
  /** Calls `listener` with every event from now on, until the returned function is called. */
  readonly subscribe: (listener: (event: PlaybackEvent) => void) => () => void;
}

/** The listeners of a {@link Playback}, for an implementation to tell. */
export const playbackListeners = (): {
  readonly subscribe: Playback["subscribe"];
  readonly emit: (event: PlaybackEvent) => void;
} => {
  const listeners: ((event: PlaybackEvent) => void)[] = [];
  return {
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    emit: (event) => {
      for (const listener of listeners.slice()) listener(event);
    },
  };
};
