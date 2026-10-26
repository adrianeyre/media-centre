import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { reverse } from "node:dns/promises";

import type { NetworkDevice, NetworkScan, OpenPort } from "@media-centre/shared";

import type { ApplianceStore } from "./appliances.ts";
import type { ListeningPorts } from "./drivers/driver.ts";
import type { HubAddressStore, NetworkInterfaces } from "./hub-address.ts";
import { networkDeviceKey, type NetworkDeviceStore } from "./network-devices.ts";
import type { RoomStore } from "./rooms.ts";

/**
 * The ports a scan checks on each device it finds, and what usually listens
 * on each: those a home's devices are known by, from a NAS's to a phone's.
 * Each Driver adds its own Appliances' ports, which only it knows.
 */
export const COMMON_PORTS: ReadonlyMap<number, string> = new Map([
  [21, "FTP"],
  [22, "SSH"],
  [23, "Telnet"],
  [25, "SMTP"],
  [53, "DNS"],
  [80, "HTTP"],
  [110, "POP3"],
  [111, "RPC"],
  [135, "Windows RPC"],
  [139, "NetBIOS"],
  [143, "IMAP"],
  [443, "HTTPS"],
  [445, "SMB file sharing"],
  [548, "AFP file sharing"],
  [554, "RTSP streaming"],
  [631, "IPP printing"],
  [1400, "Sonos"],
  [1883, "MQTT"],
  [2049, "NFS"],
  [3000, "Web app"],
  [3306, "MySQL"],
  [3389, "Remote Desktop"],
  [5000, "Synology DSM / AirPlay"],
  [5001, "Synology (HTTPS)"],
  [5357, "Web Services for Devices"],
  [5900, "VNC"],
  [6466, "Android TV remote"],
  [6467, "Android TV pairing"],
  [7000, "AirPlay"],
  [8008, "Google Cast"],
  [8009, "Google Cast"],
  [8060, "Roku"],
  [8080, "HTTP (alternative)"],
  [8123, "Home Assistant"],
  [8443, "HTTPS (alternative)"],
  [8883, "MQTT (TLS)"],
  [9100, "Printing (raw)"],
  [32400, "Plex"],
  [41080, "media-centre Hub"],
  [49152, "Universal Plug and Play"],
  [55443, "Yeelight"],
  [62078, "iPhone / iPad sync"],
]);

/**
 * The ports a scan first knocks on at every address, to find which have a
 * device: one that answers on any of them, open or refusing, is there.
 */
export const KNOCK_PORTS: readonly number[] = [80, 443, 22, 445, 139, 135, 554, 7000, 8008, 8080, 62078];

/** What a device did when the Hub tried a port: accepted, refused, which says it is there, or said nothing. */
export type PortAnswer = "open" | "closed" | "silent";

/** Tries one TCP port, and says how it answered and how long it took. */
export type ProbePort = (host: string, port: number, timeoutMs: number) => Promise<{ answer: PortAnswer; ms: number }>;

export const probePort: ProbePort = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const started = performance.now();
    const socket = new Socket();
    const done = (answer: PortAnswer): void => {
      socket.destroy();
      resolve({ answer, ms: Math.round(performance.now() - started) });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      done("open");
    });
    socket.once("timeout", () => {
      done("silent");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(error.code === "ECONNREFUSED" || error.code === "ECONNRESET" ? "closed" : "silent");
    });
    socket.connect(port, host);
  });

/** The MAC address the Hub's machine has for each address it has talked to, lower case with colons. */
export type Neighbours = () => Promise<ReadonlyMap<string, string>>;

const MAC = /\b((?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})\b/i;
const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

/** A MAC address as the Hub writes it, e.g. `04:70:56:a5:ea:4c`, from `4-70-56-A5-EA-4C` or the like. */
export const normaliseMac = (mac: string): string =>
  mac
    .toLowerCase()
    .split(/[:-]/)
    .map((part) => part.padStart(2, "0"))
    .join(":");

/** Whether it is a MAC address no single device has: broadcast, multicast, or none yet. */
const isNoDevice = (mac: string): boolean =>
  mac === "ff:ff:ff:ff:ff:ff" || mac === "00:00:00:00:00:00" || (Number.parseInt(mac.slice(0, 2), 16) & 1) === 1;

/**
 * The addresses and MAC addresses in an ARP table, as Linux's
 * `/proc/net/arp`, or `arp -a` on Windows or macOS, lists them.
 */
export const neighboursIn = (table: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const line of table.split(/\r?\n/)) {
    const address = IPV4.exec(line)?.[1];
    const mac = MAC.exec(line)?.[1];
    if (address === undefined || mac === undefined || isIP(address) !== 4) continue;
    const normalised = normaliseMac(mac);
    if (!isNoDevice(normalised)) found.set(address, normalised);
  }
  return found;
};

const run = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? stdout : "");
    });
  });

/** The Hub's machine's ARP table: Linux's `/proc/net/arp`, or `arp -a` elsewhere. Empty where it can't read it. */
export const readNeighbours: Neighbours = async () => {
  const table = await readFile("/proc/net/arp", "utf8").catch(() => run("arp", ["-a"]));
  return neighboursIn(table);
};

/** Whether a MAC address is one a device made up, rather than its maker's, as its locally administered bit says. */
export const isPrivateMac = (mac: string): boolean => (Number.parseInt(mac.slice(0, 2), 16) & 2) === 2;

let registry: Readonly<Record<string, string>> | undefined;

/** Who made the network card with this MAC address, from the IEEE's registry, or null where it doesn't say. */
export const vendorOf = (mac: string): string | null => {
  if (isPrivateMac(mac)) return null;
  // Loaded once it is first needed, as it is a few megabytes.
  registry ??= createRequire(import.meta.url)("oui-data") as Record<string, string>;
  const entry = registry[mac.replaceAll(":", "").slice(0, 6).toUpperCase()];
  return entry?.split("\n")[0]?.trim() || null;
};

/** The name the network's DNS gives an address, or null. */
export type LookUpName = (address: string) => Promise<string | null>;

/**
 * The first name reverse DNS gives, within a second and a half, unless it is
 * only the address written out, as a VPN's DNS names every address.
 */
export const lookUpName: LookUpName = async (address) => {
  const timeout = new Promise<string[]>((resolve) =>
    setTimeout(() => {
      resolve([]);
    }, 1_500).unref(),
  );
  const names = await Promise.race([reverse(address).catch(() => []), timeout]);
  const name = names[0];
  if (name === undefined) return null;
  return name.includes(address.replaceAll(".", "-")) || name.includes(address) ? null : name;
};

/** Runs `work` on each of `items`, `limit` at a time. */
const eachLimited = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

const byAddress = (a: string, b: string): number => {
  const [left, right] = [a, b].map((address) => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0));
  return (left ?? 0) - (right ?? 0);
};

export interface NetworkScannerOptions {
  /**
   * The addresses to scan. By default, every address of the Hub's own /24
   * subnet, which a home network's is. Only tests against the fakes change it.
   */
  readonly targets?: readonly string[];
  /** What listens on each port beyond {@link COMMON_PORTS}: each Driver's {@link ListeningPorts}. */
  readonly services?: ListeningPorts;
  /** The ports a scan checks on each device it finds. By default, those {@link COMMON_PORTS} and `services` name. */
  readonly ports?: readonly number[];
  /** The ports it knocks on first. By default, {@link KNOCK_PORTS}. */
  readonly knockPorts?: readonly number[];
  /** The ports "Check every port" checks. By default, 1 to 65535. */
  readonly allPorts?: { readonly from: number; readonly to: number };
  /** How long a port has to answer. By default, 800 ms. */
  readonly timeoutMs?: number;
  /** How many ports it tries at once. By default, 256. */
  readonly concurrency?: number;
  readonly probe?: ProbePort;
  readonly neighbours?: Neighbours;
  readonly lookUpName?: LookUpName;
  /** The Hub's network interfaces, for its own MAC address, which its ARP table hasn't. */
  readonly interfaces?: NetworkInterfaces;
  /** Where it writes what it did. By default, the Hub's log. */
  readonly log?: (line: string) => void;
}

export interface NetworkScanner {
  /** The last scan, or the one under way. */
  readonly read: () => NetworkScan;
  /** Starts a scan, unless one is under way, and answers at once. */
  readonly scan: () => NetworkScan;
  /**
   * Starts checking every port of a device found, and answers at once; or
   * undefined for an address not found. The ports it finds open are
   * remembered, and every scan after checks them too.
   */
  readonly checkAllPorts: (address: string) => NetworkScan | undefined;
  /**
   * Names a device found, or forgets its name given null; or undefined for
   * an address not found. Refuses a name too long, as the store does.
   */
  readonly setName: (address: string, name: string | null) => NetworkScan | undefined;
  /**
   * Puts a device found in a Room, or in "No room" given null; or undefined
   * for an address not found. A device that is an Appliance is moved, as in
   * Settings, which may refuse as the Appliances do; a Room deleted is
   * refused as the store refuses it.
   */
  readonly setRoom: (address: string, roomId: number | null) => NetworkScan | undefined;
  /** Resolves once every scan and check under way has ended. For tests. */
  readonly settled: () => Promise<void>;
}

/** A scan as the Hub keeps it, in its database, between restarts. */
interface SavedScan {
  readonly subnet: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly devices: readonly {
    readonly address: string;
    readonly macAddress: string | null;
    readonly hostname: string | null;
    readonly open: readonly number[];
    readonly responseMs: number | null;
    readonly remembered: number;
  }[];
}

const nullableText = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The scan kept, read as no more than it is, or undefined for what isn't one, as from an older Hub. */
const savedScanIn = (value: unknown): SavedScan | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const scan = value as Record<string, unknown>;
  if (!Array.isArray(scan.devices)) return undefined;
  return {
    subnet: nullableText(scan.subnet),
    startedAt: nullableText(scan.startedAt),
    finishedAt: nullableText(scan.finishedAt),
    devices: scan.devices
      .filter((each): each is Record<string, unknown> => typeof each === "object" && each !== null)
      .filter((each) => typeof each.address === "string" && isIP(each.address) === 4)
      .map((each) => ({
        address: String(each.address),
        macAddress: nullableText(each.macAddress),
        hostname: nullableText(each.hostname),
        open: Array.isArray(each.open) ? each.open.filter((port): port is number => Number.isInteger(port)) : [],
        responseMs: typeof each.responseMs === "number" ? each.responseMs : null,
        remembered: typeof each.remembered === "number" ? each.remembered : 0,
      })),
  };
};

/** What the scanner holds of a device, before the Hub's Appliances and own address are added for the Remote. */
interface Found {
  readonly address: string;
  macAddress: string | null;
  hostname: string | null;
  readonly open: Set<number>;
  responseMs: number | null;
  allPorts: { checked: number; total: number; done: boolean } | null;
  /** How many ports beyond the common ones it checked, as found open on it before by checking every port. */
  remembered: number;
}

/**
 * Finds the devices on the home network, for the Network tab: it knocks on a
 * few ports at every address of the Hub's subnet, as a device that accepts
 * or refuses a connection is there, adds every address the Hub's machine's
 * ARP table has, then checks each device found for the common ports, and
 * asks DNS its name, and the IEEE's registry, offline, who made it. Only on
 * asking does it check every port of one device. It keeps the last scan only
 * while the Hub runs.
 */
export const networkScanner = (
  {
    appliances,
    rooms,
    hubAddress,
    devices,
  }: {
    readonly appliances: ApplianceStore;
    readonly rooms: RoomStore;
    readonly hubAddress: HubAddressStore;
    readonly devices: NetworkDeviceStore;
  },
  {
    targets,
    services = new Map(),
    ports = [...new Set([...COMMON_PORTS.keys(), ...services.keys()])].toSorted((a, b) => a - b),
    knockPorts = KNOCK_PORTS,
    allPorts = { from: 1, to: 65_535 },
    timeoutMs = 800,
    concurrency = 256,
    probe = probePort,
    neighbours = readNeighbours,
    lookUpName: nameOf = lookUpName,
    interfaces = networkInterfaces,
    log = console.log,
  }: NetworkScannerOptions = {},
): NetworkScanner => {
  // The last scan, as the Hub kept it, so the Network tab shows it after a restart without scanning again.
  const kept = savedScanIn(devices.lastScan("network"));
  let subnet: string | null = kept?.subnet ?? null;
  let scanning = false;
  let checked = kept?.devices.length ?? 0;
  let total = kept?.devices.length ?? 0;
  let startedAt: string | null = kept?.startedAt ?? null;
  let finishedAt: string | null = kept?.finishedAt ?? null;
  let found = new Map<string, Found>(
    kept?.devices.map((device) => [
      device.address,
      {
        address: device.address,
        macAddress: device.macAddress,
        hostname: device.hostname,
        open: new Set(device.open),
        responseMs: device.responseMs,
        allPorts: null,
        remembered: device.remembered,
      },
    ]) ?? [],
  );
  const working = new Set<Promise<void>>();

  /** Keeps the scan as it is now, for after a restart. */
  const keep = (): void => {
    const saved: SavedScan = {
      subnet,
      startedAt,
      finishedAt,
      devices: [...found.values()].map((device) => ({
        address: device.address,
        macAddress: device.macAddress,
        hostname: device.hostname,
        open: [...device.open],
        responseMs: device.responseMs,
        remembered: device.remembered,
      })),
    };
    devices.keepScan("network", saved);
  };

  const track = (work: Promise<void>): void => {
    const tracked = work
      .catch((error: unknown) => {
        console.error("The network scan failed", error);
      })
      .finally(() => working.delete(tracked));
    working.add(tracked);
  };

  /** The addresses to scan, and how to say them, or undefined where the Hub has no address. */
  const toScan = (): { readonly label: string; readonly addresses: readonly string[] } | undefined => {
    if (targets !== undefined) return { label: targets.join(", "), addresses: targets };
    const own = hubAddress.read().address;
    if (own === null) return undefined;
    const base = own.split(".").slice(0, 3).join(".");
    return {
      label: `${base}.0/24`,
      addresses: Array.from({ length: 254 }, (_, index) => `${base}.${String(index + 1)}`),
    };
  };

  const heard = (device: Found, answer: PortAnswer, ms: number, port: number): void => {
    if (answer === "silent") return;
    if (answer === "open") device.open.add(port);
    device.responseMs = device.responseMs === null ? ms : Math.min(device.responseMs, ms);
  };

  const keyOf = (device: Found) => networkDeviceKey(device.address, device.macAddress);

  const ownMac = (address: string): string | null => {
    for (const each of Object.values(interfaces())) {
      const match = each?.find((info) => info.family === "IPv4" && info.address === address);
      if (match !== undefined && match.mac !== "00:00:00:00:00:00") return normaliseMac(match.mac);
    }
    return null;
  };

  const runScan = async (addresses: readonly string[]): Promise<void> => {
    const next = new Map<string, Found>();
    const deviceAt = (address: string): Found => {
      let device = next.get(address);
      if (device === undefined) {
        device = {
          address,
          macAddress: null,
          hostname: null,
          open: new Set(),
          responseMs: null,
          allPorts: null,
          remembered: 0,
        };
        next.set(address, device);
      }
      return device;
    };

    // Knocking: an address is done once any port answers, or none does.
    total = addresses.length;
    await eachLimited(addresses, Math.max(1, Math.floor(concurrency / knockPorts.length)), async (address) => {
      const answers = await Promise.all(
        knockPorts.map(async (port) => ({ port, ...(await probe(address, port, timeoutMs)) })),
      );
      const answered = answers.filter(({ answer }) => answer !== "silent");
      if (answered.length > 0) {
        const device = deviceAt(address);
        for (const { port, answer, ms } of answered) heard(device, answer, ms, port);
      }
      checked += 1;
    });

    // Whatever answered the Hub's machine's ARP, as knocking makes it ask each address.
    const wanted = new Set(addresses);
    for (const [address, mac] of await neighbours()) {
      if (wanted.has(address)) deviceAt(address).macAddress = mac;
    }
    for (const device of next.values()) device.macAddress ??= ownMac(device.address);

    // Each device's common ports, beyond those it knocked on, and its name.
    // Each device's common ports, and those found open on it before, beyond those it knocked on.
    const rest = ports.filter((port) => !knockPorts.includes(port));
    const tries = [...next.values()].flatMap((device) => {
      const remembered = devices
        .openPortsOf(keyOf(device))
        .filter((port) => !rest.includes(port) && !knockPorts.includes(port));
      device.remembered = remembered.length;
      return [...rest, ...remembered].map((port) => ({ device, port }));
    });
    await Promise.all([
      eachLimited(tries, concurrency, async ({ device, port }) => {
        const { answer, ms } = await probe(device.address, port, timeoutMs);
        heard(device, answer, ms, port);
      }),
      ...[...next.values()].map(async (device) => {
        device.hostname = await nameOf(device.address);
      }),
    ]);
    found = next;
  };

  const applianceAt = (address: string) => appliances.list().find((each) => each.address === address);

  /** What a device is called but for its own name, as the Remote calls it too. */
  const labelOf = (device: Found, hub: string | null): string => {
    const vendor = device.macAddress === null ? null : vendorOf(device.macAddress);
    return (
      applianceAt(device.address)?.name ??
      device.hostname ??
      (device.address === hub ? "This Hub" : null) ??
      vendor ??
      (device.macAddress !== null && isPrivateMac(device.macAddress)
        ? "A device with a private address"
        : "Unknown device")
    );
  };

  /** Keeps what the scan saw a device as, for the Rooms tab, if the Hub keeps anything of it. */
  const sawIt = (device: Found, hub: string | null): void => {
    devices.saw(keyOf(device), {
      address: device.address,
      label: labelOf(device, hub),
      maker: device.macAddress === null ? null : vendorOf(device.macAddress),
    });
  };

  const describe = (device: Found, hub: string | null): NetworkDevice => {
    const appliance = applianceAt(device.address);
    const allRooms = rooms.list();
    const room = appliance?.roomId === null ? null : allRooms.find((each) => each.id === appliance?.roomId);
    const roomId = appliance === undefined ? devices.roomOf(keyOf(device)) : appliance.roomId;
    const inRoom = allRooms.find((each) => each.id === roomId);
    const openPorts: OpenPort[] = [...device.open]
      .toSorted((a, b) => a - b)
      .map((port) => ({ port, service: services.get(port) ?? COMMON_PORTS.get(port) ?? null }));
    return {
      address: device.address,
      name: devices.nameOf(keyOf(device)),
      room: inRoom === undefined ? null : { id: inRoom.id, name: inRoom.name },
      macAddress: device.macAddress,
      vendor: device.macAddress === null ? null : vendorOf(device.macAddress),
      privateMacAddress: device.macAddress !== null && isPrivateMac(device.macAddress),
      hostname: device.hostname,
      isHub: device.address === hub,
      appliance:
        appliance === undefined
          ? null
          : { id: appliance.id, kind: appliance.kind, name: appliance.name, room: room?.name ?? null },
      openPorts,
      responseMs: device.responseMs,
      portCheck:
        device.allPorts === null
          ? { kind: "common", ports: ports.length, remembered: device.remembered }
          : { kind: "all", ...device.allPorts },
    };
  };

  const read = (): NetworkScan => {
    const hub = hubAddress.read().address;
    return {
      subnet,
      scanning,
      checked,
      total,
      startedAt,
      finishedAt,
      devices: [...found.values()]
        .toSorted((a, b) => byAddress(a.address, b.address))
        .map((device) => describe(device, hub)),
    };
  };

  return {
    read,

    scan: () => {
      if (scanning) return read();
      const plan = toScan();
      if (plan === undefined) {
        log("The Hub has no IP address on the home network, so can't scan it");
        return read();
      }
      subnet = plan.label;
      scanning = true;
      checked = 0;
      total = plan.addresses.length;
      startedAt = new Date().toISOString();
      finishedAt = null;
      log(`Scanning the network, ${plan.label}`);
      track(
        runScan(plan.addresses).finally(() => {
          scanning = false;
          finishedAt = new Date().toISOString();
          const hub = hubAddress.read().address;
          for (const device of found.values()) sawIt(device, hub);
          keep();
          log(`Scanned the network, ${plan.label}, and found ${String(found.size)} devices`);
        }),
      );
      return read();
    },

    checkAllPorts: (address) => {
      const device = found.get(address);
      if (device === undefined) return undefined;
      if (device.allPorts !== null && !device.allPorts.done) return read();
      const every = Array.from({ length: allPorts.to - allPorts.from + 1 }, (_, index) => allPorts.from + index);
      const progress = { checked: 0, total: every.length, done: false };
      device.allPorts = progress;
      log(`Checking every port of ${address}`);
      track(
        eachLimited(every, concurrency, async (port) => {
          const { answer, ms } = await probe(address, port, timeoutMs);
          heard(device, answer, ms, port);
          progress.checked += 1;
        }).finally(() => {
          progress.done = true;
          devices.rememberOpenPorts(keyOf(device), device.open);
          keep();
          log(`Checked every port of ${address}: ${String(device.open.size)} open`);
        }),
      );
      return read();
    },

    setName: (address, name) => {
      const device = found.get(address);
      if (device === undefined) return undefined;
      devices.setName(keyOf(device), name);
      sawIt(device, hubAddress.read().address);
      return read();
    },

    setRoom: (address, roomId) => {
      const device = found.get(address);
      if (device === undefined) return undefined;
      const appliance = applianceAt(address);
      if (appliance === undefined) {
        devices.setRoom(keyOf(device), roomId);
        sawIt(device, hubAddress.read().address);
      } else {
        appliances.update(appliance.id, { roomId });
      }
      return read();
    },

    settled: async () => {
      while (working.size > 0) await Promise.all(working);
    },
  };
};
