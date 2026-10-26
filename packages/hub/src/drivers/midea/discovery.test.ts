import type { NetworkInterfaceInfo } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeMideaAircon, type FakeMideaAircon } from "../../fakes/midea-aircon/fake-midea-aircon.ts";
import { BROADCAST_ADDRESS, broadcastAddresses, searchForMideaUnits } from "./discovery.ts";

let aircons: FakeMideaAircon[] = [];

afterEach(async () => {
  await Promise.all(aircons.map((aircon) => aircon.stop()));
  aircons = [];
});

/** An IPv4 interface, as `os.networkInterfaces()` gives one. */
const ipv4 = (address: string, netmask: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: null,
});

describe("Where Midea's discovery searches", () => {
  it("broadcasts on every interface's own subnet as well, as a PC with a VPN and virtual machines sends a broadcast out of only one", () => {
    expect(
      broadcastAddresses({
        Loopback: [ipv4("127.0.0.1", "255.0.0.0", true)],
        "Wi-Fi": [ipv4("192.168.1.207", "255.255.255.0")],
        Ethernet: [ipv4("192.168.1.250", "255.255.255.0")],
        "vEthernet (WSL)": [ipv4("172.30.32.1", "255.255.240.0")],
        WireGuard: [ipv4("192.168.4.8", "255.255.255.255")],
        "Point to point": [ipv4("10.0.0.1", "255.255.255.254")],
        "IPv6 only": [{ ...ipv4("fe80::1", "ffff:ffff:ffff:ffff::"), family: "IPv6", scopeid: 1 }],
      }),
    ).toEqual([BROADCAST_ADDRESS, "192.168.1.255", "172.30.47.255"]);
  });

  it("broadcasts only to the broadcast address with no interface but loopback", () => {
    expect(broadcastAddresses({ Loopback: [ipv4("127.0.0.1", "255.0.0.0", true)] })).toEqual([BROADCAST_ADDRESS]);
  });

  it("finds a unit though a target can't be sent to, as a VPN may refuse a broadcast", async () => {
    const aircon = await startFakeMideaAircon({ version: 2 });
    aircons.push(aircon);

    const found = await searchForMideaUnits({
      targets: [
        // An address no socket can send to.
        { host: "0.0.0.0", port: 0 },
        { host: aircon.host, port: aircon.discoveryPort },
      ],
      windowMs: 300,
    });

    expect(found.map(({ address }) => address)).toEqual([aircon.host]);
  });

  it("rejects when the search can't be sent to any target", async () => {
    await expect(searchForMideaUnits({ targets: [{ host: "0.0.0.0", port: 0 }], windowMs: 100 })).rejects.toThrow();
  });
});
