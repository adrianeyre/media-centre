import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeSamsungTv, type FakeSamsungTv } from "../../fakes/samsung-tv/fake-samsung-tv.ts";
import { freePort } from "../../testing/ports.ts";
import { DriverFailure, type Driver } from "../driver.ts";
import { elementText } from "./rendering-control.ts";
import { samsungTvDriver, samsungTvDriverFromEnvironment } from "./samsung-tv-driver.ts";

let tv: FakeSamsungTv | undefined;

afterEach(async () => {
  await tv?.stop();
  tv = undefined;
});

const driverFor = (fake: FakeSamsungTv): Driver =>
  samsungTvDriver({ restPort: fake.restPort, controlPort: fake.controlPort, upnpPort: fake.upnpPort });

/** The Driver's volume calls, which the Samsung TV Driver has. */
const volumeOf = (driver: Driver) => {
  const { readVolume, setVolume, setMute } = driver;
  if (readVolume === undefined || setVolume === undefined || setMute === undefined) {
    throw new Error("The Samsung TV Driver reads and sets a TV's volume");
  }
  return { readVolume, setVolume, setMute };
};

const failure = async (work: Promise<unknown>): Promise<DriverFailure> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DriverFailure);
  return error as DriverFailure;
};

const STANDBY_MESSAGE =
  "The TV at 127.0.0.1 isn't answering for its volume, as when it is in standby. Volume up and down still work.";

describe("the Samsung TV Driver's volume and mute, against the fake Samsung TV (FR-19)", () => {
  it("reads the TV's own volume and mute, without pairing", async () => {
    tv = await startFakeSamsungTv({ volume: { volume: 23, muted: true } });

    expect(await volumeOf(driverFor(tv)).readVolume(tv.host)).toEqual({ known: true, volume: 23, muted: true });
    expect(tv.connections).toEqual([]);
  });

  it("reads the volume again as it is, after it was changed on the TV's own remote", async () => {
    tv = await startFakeSamsungTv();
    const { readVolume } = volumeOf(driverFor(tv));
    expect(await readVolume(tv.host)).toEqual({ known: true, volume: 11, muted: false });

    tv.setVolume({ volume: 30, muted: true });

    expect(await readVolume(tv.host)).toEqual({ known: true, volume: 30, muted: true });
  });

  it("sets the TV's volume, as UPnP's SetVolume on the Master channel", async () => {
    tv = await startFakeSamsungTv();

    await volumeOf(driverFor(tv)).setVolume(tv.host, 18);

    expect(tv.volume()).toEqual({ volume: 18, muted: false });
    const [request] = tv.upnpRequests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/upnp/control/RenderingControl1");
    expect(request?.headers.soapaction).toBe('"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"');
    expect(request?.headers["content-type"]).toBe('text/xml; charset="utf-8"');
    expect(elementText(request?.body ?? "", "InstanceID")).toBe("0");
    expect(elementText(request?.body ?? "", "Channel")).toBe("Master");
    expect(elementText(request?.body ?? "", "DesiredVolume")).toBe("18");
    expect(tv.connections).toEqual([]);
  });

  it("sets the volume to either end, 0 and 100", async () => {
    tv = await startFakeSamsungTv();
    const { setVolume } = volumeOf(driverFor(tv));

    await setVolume(tv.host, 0);
    expect(tv.volume().volume).toBe(0);
    await setVolume(tv.host, 100);
    expect(tv.volume().volume).toBe(100);
  });

  it("mutes the TV and unmutes it, leaving its volume as it was", async () => {
    tv = await startFakeSamsungTv({ volume: { volume: 25 } });
    const { setMute } = volumeOf(driverFor(tv));

    await setMute(tv.host, true);
    expect(tv.volume()).toEqual({ volume: 25, muted: true });
    expect(elementText(tv.upnpRequests[0]?.body ?? "", "DesiredMute")).toBe("1");

    await setMute(tv.host, false);
    expect(tv.volume()).toEqual({ volume: 25, muted: false });
  });

  it("says the volume is not known for a TV in standby, rather than making one up, and can't set it then", async () => {
    tv = await startFakeSamsungTv({ volume: { volume: 25 } });
    tv.setPowerState("standby");
    const { readVolume, setVolume, setMute } = volumeOf(driverFor(tv));

    expect(await readVolume(tv.host)).toEqual({ known: false });
    for (const work of [setVolume(tv.host, 18), setMute(tv.host, true)]) {
      const error = await failure(work);
      expect(error.reason).toBe("unreachable");
      expect(error.message).toBe(STANDBY_MESSAGE);
    }
    expect(tv.volume()).toEqual({ volume: 25, muted: false });
  });

  it("says the volume is not known when nothing answers at the address", async () => {
    const driver = samsungTvDriver({ upnpPort: await freePort() });

    expect(await volumeOf(driver).readVolume("127.0.0.1")).toEqual({ known: false });
    expect((await failure(volumeOf(driver).setVolume("127.0.0.1", 18))).message).toBe(STANDBY_MESSAGE);
  });

  it.each([
    ["answers with a UPnP fault", (response: ServerResponse) => response.writeHead(500).end("<s:Fault/>")],
    [
      "answers without a volume it can read",
      (response: ServerResponse) =>
        response.writeHead(200).end("<CurrentVolume>loud</CurrentVolume><CurrentMute>0</CurrentMute>"),
    ],
    [
      "answers with a volume above 100",
      (response: ServerResponse) =>
        response.writeHead(200).end("<CurrentVolume>150</CurrentVolume><CurrentMute>0</CurrentMute>"),
    ],
    ["doesn't answer in time", () => undefined],
  ])("says the volume is not known when what is at the address %s", async (_, answer) => {
    const other = createServer((_request, response) => {
      answer(response);
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));

    try {
      const driver = samsungTvDriver({ upnpPort: (other.address() as AddressInfo).port, volumeTimeoutMs: 200 });
      expect(await volumeOf(driver).readVolume("127.0.0.1")).toEqual({ known: false });
    } finally {
      other.closeAllConnections();
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("presses volume up and down as the TV's volume keys, which work in standby too", async () => {
    tv = await startFakeSamsungTv({ volume: { volume: 20 } });
    const driver = driverFor(tv);
    const token = await driver.pair(tv.host);

    await driver.pressKey?.(tv.host, token, "volume-up");
    await driver.pressKey?.(tv.host, token, "volume-up");
    await driver.pressKey?.(tv.host, token, "volume-down");
    tv.setPowerState("standby");
    await driver.pressKey?.(tv.host, token, "volume-down");

    await expect.poll(() => tv?.keys.length).toBe(4);
    expect(tv.keys.map(({ code }) => code)).toEqual(["KEY_VOLUP", "KEY_VOLUP", "KEY_VOLDOWN", "KEY_VOLDOWN"]);
    expect(tv.volume().volume).toBe(21);
    driver.disconnect?.(tv.host);
  });

  it("runs on another UPnP port only when the environment says so", async () => {
    tv = await startFakeSamsungTv({ volume: { volume: 7 } });
    const driver = samsungTvDriverFromEnvironment({ SAMSUNG_TV_UPNP_PORT: String(tv.upnpPort) });

    expect(await volumeOf(driver).readVolume(tv.host)).toEqual({ known: true, volume: 7, muted: false });
    expect(() => samsungTvDriverFromEnvironment({ SAMSUNG_TV_UPNP_PORT: "loud" })).toThrow(
      'SAMSUNG_TV_UPNP_PORT must be a port number, not "loud"',
    );
  });
});
