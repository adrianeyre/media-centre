import { describe, expect, it } from "vitest";

import { fakePlayback } from "./fake-playback.ts";
import { playbackControlIn, startingTracksIn } from "./playback-reports.ts";
import { parseSubtitles, showSubtitles, subtitleTextAt } from "./subtitles.ts";

/** The Hub that serves the Media Files. */
const HUB = "192.168.1.10:8080";
const FILM = `http://${HUB}/api/media-sources/1/file/Film.mkv`;
const ENGLISH = `http://${HUB}/api/media-sources/1/subtitle/Film.mkv?sidecar=Film.en.srt&format=subrip`;

describe("parsing subtitles", () => {
  it("reads SubRip, each cue by its times and text, its tags left out", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:04,500",
      "<i>Hello,</i>",
      '<font color="#ffffff">world.</font>',
      "",
      "2",
      "01:02:03,040 --> 01:02:05,000",
      "{\\an8}Up top.",
      "",
    ].join("\r\n");

    expect(parseSubtitles(`\uFEFF${srt}`)).toEqual([
      { startMs: 1_000, endMs: 4_500, text: "Hello,\nworld." },
      { startMs: 3_723_040, endMs: 3_725_000, text: "Up top." },
    ]);
  });

  it("reads WebVTT, with or without hours, ids and cue settings, skipping notes and styles", () => {
    const vtt = [
      "WEBVTT - the film",
      "",
      "NOTE made by ffmpeg",
      "",
      "STYLE",
      "::cue { color: yellow }",
      "",
      "intro",
      "00:01.500 --> 00:03.000 line:90% align:center",
      "Bonjour &amp; bienvenue.",
      "",
      "01:00:00.000 --> 01:00:01.000",
      "<v Narrator>Fin.",
    ].join("\n");

    expect(parseSubtitles(vtt)).toEqual([
      { startMs: 1_500, endMs: 3_000, text: "Bonjour & bienvenue." },
      { startMs: 3_600_000, endMs: 3_601_000, text: "Fin." },
    ]);
  });

  it("takes an empty file, or WebVTT with no cues, for no subtitles", () => {
    expect(parseSubtitles("")).toEqual([]);
    expect(parseSubtitles("WEBVTT\n")).toEqual([]);
  });

  it("doesn't read ASS, which the Hub converts to SubRip before it sends it (FR-45)", () => {
    const ass = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Bonjour.",
    ].join("\n");

    expect(parseSubtitles(ass)).toBeNull();
  });

  it("shows the text of every cue at a position, a line each, from its start up to its end", () => {
    const cues = [
      { startMs: 1_000, endMs: 3_000, text: "One" },
      { startMs: 2_000, endMs: 4_000, text: "Two" },
    ];

    expect(subtitleTextAt(cues, 999)).toBeNull();
    expect(subtitleTextAt(cues, 1_000)).toBe("One");
    expect(subtitleTextAt(cues, 2_500)).toBe("One\nTwo");
    expect(subtitleTextAt(cues, 3_000)).toBe("Two");
    expect(subtitleTextAt(cues, 4_000)).toBeNull();
  });
});

describe("showing subtitles", () => {
  const setUp = (files: Readonly<Record<string, string>>) => {
    const playback = fakePlayback();
    const shown: (string | null)[] = [];
    const subtitles = showSubtitles({
      playback,
      fetchText: (url) => {
        const file = files[url];
        return file === undefined ? Promise.reject(new Error("404")) : Promise.resolve(file);
      },
      show: (text) => shown.push(text),
    });
    return { playback, shown, subtitles };
  };

  it("shows the cue at the playback's position as it plays and seeks, only once it changes", async () => {
    const { playback, shown, subtitles } = setUp({ [ENGLISH]: "1\n00:00:10,000 --> 00:00:20,000\nHello.\n" });
    subtitles.offer([ENGLISH]);
    await playback.load(FILM);

    await subtitles.select(0);
    playback.reach(12_000);
    playback.reach(15_000);
    await playback.seekTo(30_000);

    expect(shown).toEqual(["Hello.", null]);
    expect(subtitles.track()).toBe(0);
  });

  it("refuses a track it wasn't offered, or has none to read of, or can't read, showing what it showed before", async () => {
    const { playback, subtitles } = setUp({ [ENGLISH]: "1\n00:00:10,000 --> 00:00:20,000\nHello.\n" });
    // The Hub sends no URL for a track it burns into the picture.
    subtitles.offer([ENGLISH, `${ENGLISH}-gone`, ""]);
    await playback.load(FILM);
    await subtitles.select(0);
    playback.reach(12_000);

    await expect(subtitles.select(3)).rejects.toThrow("There is no subtitle track 4 to read.");
    await expect(subtitles.select(2)).rejects.toThrow("There is no subtitle track 3 to read.");
    await expect(subtitles.select(1)).rejects.toThrow("404");

    expect(subtitles.track()).toBe(0);
    expect(subtitles.text()).toBe("Hello.");
  });

  it("forgets the tracks offered once the playback is idle", async () => {
    const { playback, subtitles } = setUp({ [ENGLISH]: "1\n00:00:10,000 --> 00:00:20,000\nHello.\n" });
    subtitles.offer([ENGLISH]);
    await playback.load(FILM);
    await subtitles.select(0);

    playback.stop();

    expect(subtitles.track()).toBeNull();
    await expect(subtitles.select(0)).rejects.toThrow("There is no subtitle track 1 to read.");
  });
});

describe("a subtitle-track control from the Hub", () => {
  it("is a track by its place, or null for Off", () => {
    expect(playbackControlIn({ action: "subtitle-track", track: 2 })).toEqual({ action: "subtitle-track", track: 2 });
    expect(playbackControlIn({ action: "subtitle-track", track: null })).toEqual({
      action: "subtitle-track",
      track: null,
    });
  });

  it("is none the Player knows without a track it can show", () => {
    expect(playbackControlIn({ action: "subtitle-track" })).toBeNull();
    expect(playbackControlIn({ action: "subtitle-track", track: -1 })).toBeNull();
    expect(playbackControlIn({ action: "subtitle-track", track: 1.5 })).toBeNull();
    expect(playbackControlIn({ action: "subtitle-track", track: "1" })).toBeNull();
  });
});

describe("the tracks a play message from the Hub starts with (FR-45)", () => {
  it("are an audio track and a subtitle track by their places, or null for no subtitles", () => {
    expect(startingTracksIn({ type: "play", url: "x", audioTrack: 1, subtitleTrack: 2 })).toEqual({
      audioTrack: 1,
      subtitleTrack: 2,
    });
    expect(startingTracksIn({ type: "play", url: "x", subtitleTrack: null })).toEqual({});
  });

  it("are none it doesn't know, as from a Hub older or newer than the Player", () => {
    expect(startingTracksIn({ type: "play", url: "x" })).toEqual({});
    expect(startingTracksIn({ type: "play", url: "x", audioTrack: -1, subtitleTrack: 1.5 })).toEqual({});
    expect(startingTracksIn({ type: "play", url: "x", audioTrack: "1", subtitleTrack: "2" })).toEqual({});
  });
});
