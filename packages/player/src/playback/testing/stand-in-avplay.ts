import type { AVPlay, AVPlayListener, AVPlayState, AVPlayStreamInfo } from "../../tizen.ts";

/** A stand-in for a TV's `webapis.avplay`, which records what it was asked and calls back as the test says. */
export interface StandInAVPlay extends AVPlay {
  /** Every call, by name and arguments, oldest first. */
  readonly calls: (readonly [string, ...unknown[]])[];
  /** The listener last set. */
  readonly listener: () => AVPlayListener;
  /** Has the next prepare call back with success, or this error. Prepares wait for {@link finishPrepare} when held. */
  prepareOutcome: "success" | Error | "held";
  /** Calls back the oldest prepare held. */
  readonly finishPrepare: (outcome: "success" | Error) => void;
  /**
   * The tracks of whatever it opens, as `getTotalTrackInfo` gives them: by
   * default, a video, then two audio tracks, by indexes that aren't their
   * places, as AVPlay's needn't be. It plays the first of each type it opens.
   */
  tracks: readonly AVPlayStreamInfo[];
}

/** {@link StandInAVPlay.tracks} by default. */
export const STAND_IN_TRACKS: readonly AVPlayStreamInfo[] = [
  { index: 0, type: "VIDEO", extra_info: '{"fourCC":"H264"}' },
  { index: 1, type: "AUDIO", extra_info: '{"language":"eng","fourCC":"AC3"}' },
  { index: 3, type: "AUDIO", extra_info: '{"language":"fra","fourCC":"AC3"}' },
];

/**
 * A method of the stand-in, which, as a TV's own AVPlay does, being a host
 * object, refuses a call that isn't on an object, such as one passed around
 * on its own.
 */
const method = <A extends unknown[], R>(body: (...args: A) => R) =>
  function (this: unknown, ...args: A): R {
    if (this === undefined) throw new TypeError("Illegal invocation");
    return body(...args);
  };

export const standInAVPlay = (): StandInAVPlay => {
  let state: AVPlayState = "NONE";
  let listener: AVPlayListener = {};
  let position = 0;
  /** The index of the audio track it plays, once it has one open. */
  let audio: number | undefined;
  const opened = (): boolean => state === "READY" || state === "PLAYING" || state === "PAUSED";
  const held: { readonly onSuccess: () => void; readonly onError: (error: unknown) => void }[] = [];
  const calls: (readonly [string, ...unknown[]])[] = [];

  const avplay: StandInAVPlay = {
    calls,
    listener: () => listener,
    prepareOutcome: "success",
    tracks: STAND_IN_TRACKS,
    finishPrepare: (outcome) => {
      const prepare = held.shift();
      if (outcome === "success") {
        state = "READY";
        audio = avplay.tracks.find((track) => track.type === "AUDIO")?.index;
        prepare?.onSuccess();
      } else prepare?.onError(outcome);
    },
    open: method((url) => {
      calls.push(["open", url]);
      if (state !== "NONE") throw new Error("InvalidStateError");
      state = "IDLE";
    }),
    close: method(() => {
      calls.push(["close"]);
      state = "NONE";
      position = 0;
    }),
    prepareAsync: method((onSuccess, onError) => {
      calls.push(["prepareAsync"]);
      const outcome = avplay.prepareOutcome;
      if (outcome === "held") held.push({ onSuccess, onError });
      else
        setTimeout(() => {
          if (outcome === "success") {
            state = "READY";
            audio = avplay.tracks.find((track) => track.type === "AUDIO")?.index;
            onSuccess();
          } else onError(outcome);
        });
    }),
    setDisplayRect: method((...rect) => calls.push(["setDisplayRect", ...rect])),
    setListener: method((next) => {
      calls.push(["setListener"]);
      listener = next;
    }),
    play: method(() => {
      calls.push(["play"]);
      state = "PLAYING";
    }),
    pause: method(() => {
      calls.push(["pause"]);
      state = "PAUSED";
    }),
    stop: method(() => {
      calls.push(["stop"]);
      if (state !== "NONE") state = "IDLE";
    }),
    seekTo: method((positionMs, onSuccess) => {
      calls.push(["seekTo", positionMs]);
      setTimeout(() => {
        position = positionMs;
        onSuccess();
      });
    }),
    getState: method(() => state),
    getCurrentTime: method(() => position),
    getDuration: method(() => (state === "NONE" || state === "IDLE" ? 0 : 5_400_000)),
    getTotalTrackInfo: method(() => {
      if (!opened()) throw new Error("InvalidStateError");
      return avplay.tracks;
    }),
    getCurrentStreamInfo: method(() => {
      if (!opened()) throw new Error("InvalidStateError");
      return avplay.tracks.filter((track) => track.type !== "AUDIO" || track.index === audio);
    }),
    setSelectTrack: method((type, index) => {
      calls.push(["setSelectTrack", type, index]);
      if (!opened() || !avplay.tracks.some((track) => track.type === type && track.index === index)) {
        throw new Error("InvalidValuesError");
      }
      if (type === "AUDIO") audio = index;
    }),
  };
  return avplay;
};
