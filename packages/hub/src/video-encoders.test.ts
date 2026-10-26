import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SAMSUNG_TV_PLAYABLE_FORMATS } from "./drivers/samsung-tv/playable-formats.ts";
import {
  chooseVideoEncoderOn,
  type GpuDevices,
  NVENC_VIDEO_ENCODER,
  quickSyncVideoEncoder,
  SOFTWARE_VIDEO_ENCODER,
  systemGpuProbe,
  vaapiVideoEncoder,
  type VideoEncoder,
} from "./video-encoders.ts";

const run = promisify(execFile);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-encoders-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A machine with the GPU `devices`, on which ffmpeg encodes with those of
 * `working`, by name, and says each other can't, as ffmpeg does when a GPU's
 * driver is missing.
 */
const fakeMachine = (devices: GpuDevices, working: readonly string[] = []) => {
  const trial = vi.fn((encoder: VideoEncoder) =>
    Promise.resolve(working.includes(encoder.name) ? null : `No VA display found for ${encoder.name}.`),
  );
  return { devices: () => Promise.resolve(devices), trial };
};

const NO_GPU: GpuDevices = { renderNodes: [], nvidia: false };
const INTEL: GpuDevices = { renderNodes: ["/dev/dri/renderD128"], nvidia: false };

describe("choosing the Full Conversion Route's encoder (FR-42)", () => {
  it("chooses software where the Hub sees no GPU, trying nothing", async () => {
    const machine = fakeMachine(NO_GPU);

    expect(await chooseVideoEncoderOn(machine)()).toBe(SOFTWARE_VIDEO_ENCODER);
    expect(machine.trial).not.toHaveBeenCalled();
  });

  it("chooses Quick Sync on a GPU passed into the container that it encodes on", async () => {
    const machine = fakeMachine(INTEL, [
      quickSyncVideoEncoder("/dev/dri/renderD128").name,
      vaapiVideoEncoder("/dev/dri/renderD128").name,
    ]);

    expect(await chooseVideoEncoderOn(machine)()).toEqual(quickSyncVideoEncoder("/dev/dri/renderD128"));
    expect(machine.trial).toHaveBeenCalledTimes(1);
  });

  it("chooses VAAPI on a GPU Quick Sync can't encode on, saying why in the Hub's log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const machine = fakeMachine(INTEL, [vaapiVideoEncoder("/dev/dri/renderD128").name]);

    expect(await chooseVideoEncoderOn(machine)()).toEqual(vaapiVideoEncoder("/dev/dri/renderD128"));
    expect(log).toHaveBeenCalledWith(
      "Full Conversion can't use Quick Sync (h264_qsv) on /dev/dri/renderD128: " +
        "No VA display found for Quick Sync (h264_qsv) on /dev/dri/renderD128.",
    );
  });

  it("chooses NVENC first on an NVIDIA GPU, before any other", async () => {
    const machine = fakeMachine({ renderNodes: ["/dev/dri/renderD128"], nvidia: true }, [
      NVENC_VIDEO_ENCODER.name,
      quickSyncVideoEncoder("/dev/dri/renderD128").name,
    ]);

    expect(await chooseVideoEncoderOn(machine)()).toBe(NVENC_VIDEO_ENCODER);
  });

  it("tries each render node in turn, for a machine with two GPUs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const machine = fakeMachine({ renderNodes: ["/dev/dri/renderD128", "/dev/dri/renderD129"], nvidia: false }, [
      vaapiVideoEncoder("/dev/dri/renderD129").name,
    ]);

    expect(await chooseVideoEncoderOn(machine)()).toEqual(vaapiVideoEncoder("/dev/dri/renderD129"));
    expect(machine.trial.mock.calls.map(([encoder]) => encoder.name)).toEqual([
      "Quick Sync (h264_qsv) on /dev/dri/renderD128",
      "VAAPI (h264_vaapi) on /dev/dri/renderD128",
      "Quick Sync (h264_qsv) on /dev/dri/renderD129",
      "VAAPI (h264_vaapi) on /dev/dri/renderD129",
    ]);
  });

  it("falls back to software when no GPU it sees encodes, as without its driver or leave to open it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const machine = fakeMachine({ renderNodes: ["/dev/dri/renderD128"], nvidia: true });

    expect(await chooseVideoEncoderOn(machine)()).toBe(SOFTWARE_VIDEO_ENCODER);
    expect(machine.trial).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(3);
  });
});

describe("the Hub's machine's GPUs (FR-42)", () => {
  it("are the render nodes in /dev/dri, in order, and NVIDIA's control device, where there are any", async () => {
    const dri = join(dir, "dri");
    await mkdir(dri);
    for (const name of ["renderD129", "card0", "renderD128", "card1", "by-path"]) await writeFile(join(dri, name), "");
    const nvidia = join(dir, "nvidiactl");
    await writeFile(nvidia, "");

    expect(await systemGpuProbe({ dri, nvidia }).devices()).toEqual({
      renderNodes: [join(dri, "renderD128"), join(dri, "renderD129")],
      nvidia: true,
    });
  });

  it("are none on a machine, or in a container, without them", async () => {
    expect(await systemGpuProbe({ dri: join(dir, "no-dri"), nvidia: join(dir, "no-nvidiactl") }).devices()).toEqual(
      NO_GPU,
    );
  });

  it("encode a moment of test video in software, as every machine can", async () => {
    expect(await systemGpuProbe().trial(SOFTWARE_VIDEO_ENCODER)).toBeNull();
  });

  it("can't encode on a GPU that isn't there, and say why", async () => {
    const why = await systemGpuProbe().trial(vaapiVideoEncoder(join(dir, "renderD128")));

    expect(why).toEqual(expect.stringContaining(join(dir, "renderD128")));
  });
});

describe("the hardware encoders (FR-42)", () => {
  const onMissingGpus = (): VideoEncoder[] => [
    NVENC_VIDEO_ENCODER,
    quickSyncVideoEncoder(join(dir, "renderD128")),
    vaapiVideoEncoder(join(dir, "renderD128")),
  ];

  it("each encode H.264, which TVs play from HLS", () => {
    for (const { codec } of onMissingGpus()) {
      expect(codec).toBe("h264");
      expect(SAMSUNG_TV_PLAYABLE_FORMATS.streamed.video).toContain(codec);
    }
  });

  // Only a GPU proves one encodes; without one, ffmpeg still checks each is
  // in it and every option it is given, by name, and NVENC's by value too.
  it("are each in the Hub's ffmpeg, which takes their options, stopped only by the GPU it hasn't got", async () => {
    for (const encoder of onMissingGpus()) {
      const why = await systemGpuProbe().trial(encoder);
      expect(why ?? "", encoder.name).not.toMatch(/Unrecognized option|Unknown encoder|Error setting option/);
    }
  });
});

describe("the software encoder (FR-42)", () => {
  it("encodes video a TV can't play to H.264 it plays from HLS, High profile, 8-bit 4:2:0, at even sizes", async () => {
    // 10-bit 4:4:4 MPEG-4 Part 2 can't be, so a 4:4:4 FFV1 of odd sizes stands in for the worst of what comes.
    const source = join(dir, "odd.mkv");
    await run("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=65x37:rate=10"],
      ...["-c:v", "ffv1", "-pix_fmt", "yuv444p10le", source],
    ]);
    const encoded = join(dir, "encoded.ts");

    await run("ffmpeg", [
      ...["-v", "error", "-y", ...SOFTWARE_VIDEO_ENCODER.inputArguments, "-i", source],
      ...["-vf", SOFTWARE_VIDEO_ENCODER.filter, ...SOFTWARE_VIDEO_ENCODER.outputArguments],
      ...["-f", "mpegts", encoded],
    ]);

    const { stdout } = await run("ffprobe", [
      ...["-v", "error", "-select_streams", "v:0"],
      ...["-show_entries", "stream=codec_name,profile,pix_fmt,width,height", "-of", "json", encoded],
    ]);
    const [video] = (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams;
    expect(video).toEqual({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: 64, height: 36 });
    expect(SOFTWARE_VIDEO_ENCODER.codec).toBe("h264");
    expect(SAMSUNG_TV_PLAYABLE_FORMATS.streamed.video).toContain(SOFTWARE_VIDEO_ENCODER.codec);
  });
});
