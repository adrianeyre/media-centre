import type { IncomingMessage, ServerResponse } from "node:http";

import {
  APPLIANCES_PATH,
  PLAY_WAKE_TIMEOUT_MS,
  type Appliance,
  type HubToPlayerMessage,
  type MediaSource,
  type PlayFolderRequest,
  type PlayProgress,
  type PlayRequest,
} from "@media-centre/shared";

import { pairAgainRefusal, withCredentials } from "./appliances-api.ts";
import { ApplianceRefusal, type ApplianceStore } from "./appliances.ts";
import { DriverFailure, type Driver, type Drivers } from "./drivers/driver.ts";
import { HttpRefusal, readJson, refuseMethod } from "./http.ts";
import type { HubAddressStore } from "./hub-address.ts";
import { findMediaFile, type MediaFileFound } from "./media-files.ts";
import { audioFilesIn } from "./media-folders.ts";
import { REFUSAL_STATUS } from "./media-sources-api.ts";
import { MediaSourceRefusal, type MediaSourceStore } from "./media-sources.ts";
import {
  choosePlayRoute,
  PlayRouteRefusal,
  type PlayRoute,
  type PlayRouteDependencies,
  type PlaySent,
} from "./play-routes.ts";
import type { Players } from "./players.ts";
import type { Queues } from "./queues.ts";
import { formatPosition, mediaFilePathOf, type ResumePositionStore } from "./resume-positions.ts";
import { ROUTE_NAMES } from "./routes.ts";

const PLAY_PATH = new RegExp(`^${APPLIANCES_PATH}/([1-9][0-9]{0,15})/play$`);

export interface PlayOptions {
  /** {@link PLAY_WAKE_TIMEOUT_MS} but in tests. */
  readonly wakeTimeoutMs?: number;
  /** How often the Hub asks a TV it woke whether it is on yet: every second. */
  readonly powerPollMs?: number;
  /** How long the Hub waits for the Player to connect once it has launched it: 30 seconds. */
  readonly playerTimeoutMs?: number;
}

export interface PlayDependencies extends PlayRouteDependencies {
  readonly appliances: ApplianceStore;
  readonly drivers: Drivers;
  readonly players: Players;
  readonly mediaSources: MediaSourceStore;
  readonly hubAddress: HubAddressStore;
  readonly resumePositions: ResumePositionStore;
  readonly queues: Pick<Queues, "start" | "end">;
}

/** Why playing a Media File failed once it had started, written for the person, who is shown it as is. */
class PlayFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayFailure";
  }
}

/** "30 seconds", or "1 second". */
const seconds = (ms: number): string => {
  const whole = Math.ceil(ms / 1_000);
  return whole === 1 ? "1 second" : `${String(whole)} seconds`;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Plays a Media File on a TV (see `appliancePlayPath` in `shared`), or
 * returns false for any other path. What can be refused is checked first, and
 * refused as any request is, the Media File's Route among them, which the
 * Hub chooses by probing it now (FR-41); then each step is sent as it
 * starts, so that the Remote shows it (FR-35). The Player is sent the URL
 * the Route has it play, the Media File itself or its stream, and where to
 * start, its Resume Position if it was asked to resume (FR-40). A folder
 * is played as a Queue of its audio Media Files, starting with the first,
 * from its start (FR-46); a Media File on its own ends any Queue the TV
 * played. It is logged, as the person asked for it, but never with
 * credentials (FR-4).
 */
export const handlePlayRequest = async (
  dependencies: PlayDependencies,
  options: PlayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  const id = PLAY_PATH.exec(pathname)?.[1];
  if (id === undefined) return false;
  if (request.method !== "POST") {
    refuseMethod(response, ["POST"]);
    return true;
  }
  const { appliances, drivers, mediaSources, hubAddress, resumePositions, queues } = dependencies;
  const asked = playRequestIn(await readJson(request));

  let appliance: Appliance;
  try {
    appliance = appliances.get(Number(id));
  } catch (error) {
    if (error instanceof ApplianceRefusal) throw new HttpRefusal(404, error.message);
    throw error;
  }
  const title = appliances.title(appliance);
  const driver: Partial<Driver> = appliance.kind === "tv" ? drivers.tv : {};
  const { readPowerState, switchOn, launchPlayer, playableFormats } = driver;
  if (
    readPowerState === undefined ||
    switchOn === undefined ||
    launchPlayer === undefined ||
    playableFormats === undefined
  )
    throw new HttpRefusal(400, `${title} can't play Media Files.`);
  const tv: Tv = { appliance, title, readPowerState, switchOn, launchPlayer };
  if (appliance.pairing === "pair-again") throw pairAgainRefusal(title);

  let names: string[];
  let file: { readonly source: MediaSource; readonly found: MediaFileFound };
  /** The folder played as a Queue, and its audio Media Files, if one is. */
  let queued: { readonly folder: string; readonly files: readonly string[] } | undefined;
  try {
    const source = mediaSources.find(asked.mediaSourceId);
    if ("folder" in asked) {
      const folderNames = asked.folder.split("/").filter((name) => name !== "");
      const files = await audioFilesIn(source, folderNames);
      const first = files[0];
      if (first === undefined) {
        const folderName = folderNames.at(-1) ?? source.name;
        throw new HttpRefusal(404, `There are no audio Media Files in "${folderName}" to play.`);
      }
      queued = { folder: folderNames.join("/"), files };
      names = [...folderNames, first];
    } else {
      names = asked.path.split("/").filter((name) => name !== "");
    }
    file = { source, found: await findMediaFile(source, names) };
  } catch (error) {
    if (error instanceof MediaSourceRefusal) throw new HttpRefusal(REFUSAL_STATUS[error.reason], error.message);
    throw error;
  }

  const address = hubAddress.read().address;
  if (address === null) {
    throw new HttpRefusal(
      409,
      "The Hub doesn't know its own IP address, which the TV needs to reach it. Set it in Settings, under Hub.",
    );
  }
  // The port this request reached the Hub on, which the TV reaches it on too.
  const hub = `${address}:${String(request.socket.localPort)}`;
  const path = mediaFilePathOf(names);
  const { name } = file.found;
  let route: PlayRoute;
  try {
    route = await choosePlayRoute(
      dependencies,
      { source: file.source, path, found: file.found },
      { address: appliance.address, title, formats: playableFormats },
    );
  } catch (error) {
    if (error instanceof PlayRouteRefusal) throw new HttpRefusal(error.status, error.message);
    throw error;
  }
  const positionMs =
    "resume" in asked && asked.resume ? (resumePositions.find({ mediaSourceId: file.source.id, path }) ?? 0) : 0;
  /** The URLs to send the Player, holding the folder as the TV's Queue, or ending any it had, as they are sent. */
  const sentAt = (at: string): PlaySent => {
    const sent = route.sentAt(at);
    if (queued === undefined) queues.end(appliance.address);
    else queues.start(appliance.address, { mediaSourceId: file.source.id, ...queued }, { hub: at, url: sent.url });
    return sent;
  };

  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  const tell = (progress: PlayProgress): void => {
    response.write(`${JSON.stringify(progress)}\n`);
  };
  try {
    await playOn(dependencies, options, tv, hub, (sent) => ({ type: "play", ...sent, positionMs }), sentAt, tell);
    const from = positionMs > 0 ? ` from ${formatPosition(positionMs)}` : "";
    const as = queued === undefined ? "" : `, 1 of ${String(queued.files.length)} in the Queue of "${queued.folder}",`;
    console.log(`Sent "${name}"${as} to the Player on ${title}, to play by ${ROUTE_NAMES[route.route]}${from}`);
    tell({ step: "sent" });
  } catch (error) {
    const known = error instanceof PlayFailure || error instanceof DriverFailure || error instanceof HttpRefusal;
    if (!known) console.error(`Failed to play "${name}" on ${title}`, error);
    const message = known ? error.message : "Something went wrong. Try again.";
    console.log(`Couldn't play "${name}" on ${title}: ${message}`);
    tell({ step: "failed", error: message });
  }
  response.end();
  return true;
};

/** The TV to play on, and what its Driver does to play. */
interface Tv {
  readonly appliance: Appliance;
  readonly title: string;
  readonly readPowerState: Driver["readPowerState"];
  readonly switchOn: NonNullable<Driver["switchOn"]>;
  readonly launchPlayer: NonNullable<Driver["launchPlayer"]>;
}

/**
 * The steps of FR-35, each told as it starts: wakes the TV if it isn't on,
 * and waits for it to come on; launches the Player with the Hub's address;
 * waits for the Player to connect from the TV to the Hub there; and sends it
 * the Media File's URLs, as `sentAt` has them at the Hub's address, only then,
 * and where to start.
 */
const playOn = async (
  { appliances, players }: PlayDependencies,
  { wakeTimeoutMs = PLAY_WAKE_TIMEOUT_MS, powerPollMs = 1_000, playerTimeoutMs = 30_000 }: PlayOptions,
  { appliance, title, readPowerState, switchOn, launchPlayer }: Tv,
  hub: string,
  play: (sent: PlaySent) => HubToPlayerMessage & { readonly type: "play" },
  sentAt: (hub: string) => PlaySent,
  tell: (progress: PlayProgress) => void,
): Promise<void> => {
  // One not answering is woken too, as Wake-on-LAN can wake a TV whose
  // firmware doesn't answer in standby.
  if ((await readPowerState(appliance.address)) !== "on") {
    tell({ step: "waking" });
    await switchOn(appliance);
    console.log(`Sent Wake-on-LAN to ${title}, to play a Media File on it`);
    const deadline = Date.now() + wakeTimeoutMs;
    let on = false;
    while (!on && Date.now() < deadline) {
      await wait(Math.min(powerPollMs, Math.max(0, deadline - Date.now())));
      on = (await readPowerState(appliance.address)) === "on";
    }
    if (!on) {
      throw new PlayFailure(
        `${title} didn't come on within ${seconds(wakeTimeoutMs)}. Check that it is plugged in and set to switch on ` +
          "over the network, then try again.",
      );
    }
  }

  tell({ step: "launching" });
  await withCredentials(appliances, appliance.id, "the Player's launch", (credentials) =>
    launchPlayer(appliance.address, credentials, hub),
  );

  tell({ step: "connecting" });
  if (!(await players.waitFor(appliance.address, hub, playerTimeoutMs))) {
    throw new PlayFailure(
      `The Player on ${title} didn't connect to the Hub within ${seconds(playerTimeoutMs)}. ` +
        `Check that the TV can reach the Hub at ${hub}.`,
    );
  }

  tell({ step: "sending" });
  if ((await players.send(appliance.address, hub, play(sentAt(hub)))) === 0) {
    throw new PlayFailure(`The Player on ${title} disconnected before it was sent the Media File. Try again.`);
  }
};

/**
 * The Media File a `PlayRequest` names, or the folder a `PlayFolderRequest`
 * does, which may be anything: it is checked against the Media Source after.
 */
const playRequestIn = (body: unknown): PlayRequest | PlayFolderRequest => {
  if (typeof body !== "object" || body === null) throw new HttpRefusal(400, "Say which Media File to play.");
  const mediaSourceId = "mediaSourceId" in body ? body.mediaSourceId : undefined;
  const path = "path" in body ? body.path : undefined;
  if (!Number.isSafeInteger(mediaSourceId) || (mediaSourceId as number) < 1) {
    throw new HttpRefusal(400, "Say which Media Source the Media File is in, by its id.");
  }
  if ("folder" in body && path === undefined) {
    if (typeof body.folder !== "string") {
      throw new HttpRefusal(400, 'Say which folder to play, by its path in the Media Source, "" for its own.');
    }
    return { mediaSourceId: mediaSourceId as number, folder: body.folder };
  }
  if (typeof path !== "string" || path.trim() === "") {
    throw new HttpRefusal(400, "Say which Media File to play, by its path in the Media Source.");
  }
  const resume = "resume" in body ? body.resume : undefined;
  if (resume !== undefined && typeof resume !== "boolean") {
    throw new HttpRefusal(400, "Say whether to resume the Media File, true or false.");
  }
  return { mediaSourceId: mediaSourceId as number, path, resume: resume === true };
};
