import type { MenuShortcut, RemoteKey } from "@media-centre/shared";

/**
 * The code a Samsung TV's control socket takes for each key on the Remote's
 * key pad (FR-18). Only the Samsung TV Driver knows these (NFR-6).
 */
export const SAMSUNG_KEY_CODES: Readonly<Record<RemoteKey, string>> = {
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  ok: "KEY_ENTER",
  back: "KEY_RETURN",
  home: "KEY_HOME",
  menu: "KEY_MENU",
  tools: "KEY_TOOLS",
  info: "KEY_INFO",
  source: "KEY_SOURCE",
  "channel-up": "KEY_CHUP",
  "channel-down": "KEY_CHDOWN",
  "0": "KEY_0",
  "1": "KEY_1",
  "2": "KEY_2",
  "3": "KEY_3",
  "4": "KEY_4",
  "5": "KEY_5",
  "6": "KEY_6",
  "7": "KEY_7",
  "8": "KEY_8",
  "9": "KEY_9",
  red: "KEY_RED",
  green: "KEY_GREEN",
  yellow: "KEY_YELLOW",
  // Samsung's blue key is called cyan.
  blue: "KEY_CYAN",
  play: "KEY_PLAY",
  pause: "KEY_PAUSE",
  stop: "KEY_STOP",
  rewind: "KEY_REWIND",
  "fast-forward": "KEY_FF",
  "volume-up": "KEY_VOLUP",
  "volume-down": "KEY_VOLDOWN",
};

/** The code for a key the Remote names, or undefined for a name it doesn't have. */
export const samsungKeyCode = (key: string): string | undefined =>
  Object.hasOwn(SAMSUNG_KEY_CODES, key) ? SAMSUNG_KEY_CODES[key as RemoteKey] : undefined;

/**
 * The power key, which the Remote's Power button sends to a TV that is on
 * (FR-17), but which is no key of its key pad. A Frame TV takes a tap of it
 * for Art Mode, and switches off only when it is held.
 */
export const SAMSUNG_POWER_KEY = "KEY_POWER";

/**
 * The key a Samsung TV's control socket takes for each of TV Menu mode's
 * shortcuts (FR-24), as Samsung's remotes have them. Which of these a TV acts
 * on varies by model and firmware, and none is confirmed on a real TV yet
 * (PRD §10). Only the Samsung TV Driver knows these (NFR-6).
 */
export const SAMSUNG_SHORTCUT_KEY_CODES: Readonly<Record<MenuShortcut, string>> = {
  "picture-mode": "KEY_PMODE",
  "picture-size": "KEY_PICTURE_SIZE",
  "sleep-timer": "KEY_SLEEP",
  "energy-saving": "KEY_ESAVING",
  captions: "KEY_CAPTION",
  "audio-description": "KEY_AD",
  // Multi-track sound: the remote's key for the next audio track.
  "audio-track": "KEY_MTS",
  "input-source": "KEY_SOURCE",
};

/** The code for a shortcut the Remote names, or undefined for a name it doesn't have. */
export const samsungShortcutCode = (shortcut: string): string | undefined =>
  Object.hasOwn(SAMSUNG_SHORTCUT_KEY_CODES, shortcut)
    ? SAMSUNG_SHORTCUT_KEY_CODES[shortcut as MenuShortcut]
    : undefined;
