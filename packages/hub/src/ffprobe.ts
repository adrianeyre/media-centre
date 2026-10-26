import { execFile } from "node:child_process";
import { extname } from "node:path";

/** Long enough for a Media File on a slow network share; ffprobe reads only its headers. */
const PROBE_TIMEOUT_MS = 30_000;

/** One stream of a Media File, as ffprobe says. Streams of other kinds, e.g. fonts, are left out. */
export interface ProbedStream {
  /** Its index in the file, which ffmpeg picks it by. */
  readonly index: number;
  readonly type: "video" | "audio" | "subtitle";
  /** Its codec, by ffprobe's name for it, e.g. "h264", "dts" or "hdmv_pgs_subtitle", or "unknown". */
  readonly codec: string;
  /** A picture that goes with the file, e.g. an album's cover art, rather than video to play. */
  readonly attachedPicture: boolean;
  /** Its language, as the file tags it, e.g. "eng", or null when it doesn't, or tags it "und", undetermined. */
  readonly language: string | null;
  /** The name the file gives it, e.g. "Director's commentary", or null for none. */
  readonly title: string | null;
  /** How many channels it has, for audio, or null when ffprobe doesn't say. */
  readonly channels: number | null;
}

/**
 * What a Media File's tags say of it, as music is tagged (FR-47): each null
 * when it doesn't say, or it is blank.
 */
export interface MediaTags {
  readonly title: string | null;
  /** Its artist, or else its album's artist. */
  readonly artist: string | null;
  readonly album: string | null;
}

/** A Media File's tags when it has none, as kept from before the Hub read them. */
export const NO_TAGS: MediaTags = { title: null, artist: null, album: null };

/** What ffprobe says of a Media File: what the Hub chooses its Route by (FR-41), and its duration (FR-33). */
export interface MediaProbe {
  /**
   * Its container, by ffprobe's name for it, e.g. "matroska", "mp4" or
   * "mpegts". Where ffprobe gives one name to several, the file's extension
   * says which: "webm" for a `.webm`, and "mp4" for the whole family of MP4,
   * MOV and M4A, which ffprobe can't tell apart either.
   */
  readonly container: string;
  /** In seconds, or null when ffprobe can't tell. */
  readonly duration: number | null;
  /** When its earliest stream starts, in seconds, which ffmpeg's timestamps count from. */
  readonly startTime: number;
  readonly streams: readonly ProbedStream[];
  /**
   * Its tags: the file's own, or, where the file has none, as an Ogg file
   * tags its audio stream instead, its first audio stream's.
   */
  readonly tags: MediaTags;
}

/**
 * What ffprobe says of a Media File, or null when ffprobe read the file but
 * couldn't make it out, e.g. a damaged one. It rejects when ffprobe couldn't
 * be run at all, or took too long, which may pass, so isn't an answer to keep.
 */
export type ProbeMedia = (file: string) => Promise<MediaProbe | null>;

/** Asks ffprobe, which is in the Hub's image (FR-43). `file` is a full path. */
export const ffprobeMedia: ProbeMedia = (file) =>
  new Promise((resolve, reject) => {
    // A full path starts with "/", so ffprobe takes it as neither an option
    // nor a protocol such as "http:".
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=format_name,duration,start_time:format_tags=title,artist,album_artist,album" +
          ":stream=index,codec_type,codec_name,channels:stream_disposition=attached_pic" +
          ":stream_tags=language,title,artist,album_artist,album",
        "-of",
        "json",
        file,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) {
          resolve(probeIn(stdout, file));
        } else if (typeof error.code === "number" && !error.killed) {
          // ffprobe ran, and said it couldn't read the file.
          resolve(null);
        } else {
          reject(new Error(`ffprobe couldn't run: ${error.message}`, { cause: error }));
        }
      },
    );
  });

/**
 * Tags, as ffprobe gives them: by the name the file gives each, which ffprobe
 * matches whatever its case, e.g. "TITLE" in a FLAC tagged by another tool.
 */
type FfprobeTags = Readonly<Record<string, string | undefined>>;

/** ffprobe's JSON, as far as the Hub reads it. */
interface FfprobeOutput {
  readonly format?: {
    readonly format_name?: string;
    readonly duration?: string;
    readonly start_time?: string;
    readonly tags?: FfprobeTags;
  };
  readonly streams?: readonly {
    readonly index?: number;
    readonly codec_type?: string;
    readonly codec_name?: string;
    readonly channels?: number;
    readonly disposition?: { readonly attached_pic?: number };
    readonly tags?: FfprobeTags;
  }[];
}

const STREAM_TYPES: ReadonlySet<string> = new Set<ProbedStream["type"]>(["video", "audio", "subtitle"]);

/** The {@link MediaProbe} in ffprobe's JSON for `file`, or null when it names no container. */
export const probeIn = (output: string, file: string): MediaProbe | null => {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(output) as FfprobeOutput;
  } catch {
    return null;
  }
  const formats = (parsed.format?.format_name ?? "").split(",").filter((name) => name !== "");
  if (formats.length === 0) return null;
  const streams: ProbedStream[] = (parsed.streams ?? []).flatMap(
    ({ index, codec_type: type, codec_name: codec, channels, disposition, tags }) =>
      typeof index === "number" && type !== undefined && STREAM_TYPES.has(type)
        ? [
            {
              index,
              type: type as ProbedStream["type"],
              codec: codec ?? "unknown",
              attachedPicture: disposition?.attached_pic === 1,
              language: languageIn(tagNamed(tags, "language")),
              title: tagIn(tagNamed(tags, "title")),
              channels: typeof channels === "number" && channels > 0 ? channels : null,
            },
          ]
        : [],
  );
  return {
    container: containerOf(formats, file),
    duration: secondsIn(parsed.format?.duration),
    // It may be a little before 0, as in an MP4 that starts with an edit list.
    startTime: timeIn(parsed.format?.start_time) ?? 0,
    streams,
    tags: tagsIn(parsed.format?.tags, parsed.streams?.find(({ codec_type: type }) => type === "audio")?.tags),
  };
};

/** The tag of this name, lower case, whatever its case in `tags`. */
const tagNamed = (tags: FfprobeTags | undefined, name: string): string | undefined =>
  Object.entries(tags ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

/** The {@link MediaTags} in the file's own tags, or else its audio stream's, when the file has none of them. */
const tagsIn = (own: FfprobeTags | undefined, audio: FfprobeTags | undefined): MediaTags => {
  const read = (tags: FfprobeTags | undefined): MediaTags => ({
    title: tagIn(tagNamed(tags, "title")),
    artist: tagIn(tagNamed(tags, "artist")) ?? tagIn(tagNamed(tags, "album_artist")),
    album: tagIn(tagNamed(tags, "album")),
  });
  const file = read(own);
  return file.title === null && file.artist === null && file.album === null ? read(audio) : file;
};

/** One of a stream's tags, trimmed, or null when it hasn't got it, or it is blank. */
const tagIn = (tag: string | undefined): string | null => {
  const text = (tag ?? "").trim();
  return text === "" ? null : text;
};

/** A stream's language tag, lower case, or null for none, or "und", which says it is undetermined. */
const languageIn = (tag: string | undefined): string | null => {
  const language = tagIn(tag)?.toLowerCase() ?? null;
  return language === "und" ? null : language;
};

/** See {@link MediaProbe.container}. */
const containerOf = (formats: readonly string[], file: string): string => {
  if (formats.includes("mp4")) return "mp4";
  if (formats.includes("matroska")) return extname(file).toLowerCase() === ".webm" ? "webm" : "matroska";
  return formats[0] ?? "";
};

/** One of ffprobe's times, in seconds, which is missing or "N/A" when the file doesn't say. */
const timeIn = (text: string | undefined): number | null => {
  const trimmed = (text ?? "").trim();
  const seconds = Number(trimmed);
  return trimmed !== "" && Number.isFinite(seconds) ? seconds : null;
};

/** A length from ffprobe, in seconds, or null when it doesn't say. */
const secondsIn = (text: string | undefined): number | null => {
  const seconds = timeIn(text);
  return seconds !== null && seconds >= 0 ? seconds : null;
};
