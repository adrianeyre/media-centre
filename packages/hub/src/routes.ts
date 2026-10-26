import type { AudioTrack, Route } from "@media-centre/shared";

import type { PlayableFormats } from "./drivers/driver.ts";
import type { MediaProbe, ProbedStream } from "./ffprobe.ts";

/** Each Route as the Hub's log names it, as the glossary does. */
export const ROUTE_NAMES: Readonly<Record<Route, string>> = {
  "direct-play": "Direct Play",
  remux: "Remux",
  "audio-conversion": "Audio Conversion",
  "full-conversion": "Full Conversion",
};

/** Subtitles that are pictures, not text, which a TV that can't show them needs burned into the video (FR-45). */
const IMAGE_SUBTITLES: ReadonlySet<string> = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);

/**
 * Whether a stream of a Media File is image subtitles, e.g. PGS or VobSub,
 * that a TV that plays `formats` can't render, which the Hub burns into the
 * picture to show, by Full Conversion (FR-45).
 */
export const burnsIn = (stream: ProbedStream, formats: PlayableFormats): boolean =>
  stream.type === "subtitle" && IMAGE_SUBTITLES.has(stream.codec) && !formats.subtitles.includes(stream.codec);

export interface RouteOptions {
  /**
   * The index of the subtitle stream to show, if any. Text subtitles never
   * change the Route, as the Hub converts any the TV can't show to one it can
   * (FR-45); image subtitles the TV can't show are burned in, which only Full
   * Conversion does.
   */
  readonly subtitle?: number;
}

/**
 * The cheapest Route that plays the Media File ffprobe described on a TV
 * that plays `formats` (FR-41, ADR 0006), or null when it has neither video
 * nor audio to play. The video played is its first video stream that isn't
 * an attached picture, such as an album's cover art; every audio stream is
 * played, so that any can be chosen.
 *
 * 1. Direct Play, when the TV plays the container, and the video and every
 *    audio stream in it, as they are.
 * 2. Remux, when it plays the video and every audio stream from HLS.
 * 3. Audio Conversion, when it plays the video from HLS, but not the audio.
 * 4. Full Conversion, when it doesn't play the video even from HLS, or an
 *    image subtitle it can't show is to be burned in.
 */
export const chooseRoute = (probe: MediaProbe, formats: PlayableFormats, options: RouteOptions = {}): Route | null => {
  const { video, audio } = playedStreams(probe);
  if (video === undefined && audio.length === 0) return null;

  const subtitle = probe.streams.find((stream) => stream.type === "subtitle" && stream.index === options.subtitle);
  if (subtitle !== undefined && burnsIn(subtitle, formats)) return "full-conversion";

  const plays = (codecs: { readonly video: readonly string[]; readonly audio: readonly string[] }): boolean =>
    (video === undefined || codecs.video.includes(video.codec)) &&
    audio.every((stream) => codecs.audio.includes(stream.codec));

  const direct = formats.direct[probe.container];
  if (direct !== undefined && plays(direct)) return "direct-play";
  if (video !== undefined && !formats.streamed.video.includes(video.codec)) return "full-conversion";
  return plays(formats.streamed) ? "remux" : "audio-conversion";
};

/** The streams of a Media File that are played: its video, if it has any, and its audio. */
export const playedStreams = (
  probe: MediaProbe,
): { readonly video: ProbedStream | undefined; readonly audio: readonly ProbedStream[] } => ({
  video: probe.streams.find((stream) => stream.type === "video" && !stream.attachedPicture),
  audio: probe.streams.filter((stream) => stream.type === "audio"),
});

/**
 * The Media File's audio tracks, for the now-playing bar to list and choose
 * between (FR-36): every audio stream, in the order they are in the file, as
 * every Route plays them all.
 */
export const audioTracksOf = (probe: MediaProbe): AudioTrack[] =>
  playedStreams(probe).audio.map(({ language, title, codec, channels }) => ({ language, title, codec, channels }));

/**
 * The indexes of the Media File's audio streams that the TV doesn't play from
 * HLS, which the Audio Conversion Route re-encodes, and only those: the
 * video, and any audio stream it does play, are copied as they are.
 */
export const audioToConvert = (probe: MediaProbe, formats: PlayableFormats): number[] =>
  playedStreams(probe)
    .audio.filter((stream) => !formats.streamed.audio.includes(stream.codec))
    .map((stream) => stream.index);
