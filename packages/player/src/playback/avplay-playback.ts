import type { AVPlay, AVPlayStreamInfo } from "../tizen.ts";
import { playbackListeners, type Playback, type PlaybackState } from "./playback.ts";

/** The frame AVPlay places the picture in, whatever the screen's resolution. */
const SCREEN = { width: 1920, height: 1080 } as const;

/**
 * The {@link Playback} of a Samsung TV, through its AVPlay (ADR 0005), which
 * draws the picture full screen behind the page, through the page's
 * `<object type="application/avplayer">`. It exists only on a TV, so it is
 * tested against a stand-in for `webapis.avplay`, and proven on a real TV.
 */
export const avplayPlayback = (avplay: AVPlay): Playback => {
  const { subscribe, emit } = playbackListeners();
  let state: PlaybackState = "idle";
  /** Counts loads, so that one replaced by the next is told so and its callbacks ignored. */
  let loads = 0;

  const become = (next: PlaybackState): void => {
    if (next === state) return;
    state = next;
    emit({ type: "state", state });
  };

  /**
   * Stops and closes whatever AVPlay has, if anything. AVPlay refuses to stop
   * in some states, which leaves nothing to stop, and one it can't close
   * refuses the next open, which `load` reports.
   */
  const unload = (): void => {
    if (avplay.getState() === "NONE") return;
    try {
      avplay.stop();
    } catch {
      // Closed all the same, next.
    }
    try {
      avplay.close();
    } catch {
      // As above.
    }
  };

  /** AVPlay's audio tracks of what it has open, in the order they are in it. */
  const audioTracks = (): readonly AVPlayStreamInfo[] =>
    avplay.getTotalTrackInfo().filter((track) => track.type === "AUDIO");

  const fail = (message: string): void => {
    loads += 1;
    unload();
    become("idle");
    emit({ type: "error", message });
  };

  return {
    state: () => state,
    load: (url) => {
      unload();
      loads += 1;
      const load = loads;
      become("loading");
      return new Promise<void>((resolve, reject) => {
        const failed = (error: unknown): void => {
          if (load !== loads) {
            reject(new Error("Another Media File was loaded instead."));
            return;
          }
          unload();
          become("idle");
          reject(new Error(`AVPlay couldn't open the Media File: ${String(error)}`));
        };
        try {
          avplay.open(url);
          avplay.setDisplayRect(0, 0, SCREEN.width, SCREEN.height);
          avplay.setListener({
            oncurrentplaytime: (positionMs) => {
              if (load === loads) emit({ type: "position", positionMs });
            },
            onstreamcompleted: () => {
              if (load !== loads) return;
              loads += 1;
              unload();
              become("idle");
              emit({ type: "ended" });
            },
            onerror: (type) => {
              if (load === loads) fail(`AVPlay stopped with ${type}.`);
            },
          });
          avplay.prepareAsync(() => {
            if (load !== loads) {
              reject(new Error("Another Media File was loaded instead."));
              return;
            }
            become("paused");
            resolve();
          }, failed);
        } catch (error) {
          failed(error);
        }
      });
    },
    play: () => {
      if (state !== "paused") return;
      avplay.play();
      become("playing");
    },
    pause: () => {
      if (state !== "playing") return;
      avplay.pause();
      become("paused");
    },
    seekTo: (positionMs) =>
      new Promise<void>((resolve, reject) => {
        if (state !== "paused" && state !== "playing") {
          reject(new Error("Nothing is loaded to seek in."));
          return;
        }
        avplay.seekTo(Math.max(0, Math.round(positionMs)), resolve, (error) => {
          reject(new Error(`AVPlay couldn't seek: ${String(error)}`));
        });
      }),
    positionMs: () => (state === "paused" || state === "playing" ? avplay.getCurrentTime() : 0),
    durationMs: () => {
      if (state !== "paused" && state !== "playing") return null;
      const duration = avplay.getDuration();
      return duration > 0 ? duration : null;
    },
    audioTrack: () => {
      if (state !== "paused" && state !== "playing") return null;
      try {
        const playing = avplay.getCurrentStreamInfo().find((track) => track.type === "AUDIO");
        const place = playing === undefined ? -1 : audioTracks().findIndex((track) => track.index === playing.index);
        return place === -1 ? null : place;
      } catch {
        // It doesn't say, which the Player reports as such.
        return null;
      }
    },
    selectAudioTrack: (track) => {
      if (state !== "paused" && state !== "playing") throw new Error("Nothing is loaded to choose an audio track of.");
      const chosen = audioTracks()[track];
      if (chosen === undefined) throw new Error(`AVPlay has no audio track ${String(track + 1)}.`);
      avplay.setSelectTrack("AUDIO", chosen.index);
    },
    stop: () => {
      loads += 1;
      unload();
      become("idle");
    },
    subscribe,
  };
};
