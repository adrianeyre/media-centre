import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { readDeviceInfo } from "./device-info.ts";

let tv: FakeSamsungTv | undefined;

afterEach(async () => {
  await tv?.stop();
  tv = undefined;
});

describe("the Samsung TV Driver reading device info from the fake Samsung TV", () => {
  it("reads the TV's name, model, MAC address, power state, Frame support, network type and Developer Mode, with one GET /api/v2/", async () => {
    tv = await startFakeSamsungTv({ device: { wifiMac: "02:00:00:AB:CD:EF" } });

    const info = await readDeviceInfo(tv.host, { port: tv.restPort });

    expect(info).toEqual({
      name: "[TV] Samsung Q60 Series (55)",
      model: "QE55Q60TAUXXU",
      macAddress: "02:00:00:ab:cd:ef",
      powerState: "on",
      frame: false,
      networkType: "wireless",
      developer: { mode: "off", ip: null },
    });
    expect(tv.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/v2/"]);
  });

  it("reads standby when the TV says so", async () => {
    tv = await startFakeSamsungTv({ device: { PowerState: "standby" } });

    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).powerState).toBe("standby");
  });

  it("reads a Frame TV as one when its device info says it supports being a Frame", async () => {
    tv = await startFakeSamsungTv({ device: { FrameTVSupport: "true" } });

    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).frame).toBe(true);
  });

  it("reads a TV on a cable as wired, and a network type it doesn't know, or none, as not known", async () => {
    tv = await startFakeSamsungTv({ device: { networkType: "wired" } });
    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).networkType).toBe("wired");
    await tv.stop();

    tv = await startFakeSamsungTv({ device: { networkType: "powerline" } });
    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).networkType).toBeNull();
    await tv.stop();

    tv = await startFakeSamsungTv({ leaveOut: ["networkType"] });
    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).networkType).toBeNull();
  });

  it("reads Developer Mode on, with the Developer IP the TV reports", async () => {
    tv = await startFakeSamsungTv({ device: { developerMode: "1", developerIP: "192.168.1.10" } });

    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).developer).toEqual({
      mode: "on",
      ip: "192.168.1.10",
    });
  });

  it("reads a Developer IP of 0.0.0.0, or none, as none set", async () => {
    tv = await startFakeSamsungTv({ device: { developerMode: "1", developerIP: "" } });
    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).developer).toEqual({ mode: "on", ip: null });
    await tv.stop();

    tv = await startFakeSamsungTv({ device: { developerMode: "0", developerIP: "0.0.0.0" } });
    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).developer).toEqual({ mode: "off", ip: null });
  });

  it.each([
    ["leaves out both", { leaveOut: ["developerMode", "developerIP"] }],
    ["leaves out Developer Mode", { leaveOut: ["developerMode"] }],
    ["leaves out the Developer IP", { leaveOut: ["developerIP"] }],
    ["reports Developer Mode as something other than 0 or 1", { device: { developerMode: "true" } }],
  ] as const)("reads a TV that %s as not reporting Developer Mode and the Developer IP", async (_, options) => {
    tv = await startFakeSamsungTv(options);

    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).developer).toBeNull();
  });

  it("takes a TV whose firmware reports no power state to be on, since it answered", async () => {
    tv = await startFakeSamsungTv({ leaveOut: ["PowerState"] });

    expect((await readDeviceInfo(tv.host, { port: tv.restPort })).powerState).toBe("on");
  });

  it.each([
    ["answers with an error", 500, "{}", "answered device info with 500"],
    ["answers with something else", 200, '{"router":true}', "sent device info we cannot read"],
  ])("rejects when whatever is at the address %s", async (_, status, body, message) => {
    const other = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));

    try {
      await expect(readDeviceInfo("127.0.0.1", { port: (other.address() as AddressInfo).port })).rejects.toThrow(
        message,
      );
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("rejects when nothing answers at the TV's address", async () => {
    const port = await freePort();

    await expect(readDeviceInfo("127.0.0.1", { port })).rejects.toThrow();
  });
});
