import { randomBytes } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from "node:net";

import type { LightChange, LightState } from "@media-centre/shared";

import type { SearchTarget } from "../../drivers/lepro/transport.ts";
import {
  BRIGHTNESS_SCALE,
  capabilitiesFrom,
  colourFrom,
  DATA_POINT,
  dataPointsFor,
  dataPointsIn,
  decodeFrame,
  decodeMessage,
  encodeAnnouncement,
  encodeFrame,
  encodeMessage,
  frameLength,
  isSearchAsk,
  stateFrom,
  TEMPERATURE_SCALE,
  TUYA_COMMAND,
  type DataPoints,
} from "../../drivers/lepro/tuya.ts";

/**
 * A fake Lepro Light for tests (ADR 0004): it speaks Tuya's local protocol,
 * v3.3, on TCP, as the open-source libraries say a Tuya module does, on the
 * reading that Lepro's Lights are Tuya modules inside, and records every
 * command it receives. When a real Light turns out to behave differently,
 * change this first, then the Lepro Driver's `tuya.ts`.
 *
 * It takes only what is encrypted under the key it is given, for the id it
 * is given, and answers anything else with a return code of 1 and a few
 * words in plain text, as the libraries say a module does. It announces
 * itself as a module broadcasts, to each address it is told to, every few
 * seconds, and to whoever sends a search to its own discovery port, as tests
 * can't rely on a broadcast.
 *
 * It has the data points of one of {@link FAKE_LIGHT_KINDS}, or those it is
 * given, and keeps their values: a command sets those it has and leaves the
 * rest, as a module ignores what it hasn't got. A test changes them through
 * `/_fake/state`, as Lepro's LampUX app would.
 */

/**
 * What a fake Light can be: `colour`, which shows white at a colour
 * temperature or a colour; `white`, which shows white at a colour
 * temperature only; and `plug`, a smart plug, on/off only.
 */
export const FAKE_LIGHT_KINDS = ["colour", "white", "plug"] as const;

export type FakeLightKind = (typeof FAKE_LIGHT_KINDS)[number];

/** Each kind's data points, and the values it starts with: on, in white, at its brightest, halfway warm to cool. */
const STARTING: Readonly<Record<FakeLightKind, DataPoints>> = {
  colour: {
    [DATA_POINT.switch]: true,
    [DATA_POINT.mode]: "white",
    [DATA_POINT.brightness]: BRIGHTNESS_SCALE.max,
    [DATA_POINT.temperature]: TEMPERATURE_SCALE / 2,
    [DATA_POINT.colour]: "000003e803e8",
  },
  white: {
    [DATA_POINT.switch]: true,
    [DATA_POINT.mode]: "white",
    [DATA_POINT.brightness]: BRIGHTNESS_SCALE.max,
    [DATA_POINT.temperature]: TEMPERATURE_SCALE / 2,
  },
  plug: { [DATA_POINT.plugSwitch]: true },
};

/** Where the fake answers tests, outside what a real Light has. */
export const FAKE_LIGHT_STATE_PATH = "/_fake/state";
export const FAKE_LIGHT_COMMANDS_PATH = "/_fake/commands";
export const FAKE_LIGHT_CAPABILITIES_PATH = "/_fake/capabilities";

/** What a command the fake received asked. */
export type FakeLightAsked =
  | { readonly command: "query" }
  | { readonly command: "control"; readonly dps: DataPoints }
  | { readonly command: "heartbeat" }
  /** One it couldn't read with its key, or that was for another id, which it refused. */
  | { readonly command: "refused" };

/** A command the fake received, with when, and on which of its connections, counted from 0. */
export type FakeLightCommand = FakeLightAsked & { readonly receivedAt: number; readonly connection: number };

export interface FakeLeproLightOptions {
  /** 127.0.0.1 by default. */
  readonly host?: string;
  /** Where it takes connections: 6668 on a real Light; a free port by default. */
  readonly port?: number;
  /** Where it answers searches: 6667 on a real Light; a free port by default. */
  readonly discoveryPort?: number;
  /** Where its `/_fake/` paths are; a free port by default. */
  readonly httpPort?: number;
  /** Its id; made up by default. */
  readonly id?: string;
  /** The 16-character key it takes; made up by default. */
  readonly key?: string;
  /** `colour` by default. */
  readonly kind?: FakeLightKind;
  /** The data points it has, by their numbers, in place of its kind's, each starting as a colour Light's, or a plug's `1`. */
  readonly dataPoints?: readonly string[];
  /** Where it announces itself unasked, as a real Light broadcasts. */
  readonly announceTo?: readonly SearchTarget[];
  /** How often it does. */
  readonly announceEveryMs?: number;
  /** What it announces itself as. */
  readonly productKey?: string;
}

export interface FakeLeproLight {
  readonly host: string;
  readonly port: number;
  readonly discoveryPort: number;
  readonly httpPort: number;
  /** Its id and key, which are secret: tests use them to make the Hub's credentials, and never print them. */
  readonly id: string;
  readonly key: string;
  readonly kind: FakeLightKind;
  readonly dataPoints: readonly string[];
  /** Its data points' values now. */
  readonly state: () => DataPoints;
  /** Changes them, as LampUX would, and returns them. Those it hasn't, or of the wrong kind, are left out. */
  readonly setState: (change: DataPoints) => DataPoints;
  /**
   * Its state in the Appliance's terms, as the Lepro Driver reads it, for
   * tests beyond the protocol's boundary, which mayn't know its data points.
   */
  readonly light: () => LightState;
  /** Changes its state in the Appliance's terms, as LampUX would, and returns it. */
  readonly setLight: (change: LightChange) => LightState;
  readonly commands: FakeLightCommand[];
  readonly clear: () => void;
  readonly stop: () => Promise<void>;
}

/** Letters and digits, as Tuya's ids are, 20 of them. */
const madeUpId = (): string => `bf${randomBytes(9).toString("hex")}`;
/** 16 printable characters, as Tuya's keys are. */
const madeUpKey = (): string => randomBytes(12).toString("base64").replace(/[+/=]/g, "x");

/** Whether `value` is one data point `number` takes, as a module checks it. */
const takes = (number: string, value: unknown): boolean => {
  switch (number) {
    case DATA_POINT.switch:
    case DATA_POINT.plugSwitch:
      return typeof value === "boolean";
    case DATA_POINT.mode:
      return value === "white" || value === "colour" || value === "scene" || value === "music";
    case DATA_POINT.brightness:
      return (
        Number.isInteger(value) &&
        (value as number) >= BRIGHTNESS_SCALE.min &&
        (value as number) <= BRIGHTNESS_SCALE.max
      );
    case DATA_POINT.temperature:
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= TEMPERATURE_SCALE;
    case DATA_POINT.colour:
      return typeof value === "string" && colourFrom(value) !== undefined;
    default:
      return false;
  }
};

export const startFakeLeproLight = async ({
  host = "127.0.0.1",
  port = 0,
  discoveryPort = 0,
  httpPort = 0,
  id = madeUpId(),
  key = madeUpKey(),
  kind = "colour",
  dataPoints,
  announceTo = [],
  announceEveryMs = 5_000,
  productKey = "keyfakelepro0000",
}: FakeLeproLightOptions = {}): Promise<FakeLeproLight> => {
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new Error("A Light's id is letters and digits");
  if (!/^[\x21-\x7e]{16}$/.test(key)) throw new Error("A Light's key is 16 printable characters");
  const starting = STARTING[kind];
  let dps: Record<string, boolean | number | string> =
    dataPoints === undefined
      ? { ...starting }
      : Object.fromEntries(
          dataPoints.map((number) => {
            const value = STARTING.colour[number] ?? STARTING.plug[number];
            if (value === undefined) throw new Error(`A fake Lepro Light can't have data point ${number}`);
            return [number, value];
          }),
        );
  const has = Object.keys(dps);
  const commands: FakeLightCommand[] = [];
  let connections = 0;

  const setState = (change: DataPoints): DataPoints => {
    const taken = Object.fromEntries(
      Object.entries(change).filter(([number, value]) => has.includes(number) && takes(number, value)),
    );
    dps = { ...dps, ...taken };
    return { ...dps };
  };

  const serve = (socket: Socket): void => {
    const connection = connections;
    connections += 1;
    let buffered = Buffer.alloc(0);
    const record = (command: FakeLightAsked): void => {
      commands.push({ ...command, receivedAt: Date.now(), connection });
    };
    const answer = (seq: number, command: number, retcode: number, payload: Buffer): void => {
      socket.write(encodeFrame({ seq, command, retcode, payload }));
    };
    const refuse = (seq: number, command: number): void => {
      record({ command: "refused" });
      // Uncertain: as tinytuya reports a module answering what it can't read.
      answer(seq, command, 1, Buffer.from("data format error", "utf8"));
    };

    const handle = (packet: Buffer): void => {
      const frame = decodeFrame(packet, { fromLight: false });
      if (frame.command === TUYA_COMMAND.heartbeat) {
        record({ command: "heartbeat" });
        answer(frame.seq, frame.command, 0, Buffer.alloc(0));
        return;
      }
      if (frame.command !== TUYA_COMMAND.query && frame.command !== TUYA_COMMAND.control) return;
      let message: Record<string, unknown> | undefined;
      try {
        message = decodeMessage(key, frame.payload);
      } catch {
        refuse(frame.seq, frame.command);
        return;
      }
      if (message?.devId !== id) {
        refuse(frame.seq, frame.command);
        return;
      }
      if (frame.command === TUYA_COMMAND.query) {
        record({ command: "query" });
        answer(frame.seq, frame.command, 0, encodeMessage(key, TUYA_COMMAND.query, { devId: id, dps }));
        return;
      }
      const asked = dataPointsIn(message) ?? {};
      record({ command: "control", dps: asked });
      const before = { ...dps };
      setState(asked);
      const changed = Object.fromEntries(Object.entries(dps).filter(([number, value]) => before[number] !== value));
      // Uncertain: a module is said to acknowledge with nothing, then report what changed.
      answer(frame.seq, frame.command, 0, Buffer.alloc(0));
      if (Object.keys(changed).length > 0) {
        answer(
          0,
          TUYA_COMMAND.status,
          0,
          encodeMessage(key, TUYA_COMMAND.status, { devId: id, dps: changed, t: Math.floor(Date.now() / 1_000) }),
        );
      }
    };

    socket.on("data", (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      try {
        for (;;) {
          const length = frameLength(buffered);
          if (length === undefined || length > buffered.length) return;
          const packet = Buffer.from(buffered.subarray(0, length));
          buffered = buffered.subarray(length);
          handle(packet);
        }
      } catch {
        // What a module can't read as a frame, it hangs up on, as far as anyone knows.
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
  };

  const sockets = new Set<Socket>();
  const tcp: Server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket);
  });

  const announcement = (): Buffer => encodeAnnouncement({ ip: host, id, productKey });
  const discovery: UdpSocket = createSocket({ type: "udp4" });
  discovery.on("message", (data, from) => {
    if (isSearchAsk(data)) discovery.send(announcement(), from.port, from.address);
  });
  discovery.on("error", () => undefined);

  const http = createHttpServer((request, response) => {
    void readBody(request).then((body) => {
      const path = request.url ?? "/";
      if (path === FAKE_LIGHT_STATE_PATH) {
        if (request.method === "POST") {
          const change = changeIn(body, has);
          if (change === undefined) {
            sendJson(response, 400, {
              message: `Send data points it has, by number, with values it takes, e.g. {"${has[0] ?? DATA_POINT.switch}": false}`,
            });
            return;
          }
          setState(change);
        }
        sendJson(response, 200, dps);
        return;
      }
      if (path === FAKE_LIGHT_COMMANDS_PATH) {
        if (request.method === "DELETE") commands.length = 0;
        sendJson(response, 200, commands);
        return;
      }
      if (path === FAKE_LIGHT_CAPABILITIES_PATH) {
        sendJson(response, 200, { kind, dataPoints: has });
        return;
      }
      sendJson(response, 404, { message: "No such path" });
    });
  });

  let stopped: Promise<void> | undefined;
  await listen(tcp, port, host);
  await new Promise<void>((resolve, reject) => {
    discovery.once("error", reject);
    discovery.bind(discoveryPort, host, () => {
      discovery.off("error", reject);
      resolve();
    });
  });
  await listen(http, httpPort, host);

  const announce = (): void => {
    for (const target of announceTo) discovery.send(announcement(), target.port, target.host);
  };
  announce();
  const announcing = setInterval(announce, announceEveryMs);
  announcing.unref();

  return {
    host,
    port: (tcp.address() as AddressInfo).port,
    discoveryPort: discovery.address().port,
    httpPort: (http.address() as AddressInfo).port,
    id,
    key,
    kind,
    dataPoints: has,
    state: () => ({ ...dps }),
    setState,
    light: () => stateFrom(dps, capabilitiesFrom(dps)),
    setLight: (change) => {
      const changed = setState(dataPointsFor(change, dps));
      return stateFrom(changed, capabilitiesFrom(changed));
    },
    commands,
    clear: () => {
      commands.length = 0;
    },
    stop: () =>
      (stopped ??= (async () => {
        clearInterval(announcing);
        for (const socket of sockets) socket.destroy();
        http.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) =>
            tcp.close(() => {
              resolve();
            }),
          ),
          new Promise<void>((resolve) =>
            http.close(() => {
              resolve();
            }),
          ),
          new Promise<void>((resolve) =>
            discovery.close(() => {
              resolve();
            }),
          ),
        ]);
      })()),
  };
};

/** A change to its data points, from `POST /_fake/state`, or undefined if it isn't one it takes whole. */
const changeIn = (body: string, has: readonly string[]): DataPoints | undefined => {
  let read: unknown;
  try {
    read = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) return undefined;
  const change = read as Record<string, unknown>;
  if (!Object.entries(change).every(([number, value]) => has.includes(number) && takes(number, value)))
    return undefined;
  return change as DataPoints;
};

const listen = (server: Server | ReturnType<typeof createHttpServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk as string;
  return body;
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
};
