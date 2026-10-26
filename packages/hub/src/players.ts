import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import {
  PLAYER_HEARTBEAT_MS,
  PLAYER_SOCKET_PATH,
  type HubToPlayerMessage,
  type PlaybackControl,
  type PlaybackState,
  type PlayerPlayback,
  type PlayerToHubMessage,
} from "@media-centre/shared";

import type { ApplianceStore } from "./appliances.ts";

/** The Players connected to the Hub, each on the TV at the address it connected from (ADR 0003). */
export interface Players {
  /** Whether a Player is connected from this address, i.e. running on the TV there. */
  readonly connectedAt: (address: string) => boolean;
  /**
   * Resolves true once a Player is connected from `address` to the Hub at
   * `hubAddress`, its `host:port` as the Player reached it, at once if one is
   * already; or false if none has after `timeoutMs`, or once the Hub stops.
   * A Player connected to the Hub at another address, which it may have
   * remembered, isn't waited for: launched with this one, it connects again
   * at this one, and its old socket may close before it reads anything sent.
   */
  readonly waitFor: (address: string, hubAddress: string, timeoutMs: number) => Promise<boolean>;
  /**
   * Sends the message to each Player connected from `address` to the Hub at
   * `hubAddress`, as {@link waitFor} waits for, and resolves with how many
   * it was sent to once it has gone.
   */
  readonly send: (address: string, hubAddress: string, message: HubToPlayerMessage) => Promise<number>;
  /**
   * What the Player connected from this address last said of its playback
   * (FR-36), or null when none is connected or none has said. Of two
   * connected there, as for a moment while one replaces the other, the one
   * playing something, then the one that said last.
   */
  readonly playbackAt: (address: string) => PlayerPlayback | null;
  /**
   * Sends the control to each Player connected from this address, whichever
   * address of the Hub it reached, and resolves once one of them reports its
   * playback after it, or after `timeoutMs` if none does: true either way if
   * it was sent to any, false if none is connected.
   */
  readonly control: (address: string, control: PlaybackControl, timeoutMs: number) => Promise<boolean>;
  /**
   * Sends the `play` message to each Player connected from this address, as
   * {@link control} sends a control, and resolves as it does: as when the
   * Hub sends what it plays again, from where it is, by another Route (FR-45).
   */
  readonly playAgain: (
    address: string,
    play: HubToPlayerMessage & { readonly type: "play" },
    timeoutMs: number,
  ) => Promise<boolean>;
  /** Closes every Player's socket, as the Hub stops. Each Player connects again once the Hub is back. */
  readonly close: () => void;
}

/** A Player the Hub has heard from, and how to answer it alone. */
export interface PlayerAt {
  /** The TV's address, which it connected from. */
  readonly address: string;
  /** The Hub's `host:port` as it reached it, which it was launched with. */
  readonly hubAddress: string;
  /** Sends this Player the message, if its socket is still open. */
  readonly reply: (message: HubToPlayerMessage) => void;
}

/** A Media File a Player asked the Hub to resume (FR-39), by names still to be checked. */
export interface ResumeRequest {
  readonly mediaSourceId: number;
  readonly path: string;
}

export interface PlayersOptions {
  /** How often each Player is sent a heartbeat, and asked for a pong. By default {@link PLAYER_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  /** Hears each report a Player makes of its playback, once the Hub has it. */
  readonly onPlayback?: (player: PlayerAt, playback: PlayerPlayback) => void;
  /** Hears each Player asking to resume a Media File, from its waiting screen (FR-39). */
  readonly onResume?: (player: PlayerAt, file: ResumeRequest) => void;
  /** Hears each Player saying the Media File at `url`, as the Hub sent it, has played to its end (FR-48). */
  readonly onEnded?: (player: PlayerAt, url: string) => void;
  /** Hears each Player disconnecting, from the TV at this address, once its socket has gone. */
  readonly onDisconnect?: (address: string) => void;
}

/**
 * An IPv4 address as `Appliance.address` has it, from a socket's remote
 * address, which a server listening on IPv6 too gives as `::ffff:a.b.c.d`.
 */
const ipv4 = (address: string | undefined): string => (address ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

/** A `host:port`, with HTTP's port when it has none, so that two ways of writing one address are the same. */
const withPort = (host: string): string => (/:\d+$/.test(host) ? host : `${host}:80`).toLowerCase();

const PLAYBACK_STATES: ReadonlySet<string> = new Set<PlaybackState>(["idle", "loading", "paused", "playing"]);

/**
 * The message from a Player, or undefined if it isn't one the Hub knows, as
 * from a Player newer than it, or not one at all. Whatever connects to the
 * Players' path may send anything.
 */
const messageIn = (data: string): PlayerToHubMessage | undefined => {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null || !("type" in message)) return undefined;
  if (message.type === "resume") {
    const { mediaSourceId, path } = message as Record<string, unknown>;
    if (!Number.isSafeInteger(mediaSourceId) || (mediaSourceId as number) < 1) return undefined;
    if (typeof path !== "string" || path.trim() === "") return undefined;
    return { type: "resume", mediaSourceId: mediaSourceId as number, path };
  }
  if (message.type === "ended") {
    const { url } = message as Record<string, unknown>;
    return typeof url === "string" && url !== "" ? { type: "ended", url } : undefined;
  }
  if (message.type !== "playback") return undefined;
  const playback = playbackIn("playback" in message ? message.playback : undefined);
  return playback === undefined ? undefined : { type: "playback", playback };
};

/**
 * The {@link PlayerPlayback} a Player reports, or undefined if it isn't one.
 * One that doesn't say which audio track it plays, as a Player older than
 * the Hub doesn't, plays one it doesn't say, and one that doesn't say which
 * subtitle track it shows shows none.
 */
const playbackIn = (playback: unknown): PlayerPlayback | undefined => {
  if (typeof playback !== "object" || playback === null) return undefined;
  const { state, url, positionMs, durationMs, audioTrack, subtitleTrack } = playback as Record<string, unknown>;
  const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (typeof state !== "string" || !PLAYBACK_STATES.has(state)) return undefined;
  if (url !== null && typeof url !== "string") return undefined;
  if (!time(positionMs) || (durationMs !== null && !time(durationMs))) return undefined;
  return {
    state: state as PlaybackState,
    url: state === "idle" ? null : url,
    positionMs,
    durationMs,
    audioTrack:
      state !== "idle" && Number.isSafeInteger(audioTrack) && (audioTrack as number) >= 0
        ? (audioTrack as number)
        : null,
    subtitleTrack:
      state !== "idle" && Number.isSafeInteger(subtitleTrack) && (subtitleTrack as number) >= 0
        ? (subtitleTrack as number)
        : null,
  };
};

/** A Player's socket, as the Hub knows it. */
interface ConnectedPlayer {
  /** The TV's address, which it connected from. */
  readonly address: string;
  /** The Hub's address as it reached it, which it was launched with. */
  readonly hubAddress: string;
  /** Whether it has answered the last ping. */
  alive: boolean;
  /** What it last said of its playback, or null until it has. */
  playback: PlayerPlayback | null;
  /** When it last said so, by the count of every Player's reports. */
  reportedAt: number;
}

/**
 * Accepts the Players' WebSockets at `PLAYER_SOCKET_PATH` on the Hub's HTTP server,
 * and refuses any other upgrade. A Player is on the TV whose address it
 * connects from, which is looked up when asked, so one that connects before
 * its TV is added counts once the TV is. Each Player is sent a heartbeat
 * every `heartbeatMs`, so that it can tell a dropped connection, and one that
 * doesn't answer the ping sent with it by the next is dropped. What each
 * reports of its playback is kept until it reports again or disconnects.
 */
export const acceptPlayers = (
  server: Server,
  appliances: ApplianceStore,
  { heartbeatMs = PLAYER_HEARTBEAT_MS, onPlayback, onResume, onEnded, onDisconnect }: PlayersOptions = {},
): Players => {
  const sockets = new WebSocketServer({ noServer: true });
  const players = new Map<WebSocket, ConnectedPlayer>();
  /** Counts every report from every Player, so that the latest is known. */
  let reports = 0;
  /** Each {@link Players.control} waiting for a Player at its address to report. */
  const awaitingReports = new Set<{ readonly address: string; readonly finish: () => void }>();
  /** Each Player {@link Players.waitFor} is waiting for, finished once one connects, or it gives up. */
  const waiting = new Set<{
    readonly address: string;
    readonly hubAddress: string;
    readonly finish: (connected: boolean) => void;
  }>();
  /**
   * Sends the message to each Player connected from this address, and
   * resolves once one of them reports its playback after it, or after
   * `timeoutMs`: true if it was sent to any, false if none is connected.
   */
  const sendAwaitingReport = async (
    address: string,
    message: HubToPlayerMessage,
    timeoutMs: number,
  ): Promise<boolean> => {
    const sockets = [...players]
      .filter(([socket, player]) => player.address === address && socket.readyState === socket.OPEN)
      .map(([socket]) => socket);
    if (sockets.length === 0) return false;
    const reported = new Promise<void>((resolve) => {
      const awaiting = {
        address,
        finish: (): void => {
          clearTimeout(timeout);
          awaitingReports.delete(awaiting);
          resolve();
        },
      };
      const timeout = setTimeout(awaiting.finish, timeoutMs);
      awaitingReports.add(awaiting);
    });
    for (const socket of sockets) socket.send(JSON.stringify(message));
    await reported;
    return true;
  };
  const connectedTo = (address: string, hubAddress: string): WebSocket[] =>
    [...players]
      .filter(([, player]) => player.address === address && player.hubAddress === withPort(hubAddress))
      .map(([socket]) => socket);

  /** "on Living room · TV", or "at <address>" if no TV the Hub has is there. */
  const where = (address: string): { readonly at: string; readonly known: boolean } => {
    const tv = appliances.list().find((appliance) => appliance.kind === "tv" && appliance.address === address);
    return tv === undefined ? { at: `at ${address}`, known: false } : { at: `on ${appliances.title(tv)}`, known: true };
  };

  const heartbeat: HubToPlayerMessage = { type: "heartbeat" };
  const timer = setInterval(() => {
    for (const [socket, player] of players) {
      if (!player.alive) {
        socket.terminate();
        continue;
      }
      player.alive = false;
      socket.ping();
      socket.send(JSON.stringify(heartbeat));
    }
  }, heartbeatMs);
  timer.unref();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "http://hub");
    if (pathname !== PLAYER_SOCKET_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (player) => {
      const address = ipv4(request.socket.remoteAddress);
      const state: ConnectedPlayer = {
        address,
        hubAddress: withPort(request.headers.host ?? ""),
        alive: true,
        playback: null,
        reportedAt: 0,
      };
      players.set(player, state);
      for (const wait of [...waiting]) {
        if (wait.address === state.address && wait.hubAddress === state.hubAddress) wait.finish(true);
      }
      // Named now, as the Hub's state may be closed by the time it disconnects.
      const { at, known } = where(address);
      console.log(`A Player connected ${at}${known ? "" : ", which is not a TV the Hub has"}`);
      player.on("pong", () => {
        state.alive = true;
      });
      const from: PlayerAt = {
        address,
        hubAddress: state.hubAddress,
        reply: (message) => {
          if (player.readyState === player.OPEN) player.send(JSON.stringify(message));
        },
      };
      player.on("message", (data: Buffer, isBinary: boolean) => {
        const message = isBinary ? undefined : messageIn(data.toString("utf8"));
        if (message === undefined) return;
        if (message.type === "resume") {
          onResume?.(from, { mediaSourceId: message.mediaSourceId, path: message.path });
          return;
        }
        if (message.type === "ended") {
          onEnded?.(from, message.url);
          return;
        }
        reports += 1;
        state.playback = message.playback;
        state.reportedAt = reports;
        onPlayback?.(from, message.playback);
        for (const awaiting of [...awaitingReports]) if (awaiting.address === address) awaiting.finish();
      });
      player.on("close", () => {
        players.delete(player);
        console.log(`The Player ${at} disconnected`);
        onDisconnect?.(address);
      });
      // A socket that fails is closed too, which is all the Hub does about it.
      player.on("error", () => undefined);
    });
  });

  return {
    connectedAt: (address) => [...players.values()].some((player) => player.address === address),
    waitFor: (address, hubAddress, timeoutMs) => {
      if (connectedTo(address, hubAddress).length > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const wait = {
          address,
          hubAddress: withPort(hubAddress),
          finish: (connected: boolean): void => {
            clearTimeout(timeout);
            waiting.delete(wait);
            resolve(connected);
          },
        };
        const timeout = setTimeout(() => {
          wait.finish(false);
        }, timeoutMs);
        waiting.add(wait);
      });
    },
    send: async (address, hubAddress, message) => {
      const sockets = connectedTo(address, hubAddress).filter((socket) => socket.readyState === socket.OPEN);
      const text = JSON.stringify(message);
      const sent = await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<boolean>((resolve) => {
              // Called with null rather than nothing once it has gone, whatever the types say.
              socket.send(text, (error) => {
                resolve(!(error instanceof Error));
              });
            }),
        ),
      );
      return sent.filter(Boolean).length;
    },
    playbackAt: (address) => {
      const reported = [...players.values()]
        .filter((player) => player.address === address && player.playback !== null)
        .sort(
          (a, b) =>
            Number(b.playback?.state !== "idle") - Number(a.playback?.state !== "idle") || b.reportedAt - a.reportedAt,
        );
      return reported[0]?.playback ?? null;
    },
    control: (address, control, timeoutMs) => sendAwaitingReport(address, { type: "control", control }, timeoutMs),
    playAgain: sendAwaitingReport,
    close: () => {
      for (const wait of [...waiting]) wait.finish(false);
      for (const awaiting of [...awaitingReports]) awaiting.finish();
      clearInterval(timer);
      for (const player of players.keys()) player.terminate();
      sockets.close();
    },
  };
};
