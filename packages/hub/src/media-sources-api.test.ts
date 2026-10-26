import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile, appendFile, unlink } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MEDIA_SOURCES_PATH,
  mediaFolderPath,
  mediaSourcePath,
  type HubError,
  type MediaFolder,
  type MediaSource,
  type Route,
} from "@media-centre/shared";

import { applianceStore } from "./appliances.ts";
import { openDatabase } from "./database.ts";
import { ffprobeMedia, NO_TAGS, type MediaProbe, type ProbeMedia } from "./ffprobe.ts";
import { createHub } from "./hub.ts";
import { SAMPLE_MEDIA_FILES, SAMPLE_ROUTES, makeTestMediaSource } from "./testing/media.ts";

/** One test Media Source, generated once with ffmpeg and only read by the tests. */
let media: string;
/** A folder beside it, outside any Media Source, for each test to fill. */
let dir: string;
let database: DatabaseSync;
let hub: Server;
let base: string;
/** Every file the Hub has asked for the duration of, in order. */
let probed: string[];
/** Folders a test has locked, unlocked again after it so they can be removed. */
let locked: string[];

beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), "hub-media-source-"));
  await makeTestMediaSource(media);
});

afterAll(async () => {
  await rm(media, { recursive: true, force: true });
});

/** Starts a Hub on `database`, which asks `probe` for durations, counting what it asks for. */
const startHub = async (probe: ProbeMedia = ffprobeMedia): Promise<void> => {
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    probeMedia: (file) => {
      probed.push(file);
      return probe(file);
    },
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
};

/** What ffprobe would say of a Media File of `duration` seconds, with no streams. */
const lasting = (duration: number): MediaProbe => ({
  container: "matroska",
  duration,
  startTime: 0,
  streams: [],
  tags: NO_TAGS,
});

const stopHub = async (): Promise<void> => {
  await new Promise((done) => hub.close(done));
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-media-test-"));
  probed = [];
  locked = [];
  database = openDatabase(":memory:");
  await startHub();
});

afterEach(async () => {
  await stopHub();
  database.close();
  for (const folder of locked) await chmod(folder, 0o700);
  await rm(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

/**
 * Sends `path` exactly as written, as `fetch` would not: it tidies `..` and
 * `%2e%2e` away before sending, as a browser does, but anything else on the
 * network may send them.
 */
const sendAsWritten = (path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const { port } = hub.address() as AddressInfo;
    httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    })
      .on("error", reject)
      .end();
  });

const list = async (): Promise<MediaSource[]> =>
  (await (await send("GET", MEDIA_SOURCES_PATH)).json()) as MediaSource[];

const add = async (path: string, name?: string): Promise<MediaSource> => {
  const response = await send("POST", MEDIA_SOURCES_PATH, name === undefined ? { path } : { name, path });
  expect(response.status).toBe(201);
  return (await response.json()) as MediaSource;
};

const browse = async (id: number, folder = "", tvId?: number): Promise<MediaFolder> => {
  const response = await send("GET", mediaFolderPath(id, folder, tvId));
  expect(response.status).toBe(200);
  return (await response.json()) as MediaFolder;
};

/** Takes every permission from `folder` until the test ends, as if it were another user's. */
const lock = async (folder: string): Promise<void> => {
  await chmod(folder, 0o000);
  locked.push(folder);
};

/** Expects the Hub to refuse, and returns the message it gave the person. */
const refusal = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as HubError).error;
};

describe("the Hub's Media Sources", () => {
  it("start empty", async () => {
    expect(await list()).toEqual([]);
  });

  describe("adding", () => {
    it("adds a folder by its full path, with the name given, in name order", async () => {
      await mkdir(join(dir, "Music"));
      const films = await add(media, "Films");
      const music = await add(join(dir, "Music"), "  Albums  ");

      expect(films).toEqual({ id: expect.any(Number) as number, name: "Films", path: media });
      expect(music.name).toBe("Albums");
      expect(await list()).toEqual([music, films]);
    });

    it("names a Media Source after its folder when no name is given", async () => {
      await mkdir(join(dir, "Home videos"));

      expect((await add(join(dir, "Home videos"))).name).toBe("Home videos");
      await mkdir(join(dir, "Films"));
      expect((await add(join(dir, "Films"), "")).name).toBe("Films");
    });

    it("keeps the folder's path tidied, without a trailing slash or a `..`", async () => {
      await mkdir(join(dir, "Films"));

      expect((await add(`${dir}/x/../Films/`, "Films")).path).toBe(join(dir, "Films"));
    });

    it("refuses a path that doesn't exist, saying so", async () => {
      const missing = join(dir, "Nowhere");

      expect(await refusal(await send("POST", MEDIA_SOURCES_PATH, { path: missing }), 400)).toBe(
        `There is no folder at "${missing}".`,
      );
      expect(await list()).toEqual([]);
    });

    it("refuses a file, which isn't a folder", async () => {
      const file = join(dir, "film.mp4");
      await writeFile(file, "");

      expect(await refusal(await send("POST", MEDIA_SOURCES_PATH, { path: file }), 400)).toBe(
        `"${file}" is a file, not a folder.`,
      );
    });

    it("refuses a folder the Hub can't read", async () => {
      const folder = join(dir, "Locked");
      await mkdir(folder);
      await lock(folder);

      expect(await refusal(await send("POST", MEDIA_SOURCES_PATH, { path: folder }), 403)).toBe(
        `The Hub can't read "${folder}". Let the user the Hub runs as read it.`,
      );
    });

    it("refuses a folder inside one the Hub can't open", async () => {
      await mkdir(join(dir, "Locked", "Films"), { recursive: true });
      await lock(join(dir, "Locked"));

      expect((await send("POST", MEDIA_SOURCES_PATH, { path: join(dir, "Locked", "Films") })).status).toBe(403);
    });

    it.each([
      ["a relative path", "Films"],
      ["an empty path", "  "],
    ])("refuses %s, asking for the full one", async (_, path) => {
      expect(await refusal(await send("POST", MEDIA_SOURCES_PATH, { path }), 400)).toBe(
        "Give the folder's full path, as the Hub sees it, e.g. /media/films.",
      );
    });

    it.each([
      ["no body", null],
      ["no path", { name: "Films" }],
      ["a path that is not text", { path: 7 }],
    ])("refuses a request with %s", async (_, body) => {
      expect((await send("POST", MEDIA_SOURCES_PATH, body)).status).toBe(400);
    });

    it("refuses the same folder twice, naming the Media Source it already is", async () => {
      await add(media, "Films");

      expect(await refusal(await send("POST", MEDIA_SOURCES_PATH, { path: `${media}/`, name: "Again" }), 409)).toBe(
        `"${media}" is already the Media Source "Films".`,
      );
    });

    it("refuses a name another Media Source has, ignoring case", async () => {
      await mkdir(join(dir, "Other"));
      await add(media, "Films");

      expect(
        await refusal(await send("POST", MEDIA_SOURCES_PATH, { path: join(dir, "Other"), name: "films" }), 409),
      ).toBe('There is already a Media Source called "Films".');
    });

    it("refuses a name longer than 40 characters", async () => {
      expect(await refusal(await send("POST", MEDIA_SOURCES_PATH, { path: media, name: "x".repeat(41) }), 400)).toBe(
        "A Media Source's name can be at most 40 characters; that one has 41.",
      );
    });
  });

  describe("renaming and removing", () => {
    it("renames a Media Source, keeping its folder", async () => {
      const films = await add(media, "Films");

      const response = await send("PATCH", mediaSourcePath(films.id), { name: "Cinema" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...films, name: "Cinema" });
      expect(await list()).toEqual([{ ...films, name: "Cinema" }]);
    });

    it("refuses to rename one to an empty name or another's", async () => {
      await mkdir(join(dir, "Music"));
      const films = await add(media, "Films");
      await add(join(dir, "Music"), "Music");

      expect(await refusal(await send("PATCH", mediaSourcePath(films.id), { name: " " }), 400)).toBe(
        "Give the Media Source a name.",
      );
      expect((await send("PATCH", mediaSourcePath(films.id), { name: "MUSIC" })).status).toBe(409);
      expect((await send("PATCH", mediaSourcePath(films.id), { name: "FILMS" })).status).toBe(200);
    });

    it("removes a Media Source, but never its files", async () => {
      const films = await add(media, "Films");

      expect((await send("DELETE", mediaSourcePath(films.id))).status).toBe(204);

      expect(await list()).toEqual([]);
      expect(await refusal(await send("GET", mediaFolderPath(films.id, "")), 404)).toBe(
        "That Media Source no longer exists.",
      );
      expect((await stat(join(media, "Films", "Sci-Fi", "Clip.mp4"))).isFile()).toBe(true);
    });

    it("refuses to rename or remove one that no longer exists", async () => {
      expect((await send("PATCH", mediaSourcePath(99), { name: "Films" })).status).toBe(404);
      expect((await send("DELETE", mediaSourcePath(99))).status).toBe(404);
    });
  });

  describe("browsing", () => {
    it("lists the Media Source's own folder: its folders, and its Media Files with size and duration", async () => {
      const source = await add(media, "Films");

      const root = await browse(source.id);

      expect(root).toEqual({
        mediaSourceId: source.id,
        path: "",
        folders: ["Films", "Music"],
        files: [{ name: "Damaged.mp4", kind: "video", size: 18, duration: null, route: null }],
      });
    });

    it("lists a folder inside it by its path, with durations from ffprobe", async () => {
      const source = await add(media, "Films");

      const album = await browse(source.id, "Music/Album");
      const films = await browse(source.id, "Films");

      expect(album.path).toBe("Music/Album");
      expect(album.folders).toEqual([]);
      expect(album.files.map(({ name, kind }) => [name, kind])).toEqual([
        ["01 Tone.flac", "audio"],
        ["02 Tone.mp3", "audio"],
        ["03 Tone.m4a", "audio"],
      ]);
      expect(films.folders).toEqual(["Sci-Fi"]);
      // Film.mkv's sidecar subtitle files are no Media Files, so aren't listed.
      expect(films.files.map(({ name, kind }) => [name, kind])).toEqual([
        ["Concert.mkv", "video"],
        ["Film.mkv", "video"],
        ["Home Video.avi", "video"],
        ["Opera.mkv", "video"],
        ["Recording.mkv", "video"],
        ["Trailer.mkv", "video"],
      ]);
      for (const folder of [album, films]) {
        for (const file of folder.files) {
          const path = `${folder.path}/${file.name}` as keyof typeof SAMPLE_MEDIA_FILES;
          expect(file.size).toBe((await stat(join(media, path))).size);
          expect(file.duration).toBeCloseTo(SAMPLE_MEDIA_FILES[path], 0);
          // No TV was named, so no Route.
          expect(file.route).toBeNull();
        }
      }
    });

    it("says each Media File's Route to the TV it is asked for with, from what ffprobe says of it (FR-34)", async () => {
      const source = await add(media, "Films");
      const tv = applianceStore(database).add(
        {
          kind: "tv",
          name: "TV",
          roomId: null,
          address: "127.0.0.2",
          model: "QE55Q80TATXXU",
          macAddress: "02:00:00:00:00:02",
        },
        "token",
      );

      const routes: Record<string, Route | null> = {};
      for (const folder of ["", "Films", "Films/Sci-Fi", "Music/Album"]) {
        for (const file of (await browse(source.id, folder, tv.id)).files) {
          routes[[folder, file.name].filter((name) => name !== "").join("/")] = file.route;
        }
      }

      expect(routes).toEqual({ ...SAMPLE_ROUTES, "Damaged.mp4": null });
      // Every Route is there, and Full Conversion with them.
      expect(new Set(Object.values(SAMPLE_ROUTES))).toEqual(
        new Set(["direct-play", "remux", "audio-conversion", "full-conversion"]),
      );
    });

    it("says no Route for a TV that is no longer there", async () => {
      const source = await add(media, "Films");

      const films = await browse(source.id, "Films", 99);

      expect(films.files.map(({ route }) => route)).toEqual([null, null, null, null, null, null]);
    });

    it("hides other files, and hidden files and folders", async () => {
      await writeFile(join(dir, "film.mkv"), "");
      await writeFile(join(dir, "notes.txt"), "");
      await writeFile(join(dir, "subtitles.srt"), "");
      await writeFile(join(dir, ".secret.mp4"), "");
      await mkdir(join(dir, ".Trash"));
      await mkdir(join(dir, "@eaDir"));
      await mkdir(join(dir, "Shows"));
      const source = await add(dir, "Mixed");

      const shown = await browse(source.id);

      expect(shown.folders).toEqual(["Shows"]);
      expect(shown.files.map((file) => file.name)).toEqual(["film.mkv"]);
    });

    it("lists names as a person would sort them", async () => {
      for (const name of ["Episode 10.mkv", "episode 2.mkv", "Episode 1.mkv"]) await writeFile(join(dir, name), "");
      for (const name of ["Season 10", "Season 9"]) await mkdir(join(dir, name));
      const source = await add(dir, "Show");

      const shown = await browse(source.id);

      expect(shown.folders).toEqual(["Season 9", "Season 10"]);
      expect(shown.files.map((file) => file.name)).toEqual(["Episode 1.mkv", "episode 2.mkv", "Episode 10.mkv"]);
    });

    it("finds folders whose names need encoding in a URL", async () => {
      const name = "Rock & Roll? 100% #1 Ünïcödé";
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "Song.flac"), "");
      const source = await add(dir, "Music");

      expect((await browse(source.id)).folders).toEqual([name]);
      expect((await browse(source.id, name)).files.map((file) => file.name)).toEqual(["Song.flac"]);
    });

    it("says when a folder no longer exists, or is a file", async () => {
      const source = await add(media, "Films");

      expect(await refusal(await send("GET", mediaFolderPath(source.id, "Gone")), 404)).toBe(
        "That folder no longer exists.",
      );
      expect(await refusal(await send("GET", mediaFolderPath(source.id, "readme.txt")), 404)).toBe(
        "That is a file, not a folder.",
      );
    });

    it("says when it can't read a folder in the Media Source", async () => {
      await mkdir(join(dir, "Private"));
      const source = await add(dir, "Home");
      await lock(join(dir, "Private"));

      expect(await refusal(await send("GET", mediaFolderPath(source.id, "Private")), 403)).toBe(
        "The Hub can't read that folder.",
      );
    });

    it("says when the Media Source's own folder has gone, e.g. a share not mounted", async () => {
      await mkdir(join(dir, "Share"));
      const source = await add(join(dir, "Share"), "NAS");
      await rm(join(dir, "Share"), { recursive: true });

      expect(await refusal(await send("GET", mediaFolderPath(source.id, "")), 404)).toBe(
        `The Hub can't find "${join(dir, "Share")}", the folder of the Media Source "NAS". If it's a network share, check it is mounted.`,
      );
    });

    it("follows symlinks that stay inside the Media Source", async () => {
      await mkdir(join(dir, "Source", "Films"), { recursive: true });
      await writeFile(join(dir, "Source", "Films", "Clip.mp4"), "");
      await symlink(join(dir, "Source", "Films"), join(dir, "Source", "Favourites"));
      await symlink(join(dir, "Source", "Films", "Clip.mp4"), join(dir, "Source", "Best.mp4"));
      const source = await add(join(dir, "Source"), "Films");

      const root = await browse(source.id);

      expect(root.folders).toEqual(["Favourites", "Films"]);
      expect(root.files.map((file) => file.name)).toEqual(["Best.mp4"]);
      expect((await browse(source.id, "Favourites")).files.map((file) => file.name)).toEqual(["Clip.mp4"]);
    });

    it("browses a Media Source whose own folder is a symlink", async () => {
      await mkdir(join(dir, "Real"));
      await writeFile(join(dir, "Real", "Clip.mp4"), "");
      await symlink(join(dir, "Real"), join(dir, "Linked"));
      const source = await add(join(dir, "Linked"), "Linked");

      expect((await browse(source.id)).files.map((file) => file.name)).toEqual(["Clip.mp4"]);
    });

    it("refuses other methods", async () => {
      const source = await add(media, "Films");

      expect((await send("POST", mediaFolderPath(source.id, ""), {})).status).toBe(405);
    });
  });

  // FR-5: nothing outside a Media Source is ever listed, whichever way it is asked for.
  describe("refusing paths outside a Media Source", () => {
    /** A Media Source in `dir/Source`, beside `dir/Outside`, which has a Media File in it. */
    const besideOutside = async (): Promise<MediaSource> => {
      await mkdir(join(dir, "Source", "Films"), { recursive: true });
      await mkdir(join(dir, "Outside", "Secret"), { recursive: true });
      await writeFile(join(dir, "Outside", "private.mp4"), "");
      return add(join(dir, "Source"), "Films");
    };

    const expectRefusedAsOutside = ({ status, body }: { status: number; body: string }): void => {
      expect(status).toBe(403);
      expect((JSON.parse(body) as HubError).error).toBe("That path is outside the Media Source.");
      expect(body).not.toContain("private.mp4");
      expect(body).not.toContain("Secret");
    };

    it.each([
      ["..", "/.."],
      ["../Outside", "/../Outside"],
      ["Films/../..", "/Films/../.."],
      ["../.. far up", "/../../../../../../etc"],
      ["Films/../Films, which stays inside", "/Films/../Films"],
      [".", "/."],
    ])("refuses `%s`", async (_, rest) => {
      const source = await besideOutside();

      expectRefusedAsOutside(await sendAsWritten(`${mediaFolderPath(source.id, "")}${rest}`));
    });

    it.each([
      ["%2e%2e", "/%2e%2e"],
      ["%2E%2E/Outside", "/%2E%2E/Outside"],
      [".%2e", "/.%2e/Outside"],
      ["..%2fOutside, with an encoded slash", "/..%2fOutside"],
      ["Films%2f..%2f..%2fOutside", "/Films%2f..%2f..%2fOutside"],
      ["%2e%2e%2f%2e%2e%2fetc", "/%2e%2e%2f%2e%2e%2fetc"],
      ["an encoded slash at the start", "/%2fetc"],
      ["a NUL byte", "/Films%00"],
    ])("refuses URL-encoded traversal: %s", async (_, rest) => {
      const source = await besideOutside();

      expectRefusedAsOutside(await sendAsWritten(`${mediaFolderPath(source.id, "")}${rest}`));
    });

    it("finds no folder for a doubly-encoded `..`, which is only a strange name", async () => {
      const source = await besideOutside();

      const { status, body } = await sendAsWritten(`${mediaFolderPath(source.id, "")}/%252e%252e/Outside`);

      expect(status).toBe(404);
      expect(body).not.toContain("private.mp4");
    });

    it("refuses a malformed encoding", async () => {
      const source = await besideOutside();

      expect((await sendAsWritten(`${mediaFolderPath(source.id, "")}/%E0%A4%A`)).status).toBe(400);
    });

    it("refuses a symlinked folder that points out, and doesn't list it", async () => {
      const source = await besideOutside();
      await symlink(join(dir, "Outside"), join(dir, "Source", "Escape"));
      await symlink(join(dir, "Outside"), join(dir, "Source", "Films", "Deeper escape"));

      expect((await browse(source.id)).folders).toEqual(["Films"]);
      expect((await browse(source.id, "Films")).folders).toEqual([]);
      expectRefusedAsOutside(await sendAsWritten(mediaFolderPath(source.id, "Escape")));
      expectRefusedAsOutside(await sendAsWritten(mediaFolderPath(source.id, "Escape/Secret")));
      expectRefusedAsOutside(await sendAsWritten(mediaFolderPath(source.id, "Films/Deeper escape")));
    });

    it("doesn't list or probe a symlinked Media File that points out", async () => {
      const source = await besideOutside();
      await symlink(join(dir, "Outside", "private.mp4"), join(dir, "Source", "Films", "Linked.mp4"));
      await symlink(join(dir, "Outside", "private.mp4"), join(dir, "Source", "Films", "Linked folder.mp4"));

      expect((await browse(source.id, "Films")).files).toEqual([]);
      expect(probed).toEqual([]);
    });

    it("refuses a relative symlink that climbs out", async () => {
      const source = await besideOutside();
      await symlink("../../Outside", join(dir, "Source", "Films", "Up"));

      expectRefusedAsOutside(await sendAsWritten(mediaFolderPath(source.id, "Films/Up")));
    });

    it("hides a symlink that points nowhere, or round in a loop", async () => {
      const source = await besideOutside();
      await symlink(join(dir, "Nowhere"), join(dir, "Source", "Dangling"));
      await symlink(join(dir, "Source", "Loop"), join(dir, "Source", "Loop"));

      expect((await browse(source.id)).folders).toEqual(["Films"]);
      expect((await sendAsWritten(mediaFolderPath(source.id, "Loop"))).status).toBe(404);
    });

    it("refuses a path into another Media Source's folder from this one", async () => {
      const source = await besideOutside();
      await add(join(dir, "Outside"), "Other");

      expectRefusedAsOutside(await sendAsWritten(`${mediaFolderPath(source.id, "")}/../Outside`));
    });
  });

  describe("durations", () => {
    it("probes each Media File once, and not again while its size and modified time stay the same", async () => {
      const source = await add(media, "Films");

      const first = await browse(source.id, "Music/Album");
      expect(probed.toSorted()).toEqual([
        join(media, "Music/Album/01 Tone.flac"),
        join(media, "Music/Album/02 Tone.mp3"),
        join(media, "Music/Album/03 Tone.m4a"),
      ]);

      expect(await browse(source.id, "Music/Album")).toEqual(first);
      expect(probed).toHaveLength(3);
    });

    it("keeps a file ffprobe can't read as having no duration, without probing it again", async () => {
      const source = await add(media, "Films");

      await browse(source.id);
      await browse(source.id);

      expect(probed).toEqual([join(media, "Damaged.mp4")]);
    });

    it("probes again a Media File whose modified time or size has changed, and only that one", async () => {
      await writeFile(join(dir, "A.mp4"), "a");
      await writeFile(join(dir, "B.mp4"), "b");
      await writeFile(join(dir, "C.mp4"), "c");
      const source = await add(dir, "Films");
      await browse(source.id);
      probed = [];

      const later = new Date(Date.now() + 60_000);
      await utimes(join(dir, "A.mp4"), later, later);
      await browse(source.id);
      expect(probed).toEqual([join(dir, "A.mp4")]);

      const { mtime } = await stat(join(dir, "B.mp4"));
      await appendFile(join(dir, "B.mp4"), "more");
      await utimes(join(dir, "B.mp4"), mtime, mtime);
      await browse(source.id);
      expect(probed).toEqual([join(dir, "A.mp4"), join(dir, "B.mp4")]);
    });

    it("doesn't probe a large folder again when it is browsed again, even by a restarted Hub", async () => {
      const count = 300;
      for (let index = 0; index < count; index += 1) await writeFile(join(dir, `Episode ${String(index)}.mkv`), "");
      const file = join(dir, "hub.sqlite");
      await stopHub();
      database.close();
      database = openDatabase(file);
      await startHub(() => Promise.resolve(lasting(1_234.5)));
      const source = await add(dir, "Show");

      const first = await browse(source.id);
      expect(first.files).toHaveLength(count);
      expect(first.files.every((media) => media.duration === 1_234.5)).toBe(true);
      expect(probed).toHaveLength(count);

      await browse(source.id);
      await stopHub();
      database.close();
      database = openDatabase(file);
      await startHub(() => Promise.reject(new Error("Not again")));
      const afterRestart = await browse(source.id);

      expect(afterRestart).toEqual(first);
      expect(probed).toHaveLength(count);
    });

    it("runs a few ffprobes at a time, however many files need probing", async () => {
      for (let index = 0; index < 40; index += 1) await writeFile(join(dir, `${String(index)}.mp3`), "");
      let running = 0;
      let most = 0;
      await stopHub();
      await startHub(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((done) => setTimeout(done, 5));
        running -= 1;
        return lasting(60);
      });
      const source = await add(dir, "Music");

      await Promise.all([browse(source.id), browse(source.id)]);

      expect(most).toBe(4);
      // Both Remotes' browsing shared each probe.
      expect(probed).toHaveLength(40);
    });

    it("tries again next time when ffprobe couldn't be run, rather than keeping no duration", async () => {
      await writeFile(join(dir, "Clip.mp4"), "");
      await stopHub();
      let runs = false;
      await startHub(() => (runs ? Promise.resolve(lasting(42)) : Promise.reject(new Error("spawn ffprobe ENOENT"))));
      const source = await add(dir, "Films");

      expect((await browse(source.id)).files[0]?.duration).toBeNull();
      runs = true;
      expect((await browse(source.id)).files[0]?.duration).toBe(42);
      expect(probed).toHaveLength(2);
    });

    it("forgets the duration of a file no longer there, so a new one by that name is probed", async () => {
      await writeFile(join(dir, "Clip.mp4"), "x");
      const source = await add(dir, "Films");
      const { mtime } = await stat(join(dir, "Clip.mp4"));
      await browse(source.id);

      await unlink(join(dir, "Clip.mp4"));
      await browse(source.id);
      expect(database.prepare("SELECT count(*) AS kept FROM media_file_probe").get()).toEqual({ kept: 0 });

      await writeFile(join(dir, "Clip.mp4"), "y");
      await utimes(join(dir, "Clip.mp4"), mtime, mtime);
      await browse(source.id);
      expect(probed).toHaveLength(2);
    });

    it("forgets the durations of a Media Source removed", async () => {
      const source = await add(media, "Films");
      await browse(source.id, "Music/Album");

      await send("DELETE", mediaSourcePath(source.id));

      expect(database.prepare("SELECT count(*) AS kept FROM media_file_probe").get()).toEqual({ kept: 0 });
    });
  });
});
