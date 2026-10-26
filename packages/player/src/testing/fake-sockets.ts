import type { OpenSocket, PlayerSocket } from "../hub-connection.ts";

/** A WebSocket the test opens, sends on and drops, as the Hub would. */
export interface FakeSocket extends PlayerSocket {
  readonly url: string;
  /** Every message the Player sent on it, parsed, oldest first. */
  readonly sent: unknown[];
  /** Whether the Player has closed it. */
  readonly closed: () => boolean;
  /** As the Hub accepting it. */
  readonly accept: () => void;
  /** As the Hub sending this. */
  readonly receive: (data: unknown) => void;
  /** As the Hub closing it, or it failing to open. */
  readonly drop: () => void;
}

/** Every socket the Player opens, newest last, for a test to act as the Hub on. */
export const fakeSockets = (): { readonly opened: FakeSocket[]; readonly openSocket: OpenSocket } => {
  const opened: FakeSocket[] = [];
  const openSocket: OpenSocket = (url) => {
    let closed = false;
    const sent: unknown[] = [];
    const socket: FakeSocket = {
      url,
      onopen: null,
      onmessage: null,
      onclose: null,
      sent,
      send: (data) => {
        sent.push(JSON.parse(data));
      },
      close: () => {
        closed = true;
      },
      closed: () => closed,
      accept: () => socket.onopen?.(new Event("open")),
      receive: (data) => socket.onmessage?.(new MessageEvent("message", { data })),
      drop: () => socket.onclose?.(new CloseEvent("close")),
    };
    opened.push(socket);
    return socket;
  };
  return { opened, openSocket };
};
