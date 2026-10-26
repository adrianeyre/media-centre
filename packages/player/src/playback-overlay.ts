import { element } from "./dom.ts";
import { playbackStatus } from "./playback-status.ts";
import type { Playback } from "./playback/playback.ts";
import { formatPosition } from "./waiting-screen.ts";

/** How long the overlay stays over a playing video after anything changes, in milliseconds. */
export const OVERLAY_SHOWN_MS = 4_000;

export interface PlaybackOverlay {
  /**
   * Whether what plays is a video, which the overlay is over, or not, as
   * audio, whose now-playing screen says the same, or nothing.
   */
  readonly forVideo: (video: boolean) => void;
  /** Shows it, as after a key on the TV's own remote or a control from the Hub, for {@link OVERLAY_SHOWN_MS} if it plays on. */
  readonly reveal: () => void;
  /** Stops following the playback. */
  readonly stop: () => void;
}

/**
 * The overlay over the bottom of a video's picture (FR-36, FR-37): whether
 * it is loading, paused or playing, and how far into it the Player is, with
 * a bar and as times. While a video loads or is paused, it stays; while it
 * plays, it shows for {@link OVERLAY_SHOWN_MS} after the state changes or
 * {@link PlaybackOverlay.reveal}, then hides, so that the picture is clear.
 * Without it, a key on the TV's own remote would change the video with
 * nothing on the screen to say so. `onShown` is called as it shows and
 * hides, so that the subtitles can move out of its way. It is drawn into
 * `root` once, hidden.
 */
export const playbackOverlay = (
  root: HTMLElement,
  playback: Playback,
  onShown: (shown: boolean) => void,
): PlaybackOverlay => {
  root.classList.add("overlay");
  root.hidden = true;
  const bar = element("div", "overlay-bar");
  const status = playbackStatus("overlay-status");
  status.element.setAttribute("aria-live", "polite");
  const progress = element("div", "overlay-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Video progress");
  progress.setAttribute("aria-valuemin", "0");
  const played = element("div", "overlay-played");
  progress.appendChild(played);
  const times = element("p", "overlay-times");
  const position = element("span", "position");
  const duration = element("span", "duration");
  times.appendChild(position);
  times.appendChild(document.createTextNode(" / "));
  times.appendChild(duration);
  bar.appendChild(status.element);
  bar.appendChild(progress);
  bar.appendChild(times);
  root.appendChild(bar);

  let video = false;
  let hiding: ReturnType<typeof setTimeout> | undefined;

  const show = (shown: boolean): void => {
    if (root.hidden !== shown) return;
    root.hidden = !shown;
    onShown(shown);
  };

  const drawProgress = (): void => {
    const positionMs = playback.positionMs();
    const durationMs = playback.durationMs();
    position.textContent = formatPosition(positionMs);
    duration.textContent = durationMs === null ? "–:––" : formatPosition(durationMs);
    const fraction = durationMs === null || durationMs <= 0 ? 0 : Math.min(1, Math.max(0, positionMs / durationMs));
    played.style.width = `${String(fraction * 100)}%`;
    progress.setAttribute("aria-valuemax", String(Math.round((durationMs ?? 0) / 1_000)));
    progress.setAttribute("aria-valuenow", String(Math.round(positionMs / 1_000)));
    progress.setAttribute("aria-valuetext", `${position.textContent} of ${duration.textContent}`);
  };

  /** Draws it as the playback is, showing it if `revealed`, or while it doesn't play. */
  const refresh = (revealed: boolean): void => {
    const state = playback.state();
    if (!video || state === "idle") {
      clearTimeout(hiding);
      show(false);
      return;
    }
    status.show(state);
    drawProgress();
    if (state !== "playing") {
      clearTimeout(hiding);
      show(true);
    } else if (revealed) {
      show(true);
      clearTimeout(hiding);
      hiding = setTimeout(() => {
        show(false);
      }, OVERLAY_SHOWN_MS);
    }
  };

  const unsubscribe = playback.subscribe((event) => {
    refresh(event.type === "state");
  });

  return {
    forVideo: (next) => {
      if (next === video) return;
      video = next;
      refresh(true);
    },
    reveal: () => {
      refresh(true);
    },
    stop: () => {
      clearTimeout(hiding);
      unsubscribe();
    },
  };
};
