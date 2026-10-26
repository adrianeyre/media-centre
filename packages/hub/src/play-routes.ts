import {
  mediaCoverArtPath,
  mediaFilePath,
  mediaSubtitlePath,
  type MediaSource,
  type MusicDetails,
  type Route,
} from "@media-centre/shared";

import { coverArtOf } from "./cover-art.ts";
import type { PlayableFormats } from "./drivers/driver.ts";
import type { MediaProbe, ProbeMedia } from "./ffprobe.ts";
import { findMediaFile, type MediaFileFound } from "./media-files.ts";
import { audioToConvert, audioTracksOf, chooseRoute } from "./routes.ts";
import type { SentTracks } from "./sent-tracks.ts";
import type { Streams } from "./streams.ts";
import { sidecarSubtitlesOf, subtitleFormatFor, subtitlesOf } from "./subtitles.ts";

export interface PlayRouteDependencies {
  readonly probeMedia: ProbeMedia;
  readonly streams: Streams;
  readonly sentTracks: SentTracks;
}

/** Why a Media File can't be played on a TV, written for the person, who is shown it as is, with the status to refuse it with. */
export class PlayRouteRefusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PlayRouteRefusal";
    this.status = status;
  }
}

/** What the Hub sends the Player of a Media File to play, as a `play` message has it. */
export interface PlaySent {
  /** The Media File's URL, served as it is or streamed. */
  readonly url: string;
  /** The URL of each of its subtitle tracks, in a format the Player renders, or `""` for one burned in. */
  readonly subtitles: readonly string[];
  /** For an audio Media File, what its now-playing screen shows, its cover art at the Hub's address (FR-47). */
  readonly music?: MusicDetails;
}

/** How a Media File is to reach the Player on a TV. */
export interface PlayRoute {
  readonly route: Route;
  /**
   * The URLs to send the Player, at the Hub's `host:port` as the TV reaches
   * it, starting the stream that the Route needs, if any, and keeping the
   * Media File's audio and subtitle tracks for the now-playing bar: so it is
   * called only as they are sent.
   */
  readonly sentAt: (hub: string) => PlaySent;
}

/** A Media File to play, found inside its Media Source. */
export interface FileToPlay {
  readonly source: MediaSource;
  /** Its path inside the Media Source, its names joined by "/". */
  readonly path: string;
  readonly found: MediaFileFound;
}

/** The TV to play on: its address, which its Player connects from, and its name, for messages. */
export interface TvToPlayOn {
  readonly address: string;
  readonly title: string;
  readonly formats: PlayableFormats;
}

export interface PlayRouteOptions {
  /**
   * The subtitle track to burn into the picture, by its place among the
   * Media File's subtitle tracks, as the now-playing bar lists them, if it
   * is one the Hub burns in; none when left out or null (FR-45).
   */
  readonly burnIn?: number | null;
}

/**
 * Probes the Media File with ffprobe now, as before each play, and chooses
 * the cheapest Route that plays it on the TV (FR-41, ADR 0006): Direct Play
 * serves it as it is; Remux, Audio Conversion and Full Conversion stream it
 * as HLS (FR-42), the last two re-encoding the audio streams the TV can't
 * play, and Full Conversion the video too, with the encoder the Hub's
 * streams chose. One ffprobe can't read is tried by Direct Play, which the
 * Player says it can't play if it can't.
 *
 * Whatever the Route, the Player is sent each of the Media File's text
 * subtitle tracks, its own and the sidecar files beside it (FR-44), at a URL
 * of its own, in its own format if the Player renders it, and converted by
 * the Hub to one it does otherwise (FR-45). An image subtitle track the TV
 * can't render, such as PGS, it is sent no URL for: asked to burn one in,
 * the Hub streams the Media File by Full Conversion, whatever Route it
 * would take otherwise, with that track burned into its picture (FR-45).
 *
 * An audio Media File is sent with what its now-playing screen shows
 * (FR-47): its title, artist and album, as its tags say, its file name
 * standing in for a title it hasn't got, and the URL of its cover art, if
 * it has any embedded.
 */
export const choosePlayRoute = async (
  dependencies: PlayRouteDependencies,
  file: FileToPlay,
  tv: TvToPlayOn,
  { burnIn = null }: PlayRouteOptions = {},
): Promise<PlayRoute> => {
  const { probeMedia, streams, sentTracks } = dependencies;
  const { source, path, found } = file;
  const { address, title, formats } = tv;
  let probe: MediaProbe | null;
  try {
    probe = await probeMedia(found.path);
  } catch (error) {
    console.error(`Couldn't run ffprobe on "${found.name}"`, error instanceof Error ? error.message : error);
    throw new PlayRouteRefusal(503, `The Hub couldn't read "${found.name}" with ffprobe. Try again.`);
  }
  const subtitles = subtitlesOf(probe, await sidecarSubtitlesOf(source, path.split("/")), formats);
  const burned = burnIn === null ? undefined : subtitles[burnIn];
  const burnSubtitle = burned?.track.burnedIn === true && "stream" in burned.source ? burned.source.stream : null;
  const route =
    probe === null ? null : chooseRoute(probe, formats, burnSubtitle === null ? {} : { subtitle: burnSubtitle });
  const tracks = {
    audioTracks: probe === null ? [] : audioTracksOf(probe),
    subtitleTracks: subtitles.map(({ track }) => track),
  };
  const video = probe?.streams.some(({ type, attachedPicture }) => type === "video" && !attachedPicture) ?? false;
  // One ffprobe can't read is taken for what its name says it is.
  const music: MusicDetails | null = (
    probe === null ? found.kind === "audio" : !video && probe.streams.some(({ type }) => type === "audio")
  )
    ? {
        title: probe?.tags.title ?? found.name,
        artist: probe?.tags.artist ?? null,
        album: probe?.tags.album ?? null,
        coverArt: coverArtOf(probe) === undefined ? null : mediaCoverArtPath(source.id, path),
      }
    : null;
  const sent = (hub: string, url: string, sentBy: Route): PlaySent => {
    sentTracks.sent(address, url, {
      ...tracks,
      route: sentBy,
      burnedIn: sentBy === "full-conversion" && burnSubtitle !== null ? burnIn : null,
      hub,
      file: found.path,
      video,
      music,
      again: async (next) =>
        choosePlayRoute(dependencies, { ...file, found: await findMediaFile(source, path.split("/")) }, tv, {
          burnIn: next,
        }),
    });
    return {
      url,
      subtitles: subtitles.map(({ track, source: from }) =>
        track.burnedIn
          ? ""
          : `http://${hub}${mediaSubtitlePath(source.id, path, from, subtitleFormatFor(track.codec, formats.subtitles))}`,
      ),
      ...(music === null
        ? {}
        : { music: { ...music, coverArt: music.coverArt === null ? null : `http://${hub}${music.coverArt}` } }),
    };
  };
  const mediaSourceId = source.id;
  if (probe === null || route === null || route === "direct-play") {
    return {
      route: "direct-play",
      sentAt: (hub) => sent(hub, `http://${hub}${mediaFilePath(mediaSourceId, path)}`, "direct-play"),
    };
  }
  const { duration } = probe;
  if (duration === null) {
    throw new PlayRouteRefusal(
      409,
      `The Hub can't tell how long "${found.name}" is, which it needs to know to stream it to ${title}.`,
    );
  }
  const streamed = {
    mediaSourceId,
    path,
    file: found.path,
    name: found.name,
    probe: { ...probe, duration },
    convertAudio: route === "remux" ? [] : audioToConvert(probe, formats),
    convertVideo: route === "full-conversion",
    burnSubtitle: route === "full-conversion" ? burnSubtitle : null,
  };
  return { route, sentAt: (hub) => sent(hub, `http://${hub}${streams.start(address, streamed)}`, route) };
};
