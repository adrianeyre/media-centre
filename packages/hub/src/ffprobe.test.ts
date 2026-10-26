import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ffprobeMedia, NO_TAGS, probeIn } from "./ffprobe.ts";
import { ALBUM_TAGS, makeTestMediaSource } from "./testing/media.ts";

const run = promisify(execFile);

/** One test Media Source, generated once with ffmpeg and only read by the tests, and a folder for files of the tests' own. */
let media: string;
let dir: string;

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-ffprobe-"));
  dir = await mkdtemp(join(tmpdir(), "hub-ffprobe-own-"));
  await makeTestMediaSource(media);
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

/** ffprobe's JSON for a file in `format_name`, with these tags on it, and on its one audio stream. */
const output = (
  format: Readonly<Record<string, string>> | undefined,
  audio: Readonly<Record<string, string>> | undefined,
): string =>
  JSON.stringify({
    streams: [{ index: 0, codec_type: "audio", codec_name: "flac", ...(audio === undefined ? {} : { tags: audio }) }],
    format: { format_name: "flac", duration: "3.0", ...(format === undefined ? {} : { tags: format }) },
  });

describe("what a Media File's tags say of it, as ffprobe reads them (FR-47)", () => {
  it("reads its title, artist and album", () => {
    expect(
      probeIn(output({ title: "Tone in A", artist: "The Sine Waves", album: "Test Tones" }, undefined), "a.flac"),
    ).toMatchObject({ tags: { title: "Tone in A", artist: "The Sine Waves", album: "Test Tones" } });
  });

  it("reads them whatever their case, as another tool may have written them", () => {
    expect(
      probeIn(output({ TITLE: "Tone in A", Artist: "The Sine Waves", ALBUM: "Test Tones" }, undefined), "a.flac"),
    ).toMatchObject({ tags: { title: "Tone in A", artist: "The Sine Waves", album: "Test Tones" } });
  });

  it("takes the album's artist for one without an artist of its own", () => {
    expect(probeIn(output({ album_artist: "Various Artists" }, undefined), "a.flac")?.tags.artist).toBe(
      "Various Artists",
    );
    expect(
      probeIn(output({ artist: "The Sine Waves", album_artist: "Various" }, undefined), "a.flac")?.tags.artist,
    ).toBe("The Sine Waves");
  });

  it("reads its audio stream's, as an Ogg file has them, only when the file has none of its own", () => {
    expect(probeIn(output(undefined, { title: "Opus tone", ARTIST: "The Sine Waves" }), "a.opus")?.tags).toEqual({
      title: "Opus tone",
      artist: "The Sine Waves",
      album: null,
    });
    expect(probeIn(output({ album: "Test Tones" }, { title: "Opus tone" }), "a.opus")?.tags).toEqual({
      title: null,
      artist: null,
      album: "Test Tones",
    });
  });

  it("has none for one with no tags, or only blank ones", () => {
    expect(probeIn(output(undefined, undefined), "a.flac")?.tags).toEqual(NO_TAGS);
    expect(probeIn(output({ title: "  ", encoder: "Lavf59.27.100" }, undefined), "a.flac")?.tags).toEqual(NO_TAGS);
  });

  it.each([
    ["a FLAC", "Music/Album/01 Tone.flac", ALBUM_TAGS[0]],
    ["an untagged MP3", "Music/Album/02 Tone.mp3", ALBUM_TAGS[1]],
    ["an ALAC M4A", "Music/Album/03 Tone.m4a", ALBUM_TAGS[2]],
  ])("reads %s's from ffprobe", async (_, file, tags) => {
    expect((await ffprobeMedia(join(media, file)))?.tags).toEqual(tags);
  });

  it("reads an Ogg Opus file's from ffprobe, from its audio stream", async () => {
    const opus = join(dir, "Tone.opus");
    await run("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "libopus"],
      ...["-metadata", "title=Opus tone", "-metadata", "artist=The Sine Waves", "-metadata", "album=Test Tones", opus],
    ]);

    expect((await ffprobeMedia(opus))?.tags).toEqual({
      title: "Opus tone",
      artist: "The Sine Waves",
      album: "Test Tones",
    });
  });

  it("finds the FLAC's cover art as a picture that goes with it, not video to play", async () => {
    expect((await ffprobeMedia(join(media, "Music/Album/01 Tone.flac")))?.streams).toMatchObject([
      { index: 0, type: "audio", codec: "flac", attachedPicture: false },
      { index: 1, type: "video", codec: "png", attachedPicture: true },
    ]);
  });
});
