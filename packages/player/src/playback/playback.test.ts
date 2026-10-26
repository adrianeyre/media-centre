import { afterEach, describe, expect, it, vi } from "vitest";

import { avplayPlayback } from "./avplay-playback.ts";
import { FAKE_DURATION_MS, fakePlayback } from "./fake-playback.ts";
import type { Playback, PlaybackEvent } from "./playback.ts";
import { standInAVPlay } from "./testing/stand-in-avplay.ts";

/** The Hub that serves the Media Files. */
const HUB = "192.168.1.10:8080";
const FILM = `http://${HUB}/media/film.mkv`;

// What every playback implementation does, whichever it is (ADR 0005): the
// fake the Player's UI is tested against, and AVPlay, here on a stand-in for
// the TV's own.
describe.each([
  ["the fake playback", fakePlayback],
  ["AVPlay's playback", () => avplayPlayback(standInAVPlay())],
] satisfies [string, () => Playback][])("%s", (_, make) => {
  const recording = (): { playback: Playback; events: PlaybackEvent[] } => {
    const playback = make();
    const events: PlaybackEvent[] = [];
    playback.subscribe((event) => events.push(event));
    return { playback, events };
  };

  it("starts idle, with nothing loaded", () => {
    const playback = make();

    expect(playback.state()).toBe("idle");
    expect(playback.durationMs()).toBeNull();
  });

  it("loads a Media File, ready to play from the start, paused", async () => {
    const { playback, events } = recording();

    const loading = playback.load(FILM);
    expect(playback.state()).toBe("loading");
    await loading;

    expect(playback.state()).toBe("paused");
    expect(playback.durationMs()).toBeGreaterThan(0);
    expect(events).toEqual([
      { type: "state", state: "loading" },
      { type: "state", state: "paused" },
    ]);
  });

  it("plays and pauses what is loaded", async () => {
    const { playback, events } = recording();
    await playback.load(FILM);

    playback.play();
    expect(playback.state()).toBe("playing");
    playback.pause();
    expect(playback.state()).toBe("paused");

    expect(events.slice(2)).toEqual([
      { type: "state", state: "playing" },
      { type: "state", state: "paused" },
    ]);
  });

  it("does nothing on play or pause with nothing loaded", () => {
    const { playback, events } = recording();

    playback.play();
    playback.pause();

    expect(playback.state()).toBe("idle");
    expect(events).toEqual([]);
  });

  it("seeks in what is loaded, and refuses to with nothing", async () => {
    const playback = make();
    await expect(playback.seekTo(1_000)).rejects.toThrow();

    await playback.load(FILM);
    await expect(playback.seekTo(60_000)).resolves.toBeUndefined();
  });

  it("says how far in it is: from the start once loaded, where it seeked to, and 0 with nothing loaded", async () => {
    const playback = make();
    expect(playback.positionMs()).toBe(0);

    await playback.load(FILM);
    expect(playback.positionMs()).toBe(0);
    await playback.seekTo(30_000);
    expect(playback.positionMs()).toBe(30_000);

    playback.stop();
    expect(playback.positionMs()).toBe(0);
  });

  it("stops, leaving nothing loaded", async () => {
    const { playback, events } = recording();
    await playback.load(FILM);
    playback.play();

    playback.stop();

    expect(playback.state()).toBe("idle");
    expect(playback.durationMs()).toBeNull();
    expect(events.at(-1)).toEqual({ type: "state", state: "idle" });
  });

  it("plays its first audio track once loaded, switches to another, and has none with nothing loaded", async () => {
    const playback = make();
    expect(playback.audioTrack()).toBeNull();
    expect(() => {
      playback.selectAudioTrack(1);
    }).toThrow();

    await playback.load(FILM);
    playback.play();
    expect(playback.audioTrack()).toBe(0);
    playback.selectAudioTrack(1);

    expect(playback.audioTrack()).toBe(1);
    expect(playback.state()).toBe("playing");
    playback.stop();
    expect(playback.audioTrack()).toBeNull();
  });

  it("tells a listener nothing more once it unsubscribes", async () => {
    const playback = make();
    const events: PlaybackEvent[] = [];
    const unsubscribe = playback.subscribe((event) => events.push(event));

    unsubscribe();
    await playback.load(FILM);

    expect(events).toEqual([]);
  });
});

describe("the fake playback", () => {
  it("can be made to refuse a Media File, as a TV would one it can't play", async () => {
    const playback = fakePlayback();
    playback.refuse("Unsupported codec");

    await expect(playback.load(FILM)).rejects.toThrow("Unsupported codec");

    expect(playback.state()).toBe("idle");
    expect(playback.loaded).toEqual([FILM]);
  });

  it("can be told how far it has played, and that it has finished", async () => {
    const playback = fakePlayback();
    const events: PlaybackEvent[] = [];
    playback.subscribe((event) => events.push(event));
    await playback.load(FILM);
    playback.play();

    playback.reach(30_000);
    playback.finish();

    expect(events.slice(3)).toEqual([
      { type: "position", positionMs: 30_000 },
      { type: "state", state: "idle" },
      { type: "ended" },
    ]);
  });

  describe("playing in real time, as the fake TV's fake Player does", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("moves on as it plays, not while paused, and finishes at the end", async () => {
      vi.useFakeTimers();
      const playback = fakePlayback({ tickMs: 500 });
      const events: PlaybackEvent[] = [];
      await playback.load(FILM);
      playback.subscribe((event) => events.push(event));

      playback.play();
      vi.advanceTimersByTime(1_000);
      expect(playback.positionMs()).toBe(1_000);
      expect(events.at(-1)).toEqual({ type: "position", positionMs: 1_000 });

      playback.pause();
      vi.advanceTimersByTime(5_000);
      expect(playback.positionMs()).toBe(1_000);

      playback.play();
      vi.advanceTimersByTime(FAKE_DURATION_MS);
      expect(playback.state()).toBe("idle");
      expect(events.at(-1)).toEqual({ type: "ended" });
    });

    it("stops at either end when it seeks past it", async () => {
      const playback = fakePlayback({ tickMs: 500 });
      await playback.load(FILM);

      await playback.seekTo(-5_000);
      expect(playback.positionMs()).toBe(0);
      await playback.seekTo(FAKE_DURATION_MS + 5_000);
      expect(playback.positionMs()).toBe(FAKE_DURATION_MS);
    });
  });
});
