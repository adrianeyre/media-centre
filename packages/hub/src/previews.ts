import { execFile } from "node:child_process";
import { basename } from "node:path";

import { PREVIEW_REFRESH_MS, type PlayerPlayback, type PreviewPicture } from "@media-centre/shared";

import type { SentTracks } from "./sent-tracks.ts";

/** Long enough for a frame of a 4K Media File on a slow network share; ffmpeg decodes only from the keyframe before it. */
const EXTRACT_TIMEOUT_MS = 30_000;

/** How tall a preview picture is at most, in pixels: plenty for a card on a phone, and quick to send. */
const PREVIEW_HEIGHT = 360;

/**
 * How far the Player's position may be from where the Hub expects it, from
 * its last report, before the Hub takes it for a seek: more than a report's
 * jitter, less than the now-playing bar's shortest skip.
 */
const SEEK_TOLERANCE_MS = 2_000;

/**
 * Extracts the frame at `positionMs` into the Media File at `file`, its real
 * path, as a JPEG, or resolves null when it has none there, as past its end.
 */
export type ExtractFrame = (file: string, positionMs: number) => Promise<Uint8Array | null>;

/** Asks ffmpeg, which is in the Hub's image (FR-43), for the frame, scaled down to {@link PREVIEW_HEIGHT} at most. */
export const ffmpegFrame: ExtractFrame = (file, positionMs) =>
  new Promise((resolve, reject) => {
    // A full path starts with "/", so ffmpeg takes it as neither an option
    // nor a protocol such as "http:". Seeking before reading it has ffmpeg
    // decode only from the keyframe before the position.
    execFile(
      "ffmpeg",
      [
        ...["-v", "error", "-nostdin", "-ss", (positionMs / 1_000).toFixed(3), "-i", file],
        // Its first video stream, not an attached picture such as cover art.
        ...["-map", "0:V:0", "-frames:v", "1", "-an", "-sn", "-dn"],
        ...["-vf", `scale=-2:'min(${String(PREVIEW_HEIGHT)},ih)'`, "-c:v", "mjpeg", "-q:v", "4"],
        ...["-f", "image2pipe", "-"],
      ],
      { encoding: "buffer", timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout.length === 0 ? null : new Uint8Array(stdout));
        else reject(new Error(stderr.toString("utf8").trim() || error.message));
      },
    );
  });

export interface PreviewsOptions {
  /** {@link PREVIEW_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  /** How a frame is extracted. By default with ffmpeg. */
  readonly extractFrame?: ExtractFrame;
  /** The time, in milliseconds. By default the clock's. */
  readonly now?: () => number;
}

/**
 * The preview picture of what each TV's Player plays (FR-27): a frame of the
 * Media File itself, never a capture of the screen. Where it is follows what
 * the Player reports: at once for a Media File it starts or a seek, and every
 * {@link PREVIEW_REFRESH_MS} while it plays; while it is paused, it holds still.
 * Each frame is extracted only once it is asked for, and only once, so a TV
 * no Remote is looking at costs the Hub nothing, and one paused costs nothing
 * more. They are kept only as long as the Hub runs.
 */
export interface Previews {
  /** Hears what the Player on the TV at `address` says of its playback, moving its preview picture if it is due. */
  readonly heard: (address: string, playback: PlayerPlayback) => void;
  /** The preview picture of the Media File at `url`, if that is what the Player on the TV at `address` plays; otherwise null. */
  readonly at: (address: string, url: string | null) => PreviewPicture | null;
  /** The JPEG of the preview picture of what the Player on the TV at `address` plays, or null when there is none. */
  readonly picture: (address: string) => Promise<Uint8Array | null>;
}

/** One TV's preview picture, and the Player's last report, which the next is expected from. */
interface Preview {
  readonly url: string;
  readonly file: string;
  readonly positionMs: number;
  /** When it moved there. */
  readonly movedAt: number;
  /** The frame, once it was first asked for. */
  frame: Promise<Uint8Array | null> | undefined;
  reported: { readonly positionMs: number; readonly playing: boolean; readonly at: number };
}

export const previewPictures = (
  sentTracks: Pick<SentTracks, "at">,
  { refreshMs = PREVIEW_REFRESH_MS, extractFrame = ffmpegFrame, now = Date.now }: PreviewsOptions = {},
): Previews => {
  const byAddress = new Map<string, Preview>();

  return {
    heard: (address, { state, url, positionMs }) => {
      const sent = state === "idle" ? null : sentTracks.at(address, url);
      if (url === null || sent === null || !sent.video) {
        byAddress.delete(address);
        return;
      }
      const at = now();
      const playing = state === "playing";
      const last = byAddress.get(address);
      const reported = { positionMs, playing, at };
      if (last !== undefined && last.url === url) {
        const expected = last.reported.positionMs + (last.reported.playing ? at - last.reported.at : 0);
        const seeked = Math.abs(positionMs - expected) > SEEK_TOLERANCE_MS;
        const due = playing && at - last.movedAt >= refreshMs && positionMs !== last.positionMs;
        if (!seeked && !due) {
          last.reported = reported;
          return;
        }
      }
      byAddress.set(address, { url, file: sent.file, positionMs, movedAt: at, frame: undefined, reported });
    },

    at: (address, url) => {
      const preview = byAddress.get(address);
      return preview === undefined || preview.url !== url ? null : { positionMs: preview.positionMs };
    },

    picture: async (address) => {
      const preview = byAddress.get(address);
      if (preview === undefined) return null;
      preview.frame ??= extractFrame(preview.file, preview.positionMs).catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        console.error(`Couldn't extract a preview picture from "${basename(preview.file)}": ${why}`);
        return null;
      });
      return preview.frame;
    },
  };
};
