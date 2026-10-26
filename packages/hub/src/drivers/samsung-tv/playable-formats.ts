import type { PlayableFormats } from "../driver.ts";

/** The audio a Samsung TV plays alongside video, from a file or a stream: AAC, Dolby Digital and Dolby Digital Plus, and MP3. */
const VIDEO_AUDIO = ["aac", "ac3", "eac3", "mp3"];

/**
 * What the Player plays through AVPlay on a Samsung TV from 2018 on (ADR
 * 0005), as Samsung's own lists of supported formats say, less what the PRD
 * and ADR 0006 say those TVs lack: DTS, which none from 2018 on decodes, and
 * DivX/Xvid (MPEG-4 Part 2), which is left to Full Conversion. Where a list
 * is unsure, a codec is left out: one the TV turns out to play costs the Hub
 * a conversion it needn't have done, but one it turns out not to fails on
 * the TV. All of it is to be confirmed on a real TV (PRD §10).
 *
 * - Straight from a file: MP4 and MKV with H.264 or HEVC, MKV and MPEG-TS
 *   with MPEG-2 video too, WebM with VP8, VP9 or AV1, and audio files of
 *   MP3, AAC, FLAC, WAV and Ogg.
 * - From HLS of MPEG-TS segments, as the Hub streams the other Routes:
 *   H.264, HEVC and MPEG-2 video, and the audio a broadcast TV decodes,
 *   MPEG-1 Layer II included, which the TV doesn't list for files. So an MKV
 *   recorded from broadcast TV, with MP2 audio, plays by Remux.
 */
export const SAMSUNG_TV_PLAYABLE_FORMATS: PlayableFormats = {
  direct: {
    mp4: { video: ["h264", "hevc"], audio: VIDEO_AUDIO },
    matroska: { video: ["h264", "hevc", "mpeg2video"], audio: VIDEO_AUDIO },
    mpegts: { video: ["h264", "hevc", "mpeg2video"], audio: [...VIDEO_AUDIO, "mp2"] },
    webm: { video: ["vp8", "vp9", "av1"], audio: ["vorbis", "opus"] },
    mp3: { video: [], audio: ["mp3"] },
    aac: { video: [], audio: ["aac"] },
    flac: { video: [], audio: ["flac"] },
    wav: { video: [], audio: ["pcm_s16le", "pcm_s24le"] },
    ogg: { video: [], audio: ["vorbis", "opus", "flac"] },
  },
  streamed: { video: ["h264", "hevc", "mpeg2video"], audio: [...VIDEO_AUDIO, "mp2"] },
  subtitles: ["subrip", "webvtt"],
};
