import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { PLAYER_APP_ID, PLAYER_SOCKET_PATH, playerLaunchParameter } from "@media-centre/shared";

import {
  FAKE_APPS,
  FAKE_PLAYER_APP,
  startFakeSamsungTv,
  type FakeSamsungTv,
} from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { APP_LAUNCH_EVENT } from "./applications.ts";
import { samsungTvDriver } from "./samsung-tv-driver.ts";

// The fake TV at its own loopback address, as a TV on the home network
// would be, so that its Player is seen to connect from there.
const TV_HOST = "127.0.0.2";

let tv: FakeSamsungTv;
let driver: Driver;
let token: string;
/** Stands in for the Hub: where the Player connects to, and what connected, from which address. */
let hub: Server;
let hubAddress: string;
let connected: { readonly from: string | undefined; readonly socket: WebSocket }[];

beforeEach(async () => {
  tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
  driver = samsungTvDriver({ restPort: tv.restPort, controlPort: tv.controlPort, appsTimeoutMs: 1_000 });
  token = await driver.pair(tv.host);

  connected = [];
  hub = createServer();
  const sockets = new WebSocketServer({ server: hub, path: PLAYER_SOCKET_PATH });
  sockets.on("connection", (socket, request: IncomingMessage) => {
    connected.push({ from: request.socket.remoteAddress, socket });
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  hubAddress = `127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  driver.disconnect?.(tv.host);
  await tv.stop();
  for (const { socket } of connected) socket.terminate();
  await new Promise((done) => hub.close(done));
});

const launchPlayer = (address = hubAddress, credentials = token) => {
  if (driver.launchPlayer === undefined) throw new Error("The Samsung TV Driver launches the Player");
  return driver.launchPlayer(tv.host, credentials, address);
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

/** Every message the Driver sent on the control socket, parsed. */
const sent = (): unknown[] =>
  tv.connections.flatMap(({ messages }) => messages.map((text) => JSON.parse(text) as unknown));

describe("the Samsung TV Driver launching the Player, against the fake Samsung TV (FR-35)", () => {
  it("launches it as a deep link on the control socket, with the Hub's address as its launch data", async () => {
    expect(await launchPlayer()).toEqual({ accepted: true, credentials: token });

    expect(sent()).toContainEqual({
      method: "ms.channel.emit",
      params: {
        event: APP_LAUNCH_EVENT,
        to: "host",
        data: { appId: PLAYER_APP_ID, action_type: "DEEP_LINK", metaTag: playerLaunchParameter(hubAddress) },
      },
    });
    expect(tv.apps()).toContainEqual({ id: PLAYER_APP_ID, name: "Media Centre", running: true, visible: true });
  });

  it("has the Player connect back to the Hub at that address, from the TV's own", async () => {
    await launchPlayer();

    await expect.poll(() => connected.map(({ from }) => from?.replace(/^::ffff:/, ""))).toEqual([TV_HOST]);
    expect(tv.playerStatus()).toMatchObject({ running: true, hubAddress, connected: true });
  });

  it("launches it on the control socket that keys are sent on, kept open", async () => {
    await driver.pressKey?.(tv.host, token, "ok");
    await launchPlayer();

    expect(tv.connections.filter(({ outcome }) => outcome === "accepted")).toHaveLength(1);
  });

  it("says the Player isn't installed on a TV that hasn't got it", async () => {
    tv.setApps(FAKE_APPS);

    const error = await failure(launchPlayer());

    expect(error.reason).toBe("not-supported");
    expect(error.message).toBe(
      "The Player isn't installed on the TV. Install it from the TV's Developer section first.",
    );
    expect(tv.playerStatus().running).toBe(false);
  });

  it("says the TV didn't answer when it is in standby, and launches nothing", async () => {
    tv.setPowerState("standby");

    const error = await failure(launchPlayer());

    expect(error.reason).toBe("timed-out");
    expect(error.message).toBe(`The TV at ${TV_HOST} didn't answer.`);
    expect(tv.playerStatus().running).toBe(false);
  });

  it("reports a token the TV refuses once access is revoked on it", async () => {
    tv.revokeAccess();

    expect(await launchPlayer()).toEqual({ accepted: false });
  });
});
