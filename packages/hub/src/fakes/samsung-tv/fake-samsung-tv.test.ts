import { createSocket } from "node:dgram";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  PLAYER_APP_ID,
  PLAYER_SOCKET_PATH,
  type HubToPlayerMessage,
  type PlayerPlayback,
  type PlayerToHubMessage,
} from "@media-centre/shared";

import type { SamsungAppStatus } from "../../drivers/samsung-tv/applications.ts";
import type { SamsungDeviceInfoResponse } from "../../drivers/samsung-tv/device-info.ts";
import { SOAP_ENCODING, SOAP_ENVELOPE_NAMESPACE } from "../../drivers/samsung-tv/rendering-control.ts";
import { parseSsdpMessage } from "../../drivers/samsung-tv/ssdp.ts";
import { magicPacket } from "../../drivers/wake-on-lan.ts";
import { freePort } from "../../testing/ports.ts";
import { startNodeProcess, type RunningProcess } from "../../testing/process.ts";
import {
  FAKE_APPS_PATH,
  FAKE_CONNECTIONS_PATH,
  FAKE_CONTROL_PATH,
  FAKE_DEVELOPER_PATH,
  FAKE_FRONT_PATH,
  FAKE_IGNORED_KEYS_PATH,
  FAKE_KEYBOARD_PATH,
  FAKE_KEYS_PATH,
  FAKE_PLAYER_APP,
  FAKE_PLAYER_PATH,
  FAKE_POWER_PATH,
  FAKE_REVOKE_PATH,
  FAKE_TEXT_PATH,
  FAKE_VOLUME_PATH,
  FAKE_WAKES_PATH,
  FAKE_APPS,
  startFakeSamsungTv,
  type FakeAppStatus,
  type FakeSamsungTv,
  type RecordedConnection,
  type RecordedKey,
  type RecordedRequest,
  type RecordedText,
  type RecordedWake,
} from "./fake-samsung-tv.ts";

let tv: FakeSamsungTv | undefined;
let process_: RunningProcess | undefined;

afterEach(async () => {
  await tv?.stop();
  await process_?.stop();
  tv = undefined;
  process_ = undefined;
});

describe("the fake Samsung TV", () => {
  it("listens on the REST port it is given", async () => {
    const port = await freePort();

    tv = await startFakeSamsungTv({ restPort: port });

    expect(tv.restPort).toBe(port);
    expect((await fetch(`http://127.0.0.1:${String(port)}/api/v2/`)).status).toBe(200);
  });

  it("answers GET /api/v2/ with device info, every value a string as a real TV sends it", async () => {
    tv = await startFakeSamsungTv();

    const response = await fetch(`http://127.0.0.1:${String(tv.restPort)}/api/v2/`);
    const info = (await response.json()) as SamsungDeviceInfoResponse;

    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(info.uri).toBe(`http://127.0.0.1:${String(tv.restPort)}/api/v2/`);
    expect(info.device).toMatchObject({
      name: "[TV] Samsung Q60 Series (55)",
      modelName: "QE55Q60TAUXXU",
      wifiMac: "02:00:00:00:00:01",
      ip: "127.0.0.1",
      PowerState: "on",
      FrameTVSupport: "false",
    });
    expect(Object.values(info.device).every((value) => typeof value === "string")).toBe(true);
  });

  it("reports the device info it is configured with", async () => {
    tv = await startFakeSamsungTv({ device: { name: "[TV] Bedroom", PowerState: "standby" } });

    const info = (await (
      await fetch(`http://127.0.0.1:${String(tv.restPort)}/api/v2/`)
    ).json()) as SamsungDeviceInfoResponse;

    expect(info.name).toBe("[TV] Bedroom");
    expect(info.device).toMatchObject({ name: "[TV] Bedroom", PowerState: "standby" });
  });

  it("goes into standby and comes back on, as its own remote would do it, and says so in its device info", async () => {
    tv = await startFakeSamsungTv();
    const powerState = async (): Promise<string | undefined> =>
      ((await (await fetch(`http://127.0.0.1:${String(tv?.restPort)}/api/v2/`)).json()) as SamsungDeviceInfoResponse)
        .device.PowerState;

    tv.setPowerState("standby");
    expect(await powerState()).toBe("standby");
    tv.setPowerState("on");
    expect(await powerState()).toBe("on");
  });

  it("reports Developer Mode off with no Developer IP, until it is switched on at the TV, or neither, as some firmware doesn't", async () => {
    tv = await startFakeSamsungTv();
    const device = async () =>
      ((await (await fetch(`http://127.0.0.1:${String(tv?.restPort)}/api/v2/`)).json()) as SamsungDeviceInfoResponse)
        .device;

    expect(await device()).toMatchObject({ developerMode: "0", developerIP: "0.0.0.0" });
    expect(tv.developer()).toEqual({ mode: "off", ip: null });

    tv.setDeveloper({ mode: "on", ip: "192.168.1.10" });
    expect(await device()).toMatchObject({ developerMode: "1", developerIP: "192.168.1.10" });
    expect(tv.developer()).toEqual({ mode: "on", ip: "192.168.1.10" });

    tv.setDeveloper(null);
    const without = await device();
    expect("developerMode" in without || "developerIP" in without).toBe(false);
    expect(tv.developer()).toBeNull();

    tv.setDeveloper({ mode: "off", ip: null });
    expect(await device()).toMatchObject({ developerMode: "0", developerIP: "0.0.0.0" });
  });

  it("leaves out of its device info what it is told to, as older firmware does", async () => {
    tv = await startFakeSamsungTv({ leaveOut: ["networkType", "developerIP"] });

    const { device } = (await (
      await fetch(`http://127.0.0.1:${String(tv.restPort)}/api/v2/`)
    ).json()) as SamsungDeviceInfoResponse;

    expect(Object.keys(device)).not.toContain("networkType");
    expect(Object.keys(device)).not.toContain("developerIP");
    expect(device.developerMode).toBe("0");
    expect(tv.developer()).toBeNull();
  });

  it("records every request it receives, including ones it cannot answer", async () => {
    tv = await startFakeSamsungTv();
    const base = `http://127.0.0.1:${String(tv.restPort)}`;

    await fetch(`${base}/api/v2/`);
    const unknown = await fetch(`${base}/api/v2/applications/111299001912?x=1`, { method: "POST", body: "hello" });

    expect(unknown.status).toBe(404);
    expect(tv.requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/v2/", body: "" }),
      expect.objectContaining({ method: "POST", path: "/api/v2/applications/111299001912?x=1", body: "hello" }),
    ]);

    tv.clearRequests();
    expect(tv.requests).toEqual([]);
  });

  it("runs as its own process on the port in FAKE_TV_REST_PORT, and reports what it recorded", async () => {
    const port = await freePort();
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      { FAKE_TV_REST_PORT: String(port) },
      /Fake Samsung TV listening on http:\/\/127\.0\.0\.1:(\d+)/,
    );
    const base = `http://127.0.0.1:${String(port)}`;

    expect(process_.match[1]).toBe(String(port));
    expect((await fetch(`${base}/api/v2/`)).status).toBe(200);

    const recorded = (await (await fetch(`${base}${FAKE_CONTROL_PATH}`)).json()) as RecordedRequest[];
    expect(recorded.map(({ method, path }) => ({ method, path }))).toEqual([{ method: "GET", path: "/api/v2/" }]);

    await fetch(`${base}${FAKE_CONTROL_PATH}`, { method: "DELETE" });
    expect(await (await fetch(`${base}${FAKE_CONTROL_PATH}`)).json()).toEqual([]);
  });

  it("as its own process, reports Developer Mode and the Developer IP, and changes or leaves them out when told", async () => {
    const restPort = await freePort();
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: "0",
        FAKE_TV_SSDP_PORT: "0",
        FAKE_TV_UPNP_PORT: "0",
      },
      /Fake Samsung TV listening/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;
    const developer = (body?: string) =>
      fetch(`${base}${FAKE_DEVELOPER_PATH}`, body === undefined ? {} : { method: "PUT", body });
    const device = async () => ((await (await fetch(`${base}/api/v2/`)).json()) as SamsungDeviceInfoResponse).device;

    expect(await (await developer()).json()).toEqual({ mode: "off", ip: null });
    expect(await (await developer('{"mode": "on", "ip": "192.168.1.10"}')).json()).toEqual({
      mode: "on",
      ip: "192.168.1.10",
    });
    expect(await device()).toMatchObject({ developerMode: "1", developerIP: "192.168.1.10" });
    expect(await (await developer("null")).json()).toBeNull();
    expect("developerMode" in (await device())).toBe(false);
    for (const body of [
      "{}",
      '{"mode": "yes", "ip": null}',
      '{"mode": "on"}',
      '{"mode": "on", "ip": ""}',
      "developer",
    ]) {
      expect((await developer(body)).status).toBe(400);
    }
    expect(await (await developer()).json()).toBeNull();
    // None of it is a request a real TV would answer, so none is recorded.
    expect(await (await fetch(`${base}${FAKE_CONTROL_PATH}`)).json()).toHaveLength(2);
  });

  it("as its own process, goes into standby and comes back on when told to", async () => {
    const port = await freePort();
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      { FAKE_TV_REST_PORT: String(port), FAKE_TV_CONTROL_PORT: "0", FAKE_TV_SSDP_PORT: "0" },
      /Fake Samsung TV listening/,
    );
    const base = `http://127.0.0.1:${String(port)}`;
    const setPower = (body: string) => fetch(`${base}${FAKE_POWER_PATH}`, { method: "POST", body });
    const powerState = async (): Promise<string | undefined> =>
      ((await (await fetch(`${base}/api/v2/`)).json()) as SamsungDeviceInfoResponse).device.PowerState;

    expect((await setPower('{"power":"standby"}')).status).toBe(200);
    expect(await powerState()).toBe("standby");
    expect((await setPower('{"power":"on"}')).status).toBe(200);
    expect(await powerState()).toBe("on");
    expect((await setPower('{"power":"off"}')).status).toBe(400);
    expect(await powerState()).toBe("on");
  });
});

interface SocketVisit {
  /** Every message the TV sent before it closed or `waitMs` passed. */
  readonly received: { event: string; data?: { token?: string } }[];
  readonly closed: boolean;
}

/** Connects to the fake's control socket as a client would, sends `send`, and listens for `waitMs`. */
const visit = (
  port: number,
  {
    name = "media-centre",
    token,
    send = [],
    waitMs = 200,
    path = "/api/v2/channels/samsung.remote.control",
    host = "127.0.0.1",
  }: {
    name?: string;
    token?: string;
    send?: string[];
    waitMs?: number;
    path?: string;
    host?: string;
  } = {},
): Promise<SocketVisit> =>
  new Promise((resolve, reject) => {
    const query = new URLSearchParams({ name: Buffer.from(name).toString("base64") });
    if (token !== undefined) query.set("token", token);
    const socket = new WebSocket(`wss://${host}:${String(port)}${path}?${query.toString()}`, {
      rejectUnauthorized: false,
    });
    const received: SocketVisit["received"] = [];
    let closed = false;
    socket.on("open", () => {
      for (const message of send) socket.send(message);
    });
    socket.on("message", (data: Buffer) => {
      received.push(JSON.parse(data.toString("utf8")) as SocketVisit["received"][number]);
    });
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.terminate();
      resolve({ received, closed });
    }, waitMs);
  });

describe("the fake Samsung TV's secure control socket", () => {
  it("listens with TLS on the control port it is given, with a certificate no one signed", async () => {
    const port = await freePort();

    tv = await startFakeSamsungTv({ controlPort: port });

    expect(tv.controlPort).toBe(port);
    await expect(fetch(`https://127.0.0.1:${String(port)}/`)).rejects.toThrow();
  });

  it("pairs a client that comes without a token, as the person choosing Allow would, and issues a token", async () => {
    tv = await startFakeSamsungTv();

    const { received, closed } = await visit(tv.controlPort, { name: "media-centre" });

    expect(closed).toBe(false);
    expect(received).toEqual([
      {
        event: "ms.channel.connect",
        data: expect.objectContaining({ token: expect.stringMatching(/^\d{8}$/) as string }) as object,
      },
    ]);
    const issued = received[0]?.data?.token;
    expect(tv.issuedTokens()).toEqual([issued]);
    expect(tv.connections).toEqual([
      {
        path: "/api/v2/channels/samsung.remote.control",
        clientName: "media-centre",
        token: undefined,
        outcome: "paired",
        issuedToken: issued,
        messages: [],
      },
    ]);
  });

  it("lets in a client presenting a token it issued, without asking, and records what it sends", async () => {
    tv = await startFakeSamsungTv();
    const token = (await visit(tv.controlPort)).received[0]?.data?.token ?? "";

    const { received } = await visit(tv.controlPort, { token, send: ['{"method":"hello"}'] });

    expect(received).toEqual([{ event: "ms.channel.connect", data: expect.objectContaining({ token }) as object }]);
    expect(tv.issuedTokens()).toEqual([token]);
    expect(tv.connections[1]).toMatchObject({ token, outcome: "accepted", messages: ['{"method":"hello"}'] });
  });

  it("refuses every token issued before access was revoked, and pairs anew without one", async () => {
    tv = await startFakeSamsungTv();
    const token = (await visit(tv.controlPort)).received[0]?.data?.token ?? "";

    tv.revokeAccess();
    const refused = await visit(tv.controlPort, { token });
    const again = await visit(tv.controlPort);

    expect(refused).toEqual({ received: [{ event: "ms.channel.unauthorized" }], closed: true });
    expect(tv.connections[1]).toMatchObject({ token, outcome: "refused", issuedToken: undefined });
    const fresh = again.received[0]?.data?.token;
    expect(fresh).not.toBe(token);
    expect(tv.issuedTokens()).toEqual([token, fresh]);
  });

  it("refuses the client when the person chooses Deny", async () => {
    tv = await startFakeSamsungTv({ pairing: "deny" });

    expect(await visit(tv.controlPort)).toEqual({ received: [{ event: "ms.channel.unauthorized" }], closed: true });
    expect(tv.issuedTokens()).toEqual([]);
  });

  it("leaves the client waiting when nobody answers the prompt, until it is told to allow", async () => {
    tv = await startFakeSamsungTv({ pairing: "ignore" });

    expect(await visit(tv.controlPort)).toEqual({ received: [], closed: false });
    expect(tv.connections[0]?.outcome).toBe("unanswered");

    tv.answerPairing("allow");
    expect((await visit(tv.controlPort)).received[0]?.event).toBe("ms.channel.connect");
  });

  it("asks the person again about a token it never issued", async () => {
    tv = await startFakeSamsungTv({ pairing: "deny" });

    expect((await visit(tv.controlPort, { token: "12345678" })).received).toEqual([
      { event: "ms.channel.unauthorized" },
    ]);
  });

  it("closes a connection to any other channel", async () => {
    tv = await startFakeSamsungTv();

    expect(await visit(tv.controlPort, { path: "/api/v2/channels/something.else" })).toEqual({
      received: [],
      closed: true,
    });
  });

  it("as its own process, reports its connections and can have access revoked", async () => {
    const [restPort, controlPort] = [await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: String(controlPort),
        FAKE_TV_NAME: "[TV] Bedroom",
        FAKE_TV_MAC: "02:00:00:00:00:02",
      },
      /control socket on (\d+)/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;

    expect(process_.match[1]).toBe(String(controlPort));
    const info = (await (await fetch(`${base}/api/v2/`)).json()) as SamsungDeviceInfoResponse;
    expect(info.device).toMatchObject({ name: "[TV] Bedroom", wifiMac: "02:00:00:00:00:02" });

    const token = (await visit(controlPort)).received[0]?.data?.token ?? "";
    expect((await fetch(`${base}${FAKE_REVOKE_PATH}`, { method: "POST" })).status).toBe(200);
    expect((await visit(controlPort, { token })).received).toEqual([{ event: "ms.channel.unauthorized" }]);

    const connections = (await (await fetch(`${base}${FAKE_CONNECTIONS_PATH}`)).json()) as RecordedConnection[];
    expect(connections.map(({ outcome, issuedToken }) => ({ outcome, issuedToken }))).toEqual([
      { outcome: "paired", issuedToken: token },
      { outcome: "refused" },
    ]);

    await fetch(`${base}${FAKE_CONNECTIONS_PATH}`, { method: "DELETE" });
    expect(await (await fetch(`${base}${FAKE_CONNECTIONS_PATH}`)).json()).toEqual([]);
  });
});

/** Sends `message` over UDP to the fake's SSDP port, and resolves with every answer within `waitMs`. */
const ask = (port: number, message: string, waitMs = 200, host = "127.0.0.1"): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4" });
    const answers: string[] = [];
    socket.on("message", (data) => answers.push(data.toString("utf8")));
    socket.on("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.send(message, port, host);
      setTimeout(() => {
        socket.close();
        resolve(answers);
      }, waitMs);
    });
  });

const search = (target: string, man = '"ssdp:discover"'): string =>
  `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: ${man}\r\nMX: 2\r\nST: ${target}\r\n\r\n`;

describe("the fake Samsung TV's answers to SSDP searches", () => {
  it("answers a search for Samsung TVs, or for everything, with where it is, and records every search", async () => {
    const port = await freePort();
    tv = await startFakeSamsungTv({ host: "127.0.0.2", ssdpPort: port, device: { udn: "uuid:fake-living-room" } });
    expect(tv.ssdpPort).toBe(port);

    for (const target of ["urn:samsung.com:device:RemoteControlReceiver:1", "ssdp:all"]) {
      const answers = await ask(port, search(target), 200, "127.0.0.2");
      expect(answers).toHaveLength(1);
      const answer = parseSsdpMessage(answers[0] ?? "");
      expect(answer.startLine).toBe("HTTP/1.1 200 OK");
      expect(answer.headers.get("st")).toBe("urn:samsung.com:device:RemoteControlReceiver:1");
      expect(answer.headers.get("location")).toMatch(/^http:\/\/127\.0\.0\.2:\d+\//);
      expect(answer.headers.get("usn")).toBe("uuid:fake-living-room::urn:samsung.com:device:RemoteControlReceiver:1");
    }
    expect(tv.searches).toEqual([search("urn:samsung.com:device:RemoteControlReceiver:1"), search("ssdp:all")]);
  });

  it("ignores searches for anything else, and anything that isn't a search", async () => {
    tv = await startFakeSamsungTv();

    for (const message of [
      search("urn:schemas-upnp-org:device:MediaRenderer:1"),
      search("ssdp:all", "ssdp:discover"),
      "NOTIFY * HTTP/1.1\r\nNT: ssdp:all\r\n\r\n",
      "hello",
    ]) {
      expect(await ask(tv.ssdpPort, message)).toEqual([]);
    }
    expect(tv.searches).toHaveLength(4);
  });

  it("as its own process, answers searches on the port in FAKE_TV_SSDP_PORT", async () => {
    const [restPort, controlPort, ssdpPort] = [await freePort(), await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: String(controlPort),
        FAKE_TV_SSDP_PORT: String(ssdpPort),
      },
      /answering searches on (\d+)/,
    );

    expect(process_.match[1]).toBe(String(ssdpPort));
    expect(await ask(ssdpPort, search("ssdp:all"))).toHaveLength(1);
  });
});

/** Sends `packet` over UDP to the fake's Wake-on-LAN port, as the Hub would to its own address. */
const sendPacket = (port: number, packet: Uint8Array, host = "127.0.0.1"): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4" });
    socket.on("error", reject);
    socket.send(packet, port, host, (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });

/** One key command on the control socket, or a pause between them. */
type KeyStep = { readonly cmd: "Click" | "Press" | "Release"; readonly code: string } | { readonly waitMs: number };

/** Lets a client in with a token the TV issued, sends each step in turn, and closes once the TV has had them. */
const sendKeys = async (tv: FakeSamsungTv, steps: readonly KeyStep[]): Promise<void> => {
  const token = (await visit(tv.controlPort)).received[0]?.data?.token ?? "";
  const query = new URLSearchParams({ name: Buffer.from("media-centre").toString("base64"), token });
  const socket = new WebSocket(
    `wss://127.0.0.1:${String(tv.controlPort)}/api/v2/channels/samsung.remote.control?${query.toString()}`,
    { rejectUnauthorized: false },
  );
  await new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
  const sent = tv.keys.length;
  let commands = 0;
  for (const step of steps) {
    if ("waitMs" in step) {
      await new Promise((resolve) => setTimeout(resolve, step.waitMs));
      continue;
    }
    socket.send(
      JSON.stringify({
        method: "ms.remote.control",
        params: { Cmd: step.cmd, DataOfCmd: step.code, Option: "false", TypeOfRemote: "SendRemoteKey" },
      }),
    );
    commands += 1;
  }
  await expect.poll(() => tv.keys.length - sent).toBe(commands);
  socket.terminate();
};

const powerOf = async (fake: FakeSamsungTv): Promise<string | undefined> =>
  ((await (await fetch(`http://127.0.0.1:${String(fake.restPort)}/api/v2/`)).json()) as SamsungDeviceInfoResponse)
    .device.PowerState;

describe("the fake Samsung TV's power: Wake-on-LAN and the power key", () => {
  it("records every packet on its Wake-on-LAN port, and switches on for a magic packet with its own MAC address", async () => {
    const port = await freePort();
    tv = await startFakeSamsungTv({ wakePort: port, macAddress: "02:00:00:AA:BB:CC" });
    expect(tv.wakePort).toBe(port);
    tv.setPowerState("standby");

    await sendPacket(port, Buffer.from("hello"));
    await sendPacket(port, magicPacket("02:00:00:00:00:99"));
    await expect.poll(() => tv?.wakes.length).toBe(2);
    expect(await powerOf(tv)).toBe("standby");

    await sendPacket(port, magicPacket("02:00:00:aa:bb:cc"));
    await expect.poll(() => tv?.wakes.length).toBe(3);
    expect(tv.wakes.map(({ macAddress }) => macAddress)).toEqual([undefined, "02:00:00:00:00:99", "02:00:00:aa:bb:cc"]);
    expect(tv.wakes.every(({ receivedAt }) => Math.abs(receivedAt - Date.now()) < 5_000)).toBe(true);
    expect(await powerOf(tv)).toBe("on");
  });

  it("comes on as long after a magic packet as it is told to take", async () => {
    const port = await freePort();
    tv = await startFakeSamsungTv({ wakePort: port, macAddress: "02:00:00:aa:bb:cc", wakeDelayMs: 300 });
    tv.setPowerState("standby");

    await sendPacket(port, magicPacket("02:00:00:aa:bb:cc"));
    await expect.poll(() => tv?.wakes.length).toBe(1);
    expect(await powerOf(tv)).toBe("standby");

    await expect.poll(() => powerOf(tv as FakeSamsungTv), { timeout: 2_000 }).toBe("on");
  });

  it("goes into standby on a tap of its power key", async () => {
    tv = await startFakeSamsungTv();

    await sendKeys(tv, [{ cmd: "Click", code: "KEY_POWER" }]);

    expect(await powerOf(tv)).toBe("standby");
  });

  it("ignores its power key in standby, where only Wake-on-LAN switches it on", async () => {
    tv = await startFakeSamsungTv();
    tv.setPowerState("standby");

    await sendKeys(tv, [{ cmd: "Click", code: "KEY_POWER" }]);

    expect(await powerOf(tv)).toBe("standby");
  });

  it("as a Frame TV, says so in its device info, and shows Art Mode for a tap or a short hold of its power key", async () => {
    tv = await startFakeSamsungTv({ frame: true, frameHoldMs: 300 });
    const info = (await (
      await fetch(`http://127.0.0.1:${String(tv.restPort)}/api/v2/`)
    ).json()) as SamsungDeviceInfoResponse;
    expect(info.device.FrameTVSupport).toBe("true");

    await sendKeys(tv, [
      { cmd: "Click", code: "KEY_POWER" },
      { cmd: "Press", code: "KEY_POWER" },
      { waitMs: 50 },
      { cmd: "Release", code: "KEY_POWER" },
    ]);

    expect(await powerOf(tv)).toBe("on");
  });

  it("as a Frame TV, goes into standby once its power key is held long enough", async () => {
    tv = await startFakeSamsungTv({ frame: true, frameHoldMs: 300 });

    await sendKeys(tv, [{ cmd: "Press", code: "KEY_POWER" }, { waitMs: 400 }, { cmd: "Release", code: "KEY_POWER" }]);

    expect(await powerOf(tv)).toBe("standby");
    expect(tv.keys.map(({ command }) => command)).toEqual(["Press", "Release"]);
  });

  it("answers nothing in standby when its firmware doesn't, and answers again once woken", async () => {
    tv = await startFakeSamsungTv({ answersInStandby: false });
    tv.setPowerState("standby");

    await expect(fetch(`http://127.0.0.1:${String(tv.restPort)}/api/v2/`)).rejects.toThrow();
    await sendPacket(tv.wakePort, magicPacket("02:00:00:00:00:01"));

    await expect.poll(() => tv?.wakes.length).toBe(1);
    expect(await powerOf(tv)).toBe("on");
  });

  it("as its own process, wakes on the port in FAKE_TV_WAKE_PORT, reports what it heard, and can be a Frame", async () => {
    const [restPort, wakePort] = [await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: "0",
        FAKE_TV_SSDP_PORT: "0",
        FAKE_TV_WAKE_PORT: String(wakePort),
        FAKE_TV_MAC: "02:00:00:00:00:02",
        FAKE_TV_FRAME: "true",
      },
      /waking on (\d+), as a Frame TV/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;
    expect(process_.match[1]).toBe(String(wakePort));
    const info = (await (await fetch(`${base}/api/v2/`)).json()) as SamsungDeviceInfoResponse;
    expect(info.device.FrameTVSupport).toBe("true");

    await fetch(`${base}${FAKE_POWER_PATH}`, { method: "POST", body: '{"power":"standby"}' });
    await sendPacket(wakePort, magicPacket("02:00:00:00:00:02"));

    await expect
      .poll(async () => ((await (await fetch(`${base}${FAKE_WAKES_PATH}`)).json()) as RecordedWake[]).length)
      .toBe(1);
    expect(((await (await fetch(`${base}/api/v2/`)).json()) as SamsungDeviceInfoResponse).device.PowerState).toBe("on");
    await fetch(`${base}${FAKE_WAKES_PATH}`, { method: "DELETE" });
    expect(await (await fetch(`${base}${FAKE_WAKES_PATH}`)).json()).toEqual([]);
  });

  it("as its own process, refuses a Frame setting that is neither true nor false", async () => {
    await expect(
      startNodeProcess(
        join(import.meta.dirname, "main.ts"),
        { FAKE_TV_REST_PORT: "0", FAKE_TV_FRAME: "yes" },
        /listening/,
      ),
    ).rejects.toThrow('FAKE_TV_FRAME must be "true" or "false", not "yes"');
  });
});

/** A rendering-control call as a UPnP control point sends it, written out rather than built by the Driver's code. */
const callRenderingControl = (
  port: number,
  action: string,
  args = "<InstanceID>0</InstanceID><Channel>Master</Channel>",
  path = "/upnp/control/RenderingControl1",
): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: "POST",
    headers: {
      "content-type": 'text/xml; charset="utf-8"',
      soapaction: `"urn:schemas-upnp-org:service:RenderingControl:1#${action}"`,
    },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<s:Envelope xmlns:s="${SOAP_ENVELOPE_NAMESPACE}" s:encodingStyle="${SOAP_ENCODING}">` +
      `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">${args}</u:${action}></s:Body>` +
      "</s:Envelope>",
  });

describe("the fake Samsung TV's volume, over UPnP rendering control", () => {
  it("answers GetVolume and GetMute with its volume and mute, and records each call", async () => {
    const port = await freePort();
    tv = await startFakeSamsungTv({ upnpPort: port, volume: { volume: 23, muted: true } });
    expect(tv.upnpPort).toBe(port);

    const volume = await callRenderingControl(port, "GetVolume");
    const mute = await callRenderingControl(port, "GetMute");

    expect(volume.status).toBe(200);
    expect(volume.headers.get("content-type")).toMatch(/^text\/xml/);
    expect(await volume.text()).toMatch(
      /<s:Body><u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><CurrentVolume>23<\/CurrentVolume><\/u:GetVolumeResponse><\/s:Body>/,
    );
    expect(await mute.text()).toContain("<CurrentMute>1</CurrentMute>");
    expect(tv.upnpRequests.map(({ method, path, headers }) => [method, path, headers.soapaction])).toEqual([
      ["POST", "/upnp/control/RenderingControl1", '"urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"'],
      ["POST", "/upnp/control/RenderingControl1", '"urn:schemas-upnp-org:service:RenderingControl:1#GetMute"'],
    ]);
    expect(tv.requests).toEqual([]);
  });

  it("takes SetVolume and SetMute, and is 11 and not muted unless told otherwise", async () => {
    tv = await startFakeSamsungTv();
    expect(tv.volume()).toEqual({ volume: 11, muted: false });

    const set = await callRenderingControl(
      tv.upnpPort,
      "SetVolume",
      "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>18</DesiredVolume>",
    );
    expect(set.status).toBe(200);
    expect(await set.text()).toContain("<u:SetVolumeResponse");
    await callRenderingControl(
      tv.upnpPort,
      "SetMute",
      "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>1</DesiredMute>",
    );

    expect(tv.volume()).toEqual({ volume: 18, muted: true });
  });

  it.each([
    ["an action it hasn't got", "SetLoudness", undefined, 401],
    [
      "a volume above 100",
      "SetVolume",
      "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>101</DesiredVolume>",
      402,
    ],
    [
      "a volume that isn't a number",
      "SetVolume",
      "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>loud</DesiredVolume>",
      402,
    ],
    [
      "a mute that isn't 0 or 1",
      "SetMute",
      "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>yes</DesiredMute>",
      402,
    ],
    ["another channel", "GetVolume", "<InstanceID>0</InstanceID><Channel>LF</Channel>", 402],
  ])("answers %s with a UPnP fault, and changes nothing", async (_, action, args, code) => {
    tv = await startFakeSamsungTv();

    const response = await callRenderingControl(tv.upnpPort, action, args);

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(`<errorCode>${String(code)}</errorCode>`);
    expect(tv.volume()).toEqual({ volume: 11, muted: false });
  });

  it("answers nothing about its volume in standby, as far as we know a real TV doesn't, and answers again once on", async () => {
    tv = await startFakeSamsungTv();
    tv.setPowerState("standby");

    await expect(callRenderingControl(tv.upnpPort, "GetVolume")).rejects.toThrow();
    expect(tv.upnpRequests).toHaveLength(1);

    tv.setPowerState("on");
    expect((await callRenderingControl(tv.upnpPort, "GetVolume")).status).toBe(200);
  });

  it("answers 404 anywhere but its rendering control", async () => {
    tv = await startFakeSamsungTv();

    expect((await callRenderingControl(tv.upnpPort, "GetVolume", undefined, "/upnp/control/AVTransport1")).status).toBe(
      404,
    );
  });

  it("turns its volume up and down by one with its volume keys, unmuting, between 0 and 100, only while it is on", async () => {
    tv = await startFakeSamsungTv({ volume: { volume: 99, muted: true } });

    await sendKeys(tv, [
      { cmd: "Click", code: "KEY_VOLUP" },
      { cmd: "Click", code: "KEY_VOLUP" },
    ]);
    expect(tv.volume()).toEqual({ volume: 100, muted: false });

    tv.setVolume({ volume: 1 });
    await sendKeys(tv, [
      { cmd: "Click", code: "KEY_VOLDOWN" },
      { cmd: "Click", code: "KEY_VOLDOWN" },
    ]);
    expect(tv.volume()).toEqual({ volume: 0, muted: false });

    tv.setPowerState("standby");
    await sendKeys(tv, [{ cmd: "Click", code: "KEY_VOLUP" }]);
    expect(tv.volume()).toEqual({ volume: 0, muted: false });
  });

  it("as its own process, answers on the port in FAKE_TV_UPNP_PORT, and has its volume changed as its own remote would", async () => {
    const [restPort, upnpPort] = [await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: "0",
        FAKE_TV_SSDP_PORT: "0",
        FAKE_TV_UPNP_PORT: String(upnpPort),
      },
      /volume on (\d+)/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;
    const change = (body: string) => fetch(`${base}${FAKE_VOLUME_PATH}`, { method: "POST", body });
    expect(process_.match[1]).toBe(String(upnpPort));

    expect(await (await fetch(`${base}${FAKE_VOLUME_PATH}`)).json()).toEqual({ volume: 11, muted: false });
    expect(await (await change('{"volume": 40}')).json()).toEqual({ volume: 40, muted: false });
    expect(await (await change('{"muted": true}')).json()).toEqual({ volume: 40, muted: true });
    expect(await (await callRenderingControl(upnpPort, "GetVolume")).text()).toContain(
      "<CurrentVolume>40</CurrentVolume>",
    );

    for (const body of ['{"volume": 101}', '{"volume": 2.5}', '{"muted": "yes"}', "{}", "loud"]) {
      expect((await change(body)).status).toBe(400);
    }
    expect(await (await fetch(`${base}${FAKE_VOLUME_PATH}`)).json()).toEqual({ volume: 40, muted: true });
  });
});

/** A client let in on the fake's control socket on a token it issued, kept open, and the events the TV sent it since. */
const letInClient = async (port: number, host = "127.0.0.1") => {
  const token = (await visit(port, { host })).received[0]?.data?.token ?? "";
  const query = new URLSearchParams({ name: Buffer.from("media-centre").toString("base64"), token });
  const socket = new WebSocket(
    `wss://${host}:${String(port)}/api/v2/channels/samsung.remote.control?${query.toString()}`,
    {
      rejectUnauthorized: false,
    },
  );
  await new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
  const events: string[] = [];
  const messages: { event: string; data?: unknown }[] = [];
  socket.on("message", (data: Buffer) => {
    const message = JSON.parse(data.toString("utf8")) as { event: string; data?: unknown };
    events.push(message.event);
    messages.push(message);
  });
  return {
    events,
    messages,
    send: (message: unknown) => {
      socket.send(typeof message === "string" ? message : JSON.stringify(message));
    },
  };
};

/** Text for the on-screen keyboard, as the Driver sends it: UTF-8, in base64. */
const typed = (text: string) => ({
  method: "ms.remote.control",
  params: { Cmd: Buffer.from(text, "utf8").toString("base64"), DataOfCmd: "base64", TypeOfRemote: "SendInputString" },
});

const SUBMIT = { method: "ms.remote.control", params: { TypeOfRemote: "SendInputEnd" } };

describe("the fake Samsung TV's on-screen keyboard (FR-20)", () => {
  it("opens and closes when told, as choosing a search box would, telling every client let in", async () => {
    tv = await startFakeSamsungTv();
    const [first, second] = [await letInClient(tv.controlPort), await letInClient(tv.controlPort)];
    expect(tv.keyboardOpen()).toBe(false);

    tv.setKeyboard(true);
    tv.setKeyboard(true);
    await expect.poll(() => second.events).toEqual(["ms.remote.imeStart"]);
    expect(tv.keyboardOpen()).toBe(true);

    tv.setKeyboard(false);
    await expect.poll(() => first.events).toEqual(["ms.remote.imeStart", "ms.remote.imeEnd"]);
    expect(second.events).toEqual(["ms.remote.imeStart", "ms.remote.imeEnd"]);
    expect(tv.keyboardOpen()).toBe(false);
  });

  it("records the text typed into it exactly, in any script, and closes when it is submitted", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);
    tv.setKeyboard(true);

    client.send(typed("cosmos documentary"));
    client.send(typed("café 日本語 🎬"));
    client.send(SUBMIT);

    await expect.poll(() => tv?.keyboardOpen()).toBe(false);
    expect(tv.texts).toEqual([
      { text: "cosmos documentary", keyboardOpen: true, receivedAt: expect.any(Number) as number, connection: 1 },
      { text: "café 日本語 🎬", keyboardOpen: true, receivedAt: expect.any(Number) as number, connection: 1 },
    ]);
    expect(client.events).toEqual(["ms.remote.imeStart", "ms.remote.imeEnd"]);
  });

  it("records text typed while it is closed as such, and takes none that isn't UTF-8 in base64", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);

    client.send(typed("too soon"));
    await expect.poll(() => tv?.texts.length).toBe(1);
    tv.setKeyboard(true);
    for (const params of [
      { Cmd: "café", DataOfCmd: "base64", TypeOfRemote: "SendInputString" },
      { Cmd: Buffer.from("café").toString("base64"), TypeOfRemote: "SendInputString" },
      { Cmd: Buffer.from([0xff, 0xfe]).toString("base64"), DataOfCmd: "base64", TypeOfRemote: "SendInputString" },
    ]) {
      client.send({ method: "ms.remote.control", params });
    }
    client.send(typed("in time"));

    await expect.poll(() => tv?.texts.length).toBe(2);
    expect(tv.texts.map(({ text, keyboardOpen }) => ({ text, keyboardOpen }))).toEqual([
      { text: "too soon", keyboardOpen: false },
      { text: "in time", keyboardOpen: true },
    ]);
    expect(tv.keyboardOpen()).toBe(true);
  });

  it("opens no keyboard in standby, and closes it on going into standby", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);
    tv.setKeyboard(true);

    tv.setPowerState("standby");
    expect(tv.keyboardOpen()).toBe(false);
    tv.setKeyboard(true);
    expect(tv.keyboardOpen()).toBe(false);

    await expect.poll(() => client.events).toEqual(["ms.remote.imeStart", "ms.remote.imeEnd"]);
  });

  it("as its own process, opens and closes its keyboard when told, and reports the text typed into it", async () => {
    const [restPort, controlPort] = [await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: String(controlPort),
        FAKE_TV_SSDP_PORT: "0",
        FAKE_TV_UPNP_PORT: "0",
      },
      /Fake Samsung TV listening/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;
    const setKeyboard = (body: string) => fetch(`${base}${FAKE_KEYBOARD_PATH}`, { method: "POST", body });
    const texts = async () => (await (await fetch(`${base}${FAKE_TEXT_PATH}`)).json()) as RecordedText[];
    const client = await letInClient(controlPort);

    expect(await (await fetch(`${base}${FAKE_KEYBOARD_PATH}`)).json()).toEqual({ open: false });
    expect(await (await setKeyboard('{"open": true}')).json()).toEqual({ open: true });
    for (const body of ['{"open": "yes"}', "{}", "open"]) expect((await setKeyboard(body)).status).toBe(400);
    await expect.poll(() => client.events).toEqual(["ms.remote.imeStart"]);

    client.send(typed("café"));
    await expect.poll(async () => (await texts()).map(({ text }) => text)).toEqual(["café"]);
    await fetch(`${base}${FAKE_TEXT_PATH}`, { method: "DELETE" });
    expect(await texts()).toEqual([]);

    expect(await (await setKeyboard('{"open": false}')).json()).toEqual({ open: false });
    await fetch(`${base}${FAKE_POWER_PATH}`, { method: "POST", body: '{"power":"standby"}' });
    expect((await setKeyboard('{"open": true}')).status).toBe(409);
    expect(await (await fetch(`${base}${FAKE_KEYBOARD_PATH}`)).json()).toEqual({ open: false });
  });
});

/** A question on the control socket, as the Driver asks it. */
const emit = (event: string, data?: object) => ({
  method: "ms.channel.emit",
  params: { event, to: "host", ...(data === undefined ? {} : { data }) },
});

interface ListedApp {
  readonly appId: string;
  readonly app_type: number;
  readonly icon: string;
  readonly is_lock: number;
  readonly name: string;
}

/** The apps the TV lists in its answer to the client's question, once it has answered. */
const listedApps = async (client: Awaited<ReturnType<typeof letInClient>>, answers = 1): Promise<ListedApp[]> => {
  await expect.poll(() => client.messages.filter(({ event }) => event === "ed.installedApp.get").length).toBe(answers);
  const answer = client.messages.filter(({ event }) => event === "ed.installedApp.get").at(-1);
  return (answer?.data as { data: ListedApp[] }).data;
};

describe("the fake Samsung TV's apps (FR-21)", () => {
  const appUrl = (fake: FakeSamsungTv, appId: string): string =>
    `http://127.0.0.1:${String(fake.restPort)}/api/v2/applications/${appId}`;

  const statusOf = async (fake: FakeSamsungTv, appId: string): Promise<SamsungAppStatus> => {
    const response = await fetch(appUrl(fake, appId));
    expect(response.status).toBe(200);
    return (await response.json()) as SamsungAppStatus;
  };

  it("lists its installed apps on the control socket, with where it keeps each one's icon", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);

    client.send(emit("ed.installedApp.get"));

    expect(await listedApps(client)).toEqual([
      {
        appId: "111299001912",
        app_type: 2,
        icon: "/opt/share/webappservice/apps_icon/FirstScreen/111299001912/250x250.png",
        is_lock: 0,
        name: "YouTube",
      },
      expect.objectContaining({ appId: "3201907018807", name: "Netflix" }),
      expect.objectContaining({ appId: "3201910019365", name: "Prime Video" }),
      { appId: "org.tizen.browser", app_type: 4, icon: "", is_lock: 0, name: "Internet" },
    ]);
  });

  it("gives each app's icon as a PNG in base64, a different one for each, and none for a path it doesn't keep one at", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);
    client.send(emit("ed.installedApp.get"));
    const [youTube, netflix] = await listedApps(client);

    for (const iconPath of [youTube?.icon, netflix?.icon, "/opt/nowhere.png"])
      client.send(emit("ed.apps.icon", { iconPath }));

    await expect.poll(() => client.messages.filter(({ event }) => event === "ed.apps.icon").length).toBe(3);
    const icons = client.messages
      .filter(({ event }) => event === "ed.apps.icon")
      .map(({ data }) => data as { iconPath: string; imageBase64: string });
    expect(icons.map(({ iconPath }) => iconPath)).toEqual([youTube?.icon, netflix?.icon, "/opt/nowhere.png"]);
    const [first, second] = icons.map(({ imageBase64 }) => Buffer.from(imageBase64, "base64"));
    expect(first?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(first?.equals(second ?? Buffer.alloc(0))).toBe(false);
    expect(icons[2]?.imageBase64).toBe("");
  });

  it("lists nothing for a client it hasn't let in", async () => {
    tv = await startFakeSamsungTv({ pairing: "ignore" });
    const socket = new WebSocket(`wss://127.0.0.1:${String(tv.controlPort)}/api/v2/channels/samsung.remote.control`, {
      rejectUnauthorized: false,
    });
    const messages: string[] = [];
    socket.on("message", (data: Buffer) => messages.push(data.toString("utf8")));
    await new Promise((resolve) => socket.once("open", resolve));

    socket.send(JSON.stringify(emit("ed.installedApp.get")));

    await expect.poll(() => tv?.connections[0]?.messages.length).toBe(1);
    expect(messages).toEqual([]);
    socket.terminate();
  });

  it("launches an app over REST, which it then says is running and visible, and only one app is visible at a time", async () => {
    tv = await startFakeSamsungTv();
    expect(await statusOf(tv, "111299001912")).toEqual({
      id: "111299001912",
      name: "YouTube",
      running: false,
      version: "1.0.0",
      visible: false,
    });

    expect((await fetch(appUrl(tv, "111299001912"), { method: "POST" })).status).toBe(200);
    expect(await statusOf(tv, "111299001912")).toMatchObject({ running: true, visible: true });

    expect((await fetch(appUrl(tv, "3201907018807"), { method: "POST" })).status).toBe(200);
    expect(await statusOf(tv, "3201907018807")).toMatchObject({ running: true, visible: true });
    expect(await statusOf(tv, "111299001912")).toMatchObject({ running: true, visible: false });
    expect(
      tv
        .apps()
        .filter(({ visible }) => visible)
        .map(({ name }) => name),
    ).toEqual(["Netflix"]);
  });

  it("closes an app over REST, which it then says isn't running", async () => {
    tv = await startFakeSamsungTv();
    await fetch(appUrl(tv, "111299001912"), { method: "POST" });

    expect((await fetch(appUrl(tv, "111299001912"), { method: "DELETE" })).status).toBe(200);

    expect(await statusOf(tv, "111299001912")).toMatchObject({ running: false, visible: false });
  });

  it("answers 404 for an app it hasn't got", async () => {
    tv = await startFakeSamsungTv();

    for (const method of ["GET", "POST", "DELETE"]) {
      expect((await fetch(appUrl(tv, "no.such.app"), { method })).status).toBe(404);
    }
  });

  it("in standby, closes every app, and neither lists nor launches them", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);
    await fetch(appUrl(tv, "111299001912"), { method: "POST" });

    tv.setPowerState("standby");
    client.send(emit("ed.installedApp.get"));

    expect(tv.apps().some(({ running }) => running)).toBe(false);
    expect((await fetch(appUrl(tv, "111299001912"), { method: "POST" })).status).toBe(503);
    expect(tv.apps().some(({ running }) => running)).toBe(false);
    await expect.poll(() => tv?.connections.at(-1)?.messages.length).toBe(1);
    expect(client.messages).toEqual([]);

    tv.setPowerState("on");
    client.send(emit("ed.installedApp.get"));
    expect(await listedApps(client)).toHaveLength(4);
  });

  it("holds the apps it is given, and installs others when told, closing any removed", async () => {
    tv = await startFakeSamsungTv({
      apps: [
        { id: "a.one", name: "One" },
        { id: "a.two", name: "Two", icon: false },
      ],
    });
    await fetch(appUrl(tv, "a.one"), { method: "POST" });
    await fetch(appUrl(tv, "a.two"), { method: "POST" });

    tv.setApps([
      { id: "a.two", name: "Two" },
      { id: "a.three", name: "Three" },
    ]);

    expect(tv.apps()).toEqual([
      { id: "a.two", name: "Two", running: true, visible: true },
      { id: "a.three", name: "Three", running: false, visible: false },
    ] satisfies FakeAppStatus[]);
    expect((await fetch(appUrl(tv, "a.one"))).status).toBe(404);
  });

  it("brings an app to the front as its own remote would, launching it, or none, leaving the apps running behind", async () => {
    tv = await startFakeSamsungTv();
    await fetch(appUrl(tv, "3201907018807"), { method: "POST" });

    expect(tv.bringToFront("111299001912")).toBe(true);
    expect(await statusOf(tv, "111299001912")).toMatchObject({ running: true, visible: true });
    expect(await statusOf(tv, "3201907018807")).toMatchObject({ running: true, visible: false });

    // As live TV or another input would.
    expect(tv.bringToFront(undefined)).toBe(true);
    expect(
      tv
        .apps()
        .filter(({ running }) => running)
        .map(({ name, visible }) => ({ name, visible })),
    ).toEqual([
      { name: "YouTube", visible: false },
      { name: "Netflix", visible: false },
    ]);

    expect(tv.bringToFront("no.such.app")).toBe(false);
    tv.setPowerState("standby");
    expect(tv.bringToFront("111299001912")).toBe(false);
    expect(tv.apps().some(({ running }) => running)).toBe(false);
  });

  it("as its own process, reports its apps, and installs others when told", async () => {
    const [restPort, controlPort] = [await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: String(controlPort),
        FAKE_TV_SSDP_PORT: "0",
        FAKE_TV_UPNP_PORT: "0",
      },
      /Fake Samsung TV listening/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;
    const apps = async () => (await (await fetch(`${base}${FAKE_APPS_PATH}`)).json()) as FakeAppStatus[];
    const install = (body: string) => fetch(`${base}${FAKE_APPS_PATH}`, { method: "PUT", body });

    expect((await apps()).map(({ name }) => name)).toEqual(["YouTube", "Netflix", "Prime Video", "Internet"]);
    await fetch(`${base}/api/v2/applications/111299001912`, { method: "POST" });
    expect((await apps())[0]).toEqual({ id: "111299001912", name: "YouTube", running: true, visible: true });

    const response = await install(
      '[{"id": "111299001912", "name": "YouTube"}, {"id": "a.b", "name": "Plex", "icon": false}]',
    );
    expect(await response.json()).toEqual([
      { id: "111299001912", name: "YouTube", running: true, visible: true },
      { id: "a.b", name: "Plex", running: false, visible: false },
    ]);
    for (const body of [
      "{}",
      '[{"id": "", "name": "x"}]',
      '[{"id": "x"}]',
      '[{"id": "x", "name": "x", "icon": "yes"}]',
      "apps",
    ]) {
      expect((await install(body)).status).toBe(400);
    }
    expect(await apps()).toHaveLength(2);

    const client = await letInClient(controlPort);
    client.send(emit("ed.installedApp.get"));
    expect((await listedApps(client)).map(({ name }) => name)).toEqual(["YouTube", "Plex"]);

    const front = (body?: string) =>
      fetch(`${base}${FAKE_FRONT_PATH}`, body === undefined ? {} : { method: "POST", body });
    expect(await (await front()).json()).toEqual({ app: "111299001912" });
    expect(await (await front('{"app": "a.b"}')).json()).toEqual({ app: "a.b" });
    expect((await apps()).map(({ visible }) => visible)).toEqual([false, true]);
    expect(await (await front('{"app": null}')).json()).toEqual({ app: null });
    expect((await front('{"app": "no.such.app"}')).status).toBe(409);
    for (const body of ["{}", '{"app": ""}', '{"app": 1}', "front"]) expect((await front(body)).status).toBe(400);
    await fetch(`${base}${FAKE_POWER_PATH}`, { method: "POST", body: '{"power": "standby"}' });
    expect((await front('{"app": "a.b"}')).status).toBe(409);
  });
});

/** A tap of the key with this code, as the Driver sends it. */
const click = (code: string) => ({
  method: "ms.remote.control",
  params: { Cmd: "Click", DataOfCmd: code, Option: "false", TypeOfRemote: "SendRemoteKey" },
});

describe("the fake Samsung TV's ignored keys (FR-24)", () => {
  it("ignores no key unless told to, and says nothing of any", async () => {
    tv = await startFakeSamsungTv();
    const client = await letInClient(tv.controlPort);

    client.send(click("KEY_PMODE"));

    await expect.poll(() => tv?.keys.length).toBe(1);
    expect(tv.keys[0]).toMatchObject({ code: "KEY_PMODE", ignored: false });
    expect(tv.ignoredKeys()).toEqual({ keys: [], answer: "silence" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.events).toEqual([]);
  });

  it("records a key it ignores as ignored, and says nothing of it, as far as we know a real TV doesn't", async () => {
    tv = await startFakeSamsungTv({ ignoredKeys: { keys: ["KEY_ESAVING"], answer: "silence" } });
    const client = await letInClient(tv.controlPort);

    client.send(click("KEY_ESAVING"));
    client.send(click("KEY_PMODE"));

    await expect
      .poll(() => tv?.keys.map(({ code, ignored }) => ({ code, ignored })))
      .toEqual([
        { code: "KEY_ESAVING", ignored: true },
        { code: "KEY_PMODE", ignored: false },
      ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.events).toEqual([]);
  });

  it("answers a key it ignores with its error event, only to the client that sent it, when told to", async () => {
    tv = await startFakeSamsungTv();
    tv.ignoreKeys({ keys: ["KEY_PMODE", "KEY_AD"], answer: "error" });
    const [client, other] = [await letInClient(tv.controlPort), await letInClient(tv.controlPort)];

    client.send(click("KEY_AD"));
    client.send(click("KEY_SLEEP"));

    await expect
      .poll(() => client.messages)
      .toEqual([{ event: "ms.error", data: { message: "unable to handle key : KEY_AD" } }]);
    await expect.poll(() => tv?.keys.length).toBe(2);
    expect(tv.keys.map(({ ignored }) => ignored)).toEqual([true, false]);
    expect(other.events).toEqual([]);
  });

  it("does nothing with a key it ignores, e.g. its power or volume keys", async () => {
    tv = await startFakeSamsungTv({ ignoredKeys: { keys: ["KEY_POWER", "KEY_VOLUP"], answer: "silence" } });

    await sendKeys(tv, [
      { cmd: "Click", code: "KEY_VOLUP" },
      { cmd: "Click", code: "KEY_POWER" },
    ]);

    expect(tv.volume()).toEqual({ volume: 11, muted: false });
    expect(await powerOf(tv)).toBe("on");
  });

  it("as its own process, ignores the keys it is told to, and reports which", async () => {
    const [restPort, controlPort] = [await freePort(), await freePort()];
    process_ = await startNodeProcess(
      join(import.meta.dirname, "main.ts"),
      {
        FAKE_TV_REST_PORT: String(restPort),
        FAKE_TV_CONTROL_PORT: String(controlPort),
        FAKE_TV_SSDP_PORT: "0",
        FAKE_TV_UPNP_PORT: "0",
      },
      /Fake Samsung TV listening/,
    );
    const base = `http://127.0.0.1:${String(restPort)}`;
    const ignore = (body: string) => fetch(`${base}${FAKE_IGNORED_KEYS_PATH}`, { method: "PUT", body });
    const client = await letInClient(controlPort);

    expect(await (await fetch(`${base}${FAKE_IGNORED_KEYS_PATH}`)).json()).toEqual({ keys: [], answer: "silence" });
    expect(await (await ignore('{"keys": ["KEY_MTS"], "answer": "error"}')).json()).toEqual({
      keys: ["KEY_MTS"],
      answer: "error",
    });
    for (const body of [
      '{"keys": "KEY_MTS", "answer": "error"}',
      '{"keys": [""], "answer": "error"}',
      '{"keys": []}',
      "[]",
      "mts",
    ]) {
      expect((await ignore(body)).status).toBe(400);
    }

    client.send(click("KEY_MTS"));

    await expect.poll(() => client.events).toEqual(["ms.error"]);
    const keys = (await (await fetch(`${base}${FAKE_KEYS_PATH}`)).json()) as RecordedKey[];
    expect(keys.map(({ code, ignored }) => ({ code, ignored }))).toEqual([{ code: "KEY_MTS", ignored: true }]);
  });
});

/**
 * Stands in for the Hub: where a fake Player connects, with each socket, the
 * address it came from and its Host, and what it serves, by path, with each
 * request for it and the address it came from.
 */
interface PlayerHub {
  readonly address: string;
  readonly players: { readonly socket: WebSocket; readonly from: string; readonly host: string | undefined }[];
  readonly files: Map<string, string>;
  readonly requests: { readonly path: string; readonly from: string }[];
  /** Paths it never answers, as a Hub whose ffmpeg is slow to produce a segment. */
  readonly held: Set<string>;
  /** Each path whose request was given up on before it answered. */
  readonly givenUp: string[];
  readonly stop: () => Promise<void>;
}

let playerHubs: PlayerHub[] = [];

afterEach(async () => {
  for (const hub of playerHubs) await hub.stop();
  playerHubs = [];
});

const startPlayerHub = async (): Promise<PlayerHub> => {
  const files = new Map<string, string>();
  const requests: { path: string; from: string }[] = [];
  const held = new Set<string>();
  const givenUp: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, from: (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "") });
    if (held.has(path)) {
      response.on("close", () => givenUp.push(path));
      return;
    }
    const file = files.get(path);
    if (file === undefined) response.writeHead(404).end();
    else response.writeHead(200).end(file);
  });
  const sockets = new WebSocketServer({ server, path: PLAYER_SOCKET_PATH });
  const players: PlayerHub["players"] = [];
  sockets.on("connection", (socket, request: IncomingMessage) => {
    players.push({
      socket,
      from: (request.socket.remoteAddress ?? "").replace(/^::ffff:/, ""),
      host: request.headers.host,
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const hub: PlayerHub = {
    address: `127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    players,
    files,
    requests,
    held,
    givenUp,
    stop: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise((done) => server.close(done));
    },
  };
  playerHubs.push(hub);
  return hub;
};

/** The Hub's open sockets to the fake Player. */
const openPlayers = (hub: PlayerHub) => hub.players.filter(({ socket }) => socket.readyState === WebSocket.OPEN);

/** Launching an app on the control socket, as the Driver does the Player, with its deep link. */
const launch = (appId: string, metaTag?: string) =>
  emit("ed.apps.launch", { appId, action_type: "DEEP_LINK", ...(metaTag === undefined ? {} : { metaTag }) });

describe("the fake Samsung TV's Player (FR-35)", () => {
  const TV_HOST = "127.0.0.2";

  it("launches an app on the control socket, answering 200, and 404 for one it hasn't got", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST });
    const client = await letInClient(tv.controlPort, TV_HOST);

    client.send(launch("111299001912"));
    client.send(launch("no.such.app"));

    await expect
      .poll(() => client.messages.filter(({ event }) => event === "ed.apps.launch").map(({ data }) => data))
      .toEqual([200, 404]);
    expect(tv.apps()).toContainEqual({ id: "111299001912", name: "YouTube", running: true, visible: true });
  });

  it("runs the Player, launched with the Hub's address, as a fake Player connecting there from the TV's own", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);

    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));

    await expect.poll(() => openPlayers(hub).map(({ from, host }) => [from, host])).toEqual([[TV_HOST, hub.address]]);
    expect(tv.apps()).toContainEqual({ id: PLAYER_APP_ID, name: "Media Centre", running: true, visible: true });
    const status = await fetch(`http://${TV_HOST}:${String(tv.restPort)}${FAKE_PLAYER_PATH}`);
    expect(await status.json()).toEqual({
      running: true,
      hubAddress: hub.address,
      connected: true,
      received: [],
      segments: [],
      playback: "idle",
      positionMs: 0,
      audioTrack: null,
      subtitleTrack: null,
      subtitle: null,
      music: null,
    });
  });

  it("has the fake Player play each Media File the Hub sends it, and record its URL", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const url = `http://${hub.address}/api/media-sources/1/file/Films/Clip.mp4`;

    const heartbeat: HubToPlayerMessage = { type: "heartbeat" };
    const play: HubToPlayerMessage = { type: "play", url, positionMs: 0 };
    openPlayers(hub)[0]?.socket.send(JSON.stringify(heartbeat));
    openPlayers(hub)[0]?.socket.send(JSON.stringify(play));

    await expect.poll(() => tv?.playerStatus()).toMatchObject({ received: [url], playback: "playing" });
    expect(tv.player()?.playback.loaded).toEqual([url]);
    expect(tv.playerStatus().music).toBeNull();
  });

  it("has the fake Player keep what its now-playing screen shows of audio, reading its cover art from the TV's address (FR-47)", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const coverArt = "/api/media-sources/1/cover-art/Music/01%20Tone.flac";
    hub.files.set(coverArt, "a picture");
    const send = (message: HubToPlayerMessage): void => openPlayers(hub)[0]?.socket.send(JSON.stringify(message));
    const music = { title: "Tone in A", artist: "The Sine Waves", album: "Test Tones" };

    send({
      type: "play",
      url: `http://${hub.address}/api/media-sources/1/file/Music/01%20Tone.flac`,
      positionMs: 0,
      music: { ...music, coverArt: `http://${hub.address}${coverArt}` },
    });

    await expect
      .poll(() => tv?.playerStatus().music)
      .toEqual({ ...music, coverArt: `http://${hub.address}${coverArt}`, coverArtRead: { status: 200, bytes: 9 } });
    expect(hub.requests.find(({ path }) => path === coverArt)?.from).toBe(TV_HOST);

    // One with no cover art reads none, and a video has no now-playing screen at all.
    const untagged = { title: "02 Tone.mp3", artist: null, album: null, coverArt: null };
    send({
      type: "play",
      url: `http://${hub.address}/api/media-sources/1/file/Music/02%20Tone.mp3`,
      positionMs: 0,
      music: untagged,
    });
    await expect.poll(() => tv?.playerStatus().music).toEqual({ ...untagged, coverArtRead: null });
    send({ type: "play", url: `http://${hub.address}/api/media-sources/1/file/Films/Clip.mp4`, positionMs: 0 });
    await expect.poll(() => tv?.playerStatus().received).toHaveLength(3);
    expect(tv.playerStatus().music).toBeNull();

    // Once it stops, it shows its waiting screen instead.
    send({
      type: "play",
      url: `http://${hub.address}/api/media-sources/1/file/Music/02%20Tone.mp3`,
      positionMs: 0,
      music: untagged,
    });
    await expect.poll(() => tv?.playerStatus().music).not.toBeNull();
    send({ type: "control", control: { action: "stop" } });
    await expect.poll(() => tv?.playerStatus().playback).toBe("idle");
    expect(tv.playerStatus().music).toBeNull();
  });

  it("has the fake Player read an HLS stream as AVPlay would, from the TV's address (FR-42)", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const stream = "/api/streams/00000000-0000-0000-0000-000000000001";
    const segments = Array.from({ length: 10 }, (_, index) => [`#EXTINF:6.000,`, `${String(index)}.ts`]).flat();
    hub.files.set(
      `${stream}/index.m3u8`,
      ["#EXTM3U", "#EXT-X-TARGETDURATION:6", ...segments, "#EXT-X-ENDLIST"].join("\n"),
    );
    for (const index of [0, 5]) hub.files.set(`${stream}/${String(index)}.ts`, `segment ${String(index)}`);
    const url = `http://${hub.address}${stream}/index.m3u8`;
    const send = (message: HubToPlayerMessage): void => openPlayers(hub)[0]?.socket.send(JSON.stringify(message));

    send({ type: "play", url, positionMs: 0 });

    await expect
      .poll(() => tv?.playerStatus())
      .toMatchObject({
        playback: "playing",
        segments: [{ url: `http://${hub.address}${stream}/0.ts`, status: 200, bytes: 9 }],
      });
    expect(hub.requests.map(({ path }) => path)).toEqual([`${stream}/index.m3u8`, `${stream}/0.ts`]);
    expect(hub.requests.every(({ from }) => from === TV_HOST)).toBe(true);

    // A seek reads the segment there.
    send({ type: "control", control: { action: "seek", positionMs: 31_000 } });
    await expect
      .poll(() => tv?.playerStatus().segments.at(-1))
      .toEqual({
        url: `http://${hub.address}${stream}/5.ts`,
        status: 200,
        bytes: 9,
      });
    expect(tv.playerStatus().playback).toBe("playing");

    // One the Hub doesn't send stops it, as AVPlay stops with a stream it can't play.
    send({ type: "control", control: { action: "seek", positionMs: 45_000 } });
    await expect.poll(() => tv?.playerStatus().playback).toBe("idle");
    expect(tv.playerStatus().segments.at(-1)).toMatchObject({
      url: `http://${hub.address}${stream}/7.ts`,
      status: 404,
    });
  });

  it("has the fake Player give up on a segment it is still reading for a seek elsewhere, as AVPlay drops what it buffers", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const stream = "/api/streams/00000000-0000-0000-0000-000000000003";
    const segments = Array.from({ length: 10 }, (_, index) => [`#EXTINF:6.000,`, `${String(index)}.ts`]).flat();
    hub.files.set(
      `${stream}/index.m3u8`,
      ["#EXTM3U", "#EXT-X-TARGETDURATION:6", ...segments, "#EXT-X-ENDLIST"].join("\n"),
    );
    hub.files.set(`${stream}/5.ts`, "segment 5");
    // Segment 0 is slow in coming.
    hub.held.add(`${stream}/0.ts`);
    const send = (message: HubToPlayerMessage): void => openPlayers(hub)[0]?.socket.send(JSON.stringify(message));
    send({ type: "play", url: `http://${hub.address}${stream}/index.m3u8`, positionMs: 0 });
    await expect.poll(() => hub.requests.map(({ path }) => path)).toContain(`${stream}/0.ts`);

    send({ type: "control", control: { action: "seek", positionMs: 31_000 } });

    await expect.poll(() => hub.givenUp).toEqual([`${stream}/0.ts`]);
    await expect
      .poll(() => tv?.playerStatus().segments)
      .toEqual([{ url: `http://${hub.address}${stream}/5.ts`, status: 200, bytes: 9 }]);
    expect(tv.playerStatus().playback).toBe("playing");
  });

  it("has the fake Player fail to load a stream whose playlist the Hub doesn't send", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const url = `http://${hub.address}/api/streams/00000000-0000-0000-0000-000000000002/index.m3u8`;
    const reports: PlayerPlayback[] = [];
    openPlayers(hub)[0]?.socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as PlayerToHubMessage;
      if (message.type === "playback") reports.push(message.playback);
    });

    openPlayers(hub)[0]?.socket.send(JSON.stringify({ type: "play", url, positionMs: 0 } satisfies HubToPlayerMessage));

    await expect.poll(() => reports.map(({ state }) => state)).toEqual(["loading", "idle"]);
    expect(tv.playerStatus()).toMatchObject({ received: [url], segments: [], playback: "idle" });
  });

  it("has the fake Player tell the Hub what its playback does, and do the controls the Hub sends it (FR-36)", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const socket = openPlayers(hub)[0]?.socket;
    const reports: PlayerPlayback[] = [];
    socket?.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as PlayerToHubMessage;
      if (message.type === "playback") reports.push(message.playback);
    });
    const url = `http://${hub.address}/api/media-sources/1/file/Films/Clip.mp4`;
    const send = (message: HubToPlayerMessage): void => socket?.send(JSON.stringify(message));

    send({ type: "play", url, positionMs: 0 });

    await expect.poll(() => reports.at(-1)).toMatchObject({ state: "playing", url, durationMs: 60_000 });
    // It plays in real time, so its position moves on, and it says so.
    await expect.poll(() => reports.at(-1)?.positionMs ?? 0).toBeGreaterThan(0);

    send({ type: "control", control: { action: "pause" } });
    await expect.poll(() => tv?.playerStatus().playback).toBe("paused");
    send({ type: "control", control: { action: "seek", positionMs: 30_000 } });
    await expect.poll(() => tv?.playerStatus().positionMs).toBe(30_000);
    expect(reports.at(-1)).toMatchObject({ state: "paused", positionMs: 30_000 });

    send({ type: "control", control: { action: "stop" } });
    await expect.poll(() => tv?.playerStatus()).toMatchObject({ playback: "idle", positionMs: 0 });
    expect(reports.at(-1)).toEqual({
      state: "idle",
      url: null,
      positionMs: 0,
      durationMs: null,
      audioTrack: null,
      subtitleTrack: null,
    });
  });

  it("tells a running Player it was launched again, which connects to a new Hub address, and stays on the same one", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const first = await startPlayerHub();
    const second = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(first.address)}`));
    await expect.poll(() => openPlayers(first).length).toBe(1);

    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(first.address)}`));
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(second.address)}`));

    await expect.poll(() => openPlayers(second).length).toBe(1);
    await expect.poll(() => openPlayers(first).length).toBe(0);
    expect(first.players).toHaveLength(1);
  });

  it("runs the Player launched over REST, or from its own remote, with the Hub's address it last had", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);
    const appUrl = `http://${TV_HOST}:${String(tv.restPort)}/api/v2/applications/${PLAYER_APP_ID}`;
    await fetch(appUrl, { method: "DELETE" });
    await expect.poll(() => openPlayers(hub).length).toBe(0);

    await fetch(appUrl, { method: "POST" });
    await expect.poll(() => openPlayers(hub).length).toBe(1);

    tv.setPowerState("standby");
    await expect.poll(() => openPlayers(hub).length).toBe(0);
    tv.setPowerState("on");
    expect(tv.bringToFront(PLAYER_APP_ID)).toBe(true);
    await expect.poll(() => openPlayers(hub).length).toBe(1);
  });

  it("runs a Player never given the Hub's address without connecting anywhere", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });

    expect(tv.bringToFront(PLAYER_APP_ID)).toBe(true);

    expect(tv.playerStatus()).toEqual({
      running: true,
      hubAddress: null,
      connected: false,
      received: [],
      segments: [],
      playback: "idle",
      positionMs: 0,
      audioTrack: null,
      subtitleTrack: null,
      subtitle: null,
      music: null,
    });
  });

  it("closes the Player when it is removed from the TV", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST, apps: [...FAKE_APPS, FAKE_PLAYER_APP] });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);
    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));
    await expect.poll(() => openPlayers(hub).length).toBe(1);

    tv.setApps(FAKE_APPS);

    await expect.poll(() => openPlayers(hub).length).toBe(0);
    expect(tv.playerStatus()).toMatchObject({ running: false, connected: false });
  });

  it("starts no Player for the Player's app id while it isn't installed", async () => {
    tv = await startFakeSamsungTv({ host: TV_HOST });
    const hub = await startPlayerHub();
    const client = await letInClient(tv.controlPort, TV_HOST);

    client.send(launch(PLAYER_APP_ID, `hub=${encodeURIComponent(hub.address)}`));

    await expect.poll(() => client.messages.filter(({ event }) => event === "ed.apps.launch").length).toBe(1);
    expect(tv.playerStatus().running).toBe(false);
  });
});
