import { getByRole, queryByRole, queryByText } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAYER_SOCKET_PATH,
  type HubToPlayerMessage,
  type MusicDetails,
  type PlaybackControl,
  type PlayerPlayback,
  type PlayerToHubMessage,
  type ResumableMediaFile,
} from "@media-centre/shared";

import { OVERLAY_SHOWN_MS } from "./playback-overlay.ts";
import { FAKE_DURATION_MS, fakePlayback, type FakePlayback } from "./playback/fake-playback.ts";
import { COULDNT_PLAY, startPlayer, type Player } from "./player.ts";
import { rememberedHub, type RememberedHub } from "./remembered-hub.ts";
import { BACK_KEY_CODE } from "./remote-keys.ts";
import { fakeSockets } from "./testing/fake-sockets.ts";
import { formatPosition } from "./waiting-screen.ts";

const HUB = "192.168.1.10:8080";

type PlaybackReport = Extract<PlayerToHubMessage, { readonly type: "playback" }>;

let root: HTMLElement;
let storage: Map<string, string>;
let remembered: RememberedHub;
let sockets: ReturnType<typeof fakeSockets>;
let playback: FakePlayback;
let player: Player | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("main");
  document.body.appendChild(root);
  storage = new Map();
  remembered = rememberedHub({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  });
  sockets = fakeSockets();
  playback = fakePlayback();
});

afterEach(() => {
  player?.stop();
  player = undefined;
  root.remove();
  vi.useRealTimers();
});

const start = (launchedWith: string | null): Player => {
  player = startPlayer({ root, launchedWith, rememberedHub: remembered, openSocket: sockets.openSocket, playback });
  return player;
};

/** Where the Player opens its socket to the Hub at this address. */
const socketUrl = (address: string): string => `ws://${address}${PLAYER_SOCKET_PATH}`;

const heading = (): HTMLElement => getByRole(root, "heading", { level: 1 });
const status = (): HTMLElement => getByRole(root, "status");
const urls = (): string[] => sockets.opened.map(({ url }) => url);

describe("the Player", () => {
  it("launched with the Hub's address, connects to the Hub there, and remembers it", () => {
    start("192.168.1.10:8080");

    expect(urls()).toEqual([socketUrl("192.168.1.10:8080")]);
    expect(rememberedHub({ getItem: (key) => storage.get(key) ?? null, setItem: vi.fn() }).address()).toBe(
      "192.168.1.10:8080",
    );
  });

  it("opened from the app list, uses the address it remembers and shows it waiting for the Remote", () => {
    remembered.remember("192.168.1.10:8080");

    start(null);

    expect(heading().textContent).toBe("Waiting for the Remote");
    expect(root.textContent).toContain("Hub: 192.168.1.10:8080");
    expect(root.textContent).toContain("Choose a Media File for this TV on the Remote.");
    expect(urls()).toEqual([socketUrl("192.168.1.10:8080")]);
  });

  it("launched with a new address, uses that rather than the one it remembers", () => {
    remembered.remember("192.168.1.10:8080");

    start("192.168.1.20:8080");

    expect(root.textContent).toContain("Hub: 192.168.1.20:8080");
    expect(urls()).toEqual([socketUrl("192.168.1.20:8080")]);
    expect(remembered.address()).toBe("192.168.1.20:8080");
  });

  it("with no address at all, says so while waiting for the Remote, and connects to nothing", () => {
    start(null);

    expect(heading().textContent).toBe("Waiting for the Remote");
    expect(root.textContent).toContain("This TV hasn't been given the Hub's address yet.");
    expect(queryByText(root, /^Hub:/)?.hidden).toBe(true);
    expect(status().textContent).toBe("");
    expect(sockets.opened).toEqual([]);
  });

  it("says whether it can reach the Hub, as its connection comes and goes", () => {
    start("192.168.1.10:8080");
    expect(status().textContent).toBe("Connecting to the Hub…");

    sockets.opened[0]?.accept();
    expect(status().textContent).toBe("Connected to the Hub");

    sockets.opened[0]?.drop();
    expect(status().textContent).toBe("Can't reach the Hub. Trying again…");

    vi.advanceTimersByTime(1_000);
    sockets.opened[1]?.accept();
    expect(status().textContent).toBe("Connected to the Hub");
  });

  it("launched again while running with another address, moves to that Hub", () => {
    const running = start(null);
    expect(sockets.opened).toEqual([]);

    running.launched("192.168.1.30:8080");

    expect(urls()).toEqual([socketUrl("192.168.1.30:8080")]);
    expect(root.textContent).toContain("Hub: 192.168.1.30:8080");

    running.launched("192.168.1.31:8080");

    expect(sockets.opened[0]?.closed()).toBe(true);
    expect(urls()).toEqual([socketUrl("192.168.1.30:8080"), socketUrl("192.168.1.31:8080")]);
    expect(remembered.address()).toBe("192.168.1.31:8080");
  });

  it("launched again with the same address, or none, keeps its connection", () => {
    const running = start("192.168.1.10:8080");
    sockets.opened[0]?.accept();

    running.launched("192.168.1.10:8080");
    running.launched(null);

    expect(sockets.opened).toHaveLength(1);
    expect(sockets.opened[0]?.closed()).toBe(false);
  });

  it("shows the waiting screen only while it plays nothing", async () => {
    start("192.168.1.10:8080");
    expect(root.hidden).toBe(false);

    await playback.load(`http://${HUB}/media/film.mp4`);
    playback.play();
    expect(root.hidden).toBe(true);

    playback.finish();
    expect(root.hidden).toBe(false);
    expect(heading().textContent).toBe("Waiting for the Remote");
  });

  describe("playing what the Hub sends it (FR-35)", () => {
    const FILM = `http://${HUB}/api/media-sources/1/file/Films/Arrival.mkv`;
    const SHORT = `http://${HUB}/api/media-sources/1/file/Films/Short.mp4`;

    /** Starts it connected to the Hub, and returns how to send it a message as the Hub. */
    const connected = (): ((message: HubToPlayerMessage) => void) => {
      start(HUB);
      sockets.opened[0]?.accept();
      return (message) => sockets.opened[0]?.receive(JSON.stringify(message));
    };

    const alert = (): HTMLElement => getByRole(root, "alert", { hidden: true });

    it("plays the Media File at the URL it is sent, from the start, hiding the waiting screen", async () => {
      const send = connected();

      send({ type: "play", url: FILM, positionMs: 0 });

      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      expect(playback.loaded).toEqual([FILM]);
      expect(root.hidden).toBe(true);
    });

    it("plays the next Media File it is sent in place of the one playing", async () => {
      const send = connected();
      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });

      send({ type: "play", url: SHORT, positionMs: 0 });

      await vi.waitFor(() => {
        expect(playback.loaded).toEqual([FILM, SHORT]);
      });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
    });

    it("says so on the waiting screen when the TV couldn't play it, until it is sent another", async () => {
      const send = connected();
      playback.refuse("AVPlay couldn't open the Media File");

      send({ type: "play", url: FILM, positionMs: 0 });

      await vi.waitFor(() => {
        expect(alert().textContent).toBe(COULDNT_PLAY);
      });
      expect(alert().hidden).toBe(false);
      expect(root.hidden).toBe(false);
      expect(heading().textContent).toBe("Waiting for the Remote");

      playback.refuse(null);
      send({ type: "play", url: SHORT, positionMs: 0 });

      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      expect(alert().hidden).toBe(true);
    });

    it("says so when the TV stops playing it partway", async () => {
      const send = connected();
      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });

      playback.fail("AVPlay stopped with PLAYER_ERROR_CONNECTION_FAILED.");

      expect(root.hidden).toBe(false);
      expect(alert().textContent).toBe(COULDNT_PLAY);
    });

    it.each([
      ["a page's script", "javascript:alert(1)"],
      ["a file on the TV", "file:///etc/passwd"],
      ["no address at all", "http:///nowhere"],
    ])("plays nothing it is sent with a URL that isn't the Hub's: %s", async (_, url) => {
      const send = connected();

      send({ type: "play", url, positionMs: 0 });
      await Promise.resolve();

      expect(playback.loaded).toEqual([]);
    });

    it("ignores a message it doesn't know, from a newer Hub", () => {
      connected();

      sockets.opened[0]?.receive(JSON.stringify({ type: "seek", positionMs: 1_000 }));
      sockets.opened[0]?.receive("not JSON");

      expect(playback.loaded).toEqual([]);
    });
  });

  describe("its playback, controlled from the Hub and reported back to it (FR-36)", () => {
    const FILM = `http://${HUB}/api/media-sources/1/file/Films/Arrival.mkv`;
    const POSITION_REPORT_MS = 1_000;

    /** Starts it connected to the Hub, playing the film, and returns how to send it a message as the Hub. */
    const playing = async (): Promise<(message: HubToPlayerMessage) => void> => {
      player = startPlayer({
        root,
        launchedWith: HUB,
        rememberedHub: remembered,
        openSocket: sockets.openSocket,
        playback,
        positionReportMs: POSITION_REPORT_MS,
      });
      sockets.opened[0]?.accept();
      const send = (message: HubToPlayerMessage): void => sockets.opened[0]?.receive(JSON.stringify(message));
      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      return send;
    };

    /** Every report the Player sent the Hub on its first socket, oldest first. */
    const reports = (): PlayerPlayback[] =>
      (sockets.opened[0]?.sent as PlayerToHubMessage[])
        .filter((message): message is PlaybackReport => message.type === "playback")
        .map(({ playback: reported }) => reported);
    const lastReport = (): PlayerPlayback | undefined => reports().at(-1);
    const control = (send: (message: HubToPlayerMessage) => void, sent: PlaybackControl): void => {
      send({ type: "control", control: sent });
    };

    it("tells the Hub it plays nothing as it connects", () => {
      start(HUB);
      sockets.opened[0]?.accept();

      expect(reports()).toEqual([
        { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null, subtitleTrack: null },
      ]);
    });

    it("tells the Hub as it loads and plays the Media File, with its length", async () => {
      await playing();

      expect(reports()).toEqual([
        { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null, subtitleTrack: null },
        { state: "loading", url: FILM, positionMs: 0, durationMs: null, audioTrack: null, subtitleTrack: null },
        { state: "paused", url: FILM, positionMs: 0, durationMs: FAKE_DURATION_MS, audioTrack: 0, subtitleTrack: null },
        {
          state: "playing",
          url: FILM,
          positionMs: 0,
          durationMs: FAKE_DURATION_MS,
          audioTrack: 0,
          subtitleTrack: null,
        },
      ]);
    });

    it("tells the Hub its position as it plays, at most every second", async () => {
      await playing();
      const before = reports().length;

      playback.reach(500);
      vi.advanceTimersByTime(400);
      playback.reach(900);
      expect(reports()).toHaveLength(before);

      vi.advanceTimersByTime(600);
      playback.reach(1_500);

      expect(reports()).toHaveLength(before + 1);
      expect(lastReport()).toEqual({
        state: "playing",
        url: FILM,
        positionMs: 1_500,
        durationMs: FAKE_DURATION_MS,
        audioTrack: 0,
        subtitleTrack: null,
      });
    });

    it("pauses and plays as the Hub asks, telling it each time", async () => {
      const send = await playing();

      control(send, { action: "pause" });
      await vi.waitFor(() => {
        expect(lastReport()?.state).toBe("paused");
      });
      expect(playback.state()).toBe("paused");

      control(send, { action: "play" });
      await vi.waitFor(() => {
        expect(lastReport()?.state).toBe("playing");
      });
      expect(playback.state()).toBe("playing");
    });

    it("seeks as the Hub asks, and tells it where it is now", async () => {
      const send = await playing();

      control(send, { action: "seek", positionMs: 42_000 });

      await vi.waitFor(() => {
        expect(lastReport()?.positionMs).toBe(42_000);
      });
      expect(playback.positionMs()).toBe(42_000);
    });

    it("skips from where it is, back or forward, stopping at either end", async () => {
      const send = await playing();
      playback.reach(20_000);

      control(send, { action: "skip", byMs: 10_000 });
      await vi.waitFor(() => {
        expect(playback.positionMs()).toBe(30_000);
      });
      control(send, { action: "skip", byMs: -30_000 });
      await vi.waitFor(() => {
        expect(playback.positionMs()).toBe(0);
      });
      control(send, { action: "skip", byMs: FAKE_DURATION_MS * 2 });
      await vi.waitFor(() => {
        expect(playback.positionMs()).toBe(FAKE_DURATION_MS);
      });
      expect(lastReport()?.positionMs).toBe(FAKE_DURATION_MS);
    });

    it("switches audio track as the Hub asks, from where it is, and tells it which it plays now", async () => {
      const send = await playing();
      playback.reach(42_000);

      control(send, { action: "audio-track", track: 1 });

      await vi.waitFor(() => {
        expect(lastReport()?.audioTrack).toBe(1);
      });
      expect(playback.audioTrack()).toBe(1);
      expect(lastReport()).toMatchObject({ state: "playing", url: FILM, positionMs: 42_000 });
    });

    it("plays a Media File it is sent with an audio track from the start, as when it is sent again by another Route", async () => {
      const send = await playing();

      send({ type: "play", url: FILM, positionMs: 42_000, audioTrack: 2 });

      await vi.waitFor(() => {
        expect(lastReport()).toMatchObject({ state: "playing", url: FILM, positionMs: 42_000, audioTrack: 2 });
      });
      expect(playback.audioTrack()).toBe(2);
    });

    describe("subtitles (FR-36, FR-44)", () => {
      const ENGLISH = `http://${HUB}/api/media-sources/1/subtitle/Films/Arrival.mkv?sidecar=Arrival.en.srt&format=subrip`;
      const FRENCH = `http://${HUB}/api/media-sources/1/subtitle/Films/Arrival.mkv?sidecar=Arrival.fr.ass&format=subrip`;
      const FILES: Readonly<Record<string, string>> = {
        [ENGLISH]: "1\n00:00:40,000 --> 00:00:45,000\n<i>Hello.</i>\n\n2\n00:00:50,000 --> 00:00:55,000\nGoodbye.\n",
        [FRENCH]: "WEBVTT\n\n00:40.000 --> 00:45.000 line:90%\nBonjour.\n",
      };
      let subtitlesRoot: HTMLElement;
      let fetched: string[];

      /** Starts it connected to the Hub, playing the film with its subtitle tracks, and returns how to send it a message. */
      const playingWithSubtitles = async (
        files: Readonly<Record<string, string>> = FILES,
      ): Promise<(message: HubToPlayerMessage) => void> => {
        subtitlesRoot = document.createElement("div");
        document.body.appendChild(subtitlesRoot);
        fetched = [];
        player = startPlayer({
          root,
          launchedWith: HUB,
          rememberedHub: remembered,
          openSocket: sockets.openSocket,
          playback,
          subtitlesRoot,
          fetchText: (url) => {
            fetched.push(url);
            const file = files[url];
            return file === undefined ? Promise.reject(new Error("404")) : Promise.resolve(file);
          },
        });
        sockets.opened[0]?.accept();
        const send = (message: HubToPlayerMessage): void => sockets.opened[0]?.receive(JSON.stringify(message));
        send({ type: "play", url: FILM, positionMs: 0, subtitles: [ENGLISH, FRENCH] });
        await vi.waitFor(() => {
          expect(playback.state()).toBe("playing");
        });
        return send;
      };

      afterEach(() => {
        subtitlesRoot.remove();
      });

      it("shows none until the Hub asks, and reads none from it", async () => {
        await playingWithSubtitles();
        playback.reach(42_000);

        expect(subtitlesRoot.hidden).toBe(true);
        expect(lastReport()?.subtitleTrack).toBeNull();
        expect(fetched).toEqual([]);
      });

      it("shows the subtitle track the Hub asks for, read from the Hub, at its position, and tells the Hub", async () => {
        const send = await playingWithSubtitles();
        playback.reach(42_000);

        control(send, { action: "subtitle-track", track: 0 });

        await vi.waitFor(() => {
          expect(lastReport()?.subtitleTrack).toBe(0);
        });
        expect(fetched).toEqual([ENGLISH]);
        expect(subtitlesRoot.hidden).toBe(false);
        expect(subtitlesRoot.textContent).toBe("Hello.");
        playback.reach(47_000);
        expect(subtitlesRoot.hidden).toBe(true);
        playback.reach(52_000);
        expect(subtitlesRoot.textContent).toBe("Goodbye.");
      });

      it("switches to another subtitle track, in WebVTT, and hides them all for Off", async () => {
        const send = await playingWithSubtitles();
        playback.reach(42_000);

        control(send, { action: "subtitle-track", track: 1 });
        await vi.waitFor(() => {
          expect(subtitlesRoot.textContent).toBe("Bonjour.");
        });
        control(send, { action: "subtitle-track", track: null });

        await vi.waitFor(() => {
          expect(subtitlesRoot.hidden).toBe(true);
        });
        expect(lastReport()?.subtitleTrack).toBeNull();
        expect(subtitlesRoot.textContent).toBe("");
      });

      it("shows nothing of a subtitle track it can't render, which the Hub should have converted", async () => {
        const send = await playingWithSubtitles({
          ...FILES,
          [FRENCH]:
            "[Script Info]\nScriptType: v4.00+\n\n[Events]\nDialogue: 0,0:00:40.00,0:00:45.00,Default,,0,0,0,,Bonjour.\n",
        });
        playback.reach(42_000);

        control(send, { action: "subtitle-track", track: 1 });

        await vi.waitFor(() => {
          expect(fetched).toEqual([FRENCH]);
        });
        await vi.waitFor(() => {
          expect(lastReport()?.subtitleTrack).toBeNull();
        });
        expect(subtitlesRoot.hidden).toBe(true);
      });

      it("hides the subtitles once it stops, and shows none of the next Media File until the Hub asks", async () => {
        const send = await playingWithSubtitles();
        playback.reach(42_000);
        control(send, { action: "subtitle-track", track: 0 });
        await vi.waitFor(() => {
          expect(subtitlesRoot.hidden).toBe(false);
        });

        send({ type: "play", url: FILM, positionMs: 42_000, subtitles: [FRENCH] });

        await vi.waitFor(() => {
          expect(subtitlesRoot.hidden).toBe(true);
        });
        await vi.waitFor(() => {
          expect(lastReport()).toMatchObject({ state: "playing", subtitleTrack: null });
        });
        control(send, { action: "subtitle-track", track: 0 });
        await vi.waitFor(() => {
          expect(subtitlesRoot.textContent).toBe("Bonjour.");
        });
        control(send, { action: "stop" });
        await vi.waitFor(() => {
          expect(subtitlesRoot.hidden).toBe(true);
        });
      });

      it("shows the subtitle track a Media File is sent with from the start, as when it is sent again by another Route (FR-45)", async () => {
        const send = await playingWithSubtitles();
        fetched = [];

        send({ type: "play", url: FILM, positionMs: 42_000, subtitles: [ENGLISH, FRENCH], subtitleTrack: 1 });

        await vi.waitFor(() => {
          expect(lastReport()).toMatchObject({ state: "playing", positionMs: 42_000, subtitleTrack: 1 });
        });
        expect(fetched).toEqual([FRENCH]);
        expect(subtitlesRoot.textContent).toBe("Bonjour.");
      });

      it("shows none of a Media File sent with a subtitle track it can't show, as one the Hub burns in, playing all the same", async () => {
        const send = await playingWithSubtitles();
        fetched = [];

        // In place of a track burned into the picture, the Hub sends no URL.
        send({ type: "play", url: FILM, positionMs: 42_000, subtitles: [ENGLISH, ""], subtitleTrack: 1 });

        await vi.waitFor(() => {
          expect(lastReport()).toMatchObject({ state: "playing", positionMs: 42_000, subtitleTrack: null });
        });
        expect(subtitlesRoot.hidden).toBe(true);
        expect(fetched).toEqual([]);
      });

      it("refuses a subtitle track it wasn't sent, as from a Hub older than it, showing none", async () => {
        const send = await playingWithSubtitles();
        send({ type: "play", url: FILM, positionMs: 0 });
        await vi.waitFor(() => {
          expect(playback.state()).toBe("playing");
        });

        control(send, { action: "subtitle-track", track: 0 });

        await vi.waitFor(() => {
          expect(lastReport()).toMatchObject({ state: "playing", subtitleTrack: null });
        });
        expect(fetched).toEqual([]);
      });
    });

    it("stops as the Hub asks, back on its waiting screen, and tells it it plays nothing", async () => {
      const send = await playing();

      control(send, { action: "stop" });

      await vi.waitFor(() => {
        expect(lastReport()).toEqual({
          state: "idle",
          url: null,
          positionMs: 0,
          durationMs: null,
          audioTrack: null,
          subtitleTrack: null,
        });
      });
      expect(playback.state()).toBe("idle");
      expect(root.hidden).toBe(false);
      expect(heading().textContent).toBe("Waiting for the Remote");
    });

    it("tells the Hub after a control that changed nothing, so that it isn't kept waiting", async () => {
      const send = await playing();
      const before = reports().length;

      control(send, { action: "play" });

      await vi.waitFor(() => {
        expect(reports()).toHaveLength(before + 1);
      });
      expect(lastReport()?.state).toBe("playing");
    });

    it("tells the Hub it plays nothing once the Media File ends", async () => {
      await playing();

      playback.finish();

      expect(lastReport()).toEqual({
        state: "idle",
        url: null,
        positionMs: 0,
        durationMs: null,
        audioTrack: null,
        subtitleTrack: null,
      });
    });

    it("tells the Hub the Media File played to its end, after it plays nothing, for it to send the next (FR-48)", async () => {
      await playing();

      playback.finish();

      expect((sockets.opened[0]?.sent as PlayerToHubMessage[]).slice(-2)).toEqual([
        { type: "playback", playback: expect.objectContaining({ state: "idle", url: null }) as PlayerPlayback },
        { type: "ended", url: FILM },
      ]);
    });

    it("tells the Hub of no end once it is stopped, as with Back, nor once it fails partway", async () => {
      const send = await playing();
      control(send, { action: "stop" });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("idle");
      });
      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      playback.fail("AVPlay stopped with PLAYER_ERROR_CONNECTION_FAILED.");

      expect((sockets.opened[0]?.sent as PlayerToHubMessage[]).filter(({ type }) => type === "ended")).toEqual([]);
    });

    it("tells a Hub it connects to again what it is playing", async () => {
      await playing();
      playback.reach(5_000);

      sockets.opened[0]?.drop();
      vi.advanceTimersByTime(1_000);
      sockets.opened[1]?.accept();

      expect(sockets.opened[1]?.sent).toEqual([
        {
          type: "playback",
          playback: {
            state: "playing",
            url: FILM,
            positionMs: 5_000,
            durationMs: FAKE_DURATION_MS,
            audioTrack: 0,
            subtitleTrack: null,
          },
        },
      ]);
    });

    it.each([
      ["an action it doesn't know", { action: "rewind" }],
      ["a seek with no position", { action: "seek" }],
      ["a skip by something that isn't a number", { action: "skip", byMs: "10s" }],
      ["an audio track by no place among them", { action: "audio-track", track: -1 }],
      ["an audio track by something that isn't a whole number", { action: "audio-track", track: 0.5 }],
      ["no control at all", null],
    ])("ignores a control it doesn't know: %s", async (_, sent) => {
      await playing();
      const before = reports().length;

      sockets.opened[0]?.receive(JSON.stringify({ type: "control", control: sent }));
      await Promise.resolve();

      expect(playback.state()).toBe("playing");
      expect(reports()).toHaveLength(before);
    });
  });

  describe("the TV's own remote's media keys and Back (FR-37)", () => {
    const FILM = `http://${HUB}/api/media-sources/1/file/Films/Arrival.mkv`;
    const KEY = { playPause: 10252, play: 415, pause: 19, stop: 413, rewind: 412, fastForward: 417 } as const;

    /** Presses the key on the TV's own remote, as the TV sends it to the page, and returns whether the Player took it. */
    const press = (keyCode: number): boolean =>
      document.dispatchEvent(new KeyboardEvent("keydown", { keyCode, cancelable: true }));

    const playing = async (): Promise<void> => {
      start(HUB);
      sockets.opened[0]?.accept();
      sockets.opened[0]?.receive(JSON.stringify({ type: "play", url: FILM, positionMs: 0 }));
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
    };

    it("plays and pauses with play/pause", async () => {
      await playing();

      expect(press(KEY.playPause)).toBe(false);
      expect(playback.state()).toBe("paused");

      press(KEY.playPause);
      expect(playback.state()).toBe("playing");
    });

    it("pauses with pause, and plays with play", async () => {
      await playing();

      press(KEY.pause);
      expect(playback.state()).toBe("paused");
      press(KEY.play);
      expect(playback.state()).toBe("playing");
    });

    it("skips back and forward 10 seconds with rewind and fast-forward", async () => {
      await playing();
      playback.reach(30_000);

      press(KEY.rewind);
      await vi.waitFor(() => {
        expect(playback.positionMs()).toBe(20_000);
      });
      press(KEY.fastForward);
      await vi.waitFor(() => {
        expect(playback.positionMs()).toBe(30_000);
      });
    });

    it.each([
      ["stop", KEY.stop],
      ["Back", BACK_KEY_CODE],
    ])("stops with %s, back on its waiting screen", async (_, keyCode) => {
      await playing();

      expect(press(keyCode)).toBe(false);

      expect(playback.state()).toBe("idle");
      expect(root.hidden).toBe(false);
      expect(heading().textContent).toBe("Waiting for the Remote");
    });

    it("tells the Hub what each key did, so that every Remote sees it", async () => {
      await playing();

      press(KEY.pause);

      await vi.waitFor(() => {
        expect((sockets.opened[0]?.sent.at(-1) as PlaybackReport).playback.state).toBe("paused");
      });
    });

    it("leaves Back, and every other key, to the TV while it plays nothing", () => {
      start(HUB);
      sockets.opened[0]?.accept();

      expect(press(BACK_KEY_CODE)).toBe(true);
      expect(press(KEY.play)).toBe(true);
      expect(playback.loaded).toEqual([]);
    });

    it("leaves keys that aren't media keys to the TV while it plays", async () => {
      await playing();

      expect(press(13)).toBe(true);
      expect(playback.state()).toBe("playing");
    });

    it("hears no key once it has stopped", async () => {
      await playing();
      player?.stop();

      press(KEY.pause);

      expect(playback.state()).toBe("playing");
    });
  });

  describe("Resume Positions (FR-39, FR-40)", () => {
    const FILM = `http://${HUB}/api/media-sources/1/file/Films/Arrival.mkv`;
    const ARRIVAL: ResumableMediaFile = {
      mediaSourceId: 1,
      path: "Films/Arrival.mkv",
      name: "Arrival.mkv",
      positionMs: 4_350_000,
    };

    /** Starts it connected to the Hub, and returns how to send it a message as the Hub. */
    const connected = (): ((message: HubToPlayerMessage) => void) => {
      start(HUB);
      sockets.opened[0]?.accept();
      return (message) => sockets.opened[0]?.receive(JSON.stringify(message));
    };
    const resumeButton = (): HTMLElement | null => queryByRole(root, "button", { name: /^Resume / });
    const sentToHub = (): PlayerToHubMessage[] => sockets.opened[0]?.sent as PlayerToHubMessage[];

    it("plays a Media File from where the Hub says to start, telling the Hub it plays from there", async () => {
      const send = connected();

      send({ type: "play", url: FILM, positionMs: 42_000 });

      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      expect(playback.positionMs()).toBe(42_000);
      expect(sentToHub().at(-1)).toEqual({
        type: "playback",
        playback: {
          state: "playing",
          url: FILM,
          positionMs: 42_000,
          durationMs: FAKE_DURATION_MS,
          audioTrack: 0,
          subtitleTrack: null,
        },
      });
    });

    it("plays from the start when the Hub says nothing of where to start, as an older Hub doesn't", async () => {
      connected();

      sockets.opened[0]?.receive(JSON.stringify({ type: "play", url: FILM }));

      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      expect(playback.positionMs()).toBe(0);
    });

    it("offers to resume the Media File the Hub offers, with focus for the TV's own remote's OK", () => {
      const send = connected();
      expect(resumeButton()).toBeNull();

      send({ type: "resumable", resumable: ARRIVAL });

      const button = getByRole(root, "button", { name: "Resume Arrival.mkv from 1:12:30" });
      expect(document.activeElement).toBe(button);
      expect(heading().textContent).toBe("Waiting for the Remote");

      send({ type: "resumable", resumable: null });
      expect(resumeButton()).toBeNull();
    });

    it("asks the Hub for the Media File it offers when the button is pressed, and plays what the Hub sends", async () => {
      const send = connected();
      send({ type: "resumable", resumable: ARRIVAL });

      getByRole(root, "button", { name: /^Resume Arrival\.mkv/ }).click();

      expect(sentToHub().at(-1)).toEqual({ type: "resume", mediaSourceId: 1, path: "Films/Arrival.mkv" });
      send({ type: "play", url: FILM, positionMs: ARRIVAL.positionMs });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      expect(playback.positionMs()).toBe(Math.min(ARRIVAL.positionMs, FAKE_DURATION_MS));
      expect(root.hidden).toBe(true);
    });

    it("offers it only while it can reach the Hub to ask for it", () => {
      const send = connected();
      send({ type: "resumable", resumable: ARRIVAL });

      sockets.opened[0]?.drop();
      expect(resumeButton()).toBeNull();

      vi.advanceTimersByTime(1_000);
      sockets.opened[1]?.accept();
      expect(resumeButton()).not.toBeNull();
    });

    it("gives the button focus again once it stops playing, back on its waiting screen", async () => {
      const send = connected();
      send({ type: "resumable", resumable: ARRIVAL });
      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      (document.activeElement as HTMLElement | null)?.blur();

      send({ type: "control", control: { action: "stop" } });

      await vi.waitFor(() => {
        expect(root.hidden).toBe(false);
      });
      expect(document.activeElement).toBe(getByRole(root, "button", { name: /^Resume / }));
    });

    it.each([
      ["no name", { ...ARRIVAL, name: undefined }],
      ["a position that isn't a number", { ...ARRIVAL, positionMs: "1:12:30" }],
      ["nothing like one", "Arrival.mkv"],
    ])("offers nothing the Hub offers that it doesn't know: %s", (_, resumable) => {
      connected();

      sockets.opened[0]?.receive(JSON.stringify({ type: "resumable", resumable }));

      expect(resumeButton()).toBeNull();
    });
  });

  describe("its now-playing screen, while it plays audio (FR-47)", () => {
    const FLAC = `http://${HUB}/api/media-sources/1/file/Music/Album/01%20Tone.flac`;
    const COVER_ART = `http://${HUB}/api/media-sources/1/cover-art/Music/Album/01%20Tone.flac`;
    const TAGGED: MusicDetails = {
      title: "Tone in A",
      artist: "The Sine Waves",
      album: "Test Tones",
      coverArt: COVER_ART,
    };
    const FILM = `http://${HUB}/api/media-sources/1/file/Films/Arrival.mkv`;

    /** Starts it connected to the Hub, and returns how to send it a message as the Hub. */
    const connected = (): ((message: HubToPlayerMessage) => void) => {
      start(HUB);
      sockets.opened[0]?.accept();
      return (message) => sockets.opened[0]?.receive(JSON.stringify(message));
    };
    const playing = async (): Promise<void> => {
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
    };
    const screen = (): HTMLElement => getByRole(root, "region", { name: TAGGED.title });
    const coverArt = (): HTMLImageElement | null => root.querySelector<HTMLImageElement>(".now-playing .cover-art");
    const placeholder = (): HTMLElement | null => queryByRole(root, "img", { name: "No cover art" });
    const progress = (): HTMLElement => getByRole(root, "progressbar", { name: "Progress" });

    it("shows a tagged Media File's title, artist and album, with its cover art from the Hub, in place of the waiting screen", async () => {
      const send = connected();

      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });
      await playing();

      expect(root.hidden).toBe(false);
      expect(heading().textContent).toBe("Tone in A");
      expect(queryByRole(root, "heading", { name: "Waiting for the Remote" })).toBeNull();
      expect(screen().querySelector(".artist")?.textContent).toBe("The Sine Waves");
      expect(screen().querySelector(".album")?.textContent).toBe("Test Tones");
      expect(coverArt()?.getAttribute("src")).toBe(COVER_ART);
      // The placeholder stands in until the cover art has loaded.
      expect(placeholder()).not.toBeNull();

      coverArt()?.dispatchEvent(new Event("load"));

      expect(getByRole(root, "img", { name: "Cover art of Test Tones" })).toBe(coverArt());
      expect(placeholder()).toBeNull();
    });

    it("shows what the Hub says of an untagged one, its file name, with a placeholder for the cover art it hasn't got", async () => {
      const send = connected();

      send({
        type: "play",
        url: `http://${HUB}/api/media-sources/1/file/Music/Album/02%20Tone.mp3`,
        positionMs: 0,
        music: { title: "02 Tone.mp3", artist: null, album: null, coverArt: null },
      });
      await playing();

      expect(heading().textContent).toBe("02 Tone.mp3");
      expect(root.querySelector<HTMLElement>(".now-playing .artist")?.hidden).toBe(true);
      expect(root.querySelector<HTMLElement>(".now-playing .album")?.hidden).toBe(true);
      expect(placeholder()).not.toBeNull();
      expect(coverArt()?.hasAttribute("src")).toBe(false);
      expect(queryByRole(root, "img", { name: /^Cover art/ })).toBeNull();
    });

    it("shows the placeholder for cover art that won't load", async () => {
      const send = connected();
      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });
      await playing();

      coverArt()?.dispatchEvent(new Event("error"));

      expect(placeholder()).not.toBeNull();
      expect(queryByRole(root, "img", { name: /^Cover art/ })).toBeNull();
    });

    it("shows how far into it it is, as it plays", async () => {
      const send = connected();
      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });
      await playing();
      expect(screen().querySelector(".times")?.textContent).toBe("0:00 / 1:00");

      playback.reach(30_000);

      expect(screen().querySelector(".times")?.textContent).toBe("0:30 / 1:00");
      expect(progress().getAttribute("aria-valuenow")).toBe("30");
      expect(progress().getAttribute("aria-valuemax")).toBe("60");
      expect(progress().getAttribute("aria-valuetext")).toBe("0:30 of 1:00");
      expect(screen().querySelector<HTMLElement>(".played")?.style.width).toBe("50%");
    });

    it("says whether it plays or is paused, in words as well as an icon", async () => {
      const send = connected();
      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });
      await playing();

      expect(screen().querySelector(".status")?.textContent).toBe("Playing");

      send({ type: "control", control: { action: "pause" } });

      await vi.waitFor(() => {
        expect(screen().querySelector(".status")?.textContent).toBe("Paused");
      });
    });

    it("shows it from where the Hub says to start", async () => {
      const send = connected();

      send({ type: "play", url: FLAC, positionMs: 45_000, music: TAGGED });
      await playing();

      expect(screen().querySelector(".times")?.textContent).toBe("0:45 / 1:00");
    });

    it("shows neither screen for a video sent next, so that its picture shows, and the waiting screen once it stops", async () => {
      const send = connected();
      send({
        type: "resumable",
        resumable: { mediaSourceId: 1, path: "Films/Arrival.mkv", name: "Arrival.mkv", positionMs: 4_350_000 },
      });
      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });
      await playing();

      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.loaded).toEqual([FLAC, FILM]);
      });
      await playing();
      expect(root.hidden).toBe(true);

      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });
      await vi.waitFor(() => {
        expect(root.hidden).toBe(false);
      });
      expect(heading().textContent).toBe("Tone in A");
      // The Resume button, hidden behind it, hasn't focus, so that OK on the TV's own remote can't press it.
      expect(document.activeElement).not.toBe(root.querySelector(".resume"));

      send({ type: "control", control: { action: "stop" } });

      await vi.waitFor(() => {
        expect(heading().textContent).toBe("Waiting for the Remote");
      });
      expect(queryByRole(root, "region", { name: TAGGED.title })).toBeNull();
      expect(document.activeElement).toBe(getByRole(root, "button", { name: /^Resume / }));
    });

    it("shows the waiting screen, saying so, when the TV can't play it", async () => {
      const send = connected();
      playback.refuse("AVPlay couldn't open the Media File");

      send({ type: "play", url: FLAC, positionMs: 0, music: TAGGED });

      await vi.waitFor(() => {
        expect(getByRole(root, "alert").textContent).toBe(COULDNT_PLAY);
      });
      expect(heading().textContent).toBe("Waiting for the Remote");
    });

    it("reads no cover art from anywhere but the Hub", async () => {
      const send = connected();

      send({ type: "play", url: FLAC, positionMs: 0, music: { ...TAGGED, coverArt: "javascript:alert(1)" } });
      await playing();

      expect(coverArt()?.hasAttribute("src")).toBe(false);
      expect(placeholder()).not.toBeNull();
    });

    it.each([
      ["no title", { ...TAGGED, title: undefined }],
      ["an artist that isn't text", { ...TAGGED, artist: 1 }],
      ["nothing like it", "Tone in A"],
    ])("shows no now-playing screen for music it doesn't know: %s", async (_, music) => {
      connected();

      sockets.opened[0]?.receive(JSON.stringify({ type: "play", url: FLAC, positionMs: 0, music }));
      await playing();

      expect(root.hidden).toBe(true);
    });
  });

  describe("its overlay over a video, so that a change to it shows (FR-36, FR-37)", () => {
    const FILM = `http://${HUB}/api/media-sources/1/file/Films/Arrival.mkv`;
    const FLAC = `http://${HUB}/api/media-sources/1/file/Music/Album/01%20Tone.flac`;
    const FAST_FORWARD = 417;
    let overlayRoot: HTMLElement;
    let subtitlesRoot: HTMLElement;

    /** Starts it connected to the Hub, with its overlay and subtitles where the test sees them, and returns how to send it a message. */
    const connected = (): ((message: HubToPlayerMessage) => void) => {
      subtitlesRoot = document.createElement("div");
      overlayRoot = document.createElement("div");
      document.body.appendChild(subtitlesRoot);
      document.body.appendChild(overlayRoot);
      player = startPlayer({
        root,
        launchedWith: HUB,
        rememberedHub: remembered,
        openSocket: sockets.openSocket,
        playback,
        subtitlesRoot,
        overlayRoot,
      });
      sockets.opened[0]?.accept();
      return (message) => sockets.opened[0]?.receive(JSON.stringify(message));
    };
    const playingFilm = async (): Promise<(message: HubToPlayerMessage) => void> => {
      const send = connected();
      send({ type: "play", url: FILM, positionMs: 0 });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      return send;
    };
    const status = (): string | null | undefined => overlayRoot.querySelector(".overlay-status")?.textContent;
    const times = (): string | null | undefined => overlayRoot.querySelector(".overlay-times")?.textContent;
    const progress = (): HTMLElement => getByRole(overlayRoot, "progressbar", { name: "Video progress" });

    afterEach(() => {
      subtitlesRoot.remove();
      overlayRoot.remove();
    });

    it("shows nothing while it plays nothing", () => {
      connected();

      expect(overlayRoot.hidden).toBe(true);
    });

    it("shows while the video loads, then for a moment as it plays, then hides, so that the picture is clear", async () => {
      const send = connected();

      send({ type: "play", url: FILM, positionMs: 0 });

      expect(overlayRoot.hidden).toBe(false);
      expect(status()).toBe("Loading…");
      await vi.waitFor(() => {
        expect(status()).toBe("Playing");
      });
      expect(overlayRoot.hidden).toBe(false);

      vi.advanceTimersByTime(OVERLAY_SHOWN_MS);

      expect(overlayRoot.hidden).toBe(true);
    });

    it("stays while the video is paused, saying so, with how far into it it is", async () => {
      const send = await playingFilm();

      send({ type: "control", control: { action: "pause" } });
      await vi.waitFor(() => {
        expect(status()).toBe("Paused");
      });
      playback.reach(30_000);
      vi.advanceTimersByTime(OVERLAY_SHOWN_MS * 2);

      expect(overlayRoot.hidden).toBe(false);
      expect(times()).toBe("0:30 / 1:00");
      expect(progress().getAttribute("aria-valuetext")).toBe("0:30 of 1:00");
      expect(overlayRoot.querySelector<HTMLElement>(".overlay-played")?.style.width).toBe("50%");
    });

    it("shows again for a moment after a key on the TV's own remote, as it skips", async () => {
      await playingFilm();
      vi.advanceTimersByTime(OVERLAY_SHOWN_MS);
      expect(overlayRoot.hidden).toBe(true);

      document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: FAST_FORWARD, cancelable: true }));

      expect(overlayRoot.hidden).toBe(false);
      await vi.waitFor(() => {
        expect(times()).toBe("0:10 / 1:00");
      });
      vi.advanceTimersByTime(OVERLAY_SHOWN_MS);
      expect(overlayRoot.hidden).toBe(true);
    });

    it("shows again for a moment after a control from the Hub", async () => {
      const send = await playingFilm();
      vi.advanceTimersByTime(OVERLAY_SHOWN_MS);

      send({ type: "control", control: { action: "seek", positionMs: 45_000 } });

      expect(overlayRoot.hidden).toBe(false);
      await vi.waitFor(() => {
        expect(times()).toBe("0:45 / 1:00");
      });
    });

    it("moves the subtitles up, out of its way, while it shows", async () => {
      await playingFilm();

      expect(subtitlesRoot.classList.contains("above-overlay")).toBe(true);

      vi.advanceTimersByTime(OVERLAY_SHOWN_MS);

      expect(subtitlesRoot.classList.contains("above-overlay")).toBe(false);
    });

    it("hides once the video stops, back on the waiting screen", async () => {
      const send = await playingFilm();

      send({ type: "control", control: { action: "stop" } });

      await vi.waitFor(() => {
        expect(overlayRoot.hidden).toBe(true);
      });
      expect(heading().textContent).toBe("Waiting for the Remote");
    });

    it("shows nothing over audio, whose now-playing screen says the same", async () => {
      const send = connected();

      send({
        type: "play",
        url: FLAC,
        positionMs: 0,
        music: { title: "Tone in A", artist: null, album: null, coverArt: null },
      });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("playing");
      });
      send({ type: "control", control: { action: "pause" } });
      await vi.waitFor(() => {
        expect(playback.state()).toBe("paused");
      });

      expect(overlayRoot.hidden).toBe(true);
    });
  });

  describe("a position, as its waiting screen shows it", () => {
    it.each([
      [0, "0:00"],
      [9_000, "0:09"],
      [30_400, "0:30"],
      [3_599_000, "59:59"],
      [3_600_000, "1:00:00"],
      [4_350_000, "1:12:30"],
    ])("writes %d ms as %s", (positionMs, written) => {
      expect(formatPosition(positionMs)).toBe(written);
    });
  });
});
