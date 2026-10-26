import { beforeEach, describe, expect, it } from "vitest";

import { avplayPlayback } from "./avplay-playback.ts";
import type { Playback, PlaybackEvent } from "./playback.ts";
import { standInAVPlay, type StandInAVPlay } from "./testing/stand-in-avplay.ts";

/** The Hub that serves the Media Files. */
const HUB = "192.168.1.10:8080";
const FILM = `http://${HUB}/media/film.mkv`;
const SONG = `http://${HUB}/media/song.flac`;

let avplay: StandInAVPlay;
let playback: Playback;
let events: PlaybackEvent[];

beforeEach(() => {
  avplay = standInAVPlay();
  playback = avplayPlayback(avplay);
  events = [];
  playback.subscribe((event) => events.push(event));
});

const callNames = (): string[] => avplay.calls.map(([name]) => name);

// AVPlay exists only on a TV, so these hold the Player to how Samsung
// documents it, on a stand-in; that it plays is proven on a real TV (PRD §10).
describe("AVPlay's playback", () => {
  it("opens the Media File, full screen behind the page, and prepares it", async () => {
    await playback.load(FILM);

    expect(avplay.calls).toEqual([
      ["open", FILM],
      ["setDisplayRect", 0, 0, 1920, 1080],
      ["setListener"],
      ["prepareAsync"],
    ]);
  });

  it("stops and closes what it has before opening another", async () => {
    await playback.load(FILM);
    playback.play();
    avplay.calls.length = 0;

    await playback.load(SONG);

    expect(callNames()).toEqual(["stop", "close", "open", "setDisplayRect", "setListener", "prepareAsync"]);
    expect(avplay.calls[2]).toEqual(["open", SONG]);
  });

  it("plays, pauses, seeks to whole milliseconds and stops through AVPlay", async () => {
    await playback.load(FILM);
    avplay.calls.length = 0;

    playback.play();
    playback.pause();
    await playback.seekTo(1234.6);
    playback.stop();

    expect(avplay.calls).toEqual([["play"], ["pause"], ["seekTo", 1235], ["stop"], ["close"]]);
    expect(avplay.getState()).toBe("NONE");
  });

  it("is idle again, with AVPlay closed, when a Media File won't prepare", async () => {
    avplay.prepareOutcome = new Error("PLAYER_ERROR_NOT_SUPPORTED_FILE");

    await expect(playback.load(FILM)).rejects.toThrow("PLAYER_ERROR_NOT_SUPPORTED_FILE");

    expect(playback.state()).toBe("idle");
    expect(avplay.getState()).toBe("NONE");
  });

  it("closes what AVPlay already has open, e.g. from before the Player started, before opening the Media File", async () => {
    avplay.open(FILM);
    avplay.calls.length = 0;

    await playback.load(SONG);

    expect(callNames().slice(0, 3)).toEqual(["stop", "close", "open"]);
    expect(playback.state()).toBe("paused");
  });

  it("closes AVPlay even when it refuses to stop, as in a state it can't stop in", async () => {
    const refusing = avplayPlayback({
      ...avplay,
      stop: () => {
        throw new Error("InvalidStateError");
      },
    });
    avplay.open(FILM);

    await refusing.load(SONG);

    expect(refusing.state()).toBe("paused");
    expect(callNames()).toContain("close");
  });

  it("is idle again when AVPlay won't open the Media File at all", async () => {
    const refusing = avplayPlayback({
      ...avplay,
      open: () => {
        throw new Error("TypeMismatchError");
      },
    });

    await expect(refusing.load("not a url")).rejects.toThrow("TypeMismatchError");

    expect(refusing.state()).toBe("idle");
  });

  it("passes on the position as AVPlay plays", async () => {
    await playback.load(FILM);
    playback.play();

    avplay.listener().oncurrentplaytime?.(42_000);

    expect(events.at(-1)).toEqual({ type: "position", positionMs: 42_000 });
  });

  it("is idle, with AVPlay closed, once the Media File has played to the end", async () => {
    await playback.load(FILM);
    playback.play();

    avplay.listener().onstreamcompleted?.();

    expect(playback.state()).toBe("idle");
    expect(avplay.getState()).toBe("NONE");
    expect(events.slice(-2)).toEqual([{ type: "state", state: "idle" }, { type: "ended" }]);
  });

  it("is idle, with AVPlay closed, when AVPlay stops with an error", async () => {
    await playback.load(FILM);
    playback.play();

    avplay.listener().onerror?.("PLAYER_ERROR_CONNECTION_FAILED");

    expect(playback.state()).toBe("idle");
    expect(avplay.getState()).toBe("NONE");
    expect(events.at(-1)).toEqual({ type: "error", message: "AVPlay stopped with PLAYER_ERROR_CONNECTION_FAILED." });
  });

  it("ignores a Media File replaced while it prepared, and what AVPlay says of it", async () => {
    avplay.prepareOutcome = "held";
    const film = playback.load(FILM);
    const filmListener = avplay.listener();
    const song = playback.load(SONG);

    avplay.finishPrepare("success");
    avplay.finishPrepare("success");
    filmListener.onstreamcompleted?.();

    await expect(film).rejects.toThrow("Another Media File was loaded instead.");
    await expect(song).resolves.toBeUndefined();
    expect(playback.state()).toBe("paused");
    expect(events.filter(({ type }) => type === "ended")).toEqual([]);
  });

  it("says nothing is loaded while it is still preparing, and nothing of a length AVPlay doesn't know", async () => {
    avplay.prepareOutcome = "held";
    const loading = playback.load(FILM);
    expect(playback.durationMs()).toBeNull();

    avplay.finishPrepare("success");
    await loading;
    expect(playback.durationMs()).toBe(5_400_000);
  });

  it("says which audio track it plays by its place among AVPlay's audio tracks, not by AVPlay's index", async () => {
    expect(playback.audioTrack()).toBeNull();

    await playback.load(FILM);

    expect(playback.audioTrack()).toBe(0);
  });

  it("switches audio track by its place among AVPlay's audio tracks, keeping its position (FR-36)", async () => {
    await playback.load(FILM);
    playback.play();
    await playback.seekTo(754_000);
    avplay.calls.length = 0;

    playback.selectAudioTrack(1);

    // The second audio track, which AVPlay has at index 3.
    expect(avplay.calls).toEqual([["setSelectTrack", "AUDIO", 3]]);
    expect(playback.audioTrack()).toBe(1);
    expect(playback.positionMs()).toBe(754_000);
    expect(playback.state()).toBe("playing");
  });

  it("refuses an audio track AVPlay hasn't got, or one with nothing loaded, playing on as it was", async () => {
    expect(() => {
      playback.selectAudioTrack(0);
    }).toThrow("Nothing is loaded");

    await playback.load(FILM);
    playback.play();

    expect(() => {
      playback.selectAudioTrack(2);
    }).toThrow("AVPlay has no audio track 3.");
    expect(playback.audioTrack()).toBe(0);
    expect(playback.state()).toBe("playing");
  });

  it("says it doesn't know which audio track it plays when AVPlay won't say", async () => {
    await playback.load(FILM);
    avplay.tracks = [];

    expect(playback.audioTrack()).toBeNull();
  });
});
