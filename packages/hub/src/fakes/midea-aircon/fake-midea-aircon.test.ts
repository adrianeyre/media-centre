import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { mideaCredentials, mideaDriver } from "../../drivers/midea/midea-driver.ts";
import { freePort } from "../../testing/ports.ts";
import { startNodeProcess, type RunningProcess } from "../../testing/process.ts";
import {
  FAKE_AIRCON_CAPABILITIES_PATH,
  FAKE_AIRCON_COMMANDS_PATH,
  FAKE_AIRCON_CONNECTIONS_PATH,
  FAKE_AIRCON_STATE_PATH,
  startFakeMideaAircon,
  type FakeAirconState,
} from "./fake-midea-aircon.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const LISTENING =
  /Fake Midea Air Conditioner listening on 127\.0\.0\.1:(\d+), on protocol v(\d), answering discovery on (\d+), its \/_fake\/ paths on http:\/\/127\.0\.0\.1:(\d+)/;

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
    { FAKE_AIRCON_PORT: "0", FAKE_AIRCON_DISCOVERY_PORT: "0", FAKE_AIRCON_HTTP_PORT: String(httpPort), ...env },
    LISTENING,
  );
  const [, port, version, discoveryPort] = running.match;
  return {
    port: Number(port),
    version: Number(version),
    discoveryPort: Number(discoveryPort),
    base: `http://127.0.0.1:${String(httpPort)}`,
  };
};

/** Runs the fake as its own process, which should refuse to start, and resolves with its exit code and what it said. */
const failToStart = async (env: Readonly<Record<string, string>>): Promise<{ code: number | null; said: string }> => {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, FAKE_AIRCON_PORT: "0", FAKE_AIRCON_DISCOVERY_PORT: "0", FAKE_AIRCON_HTTP_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, said };
};

describe("The fake Midea Air Conditioner", () => {
  it("runs as its own process on v2, which the Driver controls, and reports its state and the commands it received", async () => {
    const { port, version, discoveryPort, base } = await startProcess({
      FAKE_AIRCON_ID: "4660",
      FAKE_AIRCON_NAME: "net_ac_1234",
    });
    expect(version).toBe(2);
    const driver = mideaDriver({
      port,
      searchTargets: [{ host: "127.0.0.1", port: discoveryPort }],
      searchWindowMs: 200,
      log: () => undefined,
    });

    const [found] = await driver.discover();
    expect(found).toMatchObject({ address: "127.0.0.1", name: "net_ac_1234", needsKeys: false });
    expect(found?.credentials).toBe(mideaCredentials({ id: 4660, version: 2 }));

    const changed = await fetch(`${base}${FAKE_AIRCON_STATE_PATH}`, {
      method: "POST",
      body: JSON.stringify({ power: true, mode: "heat", targetTemperature: 23, roomTemperature: 18.5 }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      power: true,
      mode: "heat",
      targetTemperature: 23,
      roomTemperature: 18.5,
    });
    expect(await driver.readState("127.0.0.1", found?.credentials ?? "")).toMatchObject({
      power: true,
      mode: "heat",
      targetTemperature: 23,
      roomTemperature: 18.5,
    });

    await driver.setState("127.0.0.1", found?.credentials ?? "", { mode: "cool", targetTemperature: 20.5 });
    expect(await (await fetch(`${base}${FAKE_AIRCON_STATE_PATH}`)).json()).toMatchObject({
      mode: "cool",
      targetTemperature: 20.5,
    } satisfies Partial<FakeAirconState>);
    const commands = (await (await fetch(`${base}${FAKE_AIRCON_COMMANDS_PATH}`)).json()) as { command: string }[];
    expect(commands.map(({ command }) => command)).toContain("set-state");
    expect(commands.find(({ command }) => command === "set-state")).toMatchObject({
      mode: "cool",
      targetTemperature: 20.5,
      count: null,
    });

    expect(await (await fetch(`${base}${FAKE_AIRCON_COMMANDS_PATH}`, { method: "DELETE" })).json()).toEqual([]);
    expect(await (await fetch(`${base}${FAKE_AIRCON_CONNECTIONS_PATH}`)).json()).toContainEqual({
      version: 2,
      handshake: "none",
    });
    for (const body of ["power", '{"power": "on"}', '{"mode": "sideways"}', '{"colour": "red"}', '{"swing": true}']) {
      expect((await fetch(`${base}${FAKE_AIRCON_STATE_PATH}`, { method: "POST", body })).status).toBe(400);
    }
    expect((await fetch(`${base}/_fake/nothing`)).status).toBe(404);
  });

  it("runs as its own process on v3, with the token and key it is given and the capabilities it is told, and never prints them", async () => {
    const token = randomBytes(64).toString("hex");
    const key = randomBytes(32).toString("hex");
    const { port, base } = await startProcess({
      FAKE_AIRCON_VERSION: "3",
      FAKE_AIRCON_TOKEN: token,
      FAKE_AIRCON_KEY: key,
      FAKE_AIRCON_CAPABILITIES: "cool, heat, fan-auto, display",
    });
    const driver = mideaDriver({ port, log: () => undefined });

    expect(await (await fetch(`${base}${FAKE_AIRCON_CAPABILITIES_PATH}`)).json()).toMatchObject({
      version: 3,
      features: ["cool", "heat", "fan-auto", "display"],
    });
    const capabilities = await driver.readCapabilities(
      "127.0.0.1",
      mideaCredentials({ id: 0x0123_4567_89ab, version: 3, token, key }),
    );
    expect(capabilities.modes.map(({ mode }) => mode)).toEqual(["cool", "heat", "fan"]);
    expect(capabilities).toMatchObject({ swing: { vertical: false, horizontal: false }, display: true, functions: [] });
    expect(await (await fetch(`${base}${FAKE_AIRCON_CONNECTIONS_PATH}`)).json()).toEqual([
      { version: 3, handshake: "accepted" },
    ]);

    const output = running?.output.join("\n") ?? "";
    expect(output).not.toContain(token);
    expect(output).not.toContain(key);
  });

  it("won't start on v3 without a token and key, nor with capabilities it doesn't know, and quotes no token", async () => {
    const token = randomBytes(60).toString("hex");

    expect(await failToStart({ FAKE_AIRCON_VERSION: "3", FAKE_AIRCON_TOKEN: token })).toEqual({
      code: 1,
      said: "FAKE_AIRCON_TOKEN must be 64 bytes, in hex, for v3\n",
    });
    expect(
      await failToStart({
        FAKE_AIRCON_VERSION: "3",
        FAKE_AIRCON_TOKEN: randomBytes(64).toString("hex"),
      }),
    ).toEqual({ code: 1, said: "FAKE_AIRCON_KEY must be 32 bytes, in hex, for v3\n" });
    expect(await failToStart({ FAKE_AIRCON_VERSION: "4" })).toEqual({
      code: 1,
      said: 'FAKE_AIRCON_VERSION must be 2 or 3, not "4"\n',
    });
    const unknown = await failToStart({ FAKE_AIRCON_CAPABILITIES: "cool,jetpack" });
    expect(unknown.code).toBe(1);
    expect(unknown.said).toMatch(/^FAKE_AIRCON_CAPABILITIES has jetpack, which aren't among cool, heat, /);
    // Modes no Midea unit can report together.
    const impossible = await failToStart({ FAKE_AIRCON_CAPABILITIES: "dry,auto" });
    expect(impossible).toEqual({
      code: 1,
      said: "The fake Midea Air Conditioner couldn't start: A Midea unit can't report the modes dry, auto\n",
    });
  });

  it("hangs up on what isn't Midea's protocol, as a unit does", async () => {
    const fake = await startFakeMideaAircon({ version: 2 });
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
});
