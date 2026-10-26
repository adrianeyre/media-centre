/**
 * The little of a Samsung TV's web runtime the Player uses, as far as we know
 * it. `tizen` is there for every Tizen web app; `webapis` once the page loads
 * `$WEBAPIS/webapis/webapis.js`. In a desktop browser neither is.
 */

/** One entry of the data an app was launched with. */
export interface AppControlData {
  readonly key: string;
  readonly value: readonly string[];
}

/**
 * `tizen.tvinputdevice`: which keys of the TV's own remote the Player is sent,
 * beyond those every app is, such as the arrows, OK and Back.
 */
export interface TvInputDevice {
  /** Has the TV send the app this key, by Tizen's name for it, e.g. `"MediaPlayPause"`, rather than act on it itself. */
  readonly registerKey: (keyName: string) => void;
}

/** What `tizen.application` says about how the Player was launched, and its `tvinputdevice`. */
export interface Tizen {
  /** Left out by a TV without the privilege for it, which the Player's manifest asks for. */
  readonly tvinputdevice?: TvInputDevice;
  readonly application: {
    readonly getCurrentApplication: () => {
      readonly getRequestedAppControl: () => {
        readonly appControl: { readonly data: readonly AppControlData[] };
      } | null;
    };
  };
}

/** AVPlay's states (ADR 0005). */
export type AVPlayState = "NONE" | "IDLE" | "READY" | "PLAYING" | "PAUSED";

/** What AVPlay calls back with as it plays. */
export interface AVPlayListener {
  readonly onbufferingstart?: () => void;
  readonly onbufferingprogress?: (percent: number) => void;
  readonly onbufferingcomplete?: () => void;
  /** The position, in milliseconds. */
  readonly oncurrentplaytime?: (positionMs: number) => void;
  readonly onstreamcompleted?: () => void;
  readonly onevent?: (type: string, data: string) => void;
  readonly onerror?: (type: string) => void;
}

/**
 * One track of what AVPlay has open, as `getTotalTrackInfo` and
 * `getCurrentStreamInfo` give it: `index` is what `setSelectTrack` takes,
 * and `extra_info` is JSON of more about it, e.g. its language.
 */
export interface AVPlayStreamInfo {
  readonly index: number;
  /** "VIDEO", "AUDIO" or "TEXT", or another type a TV may have. */
  readonly type: string;
  readonly extra_info: string;
}

/** Samsung's AVPlay, as `webapis.avplay`: the TV's own media player, behind the page. */
export interface AVPlay {
  readonly open: (url: string) => void;
  readonly close: () => void;
  readonly prepareAsync: (onSuccess: () => void, onError: (error: unknown) => void) => void;
  /** Where on the screen the picture goes, in a 1920 × 1080 frame whatever the screen's resolution. */
  readonly setDisplayRect: (x: number, y: number, width: number, height: number) => void;
  readonly setListener: (listener: AVPlayListener) => void;
  readonly play: () => void;
  readonly pause: () => void;
  readonly stop: () => void;
  readonly seekTo: (positionMs: number, onSuccess: () => void, onError: (error: unknown) => void) => void;
  readonly getState: () => AVPlayState;
  /** The position, in milliseconds. */
  readonly getCurrentTime: () => number;
  /** The length, in milliseconds. */
  readonly getDuration: () => number;
  /** Every track of what it has open, ready or playing, in the order they are in it. */
  readonly getTotalTrackInfo: () => readonly AVPlayStreamInfo[];
  /** The track of each type it plays now. */
  readonly getCurrentStreamInfo: () => readonly AVPlayStreamInfo[];
  /** Plays the track at `index`, as {@link getTotalTrackInfo} gives it, of this type in place of the one it plays. */
  readonly setSelectTrack: (type: "AUDIO" | "TEXT", index: number) => void;
}

export interface WebApis {
  readonly avplay: AVPlay;
}

declare global {
  interface Window {
    readonly tizen?: Tizen;
    readonly webapis?: WebApis;
  }
}
