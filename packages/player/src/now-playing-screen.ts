import type { MusicDetails } from "@media-centre/shared";

import { element, icon } from "./dom.ts";
import { playbackStatus } from "./playback-status.ts";
import type { Playback } from "./playback/playback.ts";
import { formatPosition } from "./waiting-screen.ts";

export interface NowPlayingScreen {
  /** Shows the screen for the audio Media File playing, as the Hub described it, or hides it for null. */
  readonly show: (music: MusicDetails | null) => void;
  /** Stops following the playback. */
  readonly stop: () => void;
}

/**
 * The music the Hub sent with a Media File (FR-47), or null for none, as for
 * a video, or for any of it the Player doesn't know, from a newer Hub. Its
 * cover art is only ever the Hub's own, as every URL it plays is.
 */
export const musicIn = (sent: unknown): MusicDetails | null => {
  if (typeof sent !== "object" || sent === null) return null;
  const { title, artist, album, coverArt } = sent as Record<string, unknown>;
  const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
  if (typeof title !== "string" || !textOrNull(artist) || !textOrNull(album) || !textOrNull(coverArt)) return null;
  return {
    title,
    artist,
    album,
    coverArt: coverArt !== null && /^http:\/\/[^/]/.test(coverArt) ? coverArt : null,
  };
};

/**
 * The screen the Player shows while it plays an audio Media File (FR-47):
 * the cover art embedded in it, which it reads from the Hub, or a
 * placeholder for one with none, or whose cover art won't load; its title,
 * artist and album, as its tags say, the Hub standing in its file name for a
 * title it hasn't got; whether `playback` plays it or is paused; and how
 * far into it it is, as it plays. Behind it all, the cover art again,
 * blurred and dimmed, to fill the screen with its colours. It is drawn into
 * `root` once, hidden, then only what it shows changes.
 */
export const nowPlayingScreen = (root: HTMLElement, playback: Playback): NowPlayingScreen => {
  const screen = element("section", "now-playing");
  screen.setAttribute("aria-labelledby", "now-playing-title");
  screen.hidden = true;
  const backdrop = element("div", "backdrop");
  const cover = element("div", "cover");
  const coverArt = element("img", "cover-art");
  const placeholder = element("div", "cover-placeholder");
  placeholder.appendChild(icon("music", "icon placeholder-icon"));
  placeholder.setAttribute("role", "img");
  placeholder.setAttribute("aria-label", "No cover art");
  cover.appendChild(coverArt);
  cover.appendChild(placeholder);
  const details = element("div", "details");
  const status = playbackStatus("status");
  const title = element("h1", "title");
  title.id = "now-playing-title";
  const artist = element("p", "artist");
  const album = element("p", "album");
  const bar = element("div", "progress");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", "Progress");
  bar.setAttribute("aria-valuemin", "0");
  const played = element("div", "played");
  bar.appendChild(played);
  const times = element("p", "times");
  const position = element("span", "position");
  const duration = element("span", "duration");
  times.appendChild(position);
  times.appendChild(document.createTextNode(" / "));
  times.appendChild(duration);
  details.appendChild(status.element);
  details.appendChild(title);
  details.appendChild(artist);
  details.appendChild(album);
  details.appendChild(bar);
  details.appendChild(times);
  screen.appendChild(backdrop);
  screen.appendChild(cover);
  screen.appendChild(details);
  root.appendChild(screen);

  /** The cover art that loaded last, by its URL. */
  let loaded: string | null = null;
  /** Asks for the cover art at `url`, if it hasn't already, showing it once it loads, and the placeholder until it does, or if it won't. */
  const showCoverArt = (url: string | null): void => {
    if (url === null) {
      coverArt.removeAttribute("src");
      backdrop.style.backgroundImage = "";
    } else if (coverArt.getAttribute("src") !== url) {
      loaded = null;
      coverArt.src = url;
      backdrop.style.backgroundImage = "";
    }
    const shown = url !== null && loaded === url;
    coverArt.hidden = !shown;
    placeholder.hidden = shown;
  };
  coverArt.addEventListener("load", () => {
    loaded = coverArt.getAttribute("src");
    // Only cover art that loaded, which is the Hub's own, as `musicIn` has it.
    if (loaded !== null) backdrop.style.backgroundImage = `url("${loaded.replace(/["\\\n]/g, "\\$&")}")`;
    coverArt.hidden = false;
    placeholder.hidden = true;
  });
  coverArt.addEventListener("error", () => {
    loaded = null;
    backdrop.style.backgroundImage = "";
    coverArt.hidden = true;
    placeholder.hidden = false;
  });

  const showProgress = (): void => {
    const positionMs = playback.positionMs();
    const durationMs = playback.durationMs();
    position.textContent = formatPosition(positionMs);
    duration.textContent = durationMs === null ? "–:––" : formatPosition(durationMs);
    const fraction = durationMs === null || durationMs <= 0 ? 0 : Math.min(1, Math.max(0, positionMs / durationMs));
    played.style.width = `${String(fraction * 100)}%`;
    bar.setAttribute("aria-valuemax", String(Math.round((durationMs ?? 0) / 1_000)));
    bar.setAttribute("aria-valuenow", String(Math.round(positionMs / 1_000)));
    bar.setAttribute("aria-valuetext", `${position.textContent} of ${duration.textContent}`);
  };

  const unsubscribe = playback.subscribe(() => {
    if (screen.hidden) return;
    status.show(playback.state());
    showProgress();
  });

  return {
    show: (music) => {
      screen.hidden = music === null;
      if (music === null) return;
      title.textContent = music.title;
      artist.textContent = music.artist ?? "";
      artist.hidden = music.artist === null;
      album.textContent = music.album ?? "";
      album.hidden = music.album === null;
      coverArt.alt = `Cover art of ${music.album ?? music.title}`;
      showCoverArt(music.coverArt);
      status.show(playback.state());
      showProgress();
    },
    stop: unsubscribe,
  };
};
