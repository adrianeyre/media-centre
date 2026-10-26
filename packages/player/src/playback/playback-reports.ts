import type { PlaybackControl, PlayerPlayback, PlayerToHubMessage } from "@media-centre/shared";

import type { Playback } from "./playback.ts";
import type { Subtitles } from "./subtitles.ts";

/** How often, at most, the Player reports its position as it plays: every second. */
export const POSITION_REPORT_MS = 1_000;

export interface PlaybackReportsOptions {
  readonly playback: Playback;
  /** What shows the subtitle track chosen of what `playback` plays, if anything does. */
  readonly subtitles?: Subtitles;
  /** Sends the message to the Hub, if the Player is connected to it; otherwise drops it. */
  readonly send: (message: PlayerToHubMessage) => void;
  /** {@link POSITION_REPORT_MS} but in tests. */
  readonly positionReportMs?: number;
}

/** The audio track to play and the subtitle track to show of what has just loaded, as the Hub sends them with it. */
export interface StartingTracks {
  /** By its place among the Media File's audio tracks; left out for whichever it plays first. */
  readonly audioTrack?: number;
  /** By its place among the subtitle tracks sent with it, or null for none; left out for none. */
  readonly subtitleTrack?: number | null;
}

export interface PlaybackReports {
  /**
   * Says the Media File at `url` is the one played from now on, with the
   * subtitle tracks at `subtitles`, none of them shown: call it just before
   * loading it.
   */
  readonly playing: (url: string, subtitles?: readonly string[]) => void;
  /**
   * Moves what has just loaded to `positionMs`, kept within it, before it
   * plays, as when the Hub sends a Media File to play from its Resume
   * Position (FR-40), then plays the audio track and shows the subtitle
   * track in `tracks`, if any, as when the Hub sends it again by another
   * Route (FR-45). Whatever it can't do it leaves as it was: at the start,
   * the first audio track, and no subtitles. It doesn't report: playing,
   * next, does.
   */
  readonly startFrom: (positionMs: number, tracks?: StartingTracks) => Promise<void>;
  /** Does what the Hub, or the TV's own remote, asked (FR-36, FR-37), then reports, whatever it changed. */
  readonly control: (control: PlaybackControl) => Promise<void>;
  /** Reports what the playback is doing now, as the Player does as it connects to the Hub. */
  readonly report: () => void;
  /** Reports nothing more. */
  readonly stop: () => void;
}

/**
 * Tells the Hub what `playback` is doing (FR-36, ADR 0003), so that every
 * Remote on the TV sees it: at once whenever it changes state, at most every
 * `positionReportMs` as its position moves, and after each control; and,
 * just after it says it plays nothing, that the Media File it played has
 * played to its end, if it has, for the Hub to send the next of its Queue,
 * if any (FR-48). The
 * Player and the fake TV's fake Player both report through this, so that
 * what the Hub hears from one it hears from the other.
 */
export const reportPlayback = ({
  playback,
  subtitles,
  send,
  positionReportMs = POSITION_REPORT_MS,
}: PlaybackReportsOptions): PlaybackReports => {
  let url: string | null = null;
  /** The Media File it played last, as it went idle, which may have played to its end. */
  let played: string | null = null;
  let lastReport = Number.NEGATIVE_INFINITY;

  const report = (): void => {
    const state = playback.state();
    const now: PlayerPlayback = {
      state,
      url: state === "idle" ? null : url,
      positionMs: playback.positionMs(),
      durationMs: playback.durationMs(),
      audioTrack: playback.audioTrack(),
      subtitleTrack: state === "idle" ? null : (subtitles?.track() ?? null),
    };
    lastReport = Date.now();
    send({ type: "playback", playback: now });
  };

  /** Moves to `positionMs`, kept within what is loaded, or does nothing when nothing is. */
  const seekTo = async (positionMs: number): Promise<void> => {
    const state = playback.state();
    if (state !== "paused" && state !== "playing") return;
    const duration = playback.durationMs();
    await playback.seekTo(Math.max(0, duration === null ? positionMs : Math.min(positionMs, duration)));
  };

  const unsubscribe = playback.subscribe((event) => {
    if (event.type === "state") {
      if (event.state === "idle") {
        played = url;
        url = null;
      }
      report();
    } else if (event.type === "ended") {
      if (played !== null) send({ type: "ended", url: played });
      played = null;
    } else if (event.type === "position" && Date.now() - lastReport >= positionReportMs) report();
  });

  return {
    playing: (next, subtitleUrls = []) => {
      url = next;
      subtitles?.offer(subtitleUrls);
    },
    startFrom: async (positionMs, { audioTrack, subtitleTrack = null } = {}) => {
      if (Number.isFinite(positionMs) && positionMs > 0) {
        try {
          await seekTo(positionMs);
        } catch (error) {
          console.error(
            "The Player couldn't start where it was asked to, so it starts at the start",
            positionMs,
            error,
          );
        }
      }
      if (audioTrack !== undefined) {
        try {
          playback.selectAudioTrack(audioTrack);
        } catch (error) {
          console.error("The Player couldn't play the audio track it was asked to", audioTrack, error);
        }
      }
      if (subtitleTrack !== null) {
        try {
          if (subtitles === undefined) throw new Error("This Player shows no subtitles.");
          await subtitles.select(subtitleTrack);
        } catch (error) {
          console.error("The Player couldn't show the subtitle track it was asked to", subtitleTrack, error);
        }
      }
    },
    control: async (control) => {
      try {
        switch (control.action) {
          case "play":
            playback.play();
            break;
          case "pause":
            playback.pause();
            break;
          case "stop":
            playback.stop();
            break;
          case "seek":
            await seekTo(control.positionMs);
            break;
          case "skip":
            await seekTo(playback.positionMs() + control.byMs);
            break;
          case "audio-track":
            playback.selectAudioTrack(control.track);
            break;
          case "subtitle-track":
            if (subtitles === undefined) throw new Error("This Player shows no subtitles.");
            await subtitles.select(control.track);
            break;
        }
      } catch (error) {
        // It is wherever it was, which the report says.
        console.error("The Player couldn't do what it was asked", control, error);
      }
      report();
    },
    report,
    stop: unsubscribe,
  };
};

/**
 * The {@link StartingTracks} in a `play` message from the Hub, leaving out
 * what isn't one, as from a Hub newer or older than the Player.
 */
export const startingTracksIn = (message: unknown): StartingTracks => {
  if (typeof message !== "object" || message === null) return {};
  const { audioTrack, subtitleTrack } = message as Record<string, unknown>;
  const place = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  return {
    ...(place(audioTrack) ? { audioTrack } : {}),
    ...(place(subtitleTrack) ? { subtitleTrack } : {}),
  };
};

/**
 * The {@link PlaybackControl} in a message from the Hub, which may be from a
 * Hub newer or older than the Player, or null if it isn't one the Player
 * knows.
 */
export const playbackControlIn = (control: unknown): PlaybackControl | null => {
  if (typeof control !== "object" || control === null || !("action" in control)) return null;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  switch (control.action) {
    case "play":
    case "pause":
    case "stop":
      return { action: control.action };
    case "seek":
      return "positionMs" in control && finite(control.positionMs)
        ? { action: "seek", positionMs: control.positionMs }
        : null;
    case "skip":
      return "byMs" in control && finite(control.byMs) ? { action: "skip", byMs: control.byMs } : null;
    case "audio-track":
      return "track" in control && Number.isSafeInteger(control.track) && (control.track as number) >= 0
        ? { action: "audio-track", track: control.track as number }
        : null;
    case "subtitle-track":
      if (!("track" in control)) return null;
      if (control.track === null) return { action: "subtitle-track", track: null };
      return Number.isSafeInteger(control.track) && (control.track as number) >= 0
        ? { action: "subtitle-track", track: control.track as number }
        : null;
    default:
      return null;
  }
};
