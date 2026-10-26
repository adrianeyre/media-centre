import type { LightState, PlayerPlayback } from "@media-centre/shared";

import type { ApplianceStore } from "./appliances.ts";
import { DriverFailure, type Drivers } from "./drivers/driver.ts";
import { changeTo, recallLightScene, type LightSceneStore } from "./light-scenes.ts";
import { changeEach, readLight } from "./lights.ts";
import type { SentTracks } from "./sent-tracks.ts";

export interface FilmLightScenesDependencies {
  readonly appliances: ApplianceStore;
  readonly scenes: LightSceneStore;
  readonly drivers: Drivers;
  readonly sentTracks: Pick<SentTracks, "at">;
}

/**
 * Each TV's film Light Scene (FR-57): recalled as the Player on the TV
 * starts a video, and undone once it stops, the Room's Lights set back as
 * they were, but any a person changed meanwhile.
 */
export interface FilmLightScenes {
  /** Hears what the Player on the TV at `address` says of its playback, starting or ending a video there. */
  readonly heard: (address: string, playback: PlayerPlayback) => void;
  /** Hears that no Player is connected from the TV at `address` any more, which ends the video it played. */
  readonly playerGone: (address: string) => void;
  /** Hears the Lights a person is about to change, by their ids, which are left as they make them once a video stops. */
  readonly changedByHand: (ids: readonly number[]) => void;
}

/** A video playing on a TV with a film Light Scene, and its Room's Lights as they were before it. */
interface Film {
  /** "Living room · TV", for the Hub's log. */
  readonly title: string;
  readonly roomId: number;
  /** Each Light of the Room that answered as the video started, as it said it was then. */
  readonly before: Map<number, LightState>;
  /** The Lights a person changed while it played. */
  readonly changed: Set<number>;
  /** Settles once the Lights are read and the Light Scene recalled, as setting them back must wait for. */
  readonly started: Promise<void>;
}

/**
 * Follows what each TV's Player reports (ADR 0003). A video starting on a
 * TV whose film Light Scene is set, which is one of its Room's, has the Hub
 * read each Light in the Room as it is, through its Driver, then recall the
 * Light Scene. The video stopping, whether stopped, played to its end, or
 * followed by audio, or the Player going away, has it set each Light it read
 * back as it was, unless a person changed it meanwhile, or it has left the
 * Room. One video following another, with no stop between, as by another
 * Route (FR-45), is the same one, so the Lights aren't read again. Audio
 * changes nothing; nor does a TV with no Room, or none chosen, or a report
 * of a Media File the Hub didn't send. What it holds is kept only as long
 * as the Hub runs.
 */
export const filmLightScenes = ({
  appliances,
  scenes,
  drivers,
  sentTracks,
}: FilmLightScenesDependencies): FilmLightScenes => {
  /** Each TV playing a video, by its address: its film, or null when it has no film Light Scene to recall. */
  const playing = new Map<string, Film | null>();

  const start = (address: string): Film | null => {
    const driver = drivers.light;
    const tv = appliances.list().find((appliance) => appliance.kind === "tv" && appliance.address === address);
    if (driver === undefined || tv === undefined || tv.roomId === null || tv.filmLightSceneId === undefined) {
      return null;
    }
    const { roomId, filmLightSceneId } = tv;
    const title = appliances.title(tv);
    const before = new Map<number, LightState>();

    const started = (async (): Promise<void> => {
      const scene = scenes.list().find(({ id }) => id === filmLightSceneId);
      if (scene?.roomId !== roomId) return;
      const lights = appliances.list().filter(({ kind, roomId: room }) => kind === "light" && room === roomId);
      await Promise.all(
        lights.map(async (light) => {
          try {
            const reading = await readLight(appliances, driver, light);
            if (reading.known) before.set(light.id, reading.state);
          } catch (error) {
            if (!(error instanceof DriverFailure)) throw error;
          }
        }),
      );
      const { unreached } = await recallLightScene(appliances, scenes, driver, scene.id);
      console.log(
        `${title} started a video, so the Hub recalled its Light Scene "${scene.name}"` +
          (unreached.length === 0 ? "" : `, which ${String(unreached.length)} of its Lights didn't answer`),
      );
    })().catch((error: unknown) => {
      console.error(`Failed to recall the Light Scene of ${title} as it started a video`, error);
    });
    return { title, roomId, before, changed: new Set(), started };
  };

  const end = (address: string): void => {
    const film = playing.get(address);
    playing.delete(address);
    const driver = drivers.light;
    if (film === undefined || film === null || driver === undefined) return;
    const { title, roomId, before, changed } = film;
    film.started
      .then(async () => {
        const lights = appliances
          .list()
          .filter(({ id, kind, roomId: room }) => kind === "light" && room === roomId && before.has(id));
        const left = lights.filter(({ id }) => !changed.has(id));
        if (left.length === 0) return;
        const { unreached } = await changeEach(appliances, driver, left, (light) => {
          const state = before.get(light.id);
          return Promise.resolve(state === undefined ? undefined : changeTo(state));
        });
        const byHand = lights.length - left.length;
        console.log(
          `${title} stopped its video, so the Hub set its Room's Lights back as they were` +
            (byHand === 0 ? "" : `, but ${String(byHand)} changed by hand meanwhile`) +
            (unreached.length === 0 ? "" : `; ${String(unreached.length)} didn't answer`),
        );
      })
      .catch((error: unknown) => {
        console.error(`Failed to set the Lights back as ${title} stopped its video`, error);
      });
  };

  return {
    heard: (address, { state, url }) => {
      if (state === "idle") {
        end(address);
        return;
      }
      const sent = sentTracks.at(address, url);
      // One the Hub didn't send, or not as the latest, says nothing of what plays now.
      if (sent === null) return;
      // A video as the Player shows one, with no now-playing screen of music.
      if (sent.music !== null) end(address);
      else if (!playing.has(address)) playing.set(address, start(address));
    },
    playerGone: end,
    changedByHand: (ids) => {
      for (const film of playing.values()) for (const id of ids) film?.changed.add(id);
    },
  };
};
