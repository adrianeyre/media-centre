import type { Queue, QueueControl, QueueRepeat } from "@media-centre/shared";

import type { ApplianceStore } from "./appliances.ts";
import type { Drivers } from "./drivers/driver.ts";
import { HttpRefusal } from "./http.ts";
import { findMediaFile } from "./media-files.ts";
import { REFUSAL_STATUS } from "./media-sources-api.ts";
import { MediaSourceRefusal, type MediaSourceStore } from "./media-sources.ts";
import { choosePlayRoute, PlayRouteRefusal, type PlayRouteDependencies } from "./play-routes.ts";
import type { PlayerAt, Players } from "./players.ts";
import { ROUTE_NAMES } from "./routes.ts";

export interface QueuesDependencies extends PlayRouteDependencies {
  readonly appliances: ApplianceStore;
  readonly drivers: Drivers;
  readonly mediaSources: MediaSourceStore;
  readonly players: Pick<Players, "playAgain">;
}

export interface QueuesOptions {
  /** Where shuffling takes its random numbers from, from 0 up to 1. By default, `Math.random`. */
  readonly random?: () => number;
}

/** A folder's audio Media Files, to play as a Queue (FR-46). */
export interface QueuedFolder {
  readonly mediaSourceId: number;
  /** Its path inside the Media Source, `""` for the Media Source's own folder. */
  readonly folder: string;
  /** The file names of its audio Media Files, in file-name order. */
  readonly files: readonly string[];
}

/** The first Media File of a Queue, as the Hub sent it the Player. */
export interface QueueStarted {
  /** The Hub's `host:port` as the TV reaches it, which its URLs are at. */
  readonly hub: string;
  /** The URL the Player was sent it at, the Media File itself or its stream. */
  readonly url: string;
}

/**
 * The Queue each TV plays (FR-46, FR-48), by the TV's address, which its
 * Player connects from. They are kept only as long as the Hub runs.
 */
export interface Queues {
  /** Holds the folder as the Queue the TV at `address` plays, in place of any, its first Media File sent as `started` says. */
  readonly start: (address: string, folder: QueuedFolder, started: QueueStarted) => void;
  /** Ends the Queue the TV at `address` plays, if any, as when it plays a Media File on its own, or is stopped. */
  readonly end: (address: string) => void;
  /** The Queue the TV at `address` plays, if the Media File at `url` its Player plays is its current one; otherwise null. */
  readonly at: (address: string, url: string | null) => Queue | null;
  /**
   * Has the Player there play the next Media File of its Queue, from its
   * start, once the one at `url`, its current one, has played to its end:
   * the same one again if it repeats one; the first after the last if it
   * repeats all; and otherwise, after the last, none, ending the Queue.
   */
  readonly ended: (player: PlayerAt, url: string) => void;
  /**
   * Does what the Remote asked of the Queue the TV at `address` plays, if
   * the Media File at `url` its Player plays is its current one, and
   * resolves once the Player has reported the Media File it moved to, if it
   * moved, or after `timeoutMs`. It refuses with an {@link HttpRefusal} what
   * can't be done, changing nothing.
   */
  readonly control: (address: string, url: string | null, control: QueueControl, timeoutMs: number) => Promise<void>;
}

/** A Queue, as the Hub holds it for one TV. */
interface HeldQueue extends QueuedFolder {
  /** The places among `files` of its Media Files, in the order they play. */
  order: number[];
  /** The place among `order` of the one the Player plays. */
  current: number;
  shuffle: boolean;
  repeat: QueueRepeat;
  readonly hub: string;
  /** The URL its current Media File was sent the Player at. */
  url: string;
}

/** "Living room · TV", or "the TV at <address>" if no TV the Hub has is there. */
const titleAt = (appliances: ApplianceStore, address: string): string => {
  const tv = appliances.list().find((appliance) => appliance.kind === "tv" && appliance.address === address);
  return tv === undefined ? `the TV at ${address}` : appliances.title(tv);
};

/**
 * The Queues the TVs play (FR-46, FR-48). The Hub holds each, so that every
 * Remote sees the same, and moves its TV's Player on to the next Media File
 * itself as each ends. Each Media File it moves to is sent the Player as
 * playing it on its own would be, by the Route it takes to that TV, chosen
 * then (FR-41), from its start, at the Hub's address the first was sent at.
 */
export const playQueues = (dependencies: QueuesDependencies, { random = Math.random }: QueuesOptions = {}): Queues => {
  const { appliances, drivers, mediaSources, players } = dependencies;
  const queues = new Map<string, HeldQueue>();

  /**
   * Sends the Player on the TV at `address` the Media File at `place` in the
   * Queue's order, making it the current one, and resolves once the Player
   * has reported it, or after `timeoutMs`. It rejects, changing nothing, if
   * it can't be found or have a Route chosen, or the Player has gone.
   */
  const playAt = async (address: string, queue: HeldQueue, place: number, timeoutMs: number): Promise<void> => {
    const name = queue.files[queue.order[place] ?? -1];
    if (name === undefined) throw new Error(`The Queue has no Media File at ${String(place)}.`);
    const names = [...queue.folder.split("/").filter((each) => each !== ""), name];
    const source = mediaSources.find(queue.mediaSourceId);
    const found = await findMediaFile(source, names);
    const title = titleAt(appliances, address);
    const formats = drivers.tv.playableFormats;
    if (formats === undefined) throw new PlayRouteRefusal(400, `${title} can't play Media Files.`);
    const route = await choosePlayRoute(
      dependencies,
      { source, path: names.join("/"), found },
      { address, title, formats },
    );
    if (queues.get(address) !== queue) return;
    const sent = route.sentAt(queue.hub);
    queue.current = place;
    queue.url = sent.url;
    if (!(await players.playAgain(address, { type: "play", ...sent, positionMs: 0 }, timeoutMs))) {
      throw new HttpRefusal(409, `The Player on ${title} has disconnected from the Hub.`);
    }
    console.log(
      `Sent "${name}", ${String(place + 1)} of ${String(queue.order.length)} in the Queue, to the Player on ${title}, to play by ${ROUTE_NAMES[route.route]}`,
    );
  };

  /** The Queue the TV at `address` plays, if the Media File at `url` is its current one. */
  const playing = (address: string, url: string | null): HeldQueue | undefined => {
    const queue = queues.get(address);
    return queue !== undefined && url !== null && queue.url === url ? queue : undefined;
  };

  /** The places in `places`, in a random order. */
  const shuffled = (places: readonly number[]): number[] => {
    const order = [...places];
    for (let at = order.length - 1; at > 0; at -= 1) {
      const other = Math.floor(random() * (at + 1));
      [order[at], order[other]] = [order[other] as number, order[at] as number];
    }
    return order;
  };

  return {
    start: (address, { mediaSourceId, folder, files }, { hub, url }) => {
      queues.set(address, {
        mediaSourceId,
        folder,
        files: [...files],
        order: files.map((_, place) => place),
        current: 0,
        shuffle: false,
        repeat: "off",
        hub,
        url,
      });
    },
    end: (address) => {
      queues.delete(address);
    },
    at: (address, url) => {
      const queue = playing(address, url);
      if (queue === undefined) return null;
      const { mediaSourceId, folder, files, order, current, shuffle, repeat } = queue;
      return { mediaSourceId, folder, mediaFiles: order.map((place) => files[place] ?? ""), current, shuffle, repeat };
    },
    ended: ({ address }, url) => {
      const queue = playing(address, url);
      if (queue === undefined) return;
      const title = titleAt(appliances, address);
      const next =
        queue.repeat === "one"
          ? queue.current
          : queue.current + 1 < queue.order.length
            ? queue.current + 1
            : queue.repeat === "all"
              ? 0
              : undefined;
      if (next === undefined) {
        queues.delete(address);
        console.log(`The Queue on ${title} has played to its end`);
        return;
      }
      playAt(address, queue, next, 0).catch((error: unknown) => {
        if (queues.get(address) === queue) queues.delete(address);
        if (error instanceof MediaSourceRefusal || error instanceof PlayRouteRefusal || error instanceof HttpRefusal) {
          console.log(`Couldn't play the next Media File of the Queue on ${title}, so it has ended: ${error.message}`);
        } else {
          console.error(`Failed to play the next Media File of the Queue on ${title}`, error);
        }
      });
    },
    control: async (address, url, control, timeoutMs) => {
      const queue = playing(address, url);
      const title = titleAt(appliances, address);
      if (queue === undefined) throw new HttpRefusal(409, `${title} isn't playing a Queue.`);
      switch (control.action) {
        case "shuffle": {
          const now = queue.order[queue.current] ?? 0;
          if (control.shuffle) {
            queue.order = [
              ...queue.order.slice(0, queue.current + 1),
              ...shuffled(queue.order.slice(queue.current + 1)),
            ];
          } else {
            queue.order = queue.files.map((_, place) => place);
            queue.current = now;
          }
          queue.shuffle = control.shuffle;
          return;
        }
        case "repeat":
          queue.repeat = control.repeat;
          return;
        case "next":
        case "previous": {
          const step = control.action === "next" ? 1 : -1;
          const length = queue.order.length;
          const place = queue.current + step;
          const to =
            place >= 0 && place < length ? place : queue.repeat === "all" ? (place + length) % length : undefined;
          if (to === undefined) {
            throw new HttpRefusal(
              409,
              control.action === "next"
                ? "That is the last Media File of the Queue."
                : "That is the first Media File of the Queue.",
            );
          }
          try {
            await playAt(address, queue, to, timeoutMs);
          } catch (error) {
            if (error instanceof PlayRouteRefusal) throw new HttpRefusal(error.status, error.message);
            if (error instanceof MediaSourceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
            throw error;
          }
        }
      }
    },
  };
};
