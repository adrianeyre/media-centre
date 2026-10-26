import { createSocket } from "node:dgram";
import type { NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vitest";

import {
  broadcastAddressFor,
  magicPacket,
  magicPacketTarget,
  MAGIC_PACKET_LENGTH,
  sendMagicPacket,
} from "./wake-on-lan.ts";

describe("Wake-on-LAN's magic packet", () => {
  it("is six bytes of 0xff, then the MAC address sixteen times", () => {
    const packet = magicPacket("02:00:00:AA:bb:0C");

    expect(packet).toHaveLength(102);
    expect(MAGIC_PACKET_LENGTH).toBe(102);
    expect(packet.toString("hex")).toBe(`${"ff".repeat(6)}${"020000aabb0c".repeat(16)}`);
  });

  it.each(["", "02:00:00:00:00", "02-00-00-00-00-01", "02:00:00:00:00:0g", "02:00:00:00:00:01:02"])(
    "refuses %j, which is no MAC address",
    (mac) => {
      expect(() => magicPacket(mac)).toThrow(`"${mac}" is not a MAC address`);
    },
  );

  it("is read back as the MAC address it wakes, lower case", () => {
    expect(magicPacketTarget(magicPacket("02:00:00:AA:BB:CC"))).toBe("02:00:00:aa:bb:cc");
  });

  it("is told apart from anything else", () => {
    const good = magicPacket("02:00:00:aa:bb:cc");
    const badStart = Buffer.from(good);
    badStart[0] = 0xfe;
    const badCopy = Buffer.from(good);
    badCopy[101] = 0xcd;

    for (const packet of [
      Buffer.from("hello"),
      good.subarray(0, 101),
      Buffer.concat([good, Buffer.of(0)]),
      badStart,
      badCopy,
    ]) {
      expect(magicPacketTarget(packet)).toBeUndefined();
    }
  });
});

describe("where a magic packet is broadcast", () => {
  const ethernet = (address: string, netmask: string): NetworkInterfaceInfo => ({
    address,
    netmask,
    family: "IPv4",
    mac: "02:00:00:00:00:ff",
    internal: false,
    cidr: null,
  });
  const interfaces = {
    lo: [{ ...ethernet("127.0.0.1", "255.0.0.0"), internal: true }],
    eth0: [ethernet("192.168.1.5", "255.255.255.0")],
    eth1: [ethernet("10.20.0.7", "255.255.0.0")],
  };

  it("is the broadcast address of the Hub's interface on the TV's subnet", () => {
    expect(broadcastAddressFor("192.168.1.20", interfaces)).toBe("192.168.1.255");
    expect(broadcastAddressFor("10.20.30.40", interfaces)).toBe("10.20.255.255");
  });

  it("is the limited broadcast address for a TV on no subnet of the Hub's, or with an IPv6 address", () => {
    expect(broadcastAddressFor("192.168.2.20", interfaces)).toBe("255.255.255.255");
    expect(broadcastAddressFor("127.0.0.2", interfaces)).toBe("255.255.255.255");
    expect(broadcastAddressFor("fe80::1", interfaces)).toBe("255.255.255.255");
  });
});

describe("sending a magic packet", () => {
  it("sends one, and only one, to the address and port it is given", async () => {
    const listener = createSocket({ type: "udp4" });
    const heard: Buffer[] = [];
    listener.on("message", (data) => heard.push(data));
    await new Promise<void>((resolve) => listener.bind(0, "127.0.0.1", resolve));

    try {
      await sendMagicPacket("02:00:00:aa:bb:cc", { host: "127.0.0.1", port: listener.address().port });

      await expect.poll(() => heard.length).toBe(1);
      expect(heard[0]?.equals(magicPacket("02:00:00:aa:bb:cc"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(resolve));
    }
  });

  it("rejects when it can't be sent", async () => {
    await expect(sendMagicPacket("02:00:00:aa:bb:cc", { host: "127.0.0.1", port: 0 })).rejects.toThrow();
  });
});
