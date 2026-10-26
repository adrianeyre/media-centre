import { element, icon } from "./dom.ts";
import type { PlaybackState } from "./playback/playback.ts";

/** What the Player says of its playback, in each state but idle, when it shows nothing. */
export const PLAYBACK_LABEL: Readonly<Record<Exclude<PlaybackState, "idle">, string>> = {
  loading: "Loading…",
  paused: "Paused",
  playing: "Playing",
};

export interface PlaybackStatus {
  readonly element: HTMLElement;
  /** Shows this state: a spinner while loading, else the play or pause icon, and what {@link PLAYBACK_LABEL} says. */
  readonly show: (state: PlaybackState) => void;
}

/**
 * Whether the Player is loading, paused or playing, as an icon and a word,
 * so that a glance across the room tells, and not by the icon alone. It is
 * redrawn only when the state changes.
 */
export const playbackStatus = (className: string): PlaybackStatus => {
  const status = element("p", className);
  const glyph = element("span", "glyph");
  const label = element("span", "label");
  status.appendChild(glyph);
  status.appendChild(label);
  let shown: PlaybackState | null = null;
  return {
    element: status,
    show: (state) => {
      if (state === shown) return;
      shown = state;
      status.setAttribute("data-state", state);
      glyph.textContent = "";
      glyph.className = state === "loading" ? "glyph spinner" : "glyph";
      if (state === "playing" || state === "paused") glyph.appendChild(icon(state === "playing" ? "play" : "pause"));
      label.textContent = state === "idle" ? "" : PLAYBACK_LABEL[state];
    },
  };
};
