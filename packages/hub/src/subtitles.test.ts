import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MEDIA_SOURCES_PATH,
  mediaSourcePath,
  mediaSubtitlePath,
  type HubError,
  type MediaSource,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { SAMSUNG_TV_PLAYABLE_FORMATS } from "./drivers/samsung-tv/playable-formats.ts";
import { ffprobeMedia, NO_TAGS } from "./ffprobe.ts";
import { createHub } from "./hub.ts";
import { sidecarSubtitle, sidecarSubtitlesOf, subtitleFormatFor, subtitlesOf } from "./subtitles.ts";
import {
  FILM_SUBTITLES,
  FILM_SUBTITLE_TRACKS,
  makeTestMediaSource,
  OPERA_SUBTITLE,
  OPERA_SUBTITLE_TRACKS,
} from "./testing/media.ts";

const FILM = "Films/Film.mkv";
/** A SubRip in English of its own, then PGS and VobSub, at indexes 3 and 4. */
const OPERA = "Films/Opera.mkv";
const TV_FORMATS = SAMSUNG_TV_PLAYABLE_FORMATS;

/** One test Media Source, generated once with ffmpeg and only read by the tests. */
let media: string;
/** A folder for each test to fill, outside any Media Source. */
let dir: string;
let database: DatabaseSync;
let hub: Server;
let base: string;

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-subtitles-"));
  await makeTestMediaSource(media);
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-subtitles-test-"));
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
  readonly text: string;
}

/** Sends `path` exactly as written, as `fetch` would not: it tidies `..` away before sending. */
const get = (path: string, method = "GET"): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const { port } = hub.address() as AddressInfo;
    httpRequest({ host: "127.0.0.1", port, path, method }, (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
      });
    })
      .on("error", reject)
      .end();
  });

const errorIn = ({ text }: Answer): string => (JSON.parse(text) as HubError).error;

describe("sidecar subtitle files (FR-44)", () => {
  it.each([
    ["Film.srt", { language: null, title: null, codec: "subrip" }],
    ["Film.en.srt", { language: "en", title: null, codec: "subrip" }],
    ["Film.fr.ass", { language: "fr", title: null, codec: "ass" }],
    ["Film.eng.vtt", { language: "eng", title: null, codec: "webvtt" }],
    ["Film.pt-BR.srt", { language: "pt-br", title: null, codec: "subrip" }],
    ["Film.en.forced.srt", { language: "en", title: "forced", codec: "subrip" }],
    ["Film.SDH.en.srt", { language: "en", title: "SDH", codec: "subrip" }],
    ["Film.Director's cut.srt", { language: null, title: "Director's cut", codec: "subrip" }],
    ["film.EN.SRT", { language: "en", title: null, codec: "subrip" }],
  ])("matches %s to Film.mkv, by its name, with its language from its suffix", (name, track) => {
    expect(sidecarSubtitle(name, "Film.mkv")).toEqual({ ...track, sidecar: name, burnedIn: false });
  });

  it.each([
    ["another Media File's", "Other.en.srt"],
    ["one whose name only starts the same", "Filmography.srt"],
    ["a format that isn't a sidecar's", "Film.en.sub"],
    ["a hidden file", ".Film.en.srt"],
    ["a text file", "Film.txt"],
  ])("doesn't match %s to Film.mkv", (_, name) => {
    expect(sidecarSubtitle(name, "Film.mkv")).toBeNull();
  });

  it("finds them beside the Media File, in name order, and leaves another's to it", async () => {
    await mkdir(join(dir, "Films"));
    for (const name of [
      "Film.mkv",
      "Film.fr.ass",
      "Film.en.srt",
      "Film.Extended.mkv",
      "Film.Extended.en.srt",
      "Film.txt",
      "Other.en.srt",
    ]) {
      await writeFile(join(dir, "Films", name), "");
    }
    const source = await add(dir, "Media");

    const names = async (file: string): Promise<(string | null)[]> =>
      (await sidecarSubtitlesOf(source, ["Films", file])).map(({ track }) => track.sidecar);

    expect(await names("Film.mkv")).toEqual(["Film.en.srt", "Film.fr.ass"]);
    expect(await names("Film.Extended.mkv")).toEqual(["Film.Extended.en.srt"]);
  });

  it("finds none in a folder that has gone", async () => {
    const source = await add(dir, "Media");

    expect(await sidecarSubtitlesOf(source, ["Gone", "Film.mkv"])).toEqual([]);
  });
});

describe("a Media File's subtitle tracks (FR-44)", () => {
  it("are its own text subtitle tracks, in its order, with their languages, then its sidecar files", async () => {
    const source = await add(media, "Media");
    const probe = await ffprobeMedia(join(media, FILM));

    const tracks = subtitlesOf(probe, await sidecarSubtitlesOf(source, FILM.split("/")), TV_FORMATS);

    expect(tracks.map(({ track }) => track)).toEqual(FILM_SUBTITLE_TRACKS);
    expect(tracks.map(({ source: from }) => from)).toEqual([
      { stream: 2 },
      { stream: 3 },
      { sidecar: "Film.en.srt" },
      { sidecar: "Film.fr.ass" },
    ]);
  });

  it("are its image subtitles too, PGS and VobSub, which a Samsung TV can't render, to be burned in (FR-45)", async () => {
    const source = await add(media, "Media");
    const probe = await ffprobeMedia(join(media, OPERA));

    const tracks = subtitlesOf(probe, await sidecarSubtitlesOf(source, OPERA.split("/")), TV_FORMATS);

    expect(tracks.map(({ track }) => track)).toEqual(OPERA_SUBTITLE_TRACKS);
    expect(tracks.map(({ source: from }) => from)).toEqual([{ stream: 2 }, { stream: 3 }, { stream: 4 }]);
  });

  it("leave out image subtitles a TV renders itself, which it is sent as text tracks are, and other streams", () => {
    const probe = {
      container: "matroska",
      duration: 60,
      startTime: 0,
      tags: NO_TAGS,
      streams: [
        { index: 0, type: "video", codec: "h264", attachedPicture: false, language: null, title: null, channels: null },
        {
          index: 1,
          type: "subtitle",
          codec: "hdmv_pgs_subtitle",
          attachedPicture: false,
          language: "eng",
          title: null,
          channels: null,
        },
        {
          index: 2,
          type: "subtitle",
          codec: "mov_text",
          attachedPicture: false,
          language: "fre",
          title: null,
          channels: null,
        },
      ],
    } as const;

    expect(subtitlesOf(probe, [], TV_FORMATS).map(({ track }) => track)).toEqual([
      { language: "eng", title: null, codec: "hdmv_pgs_subtitle", sidecar: null, burnedIn: true },
      { language: "fre", title: null, codec: "mov_text", sidecar: null, burnedIn: false },
    ]);
    // A TV that renders PGS needs none burned in, so isn't sent any to, as the Player renders only text.
    const rendersPgs = { ...TV_FORMATS, subtitles: [...TV_FORMATS.subtitles, "hdmv_pgs_subtitle"] };
    expect(subtitlesOf(probe, [], rendersPgs).map(({ track }) => track.codec)).toEqual(["mov_text"]);
  });

  it("are sent the Player in their own format if it renders it, and as SubRip otherwise (FR-45)", () => {
    const rendered = ["subrip", "webvtt"];

    expect(subtitleFormatFor("subrip", rendered)).toBe("subrip");
    expect(subtitleFormatFor("webvtt", rendered)).toBe("webvtt");
    expect(subtitleFormatFor("ass", rendered)).toBe("subrip");
    expect(subtitleFormatFor("mov_text", rendered)).toBe("subrip");
    expect(subtitleFormatFor("webvtt", ["subrip"])).toBe("subrip");
  });
});

describe("a subtitle track's URL, for the Player (FR-44, FR-45)", () => {
  it("serves a sidecar SubRip file as it is, which any page may read", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { sidecar: "Film.en.srt" }, "subrip"));

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/x-subrip; charset=utf-8");
    expect(answer.headers["access-control-allow-origin"]).toBe("*");
    expect(answer.text).toBe(await readFile(join(media, "Films/Film.en.srt"), "utf8"));
  });

  it("converts a sidecar ASS file, which the Player can't render, to SubRip before it is sent", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { sidecar: "Film.fr.ass" }, "subrip"));

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/x-subrip; charset=utf-8");
    expect(answer.text).not.toContain("[Script Info]");
    expect(answer.text.trim().split("\n")).toEqual([
      "1",
      "00:00:00,000 --> 00:01:00,000",
      `<i>${FILM_SUBTITLES[3]}</i>`,
    ]);
  });

  it("converts to WebVTT when asked", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { sidecar: "Film.en.srt" }, "webvtt"));

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(answer.text).toMatch(/^WEBVTT\n/);
    expect(answer.text).toContain(`00:00.000 --> 01:00.000\n${FILM_SUBTITLES[2]}`);
  });

  it.each([
    [2, FILM_SUBTITLES[0]],
    [3, `<i>${FILM_SUBTITLES[1]}</i>`],
  ])("takes the Media File's own text subtitle stream %i out of it, as SubRip", async (stream, text) => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { stream }, "subrip"));

    expect(answer.status).toBe(200);
    expect(answer.text).toMatch(/^1\n00:00:00,0\d\d --> 00:01:00,0\d\d\n/);
    expect(answer.text).toContain(text);
  });

  it("takes the text subtitle stream out of a Media File with image subtitles too, and refuses those, which are burned in (FR-45)", async () => {
    const source = await add(media, "Media");

    const text = await get(mediaSubtitlePath(source.id, OPERA, { stream: 2 }, "subrip"));
    expect(text.status).toBe(200);
    expect(text.text).toContain(OPERA_SUBTITLE);

    for (const stream of [3, 4]) {
      expect((await get(mediaSubtitlePath(source.id, OPERA, { stream }, "subrip"))).status).toBe(404);
    }
  });

  it("answers HEAD with no body", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { sidecar: "Film.en.srt" }, "subrip"), "HEAD");

    expect(answer.status).toBe(200);
    expect(Number(answer.headers["content-length"])).toBeGreaterThan(0);
    expect(answer.text).toBe("");
  });

  it.each([
    ["a stream that isn't a subtitle track", { stream: 1 }],
    ["a stream it hasn't got", { stream: 9 }],
    ["another file beside it", { sidecar: "Film.txt" }],
    ["another Media File's sidecar", { sidecar: "Trailer.en.srt" }],
    ["a sidecar that isn't there", { sidecar: "Film.de.srt" }],
  ])("refuses %s with 404", async (_, from) => {
    await mkdir(join(dir, "Films"));
    await copyFile(join(media, FILM), join(dir, FILM));
    await writeFile(join(dir, "Films/Film.txt"), "notes");
    await writeFile(join(dir, "Films/Trailer.en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nNo.\n");
    const source = await add(dir, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, from, "subrip"));

    expect(answer.status).toBe(404);
    expect(answer.text).not.toContain("notes");
  });

  it.each([
    ["no format", "?sidecar=Film.en.srt"],
    ["a format it doesn't serve", "?sidecar=Film.en.srt&format=ass"],
    ["no track", "?format=subrip"],
    ["a stream and a sidecar both", "?stream=2&sidecar=Film.en.srt&format=subrip"],
    ["a stream that isn't a number", "?stream=two&format=subrip"],
  ])("refuses a request with %s with 400", async (_, query) => {
    const source = await add(media, "Media");

    const answer = await get(`${mediaSourcePath(source.id)}/subtitle/Films/Film.mkv${query}`);

    expect(answer.status).toBe(400);
    expect(errorIn(answer)).toBeTruthy();
  });

  it("refuses a sidecar that is a symlink pointing outside the Media Source (FR-5)", async () => {
    await mkdir(join(dir, "Source", "Films"), { recursive: true });
    await copyFile(join(media, FILM), join(dir, "Source", FILM));
    await writeFile(join(dir, "secret.srt"), "1\n00:00:00,000 --> 00:00:01,000\nSecret.\n");
    await symlink(join(dir, "secret.srt"), join(dir, "Source/Films/Film.en.srt"));
    const source = await add(join(dir, "Source"), "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { sidecar: "Film.en.srt" }, "subrip"));

    expect(answer.status).toBe(403);
    expect(errorIn(answer)).toBe("That path is outside the Media Source.");
    expect(answer.text).not.toContain("Secret");
  });

  it.each([
    ["..", "/subtitle/Films/../../secret.mkv?sidecar=secret.srt&format=subrip"],
    ["an encoded ..", "/subtitle/Films/%2e%2e/%2e%2e/secret.mkv?sidecar=secret.srt&format=subrip"],
    ["a sidecar named with ..", "/subtitle/Films/Film.mkv?sidecar=..%2F..%2Fsecret.srt&format=subrip"],
  ])("refuses a path that leads outside the Media Source through %s", async (_, rest) => {
    await mkdir(join(dir, "Source", "Films"), { recursive: true });
    await copyFile(join(media, FILM), join(dir, "Source", FILM));
    await writeFile(join(dir, "secret.srt"), "1\n00:00:00,000 --> 00:00:01,000\nSecret.\n");
    const source = await add(join(dir, "Source"), "Media");

    const answer = await get(`${mediaSourcePath(source.id)}${rest}`);

    expect([403, 404]).toContain(answer.status);
    expect(answer.text).not.toContain("Secret");
  });

  it("refuses the subtitles of something that isn't a Media File", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, "readme.txt", { sidecar: "readme.srt" }, "subrip"));

    expect(answer.status).toBe(404);
  });

  it("refuses other methods", async () => {
    const source = await add(media, "Media");

    const answer = await get(mediaSubtitlePath(source.id, FILM, { sidecar: "Film.en.srt" }, "subrip"), "PUT");

    expect(answer.status).toBe(405);
  });
});
