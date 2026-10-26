import { PLAYER_HEARTBEAT_MS, type HubToPlayerMessage, type PlayerToHubMessage } from "@media-centre/shared";

import { hubSocketUrl } from "./hub-address.ts";

/**
 * - `connecting`: opening the socket for the first time.
 * - `connected`.
 * - `retrying`: the socket couldn't open, or dropped, and the Player is
 *   opening it again, until it does.
 */
export type HubConnectionState = "connecting" | "connected" | "retrying";

/** The part of a browser's WebSocket the Player uses, so that a test can give it another. */
export interface PlayerSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  readonly send: (data: string) => void;
  readonly close: () => void;
}

export type OpenSocket = (url: string) => PlayerSocket;

export interface HubConnectionOptions {
  /** The Hub's address, as `hubAddressIn` gives it. */
  readonly address: string;
  readonly openSocket: OpenSocket;
  readonly onState: (state: HubConnectionState) => void;
  readonly onMessage?: (message: HubToPlayerMessage) => void;
}

export interface HubConnection {
  /** Sends the message to the Hub if the socket is open, and drops it if it isn't. */
  readonly send: (message: PlayerToHubMessage) => void;
  /** Closes the socket, and opens it no more. */
  readonly close: () => void;
}

/** How long the Player waits before each try to open the socket again: soon at first, then every 10 seconds. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];

/** How long the Player hears nothing from the Hub before it takes the socket for dropped. */
export const SILENCE_MS = 3 * PLAYER_HEARTBEAT_MS;

/**
 * Opens the Player's WebSocket to the Hub (ADR 0003), and opens it again
 * whenever it drops: when it closes, as when the Hub restarts, and when the
 * Hub's heartbeat stops, as when the Hub's machine loses power without
 * closing it.
 */
export const connectToHub = ({ address, openSocket, onState, onMessage }: HubConnectionOptions): HubConnection => {
  let socket: PlayerSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let closed = false;
  /** The socket, once it has opened, until it is let go of. */
  let connected: PlayerSocket | null = null;

  const wait = (ms: number, then: () => void): void => {
    clearTimeout(timer);
    timer = setTimeout(then, ms);
  };

  /** Lets go of the socket, without waiting for it to say it has closed, and tries again after a while. */
  const drop = (): void => {
    connected = null;
    if (socket !== null) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // It is let go of all the same.
      }
      socket = null;
    }
    if (closed) return;
    onState("retrying");
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 0;
    failures += 1;
    wait(delay, open);
  };

  const open = (): void => {
    try {
      socket = openSocket(hubSocketUrl(address));
    } catch {
      drop();
      return;
    }
    const opening = socket;
    socket.onopen = () => {
      failures = 0;
      connected = opening;
      onState("connected");
      wait(SILENCE_MS, drop);
    };
    socket.onmessage = ({ data }: { readonly data: unknown }) => {
      wait(SILENCE_MS, drop);
      if (typeof data !== "string") return;
      try {
        onMessage?.(JSON.parse(data) as HubToPlayerMessage);
      } catch {
        // Not a message the Player knows; the Hub is newer than it.
      }
    };
    socket.onclose = drop;
  };

  onState("connecting");
  open();

  return {
    send: (message) => {
      try {
        connected?.send(JSON.stringify(message));
      } catch {
        // Dropped as it closes, which opens it again.
      }
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      drop();
    },
  };
};
