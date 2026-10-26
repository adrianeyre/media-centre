import type { HubToPlayerMessage, MusicDetails, ResumableMediaFile } from "@media-centre/shared";

import { connectToHub, type HubConnection, type HubConnectionState, type OpenSocket } from "./hub-connection.ts";
import { musicIn, nowPlayingScreen } from "./now-playing-screen.ts";
import { playbackOverlay } from "./playback-overlay.ts";
import {
  playbackControlIn,
  POSITION_REPORT_MS,
  reportPlayback,
  startingTracksIn,
} from "./playback/playback-reports.ts";
import type { Playback } from "./playback/playback.ts";
import { showSubtitles } from "./playback/subtitles.ts";
import type { RememberedHub } from "./remembered-hub.ts";
import { remoteKeyControl } from "./remote-keys.ts";
import { waitingScreen } from "./waiting-screen.ts";

export interface PlayerOptions {
  /** Where the Player draws its screens. */
  readonly root: HTMLElement;
  /** The Hub's address the Player was launched with, as `launchedHubAddress` gives it, or null. */
  readonly launchedWith: string | null;
  readonly rememberedHub: RememberedHub;
  readonly openSocket: OpenSocket;
  readonly playback: Playback;
  /** Where the Player draws the subtitles, over the picture. By default, an element of its own after `root`. */
  readonly subtitlesRoot?: HTMLElement;
  /** Where the Player draws its overlay over a video's picture. By default, an element of its own after `root`. */
  readonly overlayRoot?: HTMLElement;
  /** Reads a subtitle track from the Hub. By default, with `fetch`. */
  readonly fetchText?: (url: string) => Promise<string>;
  /** How often, at most, it reports its position as it plays: {@link POSITION_REPORT_MS} but in tests. */
  readonly positionReportMs?: number;
}

export interface Player {
  /** The Player was launched again while running, with the Hub's address as `launchedHubAddress` gives it, or null. */
  readonly launched: (address: string | null) => void;
  /** Closes its connection to the Hub, as for good. */
  readonly stop: () => void;
}

/** The Media File the Hub offers to resume, or null if it offers none, or one the Player doesn't know. */
const resumableIn = (offered: unknown): ResumableMediaFile | null => {
  if (typeof offered !== "object" || offered === null) return null;
  const { mediaSourceId, path, name, positionMs } = offered as Record<string, unknown>;
  if (typeof mediaSourceId !== "number" || typeof path !== "string" || typeof name !== "string") return null;
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs)) return null;
  return { mediaSourceId, path, name, positionMs };
};

/** The subtitle tracks' URLs the Hub sent, but any that aren't its own, or none from a Hub older than the Player. */
const subtitlesIn = (sent: unknown): string[] =>
  Array.isArray(sent) ? sent.map((url) => (typeof url === "string" && /^http:\/\/[^/]/.test(url) ? url : "")) : [];

/** Reads a file from the Hub, rejecting with its status when the Hub refuses it. */
const fetchFromHub = async (url: string): Promise<string> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`The Hub answered ${String(response.status)} for ${url}`);
  return response.text();
};

/** What the waiting screen says when the TV couldn't play what the Hub sent. */
export const COULDNT_PLAY = "The TV couldn't play that Media File.";

/**
 * Starts the Player: it takes the Hub's address from its launch parameters,
 * or else the one it remembers (FR-39), keeps a WebSocket open to the Hub
 * there (ADR 0003), and shows "Waiting for the Remote" whenever it plays
 * nothing. It plays each Media File the Hub sends it, from where the Hub says,
 * in place of anything playing (FR-35, FR-40), and says so on that screen
 * when the TV couldn't. That screen offers to resume the Media File the Hub
 * offers, and asks the Hub for it (FR-39). It does what the Hub asks of what
 * it plays, and what the TV's own remote's media keys and Back ask (FR-36,
 * FR-37), and tells the Hub what its playback is doing. Everything it plays
 * goes through `playback` (ADR 0005). It shows the subtitle track the Hub
 * asks for, reading it from the Hub, over the picture (FR-44), and plays a
 * Media File it is sent with the audio and subtitle tracks the Hub says, as
 * when it is sent again by another Route (FR-45). While it plays an audio
 * Media File, it shows its now-playing screen, with its cover art, tags and
 * progress, as the Hub sent them (FR-47), in place of the waiting screen;
 * while it plays a video, neither, so that the picture shows, but its
 * overlay, over the bottom of the picture, while the video loads or is
 * paused, and for a moment after anything changes it.
 */
export const startPlayer = ({
  root,
  launchedWith,
  rememberedHub,
  openSocket,
  playback,
  subtitlesRoot,
  overlayRoot,
  fetchText = fetchFromHub,
  positionReportMs = POSITION_REPORT_MS,
}: PlayerOptions): Player => {
  const subtitlesShown = subtitlesRoot ?? root.ownerDocument.createElement("div");
  if (subtitlesRoot === undefined) root.after(subtitlesShown);
  subtitlesShown.classList.add("subtitles");
  subtitlesShown.hidden = true;
  const subtitles = showSubtitles({
    playback,
    fetchText,
    show: (text) => {
      subtitlesShown.textContent = text ?? "";
      subtitlesShown.hidden = text === null;
    },
  });
  const screen = waitingScreen(root, ({ mediaSourceId, path }) => {
    connection?.send({ type: "resume", mediaSourceId, path });
  });
  const musicScreen = nowPlayingScreen(root, playback);
  const overlayShown = overlayRoot ?? root.ownerDocument.createElement("div");
  if (overlayRoot === undefined) subtitlesShown.after(overlayShown);
  // The subtitles move up, out of its way, while it shows.
  const overlay = playbackOverlay(overlayShown, playback, (shown) => {
    subtitlesShown.classList.toggle("above-overlay", shown);
  });
  /** What the now-playing screen shows of the Media File sent last, or null for a video. */
  let music: MusicDetails | null = null;
  let hubAddress: string | null = null;
  let state: HubConnectionState | null = null;
  let connection: HubConnection | null = null;
  let problem: string | null = null;
  /** What the Hub last offered to resume, which is offered only while the Player can ask it to. */
  let resumable: ResumableMediaFile | null = null;
  /** Counts the Media Files sent, so that one replaced by the next isn't reported as not playing. */
  let sent = 0;

  const show = (): void => {
    screen.show({ hubAddress, connection: state, problem, resumable: state === "connected" ? resumable : null });
  };

  const reports = reportPlayback({
    playback,
    subtitles,
    send: (message) => {
      connection?.send(message);
    },
    positionReportMs,
  });

  const onMessage = (message: HubToPlayerMessage): void => {
    if (message.type === "control") {
      const control = playbackControlIn(message.control);
      if (control !== null) {
        void reports.control(control);
        overlay.reveal();
      }
      return;
    }
    if (message.type === "resumable") {
      resumable = resumableIn(message.resumable);
      show();
      return;
    }
    // Only the Hub's own URLs, which are plain HTTP on the home network.
    if (message.type !== "play" || !/^http:\/\/[^/]/.test(message.url)) return;
    const { positionMs } = message;
    const tracks = startingTracksIn(message);
    sent += 1;
    const playing = sent;
    problem = null;
    music = musicIn(message.music);
    show();
    onPlayback();
    reports.playing(message.url, subtitlesIn(message.subtitles));
    playback
      .load(message.url)
      .then(async () => {
        if (playing === sent) await reports.startFrom(positionMs, tracks);
      })
      .then(
        () => {
          if (playing === sent) playback.play();
        },
        (error: unknown) => {
          if (playing !== sent) return;
          console.error("The Player couldn't play the Media File it was sent", error);
          problem = COULDNT_PLAY;
          show();
        },
      );
  };

  const useHub = (address: string): void => {
    rememberedHub.remember(address);
    if (address === hubAddress) return;
    connection?.close();
    hubAddress = address;
    connection = connectToHub({
      address,
      openSocket,
      onMessage,
      onState: (next) => {
        state = next;
        show();
        // A Hub that restarted, or this one moved to, hears at once what is playing.
        if (next === "connected") reports.report();
      },
    });
  };

  /** The TV's own remote's keys, which reach the page whatever has focus, as nothing on it takes them. */
  const onKey = (event: KeyboardEvent): void => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Tizen gives a remote's keys by key code, as Samsung documents them
    const control = remoteKeyControl(event.keyCode, playback.state());
    if (control === null) return;
    event.preventDefault();
    void reports.control(control);
    overlay.reveal();
  };
  const keys = root.ownerDocument;
  keys.addEventListener("keydown", onKey);

  /** Whether the waiting screen shows, as it does whenever the Player plays nothing. */
  let waiting: boolean | undefined;
  const onPlayback = (): void => {
    const playing = playback.state() !== "idle";
    // The picture of a video shows through, from behind the page.
    root.hidden = playing && music === null;
    musicScreen.show(playing ? music : null);
    overlay.forVideo(playing && music === null);
    if (waiting === !playing) return;
    waiting = !playing;
    screen.hide(playing);
    // Shown again, its Resume button, if any, has focus again.
    if (!playing) show();
  };
  playback.subscribe((event) => {
    if (event.type === "error") {
      problem = COULDNT_PLAY;
      show();
    }
    onPlayback();
  });
  onPlayback();

  const start = launchedWith ?? rememberedHub.address();
  if (start === null) show();
  else useHub(start);

  return {
    launched: (address) => {
      if (address !== null) useHub(address);
    },
    stop: () => {
      keys.removeEventListener("keydown", onKey);
      musicScreen.stop();
      overlay.stop();
      reports.stop();
      subtitles.stop();
      connection?.close();
      connection = null;
    },
  };
};
