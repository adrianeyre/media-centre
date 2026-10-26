/**
 * The Player's subtitles (FR-36, FR-44, FR-45). AVPlay loads a sidecar
 * subtitle file only from a path on the TV itself, not a URL, and leaves
 * drawing its text to the app all the same, so the Player reads each
 * subtitle track from the Hub, which sends every one as SubRip or WebVTT,
 * converting any other, and shows the text of whichever cue is at the
 * playback's position. It works the same whatever the Route, and through
 * the fake playback as through AVPlay.
 */

import type { Playback } from "./playback.ts";

/** One subtitle: its text, and when it shows, in milliseconds into the Media File. */
export interface SubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** A SubRip or WebVTT cue's timing line: from, then to, as `[hh:]mm:ss,mmm` or `[hh:]mm:ss.mmm`, then any settings. */
const TIMING = /^((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})(?:\s.*)?$/;

/** A time as a cue's timing line has it, in milliseconds. */
const msIn = (time: string): number => {
  const [clock = "", fraction = "0"] = time.split(/[,.]/);
  const parts = clock.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  // "5" is 500 ms, as "5" after the point is half a second.
  return seconds * 1_000 + Math.round(Number(`0.${fraction}`) * 1_000);
};

/** The few character references a cue may have, as WebVTT writes them. */
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", nbsp: "\u00a0", lrm: "", rlm: "" };

/** A cue's text, as shown: its tags, e.g. `<i>`, and any ASS override codes, e.g. `{\an8}`, left out. */
const plainText = (lines: readonly string[]): string =>
  lines
    .join("\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name: string) => ENTITIES[name] ?? "")
    .trim();

/**
 * The cues of a SubRip or WebVTT file, the formats the Player renders, in
 * the order they are in it, or null when it is neither, as an `.ass` is.
 */
export const parseSubtitles = (file: string): SubtitleCue[] | null => {
  const text = file.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const webvtt = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text);
  if (text.trim() === "") return [];
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n").filter((line, at) => at > 0 || line.trim() !== "");
    // A cue's id, a number in SubRip, comes before its timing line.
    const at = lines.findIndex((line) => TIMING.test(line.trim()));
    if (at === -1 || at > 1) continue;
    const timing = TIMING.exec((lines[at] ?? "").trim());
    if (timing === null) continue;
    const startMs = msIn(timing[1] ?? "");
    const endMs = msIn(timing[2] ?? "");
    const shown = plainText(lines.slice(at + 1));
    if (endMs > startMs && shown !== "") cues.push({ startMs, endMs, text: shown });
  }
  return webvtt || cues.length > 0 ? cues : null;
};

/** The text of the cues showing at `positionMs`, a line each, or null when none is. */
export const subtitleTextAt = (cues: readonly SubtitleCue[], positionMs: number): string | null => {
  const showing = cues.filter(({ startMs, endMs }) => positionMs >= startMs && positionMs < endMs);
  return showing.length === 0 ? null : showing.map(({ text }) => text).join("\n");
};

export interface SubtitlesOptions {
  readonly playback: Playback;
  /** Reads the file at the URL, from the Hub, rejecting when it can't. */
  readonly fetchText: (url: string) => Promise<string>;
  /** Shows this text over the picture, or none, for null, whenever it changes. */
  readonly show: (text: string | null) => void;
}

export interface Subtitles {
  /** The subtitle tracks of the Media File about to be loaded, by the URL of each, none of them shown yet. */
  readonly offer: (urls: readonly string[]) => void;
  /**
   * Shows the subtitle track at this place among those offered, read from
   * the Hub, or none, for null, and resolves once it does. It rejects, and
   * shows what it showed before, when it has no such track, or none to read,
   * as for one the Hub burns into the picture, or can't read it, or it isn't
   * SubRip or WebVTT.
   */
  readonly select: (track: number | null) => Promise<void>;
  /** The subtitle track it shows, by its place among those offered, or null for none. */
  readonly track: () => number | null;
  /** The text it shows now, or null for none. */
  readonly text: () => string | null;
  /** Shows nothing more. */
  readonly stop: () => void;
}

/**
 * Shows the subtitle track chosen of what `playback` plays, at its
 * position, as it plays and seeks, until it plays nothing.
 */
export const showSubtitles = ({ playback, fetchText, show }: SubtitlesOptions): Subtitles => {
  let offered: readonly string[] = [];
  let chosen: { readonly track: number; readonly cues: readonly SubtitleCue[] } | null = null;
  let shown: string | null = null;
  /** Counts what changes the track, so that a track read late isn't shown after another was chosen, or none. */
  let changes = 0;

  const showAt = (positionMs: number): void => {
    const next = chosen === null ? null : subtitleTextAt(chosen.cues, positionMs);
    if (next === shown) return;
    shown = next;
    show(shown);
  };

  const showNone = (): void => {
    changes += 1;
    chosen = null;
    showAt(0);
  };

  const unsubscribe = playback.subscribe((event) => {
    if (event.type === "position") showAt(event.positionMs);
    else if (event.type === "state" && event.state === "idle") {
      offered = [];
      showNone();
    }
  });

  return {
    offer: (urls) => {
      offered = urls.slice();
      showNone();
    },
    select: async (track) => {
      if (track === null) {
        showNone();
        return;
      }
      const url = offered[track];
      if (url === undefined || url === "") throw new Error(`There is no subtitle track ${String(track + 1)} to read.`);
      changes += 1;
      const change = changes;
      const cues = parseSubtitles(await fetchText(url));
      if (cues === null) throw new Error(`The subtitle track at ${url} is neither SubRip nor WebVTT.`);
      if (change !== changes) return;
      chosen = { track, cues };
      showAt(playback.positionMs());
    },
    track: () => chosen?.track ?? null,
    text: () => shown,
    stop: () => {
      unsubscribe();
      showNone();
    },
  };
};
