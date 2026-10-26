/**
 * The Midea Driver's search for Air Conditioners (FR-51): a UDP packet
 * broadcast to ports 6445 and 20086, which every Midea Wi-Fi module on the
 * subnet answers with its id, its serial number, its name, its type and, by
 * how its answer is wrapped, its protocol version, encrypted under the same
 * app key as v2's frames. A broadcast doesn't cross routers, so it only finds
 * units on the Hub's own subnet (FR-2, ADR 0007). Only the Driver and the
 * fake Midea Air Conditioner know this (NFR-6).
 *
 * The layout is msmart-ng's reading of a unit's answer: the open-source
 * libraries agree on the id, the serial number and the name, and read the type
 * from the name, which is the module's own Wi-Fi network's, e.g.
 * `net_ac_63BA` for an Air Conditioner.
 */
import { createSocket, type RemoteInfo } from "node:dgram";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { AIR_CONDITIONER_TYPE } from "./frames.ts";
import { decodeV2Packet, encodeV2Packet, isV3Packet } from "./lan-packets.ts";

/** Where a search goes: a unit answers on one or the other, depending on its module. */
export const MIDEA_DISCOVERY_PORTS: readonly number[] = [6445, 20_086];

/** Where a search goes on a home network: everything on the subnet hears a broadcast. */
export const BROADCAST_ADDRESS = "255.255.255.255";

/** An IPv4 address, as a number. */
const ipv4Number = (address: string): number =>
  address.split(".").reduce((number, part) => number * 256 + Number(part), 0);

const ipv4Text = (number: number): string =>
  [24, 16, 8, 0].map((shift) => String(Math.floor(number / 2 ** shift) % 256)).join(".");

/**
 * Where a search goes on a host with these network interfaces: the
 * broadcast address, which a host with more than one, such as a PC with a
 * VPN or virtual machines, sends out of only one of them, maybe not the home
 * network's; and each IPv4 interface's own subnet's broadcast address, which
 * goes out of that one. A loopback interface, or one with a subnet of one or
 * two addresses, as a VPN's often is, has no broadcast to send to.
 */
export const broadcastAddresses = (
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>> = networkInterfaces(),
): string[] => {
  const addresses = new Set([BROADCAST_ADDRESS]);
  for (const each of Object.values(interfaces).flat()) {
    if (each?.family !== "IPv4" || each.internal) continue;
    const mask = ipv4Number(each.netmask);
    if (mask >= ipv4Number("255.255.255.254")) continue;
    // Every bit the mask leaves out set, in the interface's own subnet.
    addresses.add(
      ipv4Text(ipv4Number(each.address) - (ipv4Number(each.address) % (2 ** 32 - mask)) + (2 ** 32 - mask - 1)),
    );
  }
  return [...addresses];
};

/** Where to send a search: the broadcast address, or one unit's own address. */
export interface DiscoveryTarget {
  readonly host: string;
  readonly port: number;
}

/** The search itself, as every open-source library sends it, byte for byte. */
export const DISCOVERY_REQUEST = Buffer.from([
  0x5a, 0x5a, 0x01, 0x11, 0x48, 0x00, 0x92, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x7f, 0x75, 0xbd, 0x6b, 0x3e, 0x4f, 0x8b, 0x76, 0x2e, 0x84, 0x9c, 0x6e, 0x57, 0x8d, 0x65, 0x90, 0x03,
  0x6e, 0x9d, 0x43, 0x42, 0xa5, 0x0f, 0x1f, 0x56, 0x9e, 0xb8, 0xec, 0x91, 0x8e, 0x92, 0xe5,
]);

/** What a unit says of itself, answering a search. */
export interface DiscoveryAnswer {
  /** Its id, which every v2 packet to it carries. 6 bytes. */
  readonly id: number;
  /** Its IP address, as it says it. */
  readonly ip: string;
  /** Its TCP port, 6444. */
  readonly port: number;
  readonly serialNumber: string;
  /** Its module's own Wi-Fi network's name, e.g. `net_ac_63BA`. */
  readonly name: string;
  /** The appliance type, read from the name: 0xAC for an Air Conditioner. */
  readonly type: number;
  readonly version: 2 | 3;
}

const SERIAL_NUMBER_LENGTH = 32;

/**
 * A unit's answer, as a unit writes it: v3 units wrap the v2 packet in a v3
 * header and 16 bytes msmart-ng skips, which say nothing anyone has read.
 */
export const encodeDiscoveryAnswer = (answer: DiscoveryAnswer): Buffer => {
  const name = Buffer.from(answer.name, "ascii");
  const payload = Buffer.concat([
    Buffer.from(answer.ip.split(".").map(Number).reverse()),
    Buffer.alloc(4),
    Buffer.from(answer.serialNumber.padEnd(SERIAL_NUMBER_LENGTH, "0").slice(0, SERIAL_NUMBER_LENGTH), "ascii"),
    Buffer.of(name.length),
    name,
  ]);
  payload.writeUInt32LE(answer.port, 4);
  const packet = encodeV2Packet(payload, answer.id, "unit");
  if (answer.version === 2) return packet;
  const size = packet.length + 16;
  return Buffer.concat([
    Buffer.of(0x83, 0x70, size >> 8, size & 0xff, 0x20, 0),
    Buffer.alloc(2),
    packet,
    Buffer.alloc(16),
  ]);
};

/** Reads a unit's answer to a search, or undefined if it isn't one. */
export const parseDiscoveryAnswer = (data: Uint8Array): DiscoveryAnswer | undefined => {
  const version = isV3Packet(data) ? 3 : 2;
  try {
    const { unitId, frame: payload } = decodeV2Packet(version === 3 ? data.subarray(8, -16) : data);
    const nameLength = payload[40] ?? 0;
    const name = payload.subarray(41, 41 + nameLength).toString("ascii");
    const type = Number.parseInt(name.split("_")[1] ?? "", 16);
    return {
      id: unitId,
      ip: [...payload.subarray(0, 4)].reverse().join("."),
      port: payload.readUInt32LE(4),
      serialNumber: payload.subarray(8, 8 + SERIAL_NUMBER_LENGTH).toString("ascii"),
      name,
      type: Number.isNaN(type) ? 0 : type,
      version,
    };
  } catch {
    return undefined;
  }
};

/** Whether `data` is a search, as a unit reads it. */
export const isDiscoveryRequest = (data: Uint8Array): boolean => DISCOVERY_REQUEST.equals(data);

export interface SearchOptions {
  /** By default, each of {@link broadcastAddresses} on each of {@link MIDEA_DISCOVERY_PORTS}. Tests send to each fake instead. */
  readonly targets?: readonly DiscoveryTarget[];
  /** How long to listen for answers. */
  readonly windowMs: number;
}

/** A unit that answered, and the address it answered from. */
export interface FoundUnit extends DiscoveryAnswer {
  readonly address: string;
}

/**
 * Searches for Midea Air Conditioners and resolves, once `windowMs` has
 * passed, with each that answered, once each, by the address it answered
 * from. Other Midea appliances, such as dehumidifiers, are left out. Rejects
 * if the search can't be sent at all, to any target, e.g. with no network:
 * a target an interface refuses, as a VPN's may a broadcast, isn't that.
 */
export const searchForMideaUnits = ({
  targets = broadcastAddresses().flatMap((host) => MIDEA_DISCOVERY_PORTS.map((port) => ({ host, port }))),
  windowMs,
}: SearchOptions): Promise<FoundUnit[]> =>
  new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4" });
    const found = new Map<string, FoundUnit>();
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error === undefined) resolve([...found.values()]);
      else reject(error);
    };

    socket.on("error", finish);
    socket.on("message", (data: Buffer, from: RemoteInfo) => {
      const answer = parseDiscoveryAnswer(data);
      if (answer?.type !== AIR_CONDITIONER_TYPE || found.has(from.address)) return;
      found.set(from.address, { ...answer, address: from.address });
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      let sending = targets.length;
      let delivered = 0;
      let failure: Error | undefined;
      const sent = (error: Error | null): void => {
        if (error) failure = error;
        else delivered += 1;
        sending -= 1;
        if (sending > 0) return;
        if (delivered === 0) finish(failure ?? new Error("The search had nowhere to go."));
        else timer = setTimeout(finish, windowMs);
      };
      for (const target of targets) {
        try {
          socket.send(DISCOVERY_REQUEST, target.port, target.host, sent);
        } catch (error) {
          sent(error as Error);
        }
      }
    });
  });
