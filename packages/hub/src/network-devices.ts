import type { DatabaseSync } from "node:sqlite";

import { NETWORK_DEVICE_NAME_MAX_LENGTH, type RoomDevice } from "@media-centre/shared";

import { characters } from "./names.ts";

/** Why the Hub refused a device's name. The message is written for the person using the Remote. */
export class NetworkDeviceNameRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkDeviceNameRefusal";
  }
}

/** The Room asked for has been deleted since the Remote showed it. The message is written for the person. */
export class NetworkDeviceRoomRefusal extends Error {
  constructor(message = "That Room has been deleted. Choose another.") {
    super(message);
    this.name = "NetworkDeviceRoomRefusal";
  }
}

/** Which device it is, for what the Hub keeps of it: by its MAC address, its IP address, or its Bluetooth address. */
export type NetworkDeviceKey =
  `mac:${string}` | `ip:${string}` | `bluetooth:${string}` | `amazon:${string}` | `ring:${string}`;

/** The key of a device on the home network: its MAC address, or, where the Hub has none, its IP address. */
export const networkDeviceKey = (address: string, macAddress: string | null): NetworkDeviceKey =>
  macAddress === null ? `ip:${address}` : `mac:${macAddress}`;

export interface NetworkDeviceStore {
  /** What the person named the device, or null. */
  readonly nameOf: (key: NetworkDeviceKey) => string | null;
  /**
   * Names it, or forgets its name given null or only spaces. Refuses, with a
   * {@link NetworkDeviceNameRefusal}, a name too long. Returns the name kept.
   */
  readonly setName: (key: NetworkDeviceKey, name: string | null) => string | null;
  /** The ports found open on it by checking every port, lowest first. */
  readonly openPortsOf: (key: NetworkDeviceKey) => number[];
  /** Remembers these ports as open on it, as well as those before. */
  readonly rememberOpenPorts: (key: NetworkDeviceKey, ports: Iterable<number>) => void;
  /** The id of the Room it is in, or null for "No room". */
  readonly roomOf: (key: NetworkDeviceKey) => number | null;
  /** Puts it in the Room, or in "No room" given null. Refuses, with a {@link NetworkDeviceRoomRefusal}, a Room deleted. */
  readonly setRoom: (key: NetworkDeviceKey, roomId: number | null) => void;
  /** Keeps what a scan saw it as, if the Hub keeps anything of it, for the Rooms tab to show it by. */
  readonly saw: (key: NetworkDeviceKey, seen: SeenAs) => void;
  /** Every device in a Room, by title. */
  readonly inRooms: () => RoomDevice[];
  /** The last scan of this kind, as it was kept, or undefined. */
  readonly lastScan: (kind: "network" | "bluetooth") => unknown;
  /** Keeps the last scan of this kind, so it is shown after a restart. */
  readonly keepScan: (kind: "network" | "bluetooth", scan: unknown) => void;
}

/** What a scan saw a device as: its address, what it is called but for its own name, and who made it. */
export interface SeenAs {
  /** Its IP or Bluetooth address, or null for an Echo, which the Hub reaches through Amazon. */
  readonly address: string | null;
  readonly label: string;
  readonly maker: string | null;
}

const portsIn = (json: string | undefined): number[] => {
  if (json === undefined) return [];
  const read = JSON.parse(json) as unknown;
  return Array.isArray(read) ? read.filter((each): each is number => Number.isInteger(each)) : [];
};

/** What the Hub keeps of each device on the network, in its database, so it survives a restart (NFR-4). */
export const networkDeviceStore = (database: DatabaseSync): NetworkDeviceStore => {
  const row = (key: NetworkDeviceKey) =>
    database.prepare("SELECT name, open_ports, room_id FROM network_device WHERE key = ?").get(key) as
      { name: string | null; open_ports: string; room_id: number | null } | undefined;

  return {
    nameOf: (key) => row(key)?.name ?? null,

    setName: (key, asked) => {
      const name = asked?.trim() ?? "";
      if (characters(name) > NETWORK_DEVICE_NAME_MAX_LENGTH) {
        throw new NetworkDeviceNameRefusal(
          `A device's name is at most ${String(NETWORK_DEVICE_NAME_MAX_LENGTH)} characters.`,
        );
      }
      const kept = name === "" ? null : name;
      database
        .prepare(
          "INSERT INTO network_device (key, name) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name",
        )
        .run(key, kept);
      return kept;
    },

    openPortsOf: (key) => portsIn(row(key)?.open_ports),

    rememberOpenPorts: (key, ports) => {
      const all = [...new Set([...portsIn(row(key)?.open_ports), ...ports])].toSorted((a, b) => a - b);
      database
        .prepare(
          "INSERT INTO network_device (key, open_ports) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET open_ports = excluded.open_ports",
        )
        .run(key, JSON.stringify(all));
    },

    roomOf: (key) => row(key)?.room_id ?? null,

    setRoom: (key, roomId) => {
      if (roomId !== null && database.prepare("SELECT 1 FROM room WHERE id = ?").get(roomId) === undefined) {
        throw new NetworkDeviceRoomRefusal();
      }
      database
        .prepare(
          "INSERT INTO network_device (key, room_id) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET room_id = excluded.room_id",
        )
        .run(key, roomId);
    },

    saw: (key, { address, label, maker }) => {
      database
        .prepare("UPDATE network_device SET address = ?, label = ?, maker = ? WHERE key = ?")
        .run(address, label, maker, key);
    },

    inRooms: () =>
      (
        database
          .prepare("SELECT key, name, room_id, address, label, maker FROM network_device WHERE room_id IS NOT NULL")
          .all() as {
          key: NetworkDeviceKey;
          name: string | null;
          room_id: number;
          address: string | null;
          label: string | null;
          maker: string | null;
        }[]
      )
        .map((row): RoomDevice => ({
          key: row.key,
          kind: row.key.startsWith("bluetooth:")
            ? "bluetooth"
            : row.key.startsWith("amazon:")
              ? "amazon"
              : row.key.startsWith("ring:")
                ? "ring"
                : "network",
          roomId: row.room_id,
          title: row.name ?? row.label ?? row.address ?? "A device",
          address: row.address,
          maker: row.maker,
        }))
        .toSorted((a, b) => a.title.localeCompare(b.title)),

    lastScan: (kind) => {
      const row = database.prepare("SELECT scan FROM network_scan WHERE kind = ?").get(kind) as
        { scan: string } | undefined;
      if (row === undefined) return undefined;
      try {
        return JSON.parse(row.scan) as unknown;
      } catch {
        return undefined;
      }
    },

    keepScan: (kind, scan) => {
      database
        .prepare(
          "INSERT INTO network_scan (kind, scan) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET scan = excluded.scan",
        )
        .run(kind, JSON.stringify(scan));
    },
  };
};
