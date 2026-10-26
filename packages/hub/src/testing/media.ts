import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { Route } from "@media-centre/shared";

const run = promisify(execFile);

/** Each sample Media File's path in the test Media Source, and how long ffmpeg makes it, in seconds. */
export const SAMPLE_MEDIA_FILES = {
  "Films/Concert.mkv": 1,
  "Films/Film.mkv": 60,
  "Films/Home Video.avi": 60,
  "Films/Opera.mkv": 60,
  "Films/Recording.mkv": 60,
  "Films/Sci-Fi/Arrival.mkv": 12,
  "Films/Sci-Fi/Clip.mp4": 2,
  "Films/Trailer.mkv": 1,
  "Music/Album/01 Tone.flac": 3,
  "Music/Album/02 Tone.mp3": 2,
  "Music/Album/03 Tone.m4a": 2,
} as const;

/** The Route each sample Media File takes to a Samsung TV (FR-41). */
export const SAMPLE_ROUTES: Readonly<Record<keyof typeof SAMPLE_MEDIA_FILES, Route>> = {
  "Films/Concert.mkv": "audio-conversion",
  "Films/Film.mkv": "direct-play",
  "Films/Home Video.avi": "full-conversion",
  "Films/Opera.mkv": "direct-play",
  "Films/Recording.mkv": "remux",
  "Films/Sci-Fi/Arrival.mkv": "audio-conversion",
  "Films/Sci-Fi/Clip.mp4": "direct-play",
  "Films/Trailer.mkv": "direct-play",
  "Music/Album/01 Tone.flac": "direct-play",
  "Music/Album/02 Tone.mp3": "direct-play",
  "Music/Album/03 Tone.m4a": "audio-conversion",
};

/**
 * What the album's music is tagged with, in the order of its files (FR-47):
 * the FLAC its title, artist and album, with cover art embedded too; the MP3
 * nothing at all; and the ALAC its title, album and the album's artist, but
 * no cover art.
 */
export const ALBUM_TAGS = [
  { title: "Tone in A", artist: "The Sine Waves", album: "Test Tones" },
  { title: null, artist: null, album: null },
  { title: "Tone in C#", artist: "The Sine Waves", album: "Test Tones" },
] as const;

/** The cover art embedded in the album's FLAC: a red square, this many pixels a side. */
export const COVER_ART_SIZE = 48;

/** A small picture, `seconds` long, at 10 frames a second, as ffmpeg's input. */
const picture = (seconds: number): readonly string[] => [
  "-f",
  "lavfi",
  "-i",
  `testsrc=duration=${String(seconds)}:size=64x36:rate=10`,
];

/** A tone, `seconds` long, as ffmpeg's input. */
const tone = (seconds: number, frequency = 440): readonly string[] => [
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=${String(frequency)}:duration=${String(seconds)}`,
];

/**
 * The audio tracks of the film with DTS, as ffprobe says of them, in the
 * order they are in it: what the now-playing bar lists (FR-36).
 */
export const ARRIVAL_AUDIO_TRACKS = [
  { language: "eng", title: "Surround", codec: "dts", channels: 6 },
  { language: "fre", title: null, codec: "ac3", channels: 2 },
  { language: null, title: null, codec: "aac", channels: 2 },
] as const;

/** ffmpeg's options tagging a file with this title, artist and album. */
const tagged = ({
  title,
  artist,
  album,
}: {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
}) => [...["-metadata", `title=${title}`, "-metadata", `artist=${artist}`, "-metadata", `album=${album}`]];

/** H.264 as a TV plays it, 8-bit 4:2:0, with a keyframe every `keyframeSeconds`. */
const h264 = (keyframeSeconds = 1): readonly string[] => [
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-g",
  String(keyframeSeconds * 10),
];

/**
 * The subtitle tracks of the film with subtitles, as the Hub lists them, and
 * what each shows for the whole of its first minute: its own, a SubRip in
 * English and an ASS in German, then the sidecar files beside it, a SubRip
 * in English and an ASS in French (FR-44).
 */
export const FILM_SUBTITLE_TRACKS = [
  { language: "eng", title: null, codec: "subrip", sidecar: null, burnedIn: false },
  { language: "ger", title: "Signs", codec: "ass", sidecar: null, burnedIn: false },
  { language: "en", title: null, codec: "subrip", sidecar: "Film.en.srt", burnedIn: false },
  { language: "fr", title: null, codec: "ass", sidecar: "Film.fr.ass", burnedIn: false },
] as const;

/** What each of {@link FILM_SUBTITLE_TRACKS} shows, in its order. */
export const FILM_SUBTITLES = [
  "Hello from inside the film.",
  "Hallo aus dem Film.",
  "Hello from the English file.",
  "Bonjour du fichier français.",
] as const;

/** A SubRip file of one subtitle, for the first minute. */
const subrip = (text: string): string => `1\n00:00:00,000 --> 00:01:00,000\n${text}\n`;

/** An ASS file of one subtitle, for the first minute, in italics, as ASS has them, which SubRip has as `<i>`. */
const ass = (text: string): string =>
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 384",
    "PlayResY: 288",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, " +
      "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, " +
      "MarginR, MarginV, Encoding",
    "Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,0:01:00.00,Default,,0,0,0,,{\\i1}${text}{\\i0}`,
    "",
  ].join("\n");

/**
 * The subtitle tracks of the opera, as the Hub lists them for a Samsung TV:
 * a SubRip in English, then image subtitles, which the TV can't render, so
 * the Hub burns them in (FR-45): PGS in Italian, as on a Blu-ray, and
 * VobSub in French, as on a DVD.
 */
export const OPERA_SUBTITLE_TRACKS = [
  { language: "eng", title: null, codec: "subrip", sidecar: null, burnedIn: false },
  { language: "ita", title: null, codec: "hdmv_pgs_subtitle", sidecar: null, burnedIn: true },
  { language: "fre", title: null, codec: "dvd_subtitle", sidecar: null, burnedIn: true },
] as const;

/** What the opera's SubRip track shows, for the whole of its minute. */
export const OPERA_SUBTITLE = "Welcome to the opera.";

/**
 * What the opera's image subtitles show, both of them: a white box, in
 * pixels of its picture, which is otherwise black, shown afresh every 5
 * seconds, as a film's subtitles come and go.
 */
export const OPERA_SUBTITLE_BOX = { x: 12, y: 20, width: 40, height: 10, everySeconds: 5 } as const;

/**
 * How bright a picture of a video is at a point, 0 to 255, in the
 * MPEG-TS segment `bytes`, its `frame`th from its first: in the middle of
 * {@link OPERA_SUBTITLE_BOX}, or, `outside`, in a corner of the picture.
 * Bright in the box once the opera's image subtitles are burned in.
 */
export const operaBrightness = async (bytes: Uint8Array, frame: number, where: "box" | "outside"): Promise<number> => {
  const dir = await mkdtemp(join(tmpdir(), "media-centre-segment-"));
  try {
    await writeFile(join(dir, "segment.ts"), bytes);
    const { x, y, width, height } = OPERA_SUBTITLE_BOX;
    const at = where === "box" ? `${String(x + width / 2)}:${String(y + height / 2)}` : "2:2";
    // 2 by 2, as the picture's colour is in 2 by 2 blocks.
    const { stdout } = await run(
      "ffmpeg",
      [
        ...["-v", "error", "-i", join(dir, "segment.ts")],
        ...["-vf", `select=eq(n\\,${String(frame)}),crop=2:2:${at}`, "-frames:v", "1"],
        ...["-f", "rawvideo", "-pix_fmt", "gray", "-"],
      ],
      { encoding: "buffer" },
    );
    if (stdout.length !== 4) throw new Error(`The segment has no picture ${String(frame)}.`);
    return stdout.reduce((sum, value) => sum + value, 0) / stdout.length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The opera's picture: black, 64 by 36, as a box of PGS subtitles is drawn on. */
const OPERA_SIZE = { width: 64, height: 36 } as const;

/**
 * A PGS (`.sup`) file of {@link OPERA_SUBTITLE_BOX} for a minute, as a
 * Blu-ray has its subtitles, which ffmpeg reads but can't make: a display
 * set showing the box every 5 seconds, each its palette, of white, and its
 * picture, run-length encoded, then one clearing it at the minute.
 */
const pgsSubtitles = (): Buffer => {
  const u16 = (value: number): Buffer => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
  };
  /** One segment: "PG", its time, in 90 kHz ticks, its type, and its data. */
  const segment = (seconds: number, type: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(13);
    head.write("PG", 0, "latin1");
    head.writeUInt32BE(seconds * 90_000, 2);
    head.writeUInt8(type, 10);
    head.writeUInt16BE(data.length, 11);
    return Buffer.concat([head, data]);
  };
  const { x, y, width, height, everySeconds } = OPERA_SUBTITLE_BOX;
  /** A presentation composition: the box, starting afresh, or nothing, to clear it. */
  const composition = (number: number, shown: boolean): Buffer =>
    Buffer.concat([
      ...[u16(OPERA_SIZE.width), u16(OPERA_SIZE.height), Buffer.from([0x10]), u16(number)],
      Buffer.from([shown ? 0x80 : 0x00, 0, 0, shown ? 1 : 0]),
      ...(shown ? [u16(0), Buffer.from([0, 0]), u16(x), u16(y)] : []),
    ]);
  const window = Buffer.concat([Buffer.from([1, 0]), u16(x), u16(y), u16(width), u16(height)]);
  // Colour 1 is white, opaque: Y, Cr, Cb and alpha.
  const palette = Buffer.from([0, 0, 1, 235, 128, 128, 255]);
  // Each line is a run of colour 1 as wide as the box, then the line's end.
  const picture = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, 0x80 | width, 1, 0, 0])));
  const length = picture.length + 4;
  const object = Buffer.concat([
    ...[u16(0), Buffer.from([0, 0xc0, length >> 16, (length >> 8) & 0xff, length & 0xff])],
    ...[u16(width), u16(height), picture],
  ]);
  const end = Buffer.alloc(0);
  const shows = Array.from({ length: 60 / everySeconds }, (_, at) => at * everySeconds);
  return Buffer.concat([
    ...shows.flatMap((seconds, at) => [
      segment(seconds, 0x16, composition(at, true)),
      segment(seconds, 0x17, window),
      segment(seconds, 0x14, palette),
      segment(seconds, 0x15, object),
      segment(seconds, 0x80, end),
    ]),
    segment(60, 0x16, composition(shows.length, false)),
    segment(60, 0x17, window),
    segment(60, 0x80, end),
  ]);
};

/** The sidecar subtitle files beside the film with subtitles, by their paths in the test Media Source. */
const SIDECARS: Readonly<Record<string, string>> = {
  "Films/Film.en.srt": subrip(FILM_SUBTITLES[2]),
  "Films/Film.fr.ass": ass(FILM_SUBTITLES[3]),
};

/** The ffmpeg input and output options for each sample Media File. */
const ffmpegArguments = (subtitles: {
  readonly english: string;
  readonly german: string;
  readonly opera: string;
  readonly pgs: string;
}): Readonly<Record<keyof typeof SAMPLE_MEDIA_FILES, readonly string[]>> => ({
  // H.264 with FLAC, which a Samsung TV doesn't play with video.
  "Films/Concert.mkv": [...picture(1), ...tone(1), ...h264(), "-c:a", "flac"],
  // H.264 and AAC, which a TV plays as they are, with text subtitles of its
  // own, a SubRip in English and an ASS in German.
  "Films/Film.mkv": [
    ...picture(60),
    ...tone(60),
    ...["-i", subtitles.english, "-i", subtitles.german],
    ...["-map", "0", "-map", "1", "-map", "2", "-map", "3"],
    ...h264(),
    ...["-c:a", "aac", "-c:s:0", "srt", "-c:s:1", "ass"],
    ...["-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=ger", "-metadata:s:s:1", "title=Signs"],
  ],
  // Xvid, as a DivX/Xvid AVI is: MPEG-4 Part 2, which a Samsung TV doesn't
  // play at all, with a keyframe only every 5 seconds, and MP3 audio, which
  // it does.
  "Films/Home Video.avi": [
    ...picture(60),
    ...tone(60),
    ...["-c:v", "mpeg4", "-vtag", "XVID", "-g", "50", "-c:a", "libmp3lame"],
  ],
  // H.264 and AAC, which a TV plays as they are, its picture black, with a
  // SubRip in English, then PGS in Italian and VobSub in French, both a white
  // box, which ffmpeg makes from PGS, as it can't from text.
  "Films/Opera.mkv": [
    ...[
      "-f",
      "lavfi",
      "-i",
      `color=c=black:size=${String(OPERA_SIZE.width)}x${String(OPERA_SIZE.height)}:rate=10:duration=60`,
    ],
    ...tone(60),
    // The VobSub made from the PGS ends each subtitle where the next starts,
    // rather than never, which would make the opera last 50 days.
    ...["-i", subtitles.opera, "-i", subtitles.pgs, "-fix_sub_duration", "-i", subtitles.pgs],
    ...["-map", "0", "-map", "1", "-map", "2", "-map", "3", "-map", "4"],
    ...h264(),
    ...["-c:a", "aac", "-c:s:0", "srt", "-c:s:1", "copy", "-c:s:2", "dvdsub"],
    ...["-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=ita", "-metadata:s:s:2", "language=fre"],
  ],
  // As recorded from broadcast TV, with MPEG-1 Layer II audio, which a
  // Samsung TV plays from HLS but not from an MKV, and a keyframe every 2
  // seconds, as broadcasts have. Its sound runs a tenth of a second past its
  // minute of picture, so that it lasts a moment over the minute whichever
  // ffmpeg makes it: from 6.0 on, MKV keeps the MP2 encoder's delay as
  // timestamps before 0, rather than starting the file that much later.
  "Films/Recording.mkv": [...picture(60), ...tone(60.1), ...h264(2), "-c:a", "mp2"],
  // A film as ripped from a Blu-ray, with DTS 5.1, which no Samsung TV from
  // 2018 on decodes, then two tracks a TV plays: Dolby Digital in French,
  // and AAC in no language the file says.
  "Films/Sci-Fi/Arrival.mkv": [
    ...picture(12),
    ...tone(12),
    ...tone(12, 550),
    ...tone(12, 660),
    ...["-map", "0", "-map", "1", "-map", "2", "-map", "3"],
    ...h264(2),
    ...["-c:a:0", "dca", "-strict", "-2", "-ac:a:0", "6", "-metadata:s:a:0", "language=eng"],
    ...["-metadata:s:a:0", "title=Surround"],
    ...["-c:a:1", "ac3", "-ac:a:1", "2", "-metadata:s:a:1", "language=fre"],
    ...["-c:a:2", "aac", "-ac:a:2", "2"],
  ],
  "Films/Sci-Fi/Clip.mp4": [...picture(2), ...h264()],
  // Two audio tracks a TV plays, so it plays them as they are, and switches between them itself.
  "Films/Trailer.mkv": [
    ...picture(1),
    ...tone(1),
    ...tone(1, 550),
    ...["-map", "0", "-map", "1", "-map", "2"],
    ...h264(),
    ...["-c:a", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=spa"],
  ],
  // Tagged as music is, with its cover art a PNG embedded in it, as a picture that goes with it.
  "Music/Album/01 Tone.flac": [
    ...tone(3),
    ...["-f", "lavfi", "-i", `color=c=red:size=${String(COVER_ART_SIZE)}x${String(COVER_ART_SIZE)}:rate=1:duration=1`],
    ...["-map", "0", "-map", "1", "-c:a", "flac", "-c:v", "png", "-disposition:v", "attached_pic"],
    ...tagged(ALBUM_TAGS[0]),
  ],
  // Untagged, and with no cover art.
  "Music/Album/02 Tone.mp3": [...tone(2, 660), "-c:a", "libmp3lame"],
  // ALAC, which a Samsung TV doesn't play, in an M4A, tagged with its album's artist rather than its own.
  "Music/Album/03 Tone.m4a": [
    ...tone(2, 550),
    "-c:a",
    "alac",
    ...["-metadata", `title=${ALBUM_TAGS[2].title}`, "-metadata", `album=${ALBUM_TAGS[2].album}`],
    ...["-metadata", `album_artist=${ALBUM_TAGS[2].artist}`],
  ],
});

/** Files in the test Media Source that aren't Media Files, or are hidden, which browsing never shows. */
export const SAMPLE_OTHER_FILES = ["readme.txt", "Music/Album/cover.jpg", ".hidden.mp4", "Films/.DS_Store"] as const;

/**
 * Makes a small test Media Source in `dir`, with sample Media Files generated
 * by ffmpeg rather than committed, beside files browsing should hide, the
 * sidecar subtitle files of `Films/Film.mkv`, and `Damaged.mp4`, which
 * ffprobe can't read.
 */
export const makeTestMediaSource = async (dir: string): Promise<void> => {
  // The film's own subtitles are made from files outside the Media Source.
  const made = await mkdtemp(join(tmpdir(), "media-centre-subtitles-"));
  try {
    const subtitles = {
      english: join(made, "english.srt"),
      german: join(made, "german.ass"),
      opera: join(made, "opera.srt"),
      pgs: join(made, "box.sup"),
    };
    await writeFile(subtitles.english, subrip(FILM_SUBTITLES[0]));
    await writeFile(subtitles.german, ass(FILM_SUBTITLES[1]));
    await writeFile(subtitles.opera, subrip(OPERA_SUBTITLE));
    await writeFile(subtitles.pgs, pgsSubtitles());
    for (const [file, args] of Object.entries(ffmpegArguments(subtitles))) {
      const path = join(dir, file);
      await mkdir(dirname(path), { recursive: true });
      await run("ffmpeg", ["-v", "error", "-y", ...args, path]);
    }
  } finally {
    await rm(made, { recursive: true, force: true });
  }
  for (const [file, text] of Object.entries(SIDECARS)) await writeFile(join(dir, file), text);
  for (const file of SAMPLE_OTHER_FILES) await writeFile(join(dir, file), "not a Media File");
  await writeFile(join(dir, "Damaged.mp4"), "not really a video");
};

/**
 * Makes a minute of grey video at `path`, H.264 in an MKV, which a TV plays
 * as it is, whose every picture is as bright as 4 times its time in
 * seconds, 0 to 255, so that a picture of it says where in it it is from,
 * to within a frame: as {@link brightnessOfPicture} reads it.
 */
export const makeBrighteningVideo = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await run("ffmpeg", [
    ...["-v", "error", "-y", "-f", "lavfi"],
    ...["-i", "color=c=black:size=64x36:rate=10:duration=60,format=gray,geq=lum='4*T'", ...h264(), path],
  ]);
};

/** How bright a picture is, on average, 0 to 255: of {@link makeBrighteningVideo}'s, 4 times its time in seconds. */
export const brightnessOfPicture = async (bytes: Uint8Array): Promise<number> => {
  const dir = await mkdtemp(join(tmpdir(), "media-centre-picture-"));
  try {
    await writeFile(join(dir, "picture.jpg"), bytes);
    const { stdout } = await run(
      "ffmpeg",
      ["-v", "error", "-i", join(dir, "picture.jpg"), "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { encoding: "buffer" },
    );
    if (stdout.length !== 1) throw new Error("That isn't a picture.");
    return stdout[0] ?? 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
