import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLAYER_HEARTBEAT_MS, PLAYER_SOCKET_PATH, type HubToPlayerMessage } from "@media-centre/shared";

import {
  connectToHub,
  RETRY_DELAYS_MS,
  SILENCE_MS,
  type HubConnection,
  type HubConnectionState,
} from "./hub-connection.ts";
import { fakeSockets, type FakeSocket } from "./testing/fake-sockets.ts";

const HUB = "192.168.1.10:8080";

let sockets: ReturnType<typeof fakeSockets>;
let states: HubConnectionState[];
let messages: HubToPlayerMessage[];
let connection: HubConnection;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = fakeSockets();
  states = [];
  messages = [];
  connection = connectToHub({
    address: HUB,
    openSocket: sockets.openSocket,
    onState: (state) => states.push(state),
    onMessage: (message) => messages.push(message),
  });
});

afterEach(() => {
  connection.close();
  vi.useRealTimers();
});

const latest = (): FakeSocket => {
  const socket = sockets.opened.at(-1);
  if (socket === undefined) throw new Error("No socket was opened");
  return socket;
};

describe("the Player's connection to the Hub", () => {
  it("opens a WebSocket to the Hub's Player path at its address", () => {
    expect(sockets.opened.map(({ url }) => url)).toEqual([`ws://${HUB}${PLAYER_SOCKET_PATH}`]);
    expect(states).toEqual(["connecting"]);

    latest().accept();

    expect(states).toEqual(["connecting", "connected"]);
  });

  it("passes on what the Hub sends, and ignores what isn't JSON", () => {
    latest().accept();

    latest().receive("not JSON");
    latest().receive(JSON.stringify({ type: "heartbeat" }));

    expect(messages).toEqual([{ type: "heartbeat" }]);
  });

  it("sends the Hub a message once the socket is open, and drops one sent while it isn't", () => {
    const report = {
      type: "playback",
      playback: { state: "idle", url: null, positionMs: 0, durationMs: null, audioTrack: null },
    } as const;
    connection.send(report);
    expect(latest().sent).toEqual([]);

    latest().accept();
    connection.send(report);
    expect(latest().sent).toEqual([report]);

    latest().drop();
    connection.send(report);
    expect(sockets.opened[0]?.sent).toEqual([report]);
  });

  it("opens the socket again after it drops, sooner at first and then every 10 seconds", () => {
    latest().accept();
    latest().drop();
    expect(states.at(-1)).toBe("retrying");

    for (const delay of [...RETRY_DELAYS_MS, 10_000, 10_000]) {
      const opened = sockets.opened.length;
      vi.advanceTimersByTime(delay - 1);
      expect(sockets.opened).toHaveLength(opened);
      vi.advanceTimersByTime(1);
      expect(sockets.opened).toHaveLength(opened + 1);
      latest().drop();
    }
    expect(RETRY_DELAYS_MS.at(-1)).toBe(10_000);
    expect(states.at(-1)).toBe("retrying");
  });

  it("goes back to trying soon once it has connected again", () => {
    for (let failed = 0; failed < 4; failed += 1) {
      latest().drop();
      vi.advanceTimersByTime(10_000);
    }
    latest().accept();
    expect(states.at(-1)).toBe("connected");

    latest().drop();
    const opened = sockets.opened.length;
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0] ?? 0);

    expect(sockets.opened).toHaveLength(opened + 1);
  });

  it("takes the socket for dropped when the Hub's heartbeat stops, and opens another", () => {
    latest().accept();
    for (let beat = 0; beat < 5; beat += 1) {
      vi.advanceTimersByTime(PLAYER_HEARTBEAT_MS);
      latest().receive(JSON.stringify({ type: "heartbeat" }));
    }
    expect(sockets.opened).toHaveLength(1);

    const silent = latest();
    vi.advanceTimersByTime(SILENCE_MS);

    expect(silent.closed()).toBe(true);
    expect(states.at(-1)).toBe("retrying");
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0] ?? 0);
    expect(sockets.opened).toHaveLength(2);
  });

  it("opens no more sockets once closed", () => {
    latest().accept();

    connection.close();
    vi.advanceTimersByTime(60_000);

    expect(latest().closed()).toBe(true);
    expect(sockets.opened).toHaveLength(1);
    expect(states.at(-1)).toBe("connected");
  });

  it("tries again when the socket can't even be made", () => {
    connection.close();
    let tries = 0;
    connection = connectToHub({
      address: HUB,
      openSocket: (url) => {
        tries += 1;
        if (tries === 1) throw new SyntaxError("Bad URL");
        return sockets.openSocket(url);
      },
      onState: (state) => states.push(state),
    });
    expect(states.at(-1)).toBe("retrying");

    vi.advanceTimersByTime(RETRY_DELAYS_MS[0] ?? 0);

    expect(tries).toBe(2);
  });
});
