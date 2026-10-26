import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

import {
  MEDIA_SUBTITLE_KEYS,
  type MediaSource,
  type SubtitleFormat,
  type SubtitleSource,
  type SubtitleTrack,
} from "@media-centre/shared";

import type { PlayableFormats } from "./drivers/driver.ts";
import type { MediaProbe, ProbeMedia } from "./ffprobe.ts";
import { HttpRefusal, sendError } from "./http.ts";
import { findMediaFile } from "./media-files.ts";
import { isHidden, mediaKindOf, resolveInMediaSource } from "./media-folders.ts";
import { MediaSourceRefusal } from "./media-sources.ts";
import { burnsIn } from "./routes.ts";

/**
 * Subtitle formats that are text, by ffmpeg's names for them, which ffmpeg
 * converts to SubRip or WebVTT. Image subtitles, such as PGS, are pictures,
 * which ffmpeg can't, so the Hub burns them into the picture instead (FR-45).
 */
const TEXT_SUBTITLES: ReadonlySet<string> = new Set([
  "ass",
  "jacosub",
  "microdvd",
  "mov_text",
  "mpl2",
  "pjs",
  "realtext",
  "sami",
  "ssa",
  "stl",
  "subrip",
  "subviewer",
  "subviewer1",
  "text",
  "vplayer",
  "webvtt",
]);

/** Sidecar subtitle files, by their extension, lower case, and the format of each, by ffmpeg's name for it (FR-44). */
const SIDECAR_FORMATS: ReadonlyMap<string, string> = new Map([
  [".srt", "subrip"],
  [".vtt", "webvtt"],
  [".ass", "ass"],
]);

/** The formats the Hub serves subtitles in, as `mediaSubtitlePath` in `shared` has them. */
const SUBTITLE_FORMATS: ReadonlyMap<string, SubtitleFormat> = new Map([
  ["subrip", "subrip"],
  ["webvtt", "webvtt"],
]);

/** Each {@link SubtitleFormat} as ffmpeg writes it, and as the Hub serves it. */
const SERVED_AS: Readonly<Record<SubtitleFormat, { readonly muxer: string; readonly contentType: string }>> = {
  subrip: { muxer: "srt", contentType: "application/x-subrip; charset=utf-8" },
  webvtt: { muxer: "webvtt", contentType: "text/vtt; charset=utf-8" },
};

/** What the Hub converts subtitles the Player can't render itself to (FR-45): SubRip, which every Player renders. */
export const CONVERTED_SUBTITLE_FORMAT: SubtitleFormat = "subrip";

/** Long enough for ffmpeg to read a whole film off a slow network share for the subtitles inside it. */
const CONVERT_TIMEOUT_MS = 5 * 60_000;

/** Language names, for telling a language code in a sidecar's name from any other word in it. */
const LANGUAGES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * Whether a part of a sidecar's name is a language code of `letters`
 * letters, e.g. "en" or "pt-BR" of 2, or "fre" of 3, rather than another
 * word, e.g. "forced".
 */
const isLanguage = (part: string, letters: 2 | 3): boolean => {
  if (!new RegExp(`^[a-z]{${String(letters)}}(?:-[a-z0-9]{2,8})*$`, "i").test(part)) return false;
  try {
    return LANGUAGES.of(part) !== undefined;
  } catch {
    return false;
  }
};

/** A subtitle track of a Media File, and where the Hub reads it from. */
export interface FoundSubtitle {
  readonly track: SubtitleTrack;
  readonly source: SubtitleSource;
}

/**
 * The file named `name`, as a sidecar subtitle file of the Media File named
 * `mediaFileName` beside it (FR-44), or null if it isn't one: one whose name
 * is the Media File's, less its extension, ignoring case, then an
 * extension of a sidecar subtitle format, with any parts between: the
 * first that is a language code its language, e.g. `Film.en.srt`, and the
 * others its title, e.g. `Film.en.forced.srt`. A two-letter code is taken
 * before a three-letter one, as a word such as "SDH" is a three-letter code
 * too, e.g. `Film.SDH.en.srt`.
 */
export const sidecarSubtitle = (name: string, mediaFileName: string): SubtitleTrack | null => {
  const codec = SIDECAR_FORMATS.get(extname(name).toLowerCase());
  const base = mediaFileName.slice(0, mediaFileName.length - extname(mediaFileName).length);
  if (codec === undefined || isHidden(name) || base === "" || name === mediaFileName) return null;
  const middle = name.slice(0, name.length - extname(name).length);
  if (middle.toLowerCase() === base.toLowerCase()) {
    return { language: null, title: null, codec, sidecar: name, burnedIn: false };
  }
  if (!middle.toLowerCase().startsWith(`${base.toLowerCase()}.`)) return null;
  const parts = middle
    .slice(base.length + 1)
    .split(".")
    .filter((part) => part !== "");
  const language = parts.find((part) => isLanguage(part, 2)) ?? parts.find((part) => isLanguage(part, 3));
  const rest = parts.filter((part) => part !== language);
  return {
    language: language?.toLowerCase() ?? null,
    title: rest.length === 0 ? null : rest.join(" "),
    codec,
    sidecar: name,
    burnedIn: false,
  };
};

/**
 * The sidecar subtitle files beside the Media File `names` lead to in
 * `source`, in name order, or none when the Hub can't read its folder. One
 * that is the sidecar of another Media File there whose name it matches
 * more of, e.g. `Film.Extended.srt` beside `Film.mkv` and
 * `Film.Extended.mkv`, is that one's alone.
 */
export const sidecarSubtitlesOf = async (source: MediaSource, names: readonly string[]): Promise<FoundSubtitle[]> => {
  const mediaFileName = names.at(-1);
  if (mediaFileName === undefined) return [];
  let entries: string[];
  try {
    const { path } = await resolveInMediaSource(source, names.slice(0, -1));
    entries = await readdir(path);
  } catch {
    return [];
  }
  const others = entries.filter((name) => name !== mediaFileName && mediaKindOf(name) !== undefined);
  const baseLength = (name: string): number => name.length - extname(name).length;
  return entries
    .flatMap((name) => {
      const track = sidecarSubtitle(name, mediaFileName);
      if (track === null) return [];
      const another = others.some(
        (other) => baseLength(other) > baseLength(mediaFileName) && sidecarSubtitle(name, other) !== null,
      );
      return another ? [] : [{ track, source: { sidecar: name } }];
    })
    .toSorted((a, b) => (a.track.sidecar ?? "").localeCompare(b.track.sidecar ?? "", "en", { numeric: true }));
};

/**
 * A Media File's subtitle tracks on a TV that plays `formats`, for the
 * now-playing bar to list and choose between (FR-36, FR-44): its own
 * subtitle streams, as ffprobe says, in the order they are in it, then the
 * `sidecars` beside it. Its own are its text subtitles, and its image
 * subtitles the TV can't render, which the Hub burns in to show (FR-45).
 */
export const subtitlesOf = (
  probe: MediaProbe | null,
  sidecars: readonly FoundSubtitle[],
  formats: PlayableFormats,
): FoundSubtitle[] => [
  ...(probe?.streams ?? []).flatMap((stream) => {
    const burnedIn = burnsIn(stream, formats);
    if (stream.type !== "subtitle" || (!burnedIn && !TEXT_SUBTITLES.has(stream.codec))) return [];
    const { index, language, title, codec } = stream;
    return [{ track: { language, title, codec, sidecar: null, burnedIn }, source: { stream: index } }];
  }),
  ...sidecars,
];

/**
 * The format to send the Player a subtitle track in (FR-45): its own, if
 * the Player renders it, among `rendered`, as the Driver says; otherwise
 * {@link CONVERTED_SUBTITLE_FORMAT}, which the Hub converts it to.
 */
export const subtitleFormatFor = (codec: string, rendered: readonly string[]): SubtitleFormat => {
  const own = SUBTITLE_FORMATS.get(codec);
  return own !== undefined && rendered.includes(codec) ? own : CONVERTED_SUBTITLE_FORMAT;
};

/** Why a subtitle track couldn't be served, which is logged. */
class SubtitleFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleFailure";
  }
}

/** Has ffmpeg write the subtitles at `map` in `file` as `format`, and resolves with them. */
const convert = (file: string, map: string, format: SubtitleFormat): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // A full path starts with "/", so ffmpeg takes it as neither an option nor a protocol.
    execFile(
      "ffmpeg",
      [
        ...["-hide_banner", "-nostdin", "-v", "error", "-i", file],
        ...["-map", map, "-c:s", SERVED_AS[format].muxer, "-f", SERVED_AS[format].muxer, "pipe:1"],
      ],
      { encoding: "buffer", timeout: CONVERT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new SubtitleFailure(stderr.toString("utf8").trim() || error.message));
      },
    );
  });

const NOT_A_SUBTITLE_TRACK = "That Media File has no such subtitle track.";

/** The {@link SubtitleSource} and {@link SubtitleFormat} a request's query asks for, refused with why if it doesn't. */
const askedFor = (query: URLSearchParams): { readonly source: SubtitleSource; readonly format: SubtitleFormat } => {
  const format = SUBTITLE_FORMATS.get(query.get(MEDIA_SUBTITLE_KEYS.format) ?? "");
  if (format === undefined)
    throw new HttpRefusal(400, 'Say which format to send the subtitles in: "subrip" or "webvtt".');
  const stream = query.get(MEDIA_SUBTITLE_KEYS.stream);
  const sidecar = query.get(MEDIA_SUBTITLE_KEYS.sidecar);
  if (stream !== null && /^(?:0|[1-9][0-9]{0,5})$/.test(stream) && sidecar === null) {
    return { source: { stream: Number(stream) }, format };
  }
  if (sidecar !== null && sidecar !== "" && stream === null) return { source: { sidecar }, format };
  throw new HttpRefusal(400, "Say which subtitle track: one of the Media File's own streams, or a sidecar file.");
};

/**
 * Serves one subtitle track of the Media File `names` lead to in `source`,
 * as `mediaSubtitlePath` in `shared` asks (FR-44, FR-45): a sidecar file in
 * the format asked for as it is, and any other, or a text subtitle stream of
 * the Media File, as ffmpeg converts it. A sidecar is found as the Media File
 * is, refusing anything that leads outside the Media Source (FR-5), and only
 * one of its own sidecar files is served, never another file beside it.
 * Any page may read them, as the Player's, which isn't the Hub's, does.
 */
export const serveSubtitle = async (
  {
    source,
    names,
    query,
    probeMedia,
  }: {
    readonly source: MediaSource;
    readonly names: readonly string[];
    readonly query: URLSearchParams;
    readonly probeMedia: ProbeMedia;
  },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const asked = askedFor(query);
  const found = await findMediaFile(source, names);
  let subtitles: Buffer;
  try {
    if ("sidecar" in asked.source) {
      const track = sidecarSubtitle(asked.source.sidecar, found.name);
      if (track === null) throw new MediaSourceRefusal("missing", NOT_A_SUBTITLE_TRACK);
      const { path } = await resolveInMediaSource(source, [...names.slice(0, -1), asked.source.sidecar], "file");
      subtitles =
        track.codec === asked.format
          ? await readFile(path).catch(() => {
              throw new MediaSourceRefusal("missing", "That subtitle file no longer exists.");
            })
          : await convert(path, "0:s:0", asked.format);
    } else {
      const { stream } = asked.source;
      const probe = await probeMedia(found.path);
      const own = probe?.streams.find((each) => each.index === stream);
      if (own === undefined || own.type !== "subtitle" || !TEXT_SUBTITLES.has(own.codec)) {
        throw new MediaSourceRefusal("missing", NOT_A_SUBTITLE_TRACK);
      }
      subtitles = await convert(found.path, `0:${String(stream)}`, asked.format);
    }
  } catch (error) {
    if (!(error instanceof SubtitleFailure)) throw error;
    console.error(`ffmpeg couldn't convert the subtitles of "${found.name}": ${error.message}`);
    sendError(response, 500, `The Hub couldn't convert the subtitles of "${found.name}".`);
    return;
  }
  response.writeHead(200, {
    "content-type": SERVED_AS[asked.format].contentType,
    "content-length": subtitles.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });
  response.end(request.method === "HEAD" ? undefined : subtitles);
};
