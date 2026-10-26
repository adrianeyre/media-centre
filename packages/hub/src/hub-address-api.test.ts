import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUB_ADDRESS_PATH, type HubAddress, type HubError } from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";

let database: DatabaseSync;
let hub: Server;
let base: string;
/** The Hub's network interfaces, as a test sets them. */
let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
let logged: string[];

const ethernet = (address: string): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  eth0: [
    {
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "02:00:00:00:00:01",
      internal: false,
      cidr: `${address}/24`,
    },
  ],
});

beforeEach(async () => {
  database = openDatabase(":memory:");
  interfaces = ethernet("192.168.1.5");
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    networkInterfaces: () => interfaces,
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((done) => hub.close(done));
  database.close();
});

const send = (method: string, body?: unknown, type = "application/json"): Promise<Response> =>
  fetch(`${base}${HUB_ADDRESS_PATH}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const read = async (): Promise<HubAddress> => {
  const response = await send("GET");
  expect(response.status).toBe(200);
  return (await response.json()) as HubAddress;
};

const setOverride = async (override: string | null): Promise<HubAddress> => {
  const response = await send("PUT", { override });
  expect(response.status).toBe(200);
  return (await response.json()) as HubAddress;
};

const refusal = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as HubError).error;
};

describe("the Hub's own address (FR-29)", () => {
  it("is the one it finds on its network interfaces until one is set", async () => {
    expect(await read()).toEqual({ address: "192.168.1.5", found: "192.168.1.5", override: null });
  });

  it("follows its network interfaces as they change, e.g. given another address by the router", async () => {
    interfaces = ethernet("192.168.1.6");

    expect(await read()).toEqual({ address: "192.168.1.6", found: "192.168.1.6", override: null });
  });

  it("is the one set in Settings once one is, until it is cleared, and logs each change", async () => {
    expect(await setOverride(" 192.168.1.10 ")).toEqual({
      address: "192.168.1.10",
      found: "192.168.1.5",
      override: "192.168.1.10",
    });
    expect(await read()).toEqual({ address: "192.168.1.10", found: "192.168.1.5", override: "192.168.1.10" });
    interfaces = ethernet("192.168.1.6");
    expect((await read()).address).toBe("192.168.1.10");

    expect(await setOverride(null)).toEqual({ address: "192.168.1.6", found: "192.168.1.6", override: null });
    await setOverride("192.168.1.10");
    // Emptying the field clears it too.
    expect(await setOverride("")).toEqual({ address: "192.168.1.6", found: "192.168.1.6", override: null });

    expect(logged).toEqual([
      "The Hub's IP address is set to 192.168.1.10",
      "The Hub's IP address is the one it finds, 192.168.1.6",
      "The Hub's IP address is set to 192.168.1.10",
      "The Hub's IP address is the one it finds, 192.168.1.6",
    ]);
  });

  it("is null when it finds none and none is set", async () => {
    interfaces = {};

    expect(await read()).toEqual({ address: null, found: null, override: null });
    expect((await setOverride("10.0.0.2")).address).toBe("10.0.0.2");
  });

  it.each(["192.168.1", "192.168.1.256", "fe80::1", "hub.local", "192.168.1.10:8080"])(
    'refuses "%s", which isn\'t an IPv4 address, and keeps the one it had',
    async (override) => {
      await setOverride("192.168.1.10");

      expect(await refusal(await send("PUT", { override }), 400)).toBe(
        "Give the Hub's IP address as four numbers with dots, e.g. 192.168.1.10.",
      );
      expect((await read()).override).toBe("192.168.1.10");
    },
  );

  it("refuses a body without an address, one that isn't JSON, and other methods", async () => {
    for (const body of [{}, { override: 192 }, [], "null"]) {
      expect(await refusal(await send("PUT", body), 400)).toBe(
        "Give the Hub's IP address, or null to use the one it finds.",
      );
    }
    expect((await send("PUT", "address", "text/plain")).status).toBe(415);
    expect((await send("PUT", "{", "application/json")).status).toBe(400);
    expect((await send("POST", { override: null })).status).toBe(405);
    expect((await send("HEAD")).status).toBe(200);
    expect((await read()).override).toBeNull();
  });
});
