import type { AudioTrack, MusicDetails, Route, SubtitleTrack } from "@media-centre/shared";

import type { PlayRoute } from "./play-routes.ts";

/** A Media File's audio and subtitle tracks, as the Hub found them just before sending it the Player. */
export interface MediaTracks {
  readonly audioTracks: readonly AudioTrack[];
  readonly subtitleTracks: readonly SubtitleTrack[];
}

/** A Media File as the Hub sent it the Player: its tracks, its Route, and how to choose its Route again. */
export interface SentMedia extends MediaTracks {
  readonly route: Route;
  /** The one of {@link subtitleTracks} burned into its picture, by its place among them, or null for none (FR-45). */
  readonly burnedIn: number | null;
  /** The Hub's `host:port` as the TV reaches it, which its URLs are at. */
  readonly hub: string;
  /** The Media File's real path, which ffmpeg reads its preview pictures from (FR-27). */
  readonly file: string;
  /** Whether it has video, which Now Showing shows a preview picture of (FR-27), rather than only cover art, or nothing. */
  readonly video: boolean;
  /**
   * For an audio Media File, what its tags say of it, and its cover art, a
   * path at the Hub, for Now Showing (FR-27, FR-47); null for a video.
   */
  readonly music: MusicDetails | null;
  /**
   * Finds the Media File again, and chooses its Route to the same TV anew,
   * burning in the subtitle track at this place among {@link subtitleTracks}
   * if it is one the Hub burns in, and none for null (FR-45).
   */
  readonly again: (burnIn: number | null) => Promise<PlayRoute>;
}

/**
 * The Media File the Hub last sent each TV's Player, with its audio and
 * subtitle tracks, as ffprobe and its folder said just before, for the
 * now-playing bar to list and choose between (FR-36, FR-44), and its Route.
 * They are kept only as long as the Hub runs.
 */
export interface SentTracks {
  /** Keeps the Media File at `url`, as it is sent the Player on the TV at `address`, in place of any it was sent before. */
  readonly sent: (address: string, url: string, media: SentMedia) => void;
  /** The Media File at `url`, if it is the one last sent the Player on the TV at `address`; otherwise null. */
  readonly at: (address: string, url: string | null) => SentMedia | null;
}

export const sentTracks = (): SentTracks => {
  const byAddress = new Map<string, { readonly url: string; readonly media: SentMedia }>();
  return {
    sent: (address, url, media) => {
      byAddress.set(address, { url, media });
    },
    at: (address, url) => {
      const sent = byAddress.get(address);
      return sent !== undefined && sent.url === url ? sent.media : null;
    },
  };
};
