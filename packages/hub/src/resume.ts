import type { ApplianceStore } from "./appliances.ts";
import type { Drivers } from "./drivers/driver.ts";
import { findMediaFile } from "./media-files.ts";
import { MediaSourceRefusal, type MediaSourceStore } from "./media-sources.ts";
import { choosePlayRoute, PlayRouteRefusal, type PlayRouteDependencies } from "./play-routes.ts";
import type { PlayersOptions } from "./players.ts";
import type { Queues } from "./queues.ts";
import {
  fileNameOf,
  formatPosition,
  mediaFileIn,
  mediaFilePathOf,
  type ResumePositionStore,
} from "./resume-positions.ts";
import { ROUTE_NAMES } from "./routes.ts";

export interface ResumeDependencies extends PlayRouteDependencies {
  readonly appliances: ApplianceStore;
  readonly drivers: Drivers;
  readonly mediaSources: MediaSourceStore;
  readonly resumePositions: ResumePositionStore;
  readonly queues: Pick<Queues, "end">;
}

/**
 * What the Hub does with the Players for Resume Positions (FR-39, FR-40):
 *
 * - It records each Media File's Resume Position from what each Player
 *   reports as it plays, on whichever TV, and clears it once the Media File
 *   has played to within its last 5%.
 * - Whenever a Player says it plays nothing, it tells it the Media File
 *   whose Resume Position was recorded last, for its waiting screen to offer.
 * - When a Player asks to resume one, it sends it the URL of that Media File,
 *   or of its stream, by the Route it takes to that TV (FR-41), from its
 *   Resume Position, at the Hub's address the Player reached, ending any
 *   Queue the TV played, as it plays it on its own (FR-48).
 */
export const resumeWithPlayers = (
  dependencies: ResumeDependencies,
): Required<Pick<PlayersOptions, "onPlayback" | "onResume">> => {
  const { appliances, drivers, mediaSources, resumePositions, streams, queues } = dependencies;
  /** "on Living room · TV", or "at <address>" if no TV the Hub has is there. */
  const where = (address: string): string => {
    const tv = appliances.list().find((appliance) => appliance.kind === "tv" && appliance.address === address);
    return tv === undefined ? `at ${address}` : `on ${appliances.title(tv)}`;
  };

  return {
    onPlayback: ({ reply }, playback) => {
      try {
        if (playback.state === "idle") {
          reply({ type: "resumable", resumable: resumePositions.last() });
          return;
        }
        const file = mediaFileIn(playback.url) ?? streams.mediaFileAt(playback.url);
        if (file === null || playback.durationMs === null) return;
        if (resumePositions.record(file, playback.positionMs, playback.durationMs) === "cleared") {
          console.log(`"${fileNameOf(file.path)}" has played to within its last 5%, so its Resume Position is cleared`);
        }
      } catch (error) {
        console.error("Failed to record a Resume Position", error);
      }
    },

    onResume: ({ address, hubAddress, reply }, asked) => {
      const names = asked.path.split("/").filter((name) => name !== "");
      void (async () => {
        try {
          const source = mediaSources.find(asked.mediaSourceId);
          const found = await findMediaFile(source, names);
          const path = mediaFilePathOf(names);
          // A Player on no TV the Hub has is on a TV all the same, which the TV Driver knows.
          const tv = appliances.list().find((appliance) => appliance.kind === "tv" && appliance.address === address);
          const formats = drivers.tv.playableFormats;
          if (formats === undefined) throw new PlayRouteRefusal(400, "That Appliance can't play Media Files.");
          const { route, sentAt } = await choosePlayRoute(
            dependencies,
            { source, path, found },
            { address, title: tv === undefined ? "the TV" : appliances.title(tv), formats },
          );
          const positionMs = resumePositions.find({ mediaSourceId: source.id, path }) ?? 0;
          queues.end(address);
          reply({ type: "play", ...sentAt(hubAddress), positionMs });
          console.log(
            `Resumed "${found.name}" from ${formatPosition(positionMs)} on the Player ${where(address)}, by ${ROUTE_NAMES[route]}`,
          );
        } catch (error) {
          if (error instanceof MediaSourceRefusal || error instanceof PlayRouteRefusal) {
            console.log(
              `Couldn't resume "${fileNameOf(asked.path)}" on the Player ${where(address)}: ${error.message}`,
            );
          } else {
            console.error(`Failed to resume "${fileNameOf(asked.path)}" on the Player ${where(address)}`, error);
          }
          // What it offers may be out of date.
          reply({ type: "resumable", resumable: resumePositions.last() });
        }
      })();
    },
  };
};
