import { PLAYBACK_SKIPS_MS, type PlaybackControl } from "@media-centre/shared";

import type { PlaybackState } from "./playback/playback.ts";
import type { TvInputDevice } from "./tizen.ts";

/**
 * - `play-pause`: play if paused, pause if playing.
 * - A {@link PlaybackControl}, done as it is.
 */
type KeyAction = "play-pause" | PlaybackControl;

/** The smallest skip forward on the now-playing bar, which the TV's own remote's rewind and fast-forward keys skip too. */
const SKIP_MS = Math.min(...PLAYBACK_SKIPS_MS.filter((ms) => ms > 0));

/**
 * The media keys of a Samsung TV's own remote the Player acts on (FR-37):
 * Tizen's name for each, which a web app registers it by to be sent it, and
 * the key code its `keydown` has.
 */
export const MEDIA_KEYS: readonly { readonly name: string; readonly keyCode: number; readonly does: KeyAction }[] = [
  { name: "MediaPlayPause", keyCode: 10252, does: "play-pause" },
  { name: "MediaPlay", keyCode: 415, does: { action: "play" } },
  { name: "MediaPause", keyCode: 19, does: { action: "pause" } },
  { name: "MediaStop", keyCode: 413, does: { action: "stop" } },
  { name: "MediaRewind", keyCode: 412, does: { action: "skip", byMs: -SKIP_MS } },
  { name: "MediaFastForward", keyCode: 417, does: { action: "skip", byMs: SKIP_MS } },
];

/** The key code of the TV's own remote's Back key, which every Tizen web app is sent without registering it. */
export const BACK_KEY_CODE = 10009;

/**
 * Registers {@link MEDIA_KEYS}, so that the TV sends the Player their
 * `keydown`s rather than act on them itself. A key a model hasn't got is
 * left out, and the rest are registered all the same.
 */
export const registerMediaKeys = (tvInputDevice: TvInputDevice | undefined): void => {
  for (const { name } of MEDIA_KEYS) {
    try {
      tvInputDevice?.registerKey(name);
    } catch {
      // Not a key this TV has.
    }
  }
};

/**
 * What a key pressed on the TV's own remote does to playback in this state
 * (FR-37), or null if it does nothing, and the TV may act on it as it would:
 * the media keys, and Back, which stops what is playing, returning to the
 * waiting screen. With nothing playing, every key does nothing.
 */
export const remoteKeyControl = (keyCode: number, state: PlaybackState): PlaybackControl | null => {
  if (state === "idle") return null;
  if (keyCode === BACK_KEY_CODE) return { action: "stop" };
  const does = MEDIA_KEYS.find((key) => key.keyCode === keyCode)?.does;
  if (does === undefined) return null;
  if (does !== "play-pause") return does;
  return { action: state === "playing" ? "pause" : "play" };
};
