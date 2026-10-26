import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { MediaSource } from "@media-centre/shared";

import type { MediaProbe, ProbedStream, ProbeMedia } from "./ffprobe.ts";
import { HttpRefusal, sendError } from "./http.ts";
import { findMediaFile } from "./media-files.ts";

/** Long enough for a large picture in a Media File on a slow network share; ffmpeg reads only that stream. */
const EXTRACT_TIMEOUT_MS = 30_000;

/** How tall cover art is at most, in pixels: as large as the Player's now-playing screen shows it, on a 1080p TV. */
const COVER_ART_HEIGHT = 720;

/**
 * The cover art embedded in a Media File, as ffprobe described it (FR-47):
 * its first picture that goes with the file, rather than video to play, or
 * undefined when it has none.
 */
export const coverArtOf = (probe: MediaProbe | null): ProbedStream | undefined =>
  probe?.streams.find(({ type, attachedPicture }) => type === "video" && attachedPicture);

/**
 * Takes the picture in stream `stream` out of the Media File at `file`, its
 * real path, as a JPEG, rejecting when ffmpeg can't.
 */
export type ExtractCoverArt = (file: string, stream: number) => Promise<Uint8Array>;

/**
 * Asks ffmpeg, which is in the Hub's image (FR-43), for the picture, scaled
 * down to {@link COVER_ART_HEIGHT} at most, as a JPEG, whatever it was in the
 * file, e.g. a PNG in a FLAC.
 */
export const ffmpegCoverArt: ExtractCoverArt = (file, stream) =>
  new Promise((resolve, reject) => {
    // A full path starts with "/", so ffmpeg takes it as neither an option nor a protocol such as "http:".
    execFile(
      "ffmpeg",
      [
        ...["-v", "error", "-nostdin", "-i", file, "-map", `0:${String(stream)}`, "-frames:v", "1"],
        ...["-vf", `scale=-2:'min(${String(COVER_ART_HEIGHT)},ih)'`, "-c:v", "mjpeg", "-q:v", "3"],
        ...["-f", "image2pipe", "-"],
      ],
      { encoding: "buffer", timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null && stdout.length > 0) resolve(new Uint8Array(stdout));
        else reject(new Error(stderr.toString("utf8").trim() || (error?.message ?? "ffmpeg wrote no picture")));
      },
    );
  });

/**
 * Serves the cover art embedded in the Media File `names` lead to inside
 * `source` (see `mediaCoverArtPath` in `shared`), as a JPEG, taken out of
 * the file with ffmpeg as it is asked for: never anything looked up
 * elsewhere. It refuses with `404` a Media File that has none, and as
 * {@link findMediaFile} does, anything that isn't a Media File in the Media
 * Source (FR-5).
 */
export const serveCoverArt = async (
  {
    source,
    names,
    probeMedia,
    extractCoverArt = ffmpegCoverArt,
  }: {
    readonly source: MediaSource;
    readonly names: readonly string[];
    readonly probeMedia: ProbeMedia;
    readonly extractCoverArt?: ExtractCoverArt;
  },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const found = await findMediaFile(source, names);
  const picture = coverArtOf(await probeMedia(found.path));
  if (picture === undefined) throw new HttpRefusal(404, `"${found.name}" has no cover art.`);
  let jpeg: Uint8Array;
  try {
    jpeg = await extractCoverArt(found.path, picture.index);
  } catch (error) {
    console.error(
      `Couldn't take the cover art out of "${found.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    sendError(response, 500, `The Hub couldn't read the cover art of "${found.name}".`);
    return;
  }
  response.writeHead(200, {
    "content-type": "image/jpeg",
    "content-length": jpeg.byteLength,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : jpeg);
};
