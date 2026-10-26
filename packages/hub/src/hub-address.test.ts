import type { NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vitest";

import { findHubAddress } from "./hub-address.ts";

/** One address on an interface, as `os.networkInterfaces` gives it. */
const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "02:00:00:00:00:01",
  internal,
  cidr: `${address}/24`,
});

const ipv6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: "ffff:ffff:ffff:ffff::",
  family: "IPv6",
  mac: "02:00:00:00:00:01",
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
});

describe("finding the Hub's own address", () => {
  it("finds the home network's IPv4 address, not loopback, IPv6 or a link-local address", () => {
    expect(
      findHubAddress(() => ({
        lo: [ipv4("127.0.0.1", true)],
        eth0: [ipv6("fe80::1"), ipv4("169.254.10.20"), ipv4("192.168.1.10")],
      })),
    ).toBe("192.168.1.10");
  });

  it("prefers a real interface to Docker's own, or another virtual one, whichever comes first", () => {
    expect(
      findHubAddress(() => ({
        docker0: [ipv4("172.17.0.1")],
        "br-5a1f": [ipv4("172.18.0.1")],
        veth12: [ipv4("172.19.0.1")],
        enp3s0: [ipv4("10.0.0.5")],
      })),
    ).toBe("10.0.0.5");
  });

  it("prefers a real interface to a VPN's, however its address looks", () => {
    expect(
      findHubAddress(() => ({
        "AWS Client VPN TAP-Windows Adapter V9 #1": [ipv4("10.100.0.5")],
        "WireGuard-Server-1": [ipv4("192.168.4.8")],
        wg0: [ipv4("10.8.0.2")],
        tailscale0: [ipv4("100.64.0.3")],
        "Ethernet 2": [ipv4("192.168.1.250")],
      })),
    ).toBe("192.168.1.250");
  });

  it("prefers a private address, as a home network's are, to any other", () => {
    expect(findHubAddress(() => ({ wan: [ipv4("203.0.113.7")], wlan0: [ipv4("172.20.1.4")] }))).toBe("172.20.1.4");
    expect(findHubAddress(() => ({ wan: [ipv4("172.32.0.1")] }))).toBe("172.32.0.1");
  });

  it("falls back on a virtual interface's address when it has no other", () => {
    expect(findHubAddress(() => ({ lo: [ipv4("127.0.0.1", true)], docker0: [ipv4("172.17.0.1")] }))).toBe("172.17.0.1");
  });

  it("finds none on a machine with only loopback", () => {
    expect(findHubAddress(() => ({ lo: [ipv4("127.0.0.1", true)] }))).toBeNull();
    expect(findHubAddress(() => ({}))).toBeNull();
  });

  it("finds an address on the machine running the tests, by default", () => {
    const found = findHubAddress();
    expect(found === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(found)).toBe(true);
  });
});
