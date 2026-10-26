import { spawn } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { leproCredentials, leproDriver } from "../../drivers/lepro/lepro-driver.ts";
import { tuyaTransport } from "../../drivers/lepro/tuya.ts";
import { freePort } from "../../testing/ports.ts";
import { startNodeProcess, type RunningProcess } from "../../testing/process.ts";
import {
  FAKE_LIGHT_CAPABILITIES_PATH,
  FAKE_LIGHT_COMMANDS_PATH,
  FAKE_LIGHT_STATE_PATH,
  startFakeLeproLight,
} from "./fake-lepro-light.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const LISTENING =
  /Fake Lepro Light listening on 127\.0\.0\.1:(\d+), (a colour Light|a white Light|a plug), answering searches on (\d+), its \/_fake\/ paths on http:\/\/127\.0\.0\.1:(\d+)/;

/** Made up for these tests: no real Light's. */
const ID = "bf0f1e2d3c4b5a697886";
const KEY = "k3y!for~a+fake/L";

let running: RunningProcess | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** Runs the fake as its own process on free ports, and says where. */
const startProcess = async (env: Readonly<Record<string, string>> = {}) => {
  const httpPort = await freePort();
  running = await startNodeProcess(
    MAIN,
    {
      FAKE_LIGHT_PORT: "0",
      FAKE_LIGHT_DISCOVERY_PORT: "0",
      FAKE_LIGHT_HTTP_PORT: String(httpPort),
      FAKE_LIGHT_ID: ID,
      FAKE_LIGHT_KEY: KEY,
      ...env,
    },
    LISTENING,
  );
  const [, port, said, discoveryPort] = running.match;
  return {
    port: Number(port),
    said,
    discoveryPort: Number(discoveryPort),
    base: `http://127.0.0.1:${String(httpPort)}`,
  };
};

/** Runs the fake as its own process, which should refuse to start, and resolves with its exit code and what it said. */
const failToStart = async (env: Readonly<Record<string, string>>): Promise<{ code: number | null; said: string }> => {
  // Only what the test gives it: none of the Hub's own environment's id or key.
  const without = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "FAKE_LIGHT_ID" && name !== "FAKE_LIGHT_KEY"),
  );
  const child = spawn(process.execPath, [MAIN], {
    env: { ...without, FAKE_LIGHT_PORT: "0", FAKE_LIGHT_DISCOVERY_PORT: "0", FAKE_LIGHT_HTTP_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, said };
};

describe("The fake Lepro Light", () => {
  it("runs as its own process, which the Driver finds and controls, and reports its state and the commands it received", async () => {
    const { port, said, discoveryPort, base } = await startProcess();
    expect(said).toBe("a colour Light");
    const driver = leproDriver({
      transport: tuyaTransport({
        port,
        searchTargets: [{ host: "127.0.0.1", port: discoveryPort }],
        searchWindowMs: 500,
      }),
      log: () => undefined,
    });

    const [found] = await driver.discover();
    expect(found).toMatchObject({ address: "127.0.0.1", credentials: leproCredentials({ id: ID }) });

    const credentials = leproCredentials({ id: ID, key: KEY });
    expect(await driver.readCapabilities("127.0.0.1", credentials)).toMatchObject({ colour: true });
    // As LampUX would change it.
    const changed = await fetch(`${base}${FAKE_LIGHT_STATE_PATH}`, {
      method: "POST",
      body: JSON.stringify({ "21": "colour", "24": "00f003e803e8" }),
    });
    expect(changed.status).toBe(200);
    expect(await driver.readState("127.0.0.1", credentials)).toMatchObject({
      colour: { hue: 240, saturation: 100 },
      brightness: 100,
    });
    await driver.setState("127.0.0.1", credentials, { on: false });

    expect(await (await fetch(`${base}${FAKE_LIGHT_STATE_PATH}`)).json()).toEqual({
      "20": false,
      "21": "colour",
      "22": 1_000,
      "23": 500,
      "24": "00f003e803e8",
    });
    const commands = (await (await fetch(`${base}${FAKE_LIGHT_COMMANDS_PATH}`)).json()) as { command: string }[];
    expect(commands.map(({ command }) => command)).toEqual(["query", "query", "query", "control", "query"]);
    expect(commands[3]).toMatchObject({ command: "control", dps: { "20": false } });
    expect(await (await fetch(`${base}${FAKE_LIGHT_COMMANDS_PATH}`, { method: "DELETE" })).json()).toEqual([]);
    expect(await (await fetch(`${base}${FAKE_LIGHT_CAPABILITIES_PATH}`)).json()).toEqual({
      kind: "colour",
      dataPoints: ["20", "21", "22", "23", "24"],
    });

    // A change it hasn't the data points for, or with values it doesn't take, changes nothing.
    for (const body of ['{"1": true}', '{"22": 5}', '{"21": "disco"}', '{"24": "red"}', "[]", "nonsense"]) {
      expect((await fetch(`${base}${FAKE_LIGHT_STATE_PATH}`, { method: "POST", body })).status, body).toBe(400);
    }

    const output = running?.output.join("\n") ?? "";
    expect(output).not.toContain(ID);
    expect(output).not.toContain(KEY);
  });

  it("runs as a white Light or a plug, as it is told", async () => {
    const white = await startProcess({ FAKE_LIGHT_CAPABILITIES: "white" });
    expect(white.said).toBe("a white Light");
    expect(await (await fetch(`${white.base}${FAKE_LIGHT_CAPABILITIES_PATH}`)).json()).toEqual({
      kind: "white",
      dataPoints: ["20", "21", "22", "23"],
    });
    await running?.stop();

    const plug = await startProcess({ FAKE_LIGHT_CAPABILITIES: "plug" });
    expect(plug.said).toBe("a plug");
    const driver = leproDriver({ transport: tuyaTransport({ port: plug.port }), log: () => undefined });
    expect(await driver.readCapabilities("127.0.0.1", leproCredentials({ id: ID, key: KEY }))).toEqual({
      onOff: true,
      brightness: false,
      colourTemperature: null,
      colour: false,
    });
  });

  it("won't start without an id and a key, nor as what it can't be, and quotes neither", async () => {
    expect(await failToStart({ FAKE_LIGHT_KEY: KEY })).toEqual({
      code: 1,
      said: "FAKE_LIGHT_ID must be letters and digits\n",
    });
    expect(await failToStart({ FAKE_LIGHT_ID: "bf-01!", FAKE_LIGHT_KEY: KEY })).toEqual({
      code: 1,
      said: "FAKE_LIGHT_ID must be letters and digits\n",
    });
    const shortKey = await failToStart({ FAKE_LIGHT_ID: ID, FAKE_LIGHT_KEY: "k3y!for~a+fake" });
    expect(shortKey).toEqual({ code: 1, said: "FAKE_LIGHT_KEY must be 16 printable characters\n" });
    expect(await failToStart({ FAKE_LIGHT_ID: ID, FAKE_LIGHT_KEY: KEY, FAKE_LIGHT_CAPABILITIES: "disco" })).toEqual({
      code: 1,
      said: 'FAKE_LIGHT_CAPABILITIES must be one of colour, white, plug, not "disco"\n',
    });
  });

  it("hangs up on what isn't Tuya's protocol, as a Light does", async () => {
    const fake = await startFakeLeproLight();
    try {
      const socket = new Socket();
      await new Promise<void>((resolve) => socket.connect(fake.port, fake.host, resolve));
      socket.write("GET / HTTP/1.1\r\n\r\n");
      await once(socket, "close");
      expect(fake.commands).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  it("says and changes its state in the Appliance's terms, as the Driver reads it, for tests beyond the protocol", async () => {
    const fake = await startFakeLeproLight({ id: ID, key: KEY });
    try {
      expect(fake.light()).toEqual({ on: true, brightness: 100, colourTemperature: 4_600, colour: null });
      expect(fake.setLight({ on: false, colour: { hue: 120, saturation: 50 } })).toMatchObject({
        on: false,
        colour: { hue: 120, saturation: 50 },
        colourTemperature: null,
      });
      const driver = leproDriver({
        transport: tuyaTransport({ port: fake.port, answerTimeoutMs: 1_000 }),
        log: () => undefined,
      });
      expect(await driver.readState(fake.host, leproCredentials({ id: ID, key: KEY }))).toEqual(fake.light());
    } finally {
      await fake.stop();
    }
  });

  it("can't be given data points it doesn't know", async () => {
    await expect(startFakeLeproLight({ dataPoints: ["20", "99"] })).rejects.toThrow(
      "A fake Lepro Light can't have data point 99",
    );
    await expect(startFakeLeproLight({ key: "short" })).rejects.toThrow("A Light's key is 16 printable characters");
  });
});
