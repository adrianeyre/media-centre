/**
 * Wake-on-LAN: the "magic packet" that switches on an Appliance in standby,
 * whose network card listens for its own MAC address while the rest of it
 * sleeps (FR-17). It is no brand's protocol, so any Driver may use it. It only
 * reaches Appliances on the Hub's own subnet (FR-2, ADR 0007).
 */
import { createSocket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** The port a magic packet is sent to by convention: "discard". The card reads any port. */
export const WAKE_ON_LAN_PORT = 9;

/** Six bytes of 0xff, then the MAC address sixteen times. */
export const MAGIC_PACKET_LENGTH = 6 + 16 * 6;

const MAC_ADDRESS = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

/** The magic packet for `macAddress`, written "02:00:00:aa:bb:cc" in either case. */
export const magicPacket = (macAddress: string): Buffer => {
  const mac = macAddress.toLowerCase();
  if (!MAC_ADDRESS.test(mac)) throw new Error(`"${macAddress}" is not a MAC address`);
  const bytes = Buffer.from(mac.replaceAll(":", ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
};

/** The MAC address a magic packet wakes, lower case, or undefined for anything that isn't one. */
export const magicPacketTarget = (packet: Uint8Array): string | undefined => {
  if (packet.length !== MAGIC_PACKET_LENGTH) return undefined;
  const bytes = Buffer.from(packet);
  if (!bytes.subarray(0, 6).every((byte) => byte === 0xff)) return undefined;
  const mac = bytes.subarray(6, 12);
  for (let copy = 1; copy < 16; copy += 1) {
    if (!bytes.subarray(6 + copy * 6, 12 + copy * 6).equals(mac)) return undefined;
  }
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
};

/** Where a magic packet goes. */
export interface WakeTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Where to broadcast a magic packet for the Appliance at `address`: the
 * broadcast address of the Hub's network interface on the same subnet, so it
 * goes out on that one, even on a NAS with several. With none on that subnet,
 * or for an IPv6 address, it is the limited broadcast address, which goes out
 * on the Hub's default interface.
 */
export const broadcastAddressFor = (
  address: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string => {
  if (!isIPv4(address)) return "255.255.255.255";
  const appliance = ipv4Number(address);
  for (const info of Object.values(interfaces).flat()) {
    if (info === undefined || info.family !== "IPv4" || info.internal) continue;
    const mask = ipv4Number(info.netmask);
    const own = ipv4Number(info.address);
    if ((own & mask) >>> 0 === (appliance & mask) >>> 0) return ipv4Text((own | ~mask) >>> 0);
  }
  return "255.255.255.255";
};

const ipv4Number = (address: string): number =>
  address.split(".").reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0);

const ipv4Text = (number: number): string => [24, 16, 8, 0].map((shift) => String((number >>> shift) & 0xff)).join(".");

/**
 * Sends the magic packet for `macAddress` to `target`, and resolves once it is
 * sent. Nothing answers it: whether the Appliance woke is for its Driver to
 * read afterwards.
 */
export const sendMagicPacket = (macAddress: string, target: WakeTarget): Promise<void> => {
  const packet = magicPacket(macAddress);
  const socket = createSocket({ type: isIPv4(target.host) ? "udp4" : "udp6" });
  return new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, target.port, target.host, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }).finally(() => {
    socket.close();
  });
};
