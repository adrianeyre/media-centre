import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * How ffmpeg re-encodes a Media File's video for the Full Conversion Route
 * (FR-41, FR-42, ADR 0006), to a codec every TV the Hub streams to plays
 * from HLS. The Route's streams know only this, so that another encoder, on
 * a GPU, can take the place of software without changing them.
 */
export interface VideoEncoder {
  /** What it is, for the Hub's log, e.g. "software (libx264)". */
  readonly name: string;
  /** The codec it encodes to, by ffprobe's name for it, e.g. "h264". */
  readonly codec: string;
  /** ffmpeg's options before the Media File, e.g. to open the GPU it encodes on. None for software. */
  readonly inputArguments: readonly string[];
  /**
   * ffmpeg's filters for the video before it encodes it, e.g. to make its
   * size one it encodes, or `""` for none. They come after any subtitles
   * burned into it (FR-45), in the same filter graph.
   */
  readonly filter: string;
  /** ffmpeg's options for the one video stream it encodes, its codec and quality. */
  readonly outputArguments: readonly string[];
}

/** Makes the video's width and height even, which 4:2:0 needs, by losing a line from an odd one. */
const EVEN_SIZE = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/**
 * H.264 in software, with ffmpeg's libx264: High profile, 8-bit 4:2:0, as
 * every Samsung TV from 2018 on plays it. "veryfast", to keep up as the
 * Player plays on a NAS's CPU, at a quality a little above libx264's
 * default to make up for it. Odd widths and heights, which 4:2:0 can't
 * have, lose a line.
 */
export const SOFTWARE_VIDEO_ENCODER: VideoEncoder = {
  name: "software (libx264)",
  codec: "h264",
  inputArguments: [],
  filter: EVEN_SIZE,
  outputArguments: [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
  ],
};

/**
 * H.264 on an NVIDIA GPU, with NVENC: High profile, 8-bit 4:2:0, at a
 * constant quality near the software encoder's. ffmpeg decodes the Media
 * File as for software, so that any subtitles burned in are laid over it
 * first, and NVENC takes its pictures from memory. Each keyframe Full
 * Conversion forces at a segment's start is an IDR picture, which a segment
 * must begin with to be played on its own.
 */
export const NVENC_VIDEO_ENCODER: VideoEncoder = {
  name: "NVENC (h264_nvenc)",
  codec: "h264",
  inputArguments: [],
  filter: `${EVEN_SIZE},format=yuv420p`,
  outputArguments: [
    ...["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "constqp", "-qp", "21"],
    ...["-profile:v", "high", "-forced-idr", "1"],
  ],
};

/**
 * H.264 with Intel's Quick Sync, on the GPU at `device`, a render node such
 * as `/dev/dri/renderD128`, which ffmpeg reaches through VAAPI, as on any
 * Linux: High profile, 8-bit 4:2:0, at a constant quality near the software
 * encoder's, its forced keyframes IDR pictures, as for NVENC.
 */
export const quickSyncVideoEncoder = (device: string): VideoEncoder => ({
  name: `Quick Sync (h264_qsv) on ${device}`,
  codec: "h264",
  inputArguments: ["-init_hw_device", `vaapi=va:${device}`, "-init_hw_device", "qsv=qsv@va"],
  filter: `${EVEN_SIZE},format=nv12`,
  outputArguments: ["-c:v", "h264_qsv", "-profile:v", "high", "-q:v", "21", "-forced_idr", "1"],
});

/**
 * H.264 with VAAPI, on the GPU at `device`, a render node such as
 * `/dev/dri/renderD128`: Intel's or AMD's, whichever its driver is for. High
 * profile, 8-bit 4:2:0, at a constant quality near the software encoder's.
 * The video is uploaded to the GPU after any subtitles are burned into it,
 * and VAAPI makes each keyframe Full Conversion forces an IDR picture
 * without being asked.
 */
export const vaapiVideoEncoder = (device: string): VideoEncoder => ({
  name: `VAAPI (h264_vaapi) on ${device}`,
  codec: "h264",
  inputArguments: ["-vaapi_device", device],
  filter: `${EVEN_SIZE},format=nv12,hwupload`,
  outputArguments: ["-c:v", "h264_vaapi", "-profile:v", "high", "-qp", "21"],
});

/**
 * The GPU devices the Hub can see, which in Docker are only those passed into
 * its container.
 */
export interface GpuDevices {
  /** Each render node in `/dev/dri`, e.g. `/dev/dri/renderD128`, for Quick Sync and VAAPI, in order. */
  readonly renderNodes: readonly string[];
  /** Whether an NVIDIA GPU's `/dev/nvidiactl` is there, for NVENC. */
  readonly nvidia: boolean;
}

/** What the Hub can find out of its machine's GPUs, to choose its encoder by. */
export interface GpuProbe {
  readonly devices: () => Promise<GpuDevices>;
  /**
   * Has ffmpeg encode a moment of test video with `encoder`, as Full
   * Conversion would, resolving null if it can, or else what ffmpeg says,
   * e.g. that the GPU's driver is missing, or the Hub may not open it.
   */
  readonly trial: (encoder: VideoEncoder) => Promise<string | null>;
}

/** Long enough for ffmpeg to open a GPU and encode a second of video on it, which takes it well under one. */
const TRIAL_TIMEOUT_MS = 15_000;

/**
 * The GPUs of the Hub's own machine: the render nodes in `dri`, and NVIDIA's
 * control device at `nvidia`, as Linux and NVIDIA's drivers name them.
 */
export const systemGpuProbe = ({
  dri = "/dev/dri",
  nvidia = "/dev/nvidiactl",
}: { readonly dri?: string; readonly nvidia?: string } = {}): GpuProbe => ({
  devices: async () => {
    const names = await readdir(dri).catch(() => []);
    const renderNodes = names
      .filter((name) => /^renderD[0-9]+$/.test(name))
      .sort((a, b) => Number(a.slice("renderD".length)) - Number(b.slice("renderD".length)))
      .map((name) => join(dri, name));
    const hasNvidia = await access(nvidia).then(
      () => true,
      () => false,
    );
    return { renderNodes, nvidia: hasNvidia };
  },
  trial: (encoder) =>
    new Promise((resolve) => {
      execFile(
        "ffmpeg",
        [
          ...["-hide_banner", "-nostdin", "-v", "error", ...encoder.inputArguments],
          ...["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=1"],
          ...(encoder.filter === "" ? [] : ["-vf", encoder.filter]),
          ...encoder.outputArguments,
          ...["-force_key_frames", "0.5", "-f", "null", "-"],
        ],
        { timeout: TRIAL_TIMEOUT_MS },
        (error, _, stderr) => {
          if (error === null) resolve(null);
          else resolve(stderr.trim().split("\n").join(" ") || error.message);
        },
      );
    }),
});

/** Chooses the encoder for Full Conversion, once, before the Hub's first. */
export type ChooseVideoEncoder = () => Promise<VideoEncoder>;

/**
 * Chooses hardware acceleration where the Hub can see a GPU that encodes,
 * and software otherwise (FR-42, ADR 0006): NVENC on an NVIDIA GPU, then,
 * on each render node in turn, Quick Sync, and VAAPI, which also covers an
 * Intel GPU Quick Sync can't drive, and AMD's. Each is tried with a moment
 * of video before it is chosen, as a GPU being there doesn't mean it can be
 * used: its driver may be missing from the image, or the Hub may not be
 * allowed to open it. The Hub's log says why each it tried can't be.
 */
export const chooseVideoEncoderOn =
  (probe: GpuProbe): ChooseVideoEncoder =>
  async () => {
    const { renderNodes, nvidia } = await probe.devices();
    const candidates = [
      ...(nvidia ? [NVENC_VIDEO_ENCODER] : []),
      ...renderNodes.flatMap((device) => [quickSyncVideoEncoder(device), vaapiVideoEncoder(device)]),
    ];
    for (const encoder of candidates) {
      const why = await probe.trial(encoder);
      if (why === null) return encoder;
      console.log(`Full Conversion can't use ${encoder.name}: ${why}`);
    }
    return SOFTWARE_VIDEO_ENCODER;
  };

/**
 * The one place the Hub chooses how it re-encodes video: on the GPUs the
 * Hub's machine has, as {@link chooseVideoEncoderOn} does.
 */
export const chooseVideoEncoder: ChooseVideoEncoder = chooseVideoEncoderOn(systemGpuProbe());
