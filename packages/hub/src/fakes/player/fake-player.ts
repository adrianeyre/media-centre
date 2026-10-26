import { get } from "node:http";

import { WebSocket } from "ws";

import {
  PLAYER_SOCKET_PATH,
  type HubToPlayerMessage,
  type MusicDetails,
  type PlayerToHubMessage,
} from "@media-centre/shared";

import { fakePlayback, type FakePlayback } from "@media-centre/player/fake-playback";
import { playbackControlIn, reportPlayback, startingTracksIn } from "@media-centre/player/playback-reports";
import { showSubtitles, type Subtitles } from "@media-centre/player/subtitles";

/**
 * A fake Player for tests (ADR 0004, ADR 0005), which the fake Samsung TV
 * starts when the Player is launched on it: a WebSocket client that connects
 * to the Hub, from the TV's own address as the real Player does, and plays
 * what the Hub sends it through the Player's own fake playback, in real time,
 * from where the Hub says to start, with the audio and subtitle tracks it says.
 * It does what the Hub asks of what it plays, and tells the Hub what its
 * playback is doing, through the Player's own code for that. It has no
 * screens. The real Player is tested on its own, against the same playback.
 *
 * Sent an HLS stream (FR-42), it reads it as AVPlay would, from the TV's own
 * address: the playlist as it loads, failing to load if the Hub doesn't
 * send one, then the segment at its position whenever that moves into
 * another, as it plays or seeks, stopping as AVPlay does with a stream it
 * can't play if the Hub doesn't send it. A seek elsewhere gives up on any
 * segment it was still reading, as AVPlay drops what it was buffering. It
 * never reads a Media File served as it is.
 *
 * It shows the subtitle track the Hub asks for through the Player's own code
 * for that, reading it from the Hub, from the TV's own address, and
 * rendering only SubRip and WebVTT, as the Player does (FR-44, FR-45).
 *
 * Sent an audio Media File, it keeps what the Player's now-playing screen
 * would show of it, as the Hub sent it, and reads its cover art from the
 * Hub, from the TV's own address, as the Player's screen does (FR-47).
 */
export interface FakePlayer {
  /** The Hub's address it connects to, `host:port`, or null when it hasn't been given one. */
  readonly hubAddress: () => string | null;
  /** Whether its WebSocket to the Hub is open now. */
  readonly connected: () => boolean;
  /** The URL of every Media File the Hub sent it, oldest first. */
  readonly received: readonly string[];
  /** Every HLS segment it has read from the Hub, oldest first, but those it gave up on for a seek. */
  readonly segments: readonly FakeSegmentRead[];
  /** What the Player's now-playing screen would show of what it plays, or null for a video or nothing. */
  readonly music: () => FakeMusicShown | null;
  readonly playback: FakePlayback;
  readonly subtitles: Subtitles;
  /** Connects to the Hub at this address, instead of any other, as the Player does when it is launched with it. */
  readonly useHub: (address: string) => void;
  /** Closes its WebSocket, as for good, as the Player closing does. */
  readonly stop: () => void;
}

/** An HLS segment the fake Player asked the Hub for, and what the Hub answered. */
export interface FakeSegmentRead {
  readonly url: string;
  /** The Hub's HTTP status, or 0 for no answer. */
  readonly status: number;
  /** How many bytes it sent. */
  readonly bytes: number;
}

/** What the Player's now-playing screen would show of an audio Media File (FR-47). */
export interface FakeMusicShown extends MusicDetails {
  /** What the Hub answered for its cover art, once it has: its HTTP status, 0 for no answer, and how many bytes it sent. */
  readonly coverArtRead: { readonly status: number; readonly bytes: number } | null;
}

/** What the fake TV says of its fake Player, at `/_fake/player`. */
export interface FakePlayerStatus {
  /** Whether the Player is running on the TV. */
  readonly running: boolean;
  readonly hubAddress: string | null;
  readonly connected: boolean;
  /** The URL of every Media File the Hub sent it, oldest first. */
  readonly received: readonly string[];
  /** Every HLS segment it has read from the Hub, oldest first, but those it gave up on for a seek. */
  readonly segments: readonly FakeSegmentRead[];
  /** What its playback is doing now: `idle` while it is not running. */
  readonly playback: ReturnType<FakePlayback["state"]>;
  /** How far into what it plays it is, in milliseconds: 0 while it plays nothing. */
  readonly positionMs: number;
  /** The audio track it plays, by its place among the Media File's, or null while it plays nothing. */
  readonly audioTrack: number | null;
  /** The subtitle track it shows, by its place among those the Hub sent it, or null for none. */
  readonly subtitleTrack: number | null;
  /** The text of the subtitle it shows now, at its position, or null for none. */
  readonly subtitle: string | null;
  /** What the Player's now-playing screen would show of the audio Media File it plays, or null for a video or nothing (FR-47). */
  readonly music: FakeMusicShown | null;
}

/** How long the fake Player waits before opening its socket again once it couldn't, or it dropped. */
const RETRY_MS = 500;

/** How often its playback moves on as it plays, and so how often it may report its position. */
const TICK_MS = 250;

export interface FakePlayerOptions {
  /** The TV's address, which it connects to the Hub from. */
  readonly host: string;
  /** The Hub's `host:port`, as it was launched with or remembers, or null for none. */
  readonly hubAddress: string | null;
}

/** One segment of an HLS playlist: its URL, and where it starts and ends, in milliseconds. */
interface Segment {
  readonly url: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** The segments of an HLS media playlist, at `url`, as its `#EXTINF` lines say. */
const segmentsIn = (playlist: string, url: string): Segment[] => {
  const segments: Segment[] = [];
  let length: number | undefined;
  let at = 0;
  for (const line of playlist.split("\n").map((each) => each.trim())) {
    const extinf = /^#EXTINF:([0-9.]+)/.exec(line)?.[1];
    if (extinf !== undefined) length = Number(extinf) * 1_000;
    else if (line !== "" && !line.startsWith("#") && length !== undefined) {
      segments.push({ url: new URL(line, url).href, startMs: at, endMs: at + length });
      at += length;
      length = undefined;
    }
  }
  return segments;
};

/** Whether a URL the Hub sent is an HLS stream's playlist, rather than a Media File served as it is. */
const isPlaylist = (url: string): boolean => {
  try {
    return new URL(url).pathname.endsWith(".m3u8");
  } catch {
    return false;
  }
};

/** Starts a fake Player, which connects to the Hub at once if it has an address, and again whenever it drops. */
export const startFakePlayer = ({ host, hubAddress: launchedWith }: FakePlayerOptions): FakePlayer => {
  const playback = fakePlayback({ tickMs: TICK_MS });
  const received: string[] = [];
  const segmentsRead: FakeSegmentRead[] = [];
  /** The stream it plays, if it plays one: its segments, the one it read last, and the reads not yet done. */
  let stream:
    | { readonly segments: readonly Segment[]; reading: Segment | undefined; readonly unread: Set<AbortController> }
    | undefined;
  /** Gives up on every segment of the stream it is still reading. */
  const giveUp = (): void => {
    for (const read of stream?.unread ?? []) read.abort();
  };
  /** Counts loads, so that one replaced by the next leaves no stream behind. */
  let loads = 0;
  /** The audio Media File it was sent last, as its now-playing screen would show it, or null for a video. */
  let music: { details: MusicDetails; coverArtRead: FakeMusicShown["coverArtRead"] } | null = null;

  /**
   * Asks the Hub for `url` from the TV's own address, and resolves with its
   * answer, status 0 if it gave none, or `signal` gave up on it first.
   */
  const fetchFromHub = (
    url: string,
    signal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly body: Buffer }> =>
    new Promise((resolve) => {
      const failed = (): void => {
        resolve({ status: 0, body: Buffer.alloc(0) });
      };
      const request = get(url, { localAddress: host, ...(signal === undefined ? {} : { signal }) }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        response.on("error", failed);
      });
      request.on("error", failed);
    });

  /**
   * Reads the segment at the position, as AVPlay does once it plays or seeks
   * into it, unless it read it last; giving up on the one it was reading, if
   * it still is, unless this follows on from it.
   */
  const readSegmentAt = (positionMs: number): void => {
    const playing = stream;
    const segment = playing?.segments.find(({ startMs, endMs }) => positionMs >= startMs && positionMs < endMs);
    if (playing === undefined || segment === undefined || segment === playing.reading) return;
    const previous = playing.reading === undefined ? -1 : playing.segments.indexOf(playing.reading);
    if (playing.segments.indexOf(segment) !== previous + 1) giveUp();
    playing.reading = segment;
    const reading = new AbortController();
    playing.unread.add(reading);
    void fetchFromHub(segment.url, reading.signal).then(({ status, body }) => {
      playing.unread.delete(reading);
      if (reading.signal.aborted) return;
      segmentsRead.push({ url: segment.url, status, bytes: body.length });
      if (status !== 200 && stream === playing) {
        playback.fail(`The Hub didn't send a segment of the stream: ${String(status)}`);
      }
    });
  };
  const subtitles = showSubtitles({
    playback,
    fetchText: async (url) => {
      const { status, body } = await fetchFromHub(url);
      if (status !== 200) throw new Error(`The Hub didn't send the subtitles: ${String(status)}`);
      return body.toString("utf8");
    },
    // What it shows is read from `subtitles.text()`, as there is no screen.
    show: () => undefined,
  });
  playback.subscribe((event) => {
    if (event.type === "position") readSegmentAt(event.positionMs);
    else if (event.type === "state" && event.state === "idle") {
      giveUp();
      stream = undefined;
    }
  });

  /** Loads what the Hub sent, reading its playlist first if it is a stream, and fails as AVPlay does if there is none. */
  const load = async (url: string): Promise<void> => {
    loads += 1;
    const loading = loads;
    giveUp();
    stream = undefined;
    if (!isPlaylist(url)) {
      await playback.load(url);
      return;
    }
    const { status, body } = await fetchFromHub(url);
    const segments = status === 200 ? segmentsIn(body.toString("utf8"), url) : [];
    playback.refuse(segments.length === 0 ? `The Hub didn't send the stream's playlist: ${String(status)}` : null);
    try {
      await playback.load(url);
    } finally {
      playback.refuse(null);
    }
    if (loading !== loads) return;
    stream = { segments, reading: undefined, unread: new Set() };
    readSegmentAt(playback.positionMs());
  };
  let hubAddress = launchedWith;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const reports = reportPlayback({
    playback,
    subtitles,
    send: (message: PlayerToHubMessage) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  });

  const drop = (): void => {
    clearTimeout(timer);
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.terminate();
      socket = undefined;
    }
  };

  const connect = (): void => {
    drop();
    if (stopped || hubAddress === null) return;
    const opened = new WebSocket(`ws://${hubAddress}${PLAYER_SOCKET_PATH}`, { localAddress: host });
    socket = opened;
    opened.on("message", (data: Buffer) => {
      let message: HubToPlayerMessage;
      try {
        message = JSON.parse(data.toString("utf8")) as HubToPlayerMessage;
      } catch {
        return;
      }
      if (message.type === "control") {
        const control = playbackControlIn(message.control);
        if (control !== null) void reports.control(control);
        return;
      }
      // `resumable` is for the Player's waiting screen, which the fake Player hasn't got.
      if (message.type !== "play") return;
      received.push(message.url);
      const sent: typeof music = message.music === undefined ? null : { details: message.music, coverArtRead: null };
      music = sent;
      const coverArt = sent?.details.coverArt ?? null;
      if (sent !== null && coverArt !== null) {
        void fetchFromHub(coverArt).then(({ status, body }) => {
          sent.coverArtRead = { status, bytes: body.length };
        });
      }
      reports.playing(message.url, message.subtitles ?? []);
      void load(message.url)
        .then(() => reports.startFrom(message.positionMs, startingTracksIn(message)))
        .then(
          () => {
            playback.play();
          },
          () => undefined,
        );
    });
    opened.on("open", () => {
      reports.report();
    });
    // Each socket that fails closes too, which tries again.
    opened.on("error", () => undefined);
    opened.on("close", () => {
      if (socket !== opened) return;
      socket = undefined;
      timer = setTimeout(connect, RETRY_MS);
    });
  };

  connect();

  return {
    hubAddress: () => hubAddress,
    connected: () => socket?.readyState === WebSocket.OPEN,
    received,
    segments: segmentsRead,
    // Its now-playing screen shows only while it plays, as its waiting screen does otherwise.
    music: () =>
      music === null || playback.state() === "idle" ? null : { ...music.details, coverArtRead: music.coverArtRead },
    playback,
    subtitles,
    useHub: (address) => {
      if (address === hubAddress && socket !== undefined) return;
      hubAddress = address;
      connect();
    },
    stop: () => {
      stopped = true;
      drop();
      playback.stop();
      reports.stop();
      subtitles.stop();
    },
  };
};
