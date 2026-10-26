import type { AudioTrack, SubtitleTrack } from "@media-centre/shared";

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** A Media File's size as a person reads it, e.g. "1.4 GB" or "850 MB", in thousands as a NAS counts them. */
export const formatSize = (bytes: number): string => {
  if (bytes < 1_000) return bytes === 1 ? "1 byte" : `${String(bytes)} bytes`;
  let value = bytes;
  let unit = 0;
  for (value /= 1_000; value >= 999.5 && unit < SIZE_UNITS.length - 1; unit += 1) value /= 1_000;
  const shown = value < 9.95 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toFixed(0);
  return `${shown} ${SIZE_UNITS[unit] ?? ""}`;
};

/** A Media File's duration to the second, as "m:ss", or "h:mm:ss" from an hour, e.g. "1:12:30". */
export const formatDuration = (seconds: number): string => {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${secs}` : `${String(minutes)}:${secs}`;
};

/** The names of the audio codecs a Media File most often has, by ffprobe's names for them. */
const AUDIO_CODEC_NAMES: Readonly<Record<string, string>> = {
  aac: "AAC",
  ac3: "Dolby Digital",
  alac: "ALAC",
  dts: "DTS",
  eac3: "Dolby Digital Plus",
  flac: "FLAC",
  mp2: "MP2",
  mp3: "MP3",
  opus: "Opus",
  truehd: "Dolby TrueHD",
  vorbis: "Vorbis",
};

/** The names of the commonest numbers of channels an audio track has. */
const CHANNELS_NAMES: Readonly<Record<number, string>> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };

/** How many channels an audio track has, as a person reads it: "mono", "stereo", "5.1" or "7.1", else "4 channels". */
const channelsName = (channels: number): string => CHANNELS_NAMES[channels] ?? `${String(channels)} channels`;

/** A language by its ISO 639 code, e.g. "eng" or "en", in English, or the code itself if it isn't one. */
const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code) ?? code;
  } catch {
    // Not a language code at all, e.g. a whole word in the file's tag.
    return code;
  }
};

/**
 * An audio track of a Media File as the now-playing bar lists it (FR-36):
 * its language, where the file says, otherwise its number, then its name, if
 * any, and its codec and channels, e.g. "English · Surround · DTS 5.1" or
 * "Track 3 · AAC stereo".
 */
export const formatAudioTrack = (track: AudioTrack, place: number): string => {
  const codec = AUDIO_CODEC_NAMES[track.codec] ?? (track.codec.startsWith("pcm_") ? "PCM" : track.codec.toUpperCase());
  return [
    track.language === null ? `Track ${String(place + 1)}` : languageName(track.language),
    track.title,
    track.channels === null ? codec : `${codec} ${channelsName(track.channels)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/** The names of the subtitle formats a Media File most often has, by ffmpeg's names for them. */
const SUBTITLE_FORMAT_NAMES: Readonly<Record<string, string>> = {
  ass: "ASS",
  dvb_subtitle: "DVB",
  dvd_subtitle: "VobSub",
  hdmv_pgs_subtitle: "PGS",
  mov_text: "MP4 text",
  ssa: "SSA",
  subrip: "SRT",
  webvtt: "WebVTT",
  xsub: "XSUB",
};

/**
 * A subtitle track of a Media File as the now-playing bar lists it (FR-36,
 * FR-44): its language, where the file or the sidecar's name says,
 * otherwise its number, then its name, if any, and its format, saying when
 * it is a sidecar file, and when the Hub burns it into the picture, by Full
 * Conversion (FR-45), e.g. "English · SRT file", "French · Signs · ASS",
 * "Track 2 · SRT" or "Italian · PGS · Full Conversion".
 */
export const formatSubtitleTrack = (track: SubtitleTrack, place: number): string => {
  const format = SUBTITLE_FORMAT_NAMES[track.codec] ?? track.codec.toUpperCase();
  return [
    track.language === null ? `Track ${String(place + 1)}` : languageName(track.language),
    track.title,
    track.sidecar === null ? format : `${format} file`,
    track.burnedIn ? "Full Conversion" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};
