import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MEDIA_SOURCES_PATH,
  mediaCoverArtPath,
  mediaFilePath,
  type HubError,
  type MediaSource,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";
import { COVER_ART_SIZE, makeTestMediaSource } from "./testing/media.ts";

const run = promisify(execFile);

/** One test Media Source, generated once with ffmpeg and only read by the tests. */
let media: string;
/** A folder for each test to fill, outside any Media Source. */
let dir: string;
let database: DatabaseSync;
let hub: Server;
let base: string;

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-media-files-"));
  await makeTestMediaSource(media);
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-media-files-test-"));
  database = openDatabase(":memory:");
  hub = createHub({ remoteDir: "/nonexistent", version: "9.9.9", hubId: "hub-1", database });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise((done) => hub.close(done));
  database.close();
  await rm(dir, { recursive: true, force: true });
});

const add = async (path: string, name: string): Promise<MediaSource> => {
  const response = await fetch(`${base}${MEDIA_SOURCES_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, path }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as MediaSource;
};

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/**
 * Sends `path` exactly as written, as a TV's player might, and as `fetch`
 * would not: it tidies `..` and `%2e%2e` away before sending.
 */
const get = (path: string, headers: Readonly<Record<string, string>> = {}, method = "GET"): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const { port } = hub.address() as AddressInfo;
    httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
    })
      .on("error", reject)
      .end();
  });

const errorIn = ({ body }: Answer): string => (JSON.parse(body.toString("utf8")) as HubError).error;

describe("a Media File's URL, for Direct Play", () => {
  it("serves the whole Media File unchanged, saying it takes range requests", async () => {
    const source = await add(media, "Media");
    const file = await readFile(join(media, "Films/Sci-Fi/Clip.mp4"));

    const answer = await get(mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4"));

    expect(answer.status).toBe(200);
    expect(answer.headers["accept-ranges"]).toBe("bytes");
    expect(answer.headers["content-type"]).toBe("video/mp4");
    expect(answer.headers["content-length"]).toBe(String(file.length));
    expect(answer.headers["content-range"]).toBeUndefined();
    expect(answer.body.equals(file)).toBe(true);
  });

  it("answers a range request with 206 and just those bytes, as a player seeking asks", async () => {
    const source = await add(media, "Media");
    const file = await readFile(join(media, "Films/Trailer.mkv"));

    const answer = await get(mediaFilePath(source.id, "Films/Trailer.mkv"), { range: "bytes=100-299" });

    expect(answer.status).toBe(206);
    expect(answer.headers["content-range"]).toBe(`bytes 100-299/${String(file.length)}`);
    expect(answer.headers["content-length"]).toBe("200");
    expect(answer.headers["content-type"]).toBe("video/x-matroska");
    expect(answer.body.equals(file.subarray(100, 300))).toBe(true);
  });

  it.each([
    ["from a byte to the end", () => "bytes=1000-", (size: number) => [1000, size - 1]],
    ["the last bytes", () => "bytes=-500", (size: number) => [size - 500, size - 1]],
    [
      "past the end, cut to the end",
      (size: number) => `bytes=10-${String(size + 1_000)}`,
      (size: number) => [10, size - 1],
    ],
    [
      "more last bytes than there are, as the whole",
      (size: number) => `bytes=-${String(size * 2)}`,
      (size: number) => [0, size - 1],
    ],
    ["the first byte alone", () => "bytes=0-0", () => [0, 0]],
  ])("answers a range %s", async (_, header, expected) => {
    const source = await add(media, "Media");
    const file = await readFile(join(media, "Films/Sci-Fi/Clip.mp4"));
    const [start = 0, end = 0] = expected(file.length);

    const answer = await get(mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4"), { range: header(file.length) });

    expect(answer.status).toBe(206);
    expect(answer.headers["content-range"]).toBe(`bytes ${String(start)}-${String(end)}/${String(file.length)}`);
    expect(answer.headers["content-length"]).toBe(String(end - start + 1));
    expect(answer.body.equals(file.subarray(start, end + 1))).toBe(true);
  });

  it("answers 416 with the size for a range that starts past the end", async () => {
    const source = await add(media, "Media");
    const file = await readFile(join(media, "Films/Sci-Fi/Clip.mp4"));

    const answer = await get(mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4"), {
      range: `bytes=${String(file.length)}-`,
    });

    expect(answer.status).toBe(416);
    expect(answer.headers["content-range"]).toBe(`bytes */${String(file.length)}`);
    expect(answer.body.length).toBe(0);
  });

  it.each([
    ["several ranges at once", "bytes=0-10,20-30"],
    ["another unit", "items=0-10"],
    ["a range backwards", "bytes=30-10"],
    ["nonsense", "bytes=abc"],
  ])("serves the whole Media File for a Range header it doesn't take: %s", async (_, range) => {
    const source = await add(media, "Media");
    const file = await readFile(join(media, "Films/Sci-Fi/Clip.mp4"));

    const answer = await get(mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4"), { range });

    expect(answer.status).toBe(200);
    expect(answer.body.equals(file)).toBe(true);
  });

  it("honours If-Range only while the Media File is unchanged", async () => {
    const source = await add(media, "Media");
    const path = mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4");
    const { headers } = await get(path, {}, "HEAD");
    const etag = String(headers.etag);

    expect((await get(path, { range: "bytes=0-9", "if-range": etag })).status).toBe(206);
    expect((await get(path, { range: "bytes=0-9", "if-range": String(headers["last-modified"]) })).status).toBe(206);
    expect((await get(path, { range: "bytes=0-9", "if-range": '"something-else"' })).status).toBe(200);
  });

  it("answers HEAD with the headers alone", async () => {
    const source = await add(media, "Media");
    const file = await readFile(join(media, "Music/Album/01 Tone.flac"));

    const whole = await get(mediaFilePath(source.id, "Music/Album/01 Tone.flac"), {}, "HEAD");
    const part = await get(mediaFilePath(source.id, "Music/Album/01 Tone.flac"), { range: "bytes=0-99" }, "HEAD");

    expect(whole.status).toBe(200);
    expect(whole.headers["content-length"]).toBe(String(file.length));
    expect(whole.headers["content-type"]).toBe("audio/flac");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-99/${String(file.length)}`);
    expect(whole.body.length + part.body.length).toBe(0);
  });

  it("serves a Media File whose name needs encoding in a URL", async () => {
    await mkdir(join(dir, "Source", "Films & Shows"), { recursive: true });
    await writeFile(join(dir, "Source", "Films & Shows", "Amélie #1 (100%).mp4"), "the film");
    const source = await add(join(dir, "Source"), "Films");

    const answer = await get(mediaFilePath(source.id, "Films & Shows/Amélie #1 (100%).mp4"));

    expect(answer.status).toBe(200);
    expect(answer.body.toString()).toBe("the film");
  });

  it("serves an empty Media File as empty", async () => {
    await mkdir(join(dir, "Source"));
    await writeFile(join(dir, "Source", "Empty.mp4"), "");
    const source = await add(join(dir, "Source"), "Films");

    expect((await get(mediaFilePath(source.id, "Empty.mp4"))).headers["content-length"]).toBe("0");
    expect((await get(mediaFilePath(source.id, "Empty.mp4"), { range: "bytes=0-" })).status).toBe(416);
  });

  it("serves a Media File symlinked from inside the Media Source", async () => {
    await mkdir(join(dir, "Source", "Films"), { recursive: true });
    await writeFile(join(dir, "Source", "Films", "Real.mp4"), "the film");
    await symlink(join(dir, "Source", "Films", "Real.mp4"), join(dir, "Source", "Linked.mp4"));
    const source = await add(join(dir, "Source"), "Films");

    expect((await get(mediaFilePath(source.id, "Linked.mp4"))).body.toString()).toBe("the film");
  });

  it("says when a Media File no longer exists, or the Media Source doesn't", async () => {
    const source = await add(media, "Media");

    const gone = await get(mediaFilePath(source.id, "Films/Gone.mp4"));
    expect(gone.status).toBe(404);
    expect(errorIn(gone)).toBe("That Media File no longer exists.");
    expect((await get(mediaFilePath(source.id + 1, "Films/Sci-Fi/Clip.mp4"))).status).toBe(404);
  });

  it("refuses other methods", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaFilePath(source.id, "Films/Sci-Fi/Clip.mp4"), {}, "DELETE");

    expect(answer.status).toBe(405);
    expect(answer.headers.allow).toBe("GET, HEAD");
  });

  describe("serving nothing but the Media Files in a Media Source (FR-5)", () => {
    /** A Media Source in `dir/Source`, beside `dir/Outside`, which has a Media File in it. */
    const besideOutside = async (): Promise<MediaSource> => {
      await mkdir(join(dir, "Source", "Films"), { recursive: true });
      await writeFile(join(dir, "Source", "Films", "Film.mp4"), "the film");
      await mkdir(join(dir, "Outside"), { recursive: true });
      await writeFile(join(dir, "Outside", "private.mp4"), "PRIVATE");
      return add(join(dir, "Source"), "Films");
    };

    const expectRefusedAsOutside = (answer: Answer): void => {
      expect(answer.status).toBe(403);
      expect(errorIn(answer)).toBe("That path is outside the Media Source.");
      expect(answer.body.toString()).not.toContain("PRIVATE");
    };

    it.each([
      ["../Outside/private.mp4", "/../Outside/private.mp4"],
      ["Films/../../Outside/private.mp4", "/Films/../../Outside/private.mp4"],
      ["far up", "/../../../../../../etc/passwd"],
      ["Films/../Films/Film.mp4, which stays inside", "/Films/../Films/Film.mp4"],
      ["./Films/Film.mp4", "/./Films/Film.mp4"],
    ])("refuses `%s`", async (_, rest) => {
      const source = await besideOutside();

      expectRefusedAsOutside(await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/file${rest}`));
    });

    it.each([
      ["%2e%2e", "/%2e%2e/Outside/private.mp4"],
      ["%2E%2E", "/%2E%2E/Outside/private.mp4"],
      [".%2e", "/.%2e/Outside/private.mp4"],
      ["..%2f with an encoded slash", "/..%2fOutside%2fprivate.mp4"],
      ["Films%2f..%2f..%2f", "/Films%2f..%2f..%2fOutside%2fprivate.mp4"],
      ["an encoded slash at the start", "/%2fetc%2fpasswd"],
      ["a NUL byte", "/Films/Film.mp4%00"],
    ])("refuses URL-encoded traversal: %s", async (_, rest) => {
      const source = await besideOutside();

      expectRefusedAsOutside(await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/file${rest}`));
    });

    it("refuses a malformed encoding", async () => {
      const source = await besideOutside();

      expect((await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/file/Films/%E0%A4%A.mp4`)).status).toBe(400);
    });

    it("refuses a symlinked Media File, or one in a symlinked folder, that points out", async () => {
      const source = await besideOutside();
      await symlink(join(dir, "Outside", "private.mp4"), join(dir, "Source", "Films", "Linked.mp4"));
      await symlink(join(dir, "Outside"), join(dir, "Source", "Escape"));
      await symlink("../../Outside/private.mp4", join(dir, "Source", "Films", "Up.mp4"));

      expectRefusedAsOutside(await get(mediaFilePath(source.id, "Films/Linked.mp4")));
      expectRefusedAsOutside(await get(mediaFilePath(source.id, "Escape/private.mp4")));
      expectRefusedAsOutside(await get(mediaFilePath(source.id, "Films/Up.mp4")));
    });

    it("refuses a path into another Media Source's folder from this one", async () => {
      const source = await besideOutside();
      await add(join(dir, "Outside"), "Other");

      expectRefusedAsOutside(await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/file/../Outside/private.mp4`));
    });

    it.each([
      ["a file that isn't a Media File", "notes.txt"],
      ["a hidden Media File", ".hidden.mp4"],
      ["a Media File in a hidden folder", ".private/Film.mp4"],
      ["a Media File in a NAS's own folder", "@eaDir/Film.mp4"],
      ["a folder", "Films"],
      ["a folder named like a Media File", "Folder.mp4"],
    ])("refuses %s, which browsing never shows", async (_, path) => {
      const source = await besideOutside();
      await writeFile(join(dir, "Source", "notes.txt"), "PRIVATE");
      await writeFile(join(dir, "Source", ".hidden.mp4"), "PRIVATE");
      await mkdir(join(dir, "Source", ".private"));
      await writeFile(join(dir, "Source", ".private", "Film.mp4"), "PRIVATE");
      await mkdir(join(dir, "Source", "@eaDir"));
      await writeFile(join(dir, "Source", "@eaDir", "Film.mp4"), "PRIVATE");
      await mkdir(join(dir, "Source", "Folder.mp4"));

      const answer = await get(mediaFilePath(source.id, path));

      expect(answer.status).toBe(404);
      expect(errorIn(answer)).toBe("That is not a Media File.");
    });

    it("serves nothing for the Media Source itself, with no file named", async () => {
      const source = await besideOutside();

      expect((await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/file`)).status).toBe(404);
      expect((await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/file/`)).status).toBe(404);
    });
  });
});

describe("a Media File's cover art (FR-47)", () => {
  /** What a picture is, as ffprobe says: its codec, size and, at its middle, its colour, as red, green and blue. */
  const pictureIn = async (
    bytes: Uint8Array,
  ): Promise<{ codec: string; width: number; height: number; rgb: readonly number[] }> => {
    const file = join(dir, "picture");
    await writeFile(file, bytes);
    const { stdout } = await run("ffprobe", [
      ...["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", file],
    ]);
    const [stream] = (JSON.parse(stdout) as { streams: { codec_name: string; width: number; height: number }[] })
      .streams;
    const { stdout: pixel } = await run(
      "ffmpeg",
      ["-v", "error", "-i", file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer" },
    );
    return { codec: stream?.codec_name ?? "", width: stream?.width ?? 0, height: stream?.height ?? 0, rgb: [...pixel] };
  };

  it("serves the cover art embedded in a FLAC, a PNG in it, as a JPEG taken out of the file", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaCoverArtPath(source.id, "Music/Album/01 Tone.flac"));

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/jpeg");
    expect(answer.headers["content-length"]).toBe(String(answer.body.length));
    const picture = await pictureIn(answer.body);
    expect(picture).toMatchObject({ codec: "mjpeg", width: COVER_ART_SIZE, height: COVER_ART_SIZE });
    // Red, as it is in the file, give or take JPEG's rounding.
    const [red = 0, green = 255, blue = 255] = picture.rgb;
    expect(red).toBeGreaterThan(200);
    expect(green).toBeLessThan(50);
    expect(blue).toBeLessThan(50);
  });

  it("answers HEAD with the headers alone", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaCoverArtPath(source.id, "Music/Album/01 Tone.flac"), {}, "HEAD");

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/jpeg");
    expect(Number(answer.headers["content-length"])).toBeGreaterThan(0);
    expect(answer.body.length).toBe(0);
  });

  it("scales down cover art larger than a TV shows it, to 720 pixels tall", async () => {
    await mkdir(join(dir, "Album"));
    await run("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1"],
      ...["-f", "lavfi", "-i", "color=c=blue:size=1500x1440:rate=1:duration=1", "-map", "0", "-map", "1"],
      ...["-c:a", "flac", "-c:v", "mjpeg", "-disposition:v", "attached_pic"],
      join(dir, "Album", "Large.flac"),
    ]);
    const source = await add(join(dir, "Album"), "Album");

    const answer = await get(mediaCoverArtPath(source.id, "Large.flac"));

    expect(answer.status).toBe(200);
    expect(await pictureIn(answer.body)).toMatchObject({ codec: "mjpeg", width: 750, height: 720 });
  });

  it.each([
    ["an untagged MP3", "Music/Album/02 Tone.mp3"],
    ["an ALAC M4A", "Music/Album/03 Tone.m4a"],
    ["a video", "Films/Sci-Fi/Clip.mp4"],
    ["a file ffprobe can't read", "Damaged.mp4"],
  ])("answers 404 for %s with no cover art", async (_, path) => {
    const source = await add(media, "Media");

    const answer = await get(mediaCoverArtPath(source.id, path));

    expect(answer.status).toBe(404);
    expect(errorIn(answer)).toBe(`"${path.split("/").at(-1) ?? ""}" has no cover art.`);
  });

  it("refuses other methods", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaCoverArtPath(source.id, "Music/Album/01 Tone.flac"), {}, "POST");

    expect(answer.status).toBe(405);
  });

  describe("serving nothing outside a Media Source, nor anything but its Media Files (FR-5)", () => {
    /** A Media Source in `dir/Source`, beside `dir/Outside`, which has a FLAC with cover art in it. */
    const besideOutside = async (): Promise<MediaSource> => {
      await mkdir(join(dir, "Source"), { recursive: true });
      await mkdir(join(dir, "Outside"), { recursive: true });
      await copyFile(join(media, "Music/Album/01 Tone.flac"), join(dir, "Outside", "private.flac"));
      await writeFile(join(dir, "Source", "cover.jpg"), "PRIVATE");
      return add(join(dir, "Source"), "Music");
    };

    it.each([
      ["../Outside/private.flac", "/../Outside/private.flac"],
      ["%2e%2e", "/%2e%2e/Outside/private.flac"],
      ["..%2f with an encoded slash", "/..%2fOutside%2fprivate.flac"],
    ])("refuses `%s`", async (_, rest) => {
      const source = await besideOutside();

      const answer = await get(`${MEDIA_SOURCES_PATH}/${String(source.id)}/cover-art${rest}`);

      expect(answer.status).toBe(403);
      expect(errorIn(answer)).toBe("That path is outside the Media Source.");
    });

    it("refuses a symlinked Media File that points out", async () => {
      const source = await besideOutside();
      await symlink(join(dir, "Outside", "private.flac"), join(dir, "Source", "Linked.flac"));

      expect((await get(mediaCoverArtPath(source.id, "Linked.flac"))).status).toBe(403);
    });

    it("refuses a file that isn't a Media File, such as a picture beside it", async () => {
      const source = await besideOutside();

      const answer = await get(mediaCoverArtPath(source.id, "cover.jpg"));

      expect(answer.status).toBe(404);
      expect(errorIn(answer)).toBe("That is not a Media File.");
    });
  });
});
