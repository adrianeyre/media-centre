import { useEffect, useState } from "preact/hooks";

import {
  appliancePreviewPath,
  type Appliance,
  type MusicDetails,
  type NowPlaying,
  type NowShowing,
  type PowerState,
} from "@media-centre/shared";

import { AppIcon } from "./app-icon.tsx";
import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { formatAudioTrack, formatDuration, formatSubtitleTrack } from "./media-format.ts";
import { NOW_PLAYING_REFRESH_MS } from "./tv-now-playing.tsx";

/**
 * How often the Remote asks the Hub again what the Selected TV is showing,
 * which its own remote may have changed. It asks at once when the TV's power
 * state changes.
 */
export const NOW_SHOWING_REFRESH_MS = 3_000;

export interface TvNowShowingProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV. */
  readonly tv: Appliance;
  /** It as the Remote names it, "Room · Name" (FR-9). */
  readonly title: string;
  /** Its power state, as the TV tab last read it, or undefined before the first read. */
  readonly power: PowerState | undefined;
  /** {@link NOW_SHOWING_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  /** How often what the Player in front plays is read again: `NOW_PLAYING_REFRESH_MS` but in tests. */
  readonly playbackRefreshMs?: number;
}

const NOT_KNOWN: Readonly<Record<Extract<NowShowing, { known: false }>["why"], (title: string) => string>> = {
  standby: (title) => `${title} is in standby.`,
  unreachable: (title) => `${title} isn't answering, so what it is showing can't be told.`,
  "cannot-tell": (title) => `Can't tell what ${title} is showing: none of its apps says it is in front.`,
};

/**
 * The Selected TV's Now Showing card (FR-26): the app in front, by name and
 * icon, as the TV itself says, read again every few seconds so that it
 * follows the TV's own remote. When the TV can't say, or is in standby or not
 * answering, the card says so rather than guessing (FR-25), and when the Hub
 * can't be asked, it shows no app at all rather than the one it last read.
 * When the app in front is the Player, it says what that plays too (FR-27).
 * Reading it changes nothing on the TV.
 */
export const TvNowShowing = ({
  appliances,
  tv,
  title,
  power,
  refreshMs = NOW_SHOWING_REFRESH_MS,
  playbackRefreshMs = NOW_PLAYING_REFRESH_MS,
}: TvNowShowingProps) => {
  const [read, setRead] = useState<NowShowing | undefined>(undefined);
  /** Why it couldn't be read, until it next is. */
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Counts every reading begun, so that one answered late is never shown after a later one. */
    let readings = 0;

    const readNowShowing = async (): Promise<void> => {
      readings += 1;
      const reading = readings;
      try {
        const nowShowing = await appliances.readNowShowing(tv.id);
        if (!current || reading !== readings) return;
        setRead(nowShowing);
        setProblem(undefined);
      } catch (error) {
        if (!current || reading !== readings) return;
        setRead(undefined);
        setProblem(messageFor(error));
      }
    };

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await readNowShowing();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [appliances, tv.id, refreshMs, power]);

  return (
    <section class="tv-now-showing" aria-labelledby="tv-now-showing-heading">
      <h2 id="tv-now-showing-heading">Now Showing</h2>
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="now-showing" role="status">
        {read === undefined ? (
          problem === undefined && <p class="now-showing-note">Checking what {title} is showing…</p>
        ) : read.known ? (
          <p class="now-showing-app">
            <AppIcon key={read.app.id} applianceId={tv.id} app={read.app} />
            <span class="app-name">{read.app.name}</span>
          </p>
        ) : (
          <p class="now-showing-note">{NOT_KNOWN[read.why](title)}</p>
        )}
      </div>
      {read?.known === true && read.nowPlaying !== undefined && (
        <NowShowingPlayer appliances={appliances} tv={tv} nowPlaying={read.nowPlaying} refreshMs={playbackRefreshMs} />
      )}
    </section>
  );
};

interface NowShowingPlayerProps {
  readonly appliances: AppliancesApi;
  readonly tv: Appliance;
  /** What the Player plays, as Now Showing last said, or null for nothing. */
  readonly nowPlaying: NowPlaying | null;
  readonly refreshMs: number;
}

const STATE_NAMES: Readonly<Record<NowPlaying["state"], string>> = {
  loading: "Loading",
  paused: "Paused",
  playing: "Playing",
};

/**
 * What the Player in front plays (FR-27): the Media File's name, its
 * position and duration, the audio and subtitle tracks in use, and, for a
 * video, its preview picture, a frame of the file itself that the Hub
 * extracts, never a capture of the screen; for audio, the cover art
 * embedded in the file, as the Player's now-playing screen shows it, or a
 * placeholder for one with none. It reads what the Player told
 * the Hub every second, as the now-playing bar does, as Now Showing asks
 * the TV itself only every few seconds. It is outside the card's status,
 * so that its position isn't read out each time it moves.
 */
const NowShowingPlayer = ({ appliances, tv, nowPlaying, refreshMs }: NowShowingPlayerProps) => {
  const [playing, setPlaying] = useState(nowPlaying);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      if (document.visibilityState !== "hidden") {
        try {
          const read = await appliances.readPlayback(tv.id);
          if (current) setPlaying(read);
        } catch {
          // Shown as Now Showing last said; the card says when the Hub can't be reached.
        }
      }
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };
    timer = setTimeout(() => void refresh(), refreshMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [appliances, tv.id, refreshMs]);

  if (playing === null) {
    return (
      <div class="now-showing-player">
        <p class="now-showing-note">The Player is waiting for a Media File.</p>
      </div>
    );
  }
  const {
    name,
    state,
    positionMs,
    durationMs,
    audioTracks,
    audioTrack,
    subtitleTracks,
    subtitleTrack,
    preview,
    music,
  } = playing;
  const audio = audioTrack === null ? undefined : audioTracks[audioTrack];
  const subtitles = subtitleTrack === null ? undefined : subtitleTracks[subtitleTrack];
  return (
    <div class="now-showing-player">
      {preview !== null && <PreviewPicture tv={tv} name={name} positionMs={preview.positionMs} />}
      {music !== null && <CoverArt key={music.coverArt} music={music} />}
      <p class="now-showing-media-file">{name}</p>
      <p class="now-showing-position">
        {STATE_NAMES[state]} · {formatDuration(Math.floor(positionMs / 1_000))} of{" "}
        {durationMs === null ? "a length not known yet" : formatDuration(Math.floor(durationMs / 1_000))}
      </p>
      <dl class="now-showing-tracks">
        {audioTracks.length > 0 && (
          <div>
            <dt>Audio</dt>
            <dd>
              {audio === undefined || audioTrack === null ? "Not known yet" : formatAudioTrack(audio, audioTrack)}
            </dd>
          </div>
        )}
        <div>
          <dt>Subtitles</dt>
          <dd>
            {subtitles === undefined || subtitleTrack === null ? "Off" : formatSubtitleTrack(subtitles, subtitleTrack)}
          </dd>
        </div>
      </dl>
    </div>
  );
};

interface PreviewPictureProps {
  readonly tv: Appliance;
  /** The Media File's name. */
  readonly name: string;
  /** Where in it the frame is. */
  readonly positionMs: number;
}

/**
 * The preview picture, from the Hub, asked for again only when it moves, by
 * its position in the query. One that won't load, as for a frame past the
 * Media File's end, isn't shown until it next moves.
 */
const PreviewPicture = ({ tv, name, positionMs }: PreviewPictureProps) => {
  const src = `${appliancePreviewPath(tv.id)}?at=${String(positionMs)}`;
  const [broken, setBroken] = useState<string | undefined>(undefined);
  if (broken === src) return null;
  return (
    <img
      class="now-showing-preview"
      src={src}
      alt={`${name} at ${formatDuration(Math.floor(positionMs / 1_000))}, a frame from the file itself`}
      width={320}
      height={180}
      onError={() => {
        setBroken(src);
      }}
    />
  );
};

/**
 * The cover art of the audio Media File the Player plays, from the Hub, a
 * picture embedded in the file itself (FR-27), or a placeholder for one with
 * none, or whose cover art won't load.
 */
const CoverArt = ({ music: { title, album, coverArt } }: { readonly music: MusicDetails }) => {
  const [broken, setBroken] = useState(false);
  if (coverArt === null || broken) {
    return (
      <div class="now-showing-cover-art now-showing-cover-placeholder" role="img" aria-label="No cover art">
        ♪
      </div>
    );
  }
  return (
    <img
      class="now-showing-cover-art"
      src={coverArt}
      alt={`Cover art of ${album ?? title}`}
      width={180}
      height={180}
      onError={() => {
        setBroken(true);
      }}
    />
  );
};
