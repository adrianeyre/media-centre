import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { HUB_INFO_PATH, LATEST_VERSION_PATH, type HubInfo, type LatestVersion } from "@media-centre/shared";

import { amazon as amazonThroughAlexa, amazonAccountStore, type AmazonOptions } from "./amazon.ts";
import { handleAmazonRequest } from "./amazon-api.ts";
import { ring as ringThroughItsApp, ringAccountStore, type RingOptions } from "./ring.ts";
import { handleRingRequest } from "./ring-api.ts";
import { handleAppliancesRequest } from "./appliances-api.ts";
import type { AmazonDriver } from "./drivers/amazon/amazon-driver.ts";
import { alexaDriver } from "./drivers/amazon/alexa.ts";
import type { RingDriver } from "./drivers/ring/ring-driver.ts";
import { ringDriver } from "./drivers/ring/ring.ts";
import { bluetoothScanner, windowsWatch, type BluetoothScannerOptions } from "./bluetooth.ts";
import { handleBluetoothRequest } from "./bluetooth-api.ts";
import { applianceStore } from "./appliances.ts";
import type { Drivers, PlayableFormats } from "./drivers/driver.ts";
import { driversFromEnvironment } from "./drivers/drivers.ts";
import { ffprobeMedia, type ProbeMedia } from "./ffprobe.ts";
import { filmLightScenes } from "./film-light-scenes.ts";
import { floorPlanStore } from "./floor-plan.ts";
import { heating as heatingThroughHive } from "./heating.ts";
import { handleHeatingRequest } from "./heating-api.ts";
import { hive as signInToHive, hiveAccountStore } from "./hive.ts";
import { handleHiveRequest } from "./hive-api.ts";
import { HttpRefusal, sendError, sendJson } from "./http.ts";
import { handleHubAddressRequest } from "./hub-address-api.ts";
import { hubAddressStore, type NetworkInterfaces } from "./hub-address.ts";
import type { LatestVersionOf } from "./latest-version.ts";
import { lightSceneStore } from "./light-scenes.ts";
import { handleLightScenesRequest } from "./light-scenes-api.ts";
import { mediaProbes } from "./media-probes.ts";
import { handleMediaSourcesRequest } from "./media-sources-api.ts";
import { mediaSourceStore } from "./media-sources.ts";
import { networkScanner, type NetworkScannerOptions } from "./network.ts";
import { networkDeviceStore } from "./network-devices.ts";
import { handleNetworkRequest } from "./network-api.ts";
import { handlePlayRequest, type PlayOptions } from "./play-api.ts";
import { createPlayerToolsHandler } from "./player-tools-api.ts";
import { acceptPlayers } from "./players.ts";
import { handlePlayersRequest, nowPlaying, type PlayersApiOptions } from "./players-api.ts";
import { previewPictures, type PreviewsOptions } from "./previews.ts";
import { playQueues, type QueuesOptions } from "./queues.ts";
import { serveRemoteFile } from "./remote-files.ts";
import { handleRoomsRequest } from "./rooms-api.ts";
import { resumeWithPlayers } from "./resume.ts";
import { resumePositionStore } from "./resume-positions.ts";
import { roomStore } from "./rooms.ts";
import { sentTracks } from "./sent-tracks.ts";
import { handleSigningCertificateRequest } from "./signing-certificate-api.ts";
import { signingCertificateStore } from "./signing-certificates.ts";
import { hlsStreams, type StreamsOptions } from "./streams.ts";

export interface HubOptions {
  /** The Remote's built files, served to any browser that opens the Hub. */
  readonly remoteDir: string;
  readonly version: string;
  /** See `HubInfo.hubId`. */
  readonly hubId: string;
  /** The Hub's state (FR-3), opened by `openDatabase`. */
  readonly database: DatabaseSync;
  /** The Driver for each kind of Appliance. By default, those for real Appliances. */
  readonly drivers?: Drivers;
  /** Where the Hub looks for its own address (see `HubAddress.found`). By default, its own network interfaces. */
  readonly networkInterfaces?: NetworkInterfaces;
  /** How the Hub reads a Media File's duration and streams, which its Route is chosen by. By default, with ffprobe. */
  readonly probeMedia?: ProbeMedia;
  /** How long playing a Media File waits for a TV and its Player. By default, as the PRD says (FR-35). */
  readonly play?: PlayOptions;
  /** How long a control from the now-playing bar waits for the Player to report. By default, 3 seconds. */
  readonly playback?: PlayersApiOptions;
  /** How the Hub streams Media Files as HLS. By default, as the PRD says (FR-42). */
  readonly streams?: StreamsOptions;
  /** How the Hub extracts preview pictures, and how often. By default, with ffmpeg, as the PRD says (FR-27). */
  readonly previews?: PreviewsOptions;
  /** How the Hub shuffles a Queue. By default, at random. */
  readonly queues?: QueuesOptions;
  /** The Player build the Hub installs on TVs (FR-31). By default, the one `pnpm build` writes, `packages/player/dist`. */
  readonly playerDir?: string;
  /** How the Hub finds the latest version of media-centre, for the Remote to offer an update (FR-61). By default, it doesn't. */
  readonly latestVersion?: LatestVersionOf;
  /** How the Network tab's scan finds the devices on the home network. By default, on the Hub's own subnet. */
  readonly network?: NetworkScannerOptions;
  /** How the Network tab listens for Bluetooth devices. By default, with Windows' own API, on Windows alone. */
  readonly bluetooth?: BluetoothScannerOptions;
  /** How the Amazon tab reaches the owner's Echo devices. By default, through the Alexa app's API (ADR 0011). */
  readonly amazon?: AmazonOptions & { readonly driver?: AmazonDriver };
  /** How the Ring tab reaches the owner's Ring devices. By default, through the Ring app's API (ADR 0014). */
  readonly ring?: RingOptions & { readonly driver?: RingDriver };
}

/**
 * The Hub's HTTP server: the Remote's files, the API the Remote talks to
 * (ADR 0001), and the WebSocket each Player keeps open to it (ADR 0003),
 * through which it records each Media File's Resume Position (FR-40), and
 * the HLS streams of the Media Files it doesn't serve as they are (FR-42),
 * which end as their Players stop or disconnect, and the preview pictures of
 * the videos they play, for Now Showing (FR-27), and the Queue each TV
 * plays, moving its Player on to the next Media File as each ends (FR-48),
 * and installs, launches and uninstalls the Player on TVs in Developer Mode,
 * signed with the owner's signing certificate (FR-31), and keeps each
 * Room's Light Scenes, recalling them on its Lights (FR-56), and each TV's
 * film Light Scene as a video starts on it, setting the Lights back as it
 * stops (FR-57), and keeps its one sign-in to Hive, whose Heating, Radiator
 * Valves and Hot Water it adds as Appliances (FR-67), and reads and changes
 * them through Hive as the Heating tab asks (FR-62 to FR-66). It is returned
 * unstarted, so the caller picks the port and tests can listen on port 0.
 */
export const createHub = ({
  remoteDir,
  version,
  hubId,
  database,
  drivers = driversFromEnvironment({}),
  networkInterfaces,
  probeMedia = ffprobeMedia,
  play = {},
  playback = {},
  streams: streamsOptions = {},
  previews: previewsOptions = {},
  queues: queuesOptions = {},
  playerDir = resolve(import.meta.dirname, "../../player/dist"),
  latestVersion = () => Promise.resolve(undefined),
  network: networkOptions = {},
  bluetooth: bluetoothOptions = process.platform === "win32" ? { watch: windowsWatch() } : {},
  amazon: { driver: amazonDriver = alexaDriver(), ...amazonOptions } = {},
  ring: { driver: ringDriverUsed = ringDriver(), ...ringOptions } = {},
}: HubOptions): Server => {
  const rooms = roomStore(database);
  const floorPlan = floorPlanStore(database);
  const appliances = applianceStore(database);
  const lightScenes = lightSceneStore(database);
  const hubAddress = hubAddressStore(database, networkInterfaces);
  const networkDevices = networkDeviceStore(database);
  const bluetooth = bluetoothScanner({ devices: networkDevices, rooms }, bluetoothOptions);
  const echos = amazonThroughAlexa(
    { driver: amazonDriver, account: amazonAccountStore(database), hubAddress, devices: networkDevices, rooms },
    amazonOptions,
  );
  echos.resume();
  const rings = ringThroughItsApp(
    { driver: ringDriverUsed, account: ringAccountStore(database), devices: networkDevices, rooms },
    ringOptions,
  );
  rings.resume();
  const network = networkScanner(
    { appliances, rooms, hubAddress, devices: networkDevices },
    {
      services: new Map([
        ...(drivers.tv.ports ?? []),
        ...(drivers["air-conditioner"]?.ports ?? []),
        ...(drivers.light?.ports ?? []),
      ]),
      ...(networkInterfaces === undefined ? {} : { interfaces: networkInterfaces }),
      ...networkOptions,
    },
  );
  const mediaSources = mediaSourceStore(database);
  const probes = mediaProbes(database, probeMedia);
  const resumePositions = resumePositionStore(database);
  const streams = hlsStreams(streamsOptions);
  const tracks = sentTracks();
  const previews = previewPictures(tracks, previewsOptions);
  const films = filmLightScenes({ appliances, scenes: lightScenes, drivers, sentTracks: tracks });
  const signingCertificate = signingCertificateStore(database);
  const hiveAccount = hiveAccountStore(database);
  const hive = signInToHive({ appliances, account: hiveAccount, driver: drivers.heating });
  const heating = heatingThroughHive({ appliances, account: hiveAccount, driver: drivers.heating });
  const handlePlayerToolsRequest = createPlayerToolsHandler({
    appliances,
    drivers,
    hubAddress,
    signingCertificate,
    playerDir,
  });
  const playersApi = () => ({ players, appliances, streams, sentTracks: tracks, previews, queues });
  const playableFormatsOf = (tvId: number): PlayableFormats | undefined => {
    const tv = appliances.list().find((appliance) => appliance.id === tvId);
    return tv?.kind === "tv" ? drivers.tv.playableFormats : undefined;
  };

  /** Whether the Hub has begun to stop, closing its server. */
  let closing = false;
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://hub");
    // Answered as the Hub stops, as a Player's request for a segment is when
    // its stream ends, so its connection, idle once more, mustn't keep the
    // Hub from stopping until it times out, as closing the server lets it.
    response.on("finish", () => {
      if (closing) {
        setImmediate(() => {
          server.closeIdleConnections();
        });
      }
    });

    handleRoomsRequest(rooms, floorPlan, request, response, pathname)
      .then(async (handled) => handled || streams.handle(request, response, pathname))
      .then(async (handled) => handled || handlePlayersRequest(playersApi(), playback, request, response, pathname))
      .then(
        async (handled) =>
          handled ||
          handlePlayRequest(
            {
              appliances,
              drivers,
              players,
              mediaSources,
              hubAddress,
              resumePositions,
              probeMedia,
              streams,
              sentTracks: tracks,
              queues,
            },
            play,
            request,
            response,
            pathname,
          ),
      )
      .then(async (handled) => handled || handlePlayerToolsRequest(request, response, pathname))
      .then(
        async (handled) =>
          handled ||
          handleLightScenesRequest(
            { scenes: lightScenes, appliances, drivers, onLightsChanged: films.changedByHand },
            request,
            response,
            pathname,
          ),
      )
      .then(async (handled) => handled || handleHiveRequest(hive, request, response, pathname))
      .then(async (handled) => handled || handleHeatingRequest(heating, request, response, pathname))
      .then(
        async (handled) =>
          handled ||
          handleAppliancesRequest(appliances, drivers, request, response, pathname, {
            nowPlayingAt: (address) => nowPlaying(playersApi(), address),
            onLightsChanged: films.changedByHand,
          }),
      )
      .then(async (handled) => handled || handleHubAddressRequest(hubAddress, request, response, pathname))
      .then(async (handled) => handled || handleAmazonRequest(echos, request, response, pathname))
      .then(async (handled) => handled || handleRingRequest(rings, request, response, pathname))
      .then(async (handled) => handled || handleBluetoothRequest(bluetooth, request, response, pathname))
      .then(async (handled) => handled || handleNetworkRequest(network, networkDevices, request, response, pathname))
      .then(
        async (handled) => handled || handleSigningCertificateRequest(signingCertificate, request, response, pathname),
      )
      .then(
        async (handled) =>
          handled ||
          handleMediaSourcesRequest(
            { sources: mediaSources, probes, resumePositions, probeMedia, playableFormatsOf },
            request,
            response,
            pathname,
          ),
      )
      .then(async (handled) => {
        if (handled) return;

        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }

        if (pathname === HUB_INFO_PATH) {
          const info: HubInfo = { product: "media-centre", version, hubId };
          sendJson(response, 200, info);
          return;
        }

        if (pathname === LATEST_VERSION_PATH) {
          const latest: LatestVersion = { version: (await latestVersion()) ?? null };
          sendJson(response, 200, latest);
          return;
        }

        if (pathname.startsWith("/api/")) {
          sendError(response, 404, "Not found");
          return;
        }

        return serveRemoteFile(remoteDir, pathname, request.headers.host, request.method === "HEAD", response);
      })
      .catch((error: unknown) => {
        if (error instanceof HttpRefusal && !response.headersSent) {
          // Close the connection rather than read a body that was refused unread.
          if (!request.complete) response.setHeader("connection", "close");
          sendError(response, error.status, error.message, error.needs);
          return;
        }
        console.error("Failed to answer a request", error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });

  const resume = resumeWithPlayers({
    appliances,
    drivers,
    mediaSources,
    resumePositions,
    probeMedia,
    streams,
    sentTracks: tracks,
    queues: {
      end: (address) => {
        queues.end(address);
      },
    },
  });
  const players = acceptPlayers(server, appliances, {
    onPlayback: (player, reported) => {
      // Recorded first, from the stream it plays, before that stream may end.
      resume.onPlayback(player, reported);
      streams.heard(player.address, reported);
      previews.heard(player.address, reported);
      films.heard(player.address, reported);
    },
    onResume: resume.onResume,
    onEnded: (player, url) => {
      queues.ended(player, url);
    },
    onDisconnect: (address) => {
      if (players.connectedAt(address)) return;
      streams.playerGone(address);
      films.playerGone(address);
    },
  });
  const queues = playQueues(
    { appliances, drivers, mediaSources, probeMedia, streams, sentTracks: tracks, players },
    queuesOptions,
  );
  // A Player's socket is no longer the HTTP server's to close, so closing the
  // server closes them too, rather than wait for them forever, and stops
  // every ffmpeg streaming to them, calling back only once their segments are
  // deleted, as the process may exit then.
  const close = server.close.bind(server);
  server.close = (callback) => {
    closing = true;
    players.close();
    const streamsClosed = streams.close().catch((error: unknown) => {
      console.error("Failed to delete the streams' segments", error);
    });
    return close((error) => {
      void streamsClosed.then(() => callback?.(error));
    });
  };
  return server;
};
