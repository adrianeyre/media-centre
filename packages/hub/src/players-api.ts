import type { IncomingMessage, ServerResponse } from "node:http";

import {
  APPLIANCES_PATH,
  type Appliance,
  type AppliancePlayback,
  type AppliancePlayer,
  type NowPlaying,
  type PlaybackControl,
  type PlayerPlayback,
  type QueueControl,
  type QueueRepeat,
} from "@media-centre/shared";

import { ApplianceRefusal, type ApplianceStore } from "./appliances.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import { REFUSAL_STATUS } from "./media-sources-api.ts";
import { MediaSourceRefusal } from "./media-sources.ts";
import { PlayRouteRefusal, type PlayRoute } from "./play-routes.ts";
import type { Players } from "./players.ts";
import type { Previews } from "./previews.ts";
import type { Queues } from "./queues.ts";
import { formatPosition } from "./resume-positions.ts";
import { ROUTE_NAMES } from "./routes.ts";
import type { SentTracks } from "./sent-tracks.ts";
import type { Streams } from "./streams.ts";

const PLAYER_PATH = new RegExp(`^${APPLIANCES_PATH}/([1-9][0-9]{0,15})/(player|playback|preview|queue)$`);

/** How long the Hub waits for a Player to report its playback once it has sent it a control: 3 seconds. */
export const CONTROL_REPORT_TIMEOUT_MS = 3_000;

export interface PlayersApiDependencies {
  readonly players: Players;
  readonly appliances: ApplianceStore;
  readonly streams: Pick<Streams, "mediaFileAt">;
  readonly sentTracks: Pick<SentTracks, "at">;
  readonly previews: Pick<Previews, "at" | "picture">;
  readonly queues: Pick<Queues, "at" | "end" | "control">;
}

export interface PlayersApiOptions {
  /** {@link CONTROL_REPORT_TIMEOUT_MS} but in tests. */
  readonly controlReportTimeoutMs?: number;
}

/**
 * Answers whether the Player is connected on an Appliance (see
 * `appliancePlayerPath` in `shared`), and what it is playing, and sends it
 * the now-playing bar's controls (see `appliancePlaybackPath`), and serves
 * the preview picture of what it plays (see `appliancePreviewPath`), and
 * changes the Queue it plays (see `applianceQueuePath`), or returns false
 * for any other path. A subtitle track that changes what is burned into the
 * picture is shown by sending the Media File again (FR-45). Stopping ends
 * the Queue it plays, if any (FR-48).
 */
export const handlePlayersRequest = async (
  dependencies: PlayersApiDependencies,
  { controlReportTimeoutMs = CONTROL_REPORT_TIMEOUT_MS }: PlayersApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  const match = PLAYER_PATH.exec(pathname);
  if (match?.[1] === undefined) return false;
  const { players, appliances } = dependencies;
  const methods = match[2] === "playback" ? ["GET", "HEAD", "POST"] : match[2] === "queue" ? ["POST"] : ["GET", "HEAD"];

  if (!methods.includes(request.method ?? "")) {
    refuseMethod(response, methods);
    return true;
  }
  let appliance: Appliance;
  try {
    appliance = appliances.get(Number(match[1]));
  } catch (error) {
    if (error instanceof ApplianceRefusal) throw new HttpRefusal(404, error.message);
    throw error;
  }
  const { address } = appliance;

  if (match[2] === "player") {
    const answer: AppliancePlayer = { connected: players.connectedAt(address) };
    sendJson(response, 200, answer);
    return true;
  }
  if (match[2] === "preview") {
    // Only of what the Player says it plays now, which may have stopped since the last.
    const picture =
      (nowPlaying(dependencies, address)?.preview ?? null) === null
        ? null
        : await dependencies.previews.picture(address);
    if (picture === null)
      throw new HttpRefusal(404, `There is no preview picture of what ${appliances.title(appliance)} is playing.`);
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": picture.byteLength,
      // Each is of where the Player was, which moves on.
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : picture);
    return true;
  }
  if (match[2] === "queue") {
    const control = queueControlIn(await readJson(request));
    await dependencies.queues.control(
      address,
      players.playbackAt(address)?.url ?? null,
      control,
      controlReportTimeoutMs,
    );
  } else if (request.method === "POST") {
    const control = playbackControlIn(await readJson(request));
    const playing = nowPlaying(dependencies, address);
    if (playing === null) throw new HttpRefusal(409, `Nothing is playing on ${appliances.title(appliance)}.`);
    if (control.action === "audio-track" && control.track >= playing.audioTracks.length) {
      throw new HttpRefusal(
        400,
        `"${playing.name}" hasn't got an audio track ${String(control.track + 1)}. Choose one of its own.`,
      );
    }
    if (
      control.action === "subtitle-track" &&
      control.track !== null &&
      control.track >= playing.subtitleTracks.length
    ) {
      throw new HttpRefusal(
        400,
        `"${playing.name}" hasn't got a subtitle track ${String(control.track + 1)}. Choose one of its own, or "Off".`,
      );
    }
    const shown =
      control.action === "subtitle-track" &&
      (await showByRoute(dependencies, appliance, playing.name, control.track, controlReportTimeoutMs));
    if (!shown && !(await players.control(address, control, controlReportTimeoutMs))) {
      throw new HttpRefusal(409, `The Player on ${appliances.title(appliance)} has disconnected from the Hub.`);
    }
    if (control.action === "stop") dependencies.queues.end(address);
  }
  const answer: AppliancePlayback = { nowPlaying: nowPlaying(dependencies, address) };
  sendJson(response, 200, answer);
  return true;
};

/**
 * Shows the subtitle track at `track`, or none for null, of the Media File
 * the Player on the TV plays, `name`, by sending it the Media File again,
 * from where it is, with the audio track it plays, when that changes which
 * subtitle track is burned into its picture, if any (FR-45): by Full
 * Conversion, with one the Hub burns in; or by the Route it takes without,
 * with the text track chosen, if any, for the Player to show itself. It
 * resolves true once the Player has it, or has it already, and false when
 * the Player is to show the track itself, as it is sent the control.
 */
const showByRoute = async (
  { players, appliances, sentTracks }: PlayersApiDependencies,
  appliance: Appliance,
  name: string,
  track: number | null,
  timeoutMs: number,
): Promise<boolean> => {
  const { address } = appliance;
  const playback = players.playbackAt(address);
  const sent = sentTracks.at(address, playback?.url ?? null);
  if (playback === null || sent === null) return false;
  const burnIn = track !== null && sent.subtitleTracks[track]?.burnedIn === true ? track : null;
  if (burnIn === sent.burnedIn) return burnIn !== null;
  const title = appliances.title(appliance);
  let route: PlayRoute;
  try {
    route = await sent.again(burnIn);
  } catch (error) {
    if (error instanceof PlayRouteRefusal) throw new HttpRefusal(error.status, error.message);
    if (error instanceof MediaSourceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    throw error;
  }
  const { positionMs, audioTrack } = playback;
  const play = {
    type: "play",
    ...route.sentAt(sent.hub),
    positionMs,
    ...(audioTrack === null ? {} : { audioTrack }),
    subtitleTrack: burnIn === null ? track : null,
  } as const;
  if (!(await players.playAgain(address, play, timeoutMs))) {
    throw new HttpRefusal(409, `The Player on ${title} has disconnected from the Hub.`);
  }
  const why =
    burnIn === null
      ? "burning no subtitles into the picture"
      : `to burn its subtitle track ${String(burnIn + 1)} into the picture`;
  console.log(
    `Sent "${name}" to the Player on ${title} again from ${formatPosition(positionMs)}, by ${ROUTE_NAMES[route.route]}, ${why}`,
  );
  return true;
};

/**
 * What the Remote's now-playing bar and Now Showing show of what the Player
 * on the TV at `address` last reported, or null when it plays nothing. A
 * stream is named by the Media File streamed. The audio and subtitle tracks,
 * and the Route, are those of the Media File the Hub sent it, and the ones it
 * plays and shows are as it said, if they are among them, or the subtitle
 * track the Hub burned into the picture, if it shows none itself. Its
 * preview picture is where the Hub last moved it, and, for audio, its tags
 * and cover art are as the Hub sent them (FR-27). Its Queue is the one the
 * TV plays, if it is that Queue's current Media File (FR-48).
 */
export const nowPlaying = (
  { players, streams, sentTracks, previews, queues }: PlayersApiDependencies,
  address: string,
): NowPlaying | null => {
  const playback: PlayerPlayback | null = players.playbackAt(address);
  if (playback === null || playback.state === "idle") return null;
  const { state, url, positionMs, durationMs, audioTrack, subtitleTrack = null } = playback;
  const sent = sentTracks.at(address, url);
  const audioTracks = sent?.audioTracks ?? [];
  const subtitleTracks = sent?.subtitleTracks ?? [];
  const shown = subtitleTrack ?? sent?.burnedIn ?? null;
  return {
    name: streams.mediaFileAt(url)?.name ?? mediaFileName(url),
    route: sent?.route ?? null,
    state,
    positionMs,
    durationMs,
    audioTracks,
    audioTrack: audioTrack !== null && audioTrack < audioTracks.length ? audioTrack : null,
    subtitleTracks,
    subtitleTrack: shown !== null && shown < subtitleTracks.length ? shown : null,
    preview: previews.at(address, url),
    music: sent?.music ?? null,
    queue: queues.at(address, url),
  };
};

/** A Media File's file name, from the URL the Hub sent the Player, e.g. a `mediaFilePath`. */
const mediaFileName = (url: string | null): string => {
  if (url === null) return "A Media File";
  try {
    const last = new URL(url).pathname
      .split("/")
      .filter((name) => name !== "")
      .at(-1);
    return last === undefined ? url : decodeURIComponent(last);
  } catch {
    return url;
  }
};

const QUEUE_REPEATS: ReadonlySet<unknown> = new Set<QueueRepeat>(["off", "one", "all"]);

/** The {@link QueueControl} a request asks for, refused with why if it isn't one. */
const queueControlIn = (body: unknown): QueueControl => {
  const action = typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  switch (action) {
    case "next":
    case "previous":
      return { action };
    case "shuffle": {
      const { shuffle } = body as Record<string, unknown>;
      if (typeof shuffle !== "boolean") throw new HttpRefusal(400, "Say whether to shuffle the Queue, true or false.");
      return { action, shuffle };
    }
    case "repeat": {
      const { repeat } = body as Record<string, unknown>;
      if (!QUEUE_REPEATS.has(repeat)) throw new HttpRefusal(400, 'Say how to repeat the Queue: "off", "one" or "all".');
      return { action, repeat: repeat as QueueRepeat };
    }
    default:
      throw new HttpRefusal(400, 'Say what to do to the Queue: "next", "previous", "shuffle" or "repeat".');
  }
};

/** The {@link PlaybackControl} a request asks for, refused with why if it isn't one. */
const playbackControlIn = (body: unknown): PlaybackControl => {
  const action = typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  const number = (key: string): number | undefined => {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  switch (action) {
    case "play":
    case "pause":
    case "stop":
      return { action };
    case "seek": {
      const positionMs = number("positionMs");
      if (positionMs === undefined || positionMs < 0) {
        throw new HttpRefusal(400, "Say where to seek to, in milliseconds from the start.");
      }
      return { action, positionMs };
    }
    case "skip": {
      const byMs = number("byMs");
      if (byMs === undefined) throw new HttpRefusal(400, "Say how far to skip, in milliseconds, back when negative.");
      return { action, byMs };
    }
    case "audio-track": {
      const track = number("track");
      if (track === undefined || !Number.isSafeInteger(track) || track < 0) {
        throw new HttpRefusal(400, "Say which audio track to play, by its place among the Media File's, from 0.");
      }
      return { action, track };
    }
    case "subtitle-track": {
      const track = (body as Record<string, unknown>).track;
      if (track === null) return { action, track };
      if (typeof track !== "number" || !Number.isSafeInteger(track) || track < 0) {
        throw new HttpRefusal(
          400,
          "Say which subtitle track to show, by its place among the Media File's, from 0, or null for none.",
        );
      }
      return { action, track };
    }
    default:
      throw new HttpRefusal(
        400,
        'Say what to do: "play", "pause", "seek", "skip", "stop", "audio-track" or "subtitle-track".',
      );
  }
};
