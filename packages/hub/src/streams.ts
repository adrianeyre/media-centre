import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { STREAMS_PATH, streamPlaylistPath, type PlayerPlayback } from "@media-centre/shared";

import type { MediaProbe } from "./ffprobe.ts";
import { refuseMethod, sendError } from "./http.ts";
import type { MediaFileAt } from "./resume-positions.ts";
import { playedStreams } from "./routes.ts";
import { chooseVideoEncoder, type ChooseVideoEncoder, type VideoEncoder } from "./video-encoders.ts";

/**
 * What the Audio Conversion Route re-encodes the audio a TV can't play to:
 * Dolby Digital, which every TV the Hub streams to plays (ADR 0006), and
 * which carries 5.1, as DTS and TrueHD do. ffmpeg mixes anything with more
 * channels, e.g. 7.1, down to 5.1 for it.
 */
export const CONVERTED_AUDIO_CODEC = "ac3";

/** How long each segment of a stream is, in seconds: as long as a seek to a segment not yet produced may have to wait for one to be made. */
export const SEGMENT_SECONDS = 6;

/** How long a request for a segment waits for ffmpeg to produce it: 30 seconds. */
const SEGMENT_TIMEOUT_MS = 30_000;

/** How long a stream outlives its Player disconnecting, for it to connect again and go on: a minute. */
const ABANDONED_MS = 60_000;

/**
 * How many segments beyond what ffmpeg has produced a request may ask for and
 * wait for it to get there, rather than have it start again from that
 * segment: a player reading a little ahead, rather than a seek.
 */
const LOOKAHEAD_SEGMENTS = 3;

/** How often a request for a segment looks for it, while it waits. */
const POLL_MS = 100;

/** How each Hub's folder of segments, in the system's temporary folder, is named: then its process id, and a UUID. */
const FOLDER_PREFIX = "media-centre-streams-";

/** The folders of segments made by this process, which it never takes for left behind. */
const madeHere = new Set<string>();

/** Whether the process with this id is running, as far as this one can tell. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It is running, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Deletes the folders of segments that Hubs no longer running left behind,
 * having been killed or lost power before they could. One with this
 * process's id that it didn't make is another's, which ran before it, as in a
 * container, where each start may be given the same id.
 */
const sweepLeftBehind = async (): Promise<void> => {
  const names = await readdir(tmpdir()).catch(() => []);
  const pattern = new RegExp(`^${FOLDER_PREFIX}([0-9]+)-`);
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(pattern.exec(name)?.[1] ?? Number.NaN);
      if (Number.isNaN(pid) || madeHere.has(name) || (pid !== process.pid && isRunning(pid))) return;
      await rm(join(tmpdir(), name), { recursive: true, force: true });
    }),
  );
};

export interface StreamsOptions {
  /** {@link SEGMENT_SECONDS} but in tests. */
  readonly segmentSeconds?: number;
  /**
   * Has ffmpeg read each Media File at this many times its own speed, 1 for
   * as it plays, rather than as fast as it can: for tests, to seek past
   * what it has produced.
   */
  readonly readRate?: number;
  /** {@link SEGMENT_TIMEOUT_MS} but in tests. */
  readonly segmentTimeoutMs?: number;
  /** {@link ABANDONED_MS} but in tests. */
  readonly abandonedMs?: number;
  /** How the Full Conversion Route's encoder is chosen. By default, as `chooseVideoEncoder` does, which is the only place it is. */
  readonly chooseVideoEncoder?: ChooseVideoEncoder;
}

/** A Media File to stream, found inside its Media Source, and what ffprobe said of it just now. */
export interface StreamedFile extends MediaFileAt {
  /** Its real path, which ffmpeg reads. */
  readonly file: string;
  /** Its file name, for the now-playing bar and the Hub's log. */
  readonly name: string;
  /** With a duration, which the playlist is made from. */
  readonly probe: MediaProbe & { readonly duration: number };
  /**
   * The indexes of its audio streams that ffmpeg re-encodes to
   * {@link CONVERTED_AUDIO_CODEC}, as the TV can't play them, by the Audio
   * Conversion and Full Conversion Routes: none by Remux. Every other audio
   * stream is copied.
   */
  readonly convertAudio: readonly number[];
  /**
   * Whether ffmpeg re-encodes its video, with the Hub's {@link VideoEncoder},
   * as the TV can't play it, by the Full Conversion Route. Otherwise it is
   * copied.
   */
  readonly convertVideo: boolean;
  /**
   * The index of its image subtitle stream, e.g. PGS or VobSub, that ffmpeg
   * burns into the video it re-encodes, as the TV can't render it (FR-45),
   * or null for none. Only Full Conversion re-encodes the video, so only it
   * burns one in.
   */
  readonly burnSubtitle: number | null;
}

/**
 * The Media Files the Hub streams to Players as HLS (FR-42, ADR 0006), by
 * the Remux, Audio Conversion and Full Conversion Routes: ffmpeg copies the
 * streams of the Media File into MPEG-TS segments, which the Player asks for
 * one by one, re-encoding the audio streams that the TV can't play, and only
 * those, by Audio Conversion, and the video too by Full Conversion. Every
 * audio stream is in each segment, so that the Player can switch between
 * them (FR-36).
 */
export interface Streams {
  /**
   * Streams the Media File to the Player on the TV at `address`, ending any
   * stream that TV had, and returns the path of its playlist (see
   * `streamPlaylistPath` in `shared`). ffmpeg starts once the Player asks for
   * a segment.
   */
  readonly start: (address: string, file: StreamedFile) => string;
  /** The Media File streamed at this URL, as the Hub sent it a Player, or null if it isn't one of its streams. */
  readonly mediaFileAt: (url: string | null) => (MediaFileAt & { readonly name: string }) | null;
  /**
   * Hears what the Player on the TV at `address` says of its playback. Once it
   * has played its stream, the stream ends when it plays nothing, or plays
   * something else, as when it was stopped.
   */
  readonly heard: (address: string, playback: PlayerPlayback) => void;
  /**
   * Stops ffmpeg for the TV at `address`, whose Player has disconnected from
   * the Hub, and ends its stream unless the Player says it is playing it
   * again within a minute, having connected again. A segment it asks for
   * meanwhile is produced as one asked for after a seek is.
   */
  readonly playerGone: (address: string) => void;
  /** Serves a stream's playlist or segments, or returns false for any other path. */
  readonly handle: (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<boolean>;
  /** The process ids of the ffmpegs running now. */
  readonly running: () => readonly number[];
  /** Ends every stream, and resolves once their ffmpegs have stopped and their segments are deleted. */
  readonly close: () => Promise<void>;
}

/** One ffmpeg, producing a stream's segments from `first` on. */
interface Run {
  readonly first: number;
  readonly child: ChildProcess;
  /** The file ffmpeg lists each segment in once it has finished it. */
  readonly list: string;
  /** The highest segment it has finished, or `first - 1` before it has finished any. */
  produced: number;
  exited: boolean;
  /** Whether the Hub stopped it, rather than it finishing or failing. */
  stopped: boolean;
  /** What ffmpeg last said, for the log when it fails. */
  readonly said: string[];
  readonly gone: Promise<void>;
}

interface Stream {
  readonly id: string;
  readonly address: string;
  readonly file: StreamedFile;
  /** How many segments it has, all {@link StreamsOptions.segmentSeconds} long but the last. */
  readonly count: number;
  readonly dir: Promise<string>;
  /** The file of each segment ffmpeg has finished, by its number. */
  readonly finished: Map<number, string>;
  run: Run | undefined;
  runs: number;
  /** Whether the Player has said it plays it. */
  taken: boolean;
  ended: boolean;
  abandoned: ReturnType<typeof setTimeout> | undefined;
}

/** Why a segment couldn't be served, written for the log. */
class SegmentFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SegmentFailure";
    this.status = status;
  }
}

const STREAM_PATH = new RegExp(`^${STREAMS_PATH}/([0-9a-f-]{36})/(?:index\\.m3u8|([0-9]{1,9})\\.ts)$`);

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * How many segments a Media File of `duration` seconds has: a few seconds'
 * remainder at the end goes in the last, so that there is never one too
 * short for ffmpeg to have anything to put in it.
 */
const segmentsIn = (duration: number, segmentSeconds: number): number =>
  Math.max(1, Math.ceil((duration - 0.5) / segmentSeconds));

/**
 * The stream's VOD playlist: all of the Media File, so that the Player can
 * seek anywhere in it, each segment by its number, which ffmpeg makes from
 * that many segments' length into the Media File.
 */
const playlistOf = (stream: Stream, segmentSeconds: number): string => {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${String(Math.ceil(Math.max(segmentSeconds, stream.file.probe.duration - (stream.count - 1) * segmentSeconds)))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (let segment = 0; segment < stream.count; segment += 1) {
    const length = segment < stream.count - 1 ? segmentSeconds : stream.file.probe.duration - segment * segmentSeconds;
    lines.push(`#EXTINF:${length.toFixed(3)},`, `${String(segment)}.ts`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
};

/** How an ffmpeg streams a Media File, as {@link ffmpegPlan} plans it. */
interface FfmpegPlan {
  /** Its options for reading the Media File, from where it starts. */
  readonly input: readonly string[];
  /** Its options for the streams it makes of it: what it maps, and how it encodes each. */
  readonly output: readonly string[];
  /**
   * Its options for making only the stream its segments are cut by, and only
   * its first packet: the video, or with none, the first audio stream, as
   * ffmpeg's segment muxer chooses.
   */
  readonly reference: readonly string[];
  /** The time of each cut between its segments, in the Media File's own timestamps, in seconds. */
  readonly cuts: readonly string[];
}

/**
 * How ffmpeg streams the Media File from segment `first` on: copying its
 * video and every audio stream but those it is to convert, which it
 * re-encodes. It starts at the keyframe before that segment, so the first
 * segment it makes begins with a picture the TV can show at once, and keeps
 * the file's own timestamps, so that segments from one ffmpeg follow on from
 * those of another.
 *
 * Given an `encoder`, it re-encodes the video with it, starting at exactly
 * the segment's time, and has it make a keyframe at every cut, so that each
 * segment begins with one. The audio it copies then starts there too, not
 * wherever the Media File's container puts the packets before it. Any image
 * subtitle stream to burn in is laid over the video first, scaled to its
 * size, as a 1080p PGS is over a film re-encoded to 720p. A subtitle already
 * showing where ffmpeg starts, after a seek, is before what it reads, so
 * shows only from the next.
 */
const ffmpegPlan = (
  stream: Stream,
  first: number,
  segmentSeconds: number,
  encoder: VideoEncoder | undefined,
): FfmpegPlan => {
  const { probe } = stream.file;
  const { video, audio } = playedStreams(probe);
  const burn = encoder === undefined || video === undefined ? null : stream.file.burnSubtitle;
  const filter = encoder?.filter ?? "";
  const cuts: string[] = [];
  for (let segment = first + 1; segment < stream.count; segment += 1) {
    cuts.push((probe.startTime + segment * segmentSeconds).toFixed(3));
  }
  const output = (audioStreams: typeof audio): string[] => [
    ...(video === undefined
      ? []
      : burn === null
        ? ["-map", `0:${String(video.index)}`]
        : [
            "-filter_complex",
            `[0:${String(burn)}][0:${String(video.index)}]scale2ref[subtitles][video];` +
              `[video][subtitles]overlay=eof_action=pass${filter === "" ? "" : `,${filter}`}[burned]`,
            "-map",
            "[burned]",
          ]),
    ...audioStreams.flatMap(({ index }) => ["-map", `0:${String(index)}`]),
    "-c",
    "copy",
    ...(encoder === undefined
      ? []
      : [
          ...(burn !== null || filter === "" ? [] : ["-vf", filter]),
          ...encoder.outputArguments,
          ...(cuts.length === 0 ? [] : ["-force_key_frames", cuts.join(",")]),
          "-copypriorss",
          "0",
        ]),
    // By its place among the audio streams mapped, which are in the file's order.
    ...audioStreams.flatMap(({ index }, place) =>
      stream.file.convertAudio.includes(index) ? [`-c:a:${String(place)}`, CONVERTED_AUDIO_CODEC] : [],
    ),
    "-copyts",
  ];
  return {
    input: [
      ...(first > 0 ? ["-ss", (first * segmentSeconds).toFixed(3)] : []),
      ...(encoder?.inputArguments ?? []),
      "-i",
      stream.file.file,
    ],
    output: output(audio),
    reference: [
      ...output(video === undefined ? audio.slice(0, 1) : []),
      ...(video === undefined ? ["-frames:a", "1"] : ["-frames:v", "1"]),
    ],
    cuts,
  };
};

/** Microseconds as ffmpeg takes a duration, in seconds. */
const seconds = (microseconds: number): string => (microseconds / 1_000_000).toFixed(6);

/**
 * The timestamp of the first packet of the stream ffmpeg's segments are cut
 * by, as it will make it by `plan`, in microseconds: the keyframe a copied
 * video starts at, before the segment's time, or the first picture
 * re-encoded video does. ffmpeg itself says, making that packet alone, as
 * the keyframe a seek lands on is the container's to say, and the time base
 * of an encoder's packets the encoder's. Rounded up, so that a cut measured
 * from it is never later than a picture at exactly its time. Null if ffmpeg
 * can't say.
 */
const firstTimestamp = (plan: FfmpegPlan, timeoutMs: number): Promise<number | null> =>
  new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-v", "error", ...plan.input, ...plan.reference, "-f", "framecrc", "-"],
      { timeout: timeoutMs },
      (error, stdout) => {
        // Its time base, e.g. `#tb 0: 1/1000`, then its packets, each `0, dts, pts, ...`.
        const base = /^#tb 0: ([0-9]+)\/([0-9]+)$/m.exec(stdout);
        const pts = /^0,\s*-?[0-9]+,\s*(-?[0-9]+),/m.exec(stdout)?.[1];
        if (error !== null || base === null || pts === undefined) {
          resolve(null);
          return;
        }
        const at = (Number(pts) * Number(base[1]) * 1_000_000) / Number(base[2]);
        // ffmpeg's for no timestamp at all.
        resolve(Number(pts) === -(2 ** 63) || !Number.isFinite(at) ? null : Math.ceil(at));
      },
    );
  });

/**
 * ffmpeg's arguments to stream the Media File by `plan` as MPEG-TS segments,
 * numbered from `first`, cutting each at exactly its time, keyframe or not,
 * so that segment n is always the n-th stretch of the playlist.
 *
 * ffmpeg's segment muxer takes the times of its cuts as from the first
 * packet it cuts by from version 6.0 on, but as timestamps before, so ffmpeg
 * shifts the timestamps it gives the muxer for that packet's to be 0, given
 * where it is, `start`, where both read the same, and shifts them back in
 * each segment. Without `start`, the cuts are timestamps, as before 6.0.
 */
const ffmpegArguments = (
  plan: FfmpegPlan,
  first: number,
  start: number | null,
  { dir, list, prefix }: { readonly dir: string; readonly list: string; readonly prefix: string },
  readRate: number | undefined,
): string[] => {
  const cuts = plan.cuts.map((cut) => (start === null ? cut : seconds(Math.round(Number(cut) * 1_000_000) - start)));
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    ...(readRate === undefined ? [] : ["-readrate", String(readRate)]),
    ...plan.input,
    ...plan.output,
    "-avoid_negative_ts",
    "disabled",
    ...(start === null ? [] : ["-output_ts_offset", seconds(-start)]),
    "-f",
    "segment",
    "-segment_format",
    "mpegts",
    // Nor for each segment's own MPEG-TS, which would otherwise shift the
    // first segment's timestamps by as long as the video's B-frames hold its
    // first picture back, which no segment from a seek is.
    "-segment_format_options",
    `avoid_negative_ts=disabled${start === null ? "" : `:output_ts_offset=${seconds(start)}`}`,
    ...(cuts.length === 0 ? [] : ["-segment_times", cuts.join(",")]),
    "-break_non_keyframes",
    "1",
    "-segment_start_number",
    String(first),
    "-segment_list",
    list,
    "-segment_list_type",
    "flat",
    join(dir, `${prefix}%d.ts`),
  ];
};

/**
 * The Hub's {@link Streams}. Each stream's segments are kept in a folder of
 * its own, in a folder of the Hub's own in the system's temporary folder,
 * and deleted with it. Before its first, the Hub deletes any folders of
 * segments left behind by Hubs no longer running.
 */
export const hlsStreams = ({
  segmentSeconds = SEGMENT_SECONDS,
  readRate,
  segmentTimeoutMs = SEGMENT_TIMEOUT_MS,
  abandonedMs = ABANDONED_MS,
  chooseVideoEncoder: chooseEncoder = chooseVideoEncoder,
}: StreamsOptions = {}): Streams => {
  const streams = new Map<string, Stream>();
  const byAddress = new Map<string, Stream>();
  const children = new Set<ChildProcess>();
  let base: Promise<string> | undefined;
  const baseDir = (): Promise<string> => {
    if (base === undefined) {
      // Known to be this process's before it exists, so that no other sweep takes it for left behind.
      const name = `${FOLDER_PREFIX}${String(process.pid)}-${randomUUID()}`;
      madeHere.add(name);
      base = sweepLeftBehind().then(async () => {
        const dir = join(tmpdir(), name);
        await mkdir(dir, { recursive: true });
        return dir;
      });
    }
    return base;
  };
  let chosenEncoder: Promise<VideoEncoder> | undefined;
  /** The encoder for Full Conversion, chosen once, before the Hub's first. */
  const videoEncoder = (): Promise<VideoEncoder> => {
    chosenEncoder ??= chooseEncoder().then((encoder) => {
      console.log(`Full Conversion re-encodes video in ${encoder.name}`);
      return encoder;
    });
    return chosenEncoder;
  };

  const streamAt = (url: string | null): Stream | undefined => {
    if (url === null) return undefined;
    try {
      const id = STREAM_PATH.exec(new URL(url).pathname)?.[1];
      return id === undefined ? undefined : streams.get(id);
    } catch {
      return undefined;
    }
  };

  /** Takes in the segments the stream's ffmpeg has finished since it was last asked. */
  const refresh = async (stream: Stream, run: Run): Promise<void> => {
    const listed = await readFile(run.list, "utf8").catch(() => "");
    const dir = await stream.dir;
    for (const name of listed.split("\n")) {
      const segment = /-([0-9]+)\.ts$/.exec(name)?.[1];
      if (segment === undefined) continue;
      const number = Number(segment);
      if (!stream.finished.has(number)) stream.finished.set(number, join(dir, name));
      run.produced = Math.max(run.produced, number);
    }
  };

  /** Stops the ffmpeg at once, not letting it finish the segment it is on, which would be cut short. */
  const stopRun = (run: Run): void => {
    if (run.exited) return;
    run.stopped = true;
    run.child.kill("SIGKILL");
  };

  /** Starts ffmpeg producing the stream's segments from `first`, in place of any producing it now. */
  const restart = async (stream: Stream, first: number): Promise<void> => {
    if (stream.run !== undefined) {
      await refresh(stream, stream.run);
      stopRun(stream.run);
    }
    const encoder = stream.file.convertVideo ? await videoEncoder() : undefined;
    const plan = ffmpegPlan(stream, first, segmentSeconds, encoder);
    const start = await firstTimestamp(plan, segmentTimeoutMs);
    const dir = await stream.dir;
    await mkdir(dir, { recursive: true });
    // Ended while it waited, so it mustn't leave an ffmpeg running.
    if (stream.ended) return;
    // Another request may have started one meanwhile, which this replaces.
    if (stream.run !== undefined) stopRun(stream.run);
    stream.runs += 1;
    const prefix = `run${String(stream.runs)}-`;
    const list = join(dir, `run${String(stream.runs)}.list`);
    const child = spawn("ffmpeg", ffmpegArguments(plan, first, start, { dir, list, prefix }, readRate), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(child);
    const said: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      said.push(...text.split("\n").filter((line) => line.trim() !== ""));
      said.splice(0, Math.max(0, said.length - 10));
    });
    const run: Run = {
      first,
      child,
      list,
      produced: first - 1,
      exited: false,
      stopped: false,
      said,
      gone: once(child, "close").then(
        () => undefined,
        () => undefined,
      ),
    };
    child.on("error", (error) => {
      said.push(error.message);
    });
    void run.gone.then(() => {
      run.exited = true;
      children.delete(child);
      if (!run.stopped && child.exitCode !== 0) {
        const doing = stream.file.convertVideo
          ? "convert"
          : stream.file.convertAudio.length === 0
            ? "remux"
            : "convert the audio of";
        console.error(`ffmpeg couldn't ${doing} "${stream.file.name}": ${said.join(" / ") || "it said nothing"}`);
      }
    });
    stream.run = run;
  };

  /** The file of segment `number`, once ffmpeg has finished it, starting ffmpeg there if it isn't getting there. */
  const segment = async (stream: Stream, number: number, response: ServerResponse): Promise<string> => {
    const deadline = Date.now() + segmentTimeoutMs;
    for (;;) {
      if (stream.ended) throw new SegmentFailure(404, "That stream has ended.");
      const { run } = stream;
      if (run !== undefined) await refresh(stream, run);
      const finished = stream.finished.get(number);
      if (finished !== undefined) return finished;
      if (run?.exited === true && !run.stopped && run.first === number) {
        throw new SegmentFailure(500, `ffmpeg didn't produce segment ${String(number)} of "${stream.file.name}".`);
      }
      if (run === undefined || run.exited || number < run.first || number > run.produced + 1 + LOOKAHEAD_SEGMENTS) {
        await restart(stream, number);
      }
      if (Date.now() >= deadline) {
        throw new SegmentFailure(503, `ffmpeg didn't produce segment ${String(number)} in time.`);
      }
      // A Player that gave up on it, e.g. to seek elsewhere, needn't be waited for.
      if (response.closed) throw new SegmentFailure(499, "The Player stopped waiting.");
      await wait(POLL_MS);
    }
  };

  const end = (stream: Stream): void => {
    if (stream.ended) return;
    stream.ended = true;
    clearTimeout(stream.abandoned);
    streams.delete(stream.id);
    if (byAddress.get(stream.address) === stream) byAddress.delete(stream.address);
    const { run } = stream;
    if (run !== undefined) stopRun(run);
    void (async () => {
      await run?.gone;
      await rm(await stream.dir, { recursive: true, force: true });
    })();
  };

  return {
    start: (address, file) => {
      const previous = byAddress.get(address);
      if (previous !== undefined) end(previous);
      const id = randomUUID();
      const stream: Stream = {
        id,
        address,
        file,
        count: segmentsIn(file.probe.duration, segmentSeconds),
        dir: baseDir().then((dir) => join(dir, id)),
        finished: new Map(),
        run: undefined,
        runs: 0,
        taken: false,
        ended: false,
        abandoned: undefined,
      };
      streams.set(id, stream);
      byAddress.set(address, stream);
      return streamPlaylistPath(id);
    },

    mediaFileAt: (url) => {
      const stream = streamAt(url);
      if (stream === undefined) return null;
      const { mediaSourceId, path, name } = stream.file;
      return { mediaSourceId, path, name };
    },

    heard: (address, playback) => {
      const stream = byAddress.get(address);
      if (stream === undefined) return;
      if (streamAt(playback.url) === stream) {
        stream.taken = true;
        clearTimeout(stream.abandoned);
        stream.abandoned = undefined;
        return;
      }
      // Until the Player says it plays it, what it says is of what it played before.
      if (stream.taken) end(stream);
    },

    playerGone: (address) => {
      const stream = byAddress.get(address);
      if (stream === undefined) return;
      if (stream.run !== undefined) stopRun(stream.run);
      clearTimeout(stream.abandoned);
      stream.abandoned = setTimeout(() => {
        end(stream);
      }, abandonedMs);
      stream.abandoned.unref();
    },

    handle: async (request, response, pathname) => {
      if (!pathname.startsWith(`${STREAMS_PATH}/`)) return false;
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response, ["GET", "HEAD"]);
        return true;
      }
      const match = STREAM_PATH.exec(pathname);
      const stream = match?.[1] === undefined ? undefined : streams.get(match[1]);
      if (match === null || stream === undefined) {
        sendError(response, 404, "That stream has ended.");
        return true;
      }
      const headers = { "cache-control": "no-cache", "x-content-type-options": "nosniff" };

      if (match[2] === undefined) {
        const playlist = playlistOf(stream, segmentSeconds);
        response.writeHead(200, {
          ...headers,
          "content-type": "application/vnd.apple.mpegurl",
          "content-length": Buffer.byteLength(playlist),
        });
        response.end(request.method === "HEAD" ? undefined : playlist);
        return true;
      }

      const number = Number(match[2]);
      if (number >= stream.count) {
        sendError(response, 404, "That stream has no such segment.");
        return true;
      }
      let file: string;
      try {
        file = await segment(stream, number, response);
      } catch (error) {
        if (!(error instanceof SegmentFailure)) throw error;
        if (error.status === 500 || error.status === 503) console.error(error.message);
        if (!response.headersSent && !response.closed) sendError(response, error.status, error.message);
        return true;
      }
      // The stream may have ended since, its segments deleted with it.
      const size = await stat(file).then(
        (stats) => stats.size,
        () => undefined,
      );
      if (size === undefined) {
        sendError(response, 404, "That stream has ended.");
        return true;
      }
      response.writeHead(200, { ...headers, "content-type": "video/mp2t", "content-length": size });
      if (request.method === "HEAD") {
        response.end();
        return true;
      }
      // A Player that seeks elsewhere hangs up mid-segment: no failure of the Hub's.
      await pipeline(createReadStream(file), response).catch(() => undefined);
      return true;
    },

    running: () => [...children].flatMap((child) => (child.pid === undefined ? [] : [child.pid])),

    close: async () => {
      const runs = [...streams.values()].flatMap((stream) => (stream.run === undefined ? [] : [stream.run]));
      for (const stream of [...streams.values()]) end(stream);
      await Promise.all(runs.map((run) => run.gone));
      if (base !== undefined) await rm(await base, { recursive: true, force: true });
    },
  };
};
