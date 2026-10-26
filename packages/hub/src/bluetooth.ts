import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BluetoothDevice, BluetoothScan, BluetoothService } from "@media-centre/shared";

import { runCommand, type RunCommand } from "./commands.ts";
import { isPrivateMac, vendorOf } from "./network.ts";
import type { NetworkDeviceStore } from "./network-devices.ts";
import type { RoomStore } from "./rooms.ts";

/** What one advertisement said: who sent it, how strongly it was heard, and what it says of itself. */
export interface Advert {
  /** Lower case, with colons. */
  readonly address: string;
  readonly randomAddress: boolean;
  readonly signal: number;
  readonly name: string | null;
  /** The company ids it names, as 4 lower-case hex digits. */
  readonly companies: readonly string[];
  readonly uuids: readonly string[];
}

/** A line the helper writes: an advertisement, Windows stopping it with why, or the end of its listening. */
export type WatchLine =
  | { readonly kind: "advert"; readonly advert: Advert }
  | { readonly kind: "stopped"; readonly why: string }
  | { readonly kind: "done" };

/** Reads a line `ble-watch.cs` writes, or undefined for one it doesn't. */
export const watchLineIn = (line: string): WatchLine | undefined => {
  const [kind, ...parts] = line.trimEnd().split("\t");
  if (kind === "DONE") return { kind: "done" };
  if (kind === "STOPPED") return { kind: "stopped", why: parts[0] ?? "" };
  if (kind !== "ADVERT") return undefined;
  const [hex = "", type = "", signal = "", name = "", companies = "", uuids = ""] = parts;
  if (!/^[0-9a-f]{12}$/i.test(hex) || !/^-?\d+$/.test(signal) || !/^(?:[0-9a-f]{2})*$/i.test(name)) return undefined;
  const text = Buffer.from(name, "hex").toString("utf8").trim();
  return {
    kind: "advert",
    advert: {
      address: hex.toLowerCase().replace(/(..)(?!$)/g, "$1:"),
      randomAddress: type === "1",
      signal: Number(signal),
      name: text === "" ? null : text,
      companies: companies === "" ? [] : companies.toLowerCase().split(","),
      uuids: uuids === "" ? [] : uuids.toLowerCase().split(","),
    },
  };
};

/** Listens for `seconds`, telling `heard` each line the helper writes, and resolves once it has ended. */
export type BluetoothWatch = (seconds: number, heard: (line: WatchLine) => void) => Promise<void>;

/** Why the Hub couldn't listen, written for the person. */
export class BluetoothUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BluetoothUnavailable";
  }
}

/** Runs a program, or a Node script with the Node running the Hub, telling `heard` each line it writes. */
const runLines = (program: string, args: readonly string[], heard: (line: WatchLine) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const script = /\.[cm]?[jt]s$/.test(program);
    const child = spawn(script ? process.execPath : program, script ? [program, ...args] : args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let pending = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const read = watchLineIn(line);
        if (read !== undefined) heard(read);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      reject(new BluetoothUnavailable("The Hub couldn't start listening for Bluetooth devices.", { cause: error }));
    });
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else
        reject(
          new BluetoothUnavailable(
            `Listening for Bluetooth devices failed${errors.trim() === "" ? "" : `: ${errors.trim().split(/\r?\n/)[0] ?? ""}`}.`,
          ),
        );
    });
  });

/** Where `ble-watch.cs` is, which the Hub compiles into the helper it runs. */
const HELPER_SOURCE = join(import.meta.dirname, "bluetooth", "ble-watch.cs");

/**
 * Compiles `ble-watch.cs` with the C# compiler every Windows has, from .NET
 * Framework 4, against Windows' own Bluetooth API, into the system's
 * temporary folder, once for each version of it, and answers where it is.
 */
export const compileHelper = async (run: RunCommand = runCommand): Promise<string> => {
  const source = readFileSync(HELPER_SOURCE);
  const helper = join(
    tmpdir(),
    `media-centre-ble-watch-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.exe`,
  );
  if (existsSync(helper)) return helper;
  const windows = process.env.WINDIR ?? "C:\\Windows";
  const framework = join(windows, "Microsoft.NET", "Framework64", "v4.0.30319");
  const metadata = join(windows, "System32", "WinMetadata");
  const references = [
    join(metadata, "Windows.Devices.winmd"),
    join(metadata, "Windows.Foundation.winmd"),
    join(framework, "System.Runtime.WindowsRuntime.dll"),
    join(framework, "System.Runtime.InteropServices.WindowsRuntime.dll"),
    join(framework, "System.Runtime.dll"),
  ];
  const compiled = await run(
    join(framework, "csc.exe"),
    ["-nologo", "-nowarn:162", `-out:${helper}`, ...references.map((each) => `-r:${each}`), HELPER_SOURCE],
    { timeoutMs: 60_000 },
  ).catch((error: unknown) => {
    throw new BluetoothUnavailable("The Hub couldn't find the C# compiler that comes with Windows.", { cause: error });
  });
  if (compiled.exitCode !== 0 || !existsSync(helper)) {
    throw new BluetoothUnavailable(
      `The Hub couldn't build its Bluetooth helper: ${compiled.output.trim().split(/\r?\n/)[0] ?? "the compiler said nothing"}`,
    );
  }
  return helper;
};

/**
 * Listens with Windows' own Bluetooth API, through `ble-watch.cs`, which it
 * compiles the first time; or, given `helper`, runs that in its place, as
 * the tests run the fake one.
 */
export const windowsWatch =
  ({ helper }: { readonly helper?: string } = {}): BluetoothWatch =>
  async (seconds, heard) => {
    await runLines(helper ?? (await compileHelper()), [String(seconds)], heard);
  };

interface AssignedNumbers {
  readonly companies: Readonly<Record<string, string>>;
  readonly services: Readonly<Record<string, string>>;
}

let assigned: AssignedNumbers | undefined;
const assignedNumbers = (): AssignedNumbers =>
  (assigned ??= createRequire(import.meta.url)("./bluetooth/assigned-numbers.json") as AssignedNumbers);

/** The company a Bluetooth company id stands for, by the Bluetooth SIG's list, or null. */
export const companyNamed = (id: string): string | null => assignedNumbers().companies[id] ?? null;

const BASE_UUID = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/;

/** A service, with its name where its UUID is one the Bluetooth SIG assigned. */
export const serviceNamed = (uuid: string): BluetoothService => {
  const short = BASE_UUID.exec(uuid)?.[1];
  return { uuid, name: short === undefined ? null : (assignedNumbers().services[short] ?? null) };
};

/** The company ids of makers of the chips in smart bulbs: Tuya's and Telink's. */
const LIGHT_CHIP_MAKERS: ReadonlySet<string> = new Set(["07d0", "0211"]);

/** What a light might advertise itself as. */
const LIGHT_NAME = /lepro|lampux|bulb|lamp|light|\bled\b|strip/i;

/** What a Bluetooth scan kept heard, read as no more than it is, or undefined for what isn't one. */
const savedHeardIn = (
  value: unknown,
):
  | {
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
      readonly devices: readonly (Omit<Heard, "companies" | "uuids"> & {
        readonly companies: readonly string[];
        readonly uuids: readonly string[];
      })[];
    }
  | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const scan = value as Record<string, unknown>;
  if (!Array.isArray(scan.devices)) return undefined;
  const textOrNull = (each: unknown): string | null => (typeof each === "string" ? each : null);
  const texts = (each: unknown): string[] =>
    Array.isArray(each) ? each.filter((one): one is string => typeof one === "string") : [];
  return {
    startedAt: textOrNull(scan.startedAt),
    finishedAt: textOrNull(scan.finishedAt),
    devices: scan.devices
      .filter((each): each is Record<string, unknown> => typeof each === "object" && each !== null)
      .filter((each) => typeof each.address === "string" && typeof each.signal === "number")
      .map((each) => ({
        address: String(each.address),
        randomAddress: each.randomAddress === true,
        name: textOrNull(each.name),
        signal: Number(each.signal),
        companies: texts(each.companies),
        uuids: texts(each.uuids),
        lastHeardAt: textOrNull(each.lastHeardAt) ?? new Date(0).toISOString(),
      })),
  };
};

/** What the scanner holds of a device it heard. */
interface Heard {
  readonly address: string;
  randomAddress: boolean;
  name: string | null;
  signal: number;
  readonly companies: Set<string>;
  readonly uuids: Set<string>;
  lastHeardAt: string;
}

export interface BluetoothScannerOptions {
  /** How it listens: Windows' own API, on Windows. Undefined where the Hub can't listen. */
  readonly watch?: BluetoothWatch;
  /** How long a scan listens. By default, 20 seconds: a device advertises every second or so, some every few. */
  readonly seconds?: number;
  readonly log?: (line: string) => void;
}

export interface BluetoothScanner {
  readonly read: () => BluetoothScan;
  /** Starts listening, unless it is, and answers at once. */
  readonly scan: () => BluetoothScan;
  /** Names a device heard, or forgets its name given null; or undefined for an address not heard. */
  readonly setName: (address: string, name: string | null) => BluetoothScan | undefined;
  /** Puts a device heard in a Room, or in "No room" given null; or undefined for an address not heard. */
  readonly setRoom: (address: string, roomId: number | null) => BluetoothScan | undefined;
  /** Resolves once a scan under way has ended. For tests. */
  readonly settled: () => Promise<void>;
}

/** Why Windows stopped listening, written for the person. */
const whyStopped = (why: string): string =>
  why === "RadioNotAvailable"
    ? "The Hub's PC has no Bluetooth, or it is switched off."
    : why === "DisabledByUser" || why === "DisabledByPolicy"
      ? "Bluetooth is switched off on the Hub's PC, or not allowed there."
      : `Windows stopped listening for Bluetooth devices (${why}).`;

/**
 * Listens for the Bluetooth devices near the Hub's machine, for the Network
 * tab, by what each advertises: its name, the companies and services it
 * names, and how strongly it is heard. It keeps what the last scan heard only
 * while the Hub runs, and what the person named each device in its database.
 */
export const bluetoothScanner = (
  { devices, rooms }: { readonly devices: NetworkDeviceStore; readonly rooms: RoomStore },
  { watch, seconds = 20, log = console.log }: BluetoothScannerOptions = {},
): BluetoothScanner => {
  let scanning = false;
  let problem: string | null =
    watch === undefined ? "The Hub can listen for Bluetooth devices only when it runs on Windows, for now." : null;
  // The last scan, as the Hub kept it, so the Network tab shows it after a restart without listening again.
  const kept = savedHeardIn(devices.lastScan("bluetooth"));
  let startedAt: string | null = kept?.startedAt ?? null;
  let finishedAt: string | null = kept?.finishedAt ?? null;
  let heard = new Map<string, Heard>(
    kept?.devices.map((device) => [
      device.address,
      { ...device, companies: new Set(device.companies), uuids: new Set(device.uuids) },
    ]) ?? [],
  );

  /** Keeps what was heard, for after a restart. */
  const keep = (): void => {
    devices.keepScan("bluetooth", {
      startedAt,
      finishedAt,
      devices: [...heard.values()].map((device) => ({
        ...device,
        companies: [...device.companies],
        uuids: [...device.uuids],
      })),
    });
  };
  let working: Promise<void> | undefined;

  const makerOf = (device: Heard): string | null =>
    [...device.companies].map(companyNamed).find((each) => each !== null) ??
    (device.randomAddress || isPrivateMac(device.address) ? null : vendorOf(device.address));

  /** Keeps what the scan heard a device as, for the Rooms tab, if the Hub keeps anything of it. */
  const sawIt = (device: Heard): void => {
    const maker = makerOf(device);
    devices.saw(`bluetooth:${device.address}`, {
      address: device.address,
      label: device.name ?? maker ?? "Unnamed Bluetooth device",
      maker,
    });
  };

  const describe = (device: Heard): BluetoothDevice => {
    const companies = [...device.companies];
    const maker = makerOf(device);
    const roomId = devices.roomOf(`bluetooth:${device.address}`);
    const room = rooms.list().find((each) => each.id === roomId);
    return {
      address: device.address,
      randomAddress: device.randomAddress,
      name: devices.nameOf(`bluetooth:${device.address}`),
      room: room === undefined ? null : { id: room.id, name: room.name },
      advertisedName: device.name,
      maker,
      signal: device.signal,
      services: [...device.uuids].map(serviceNamed),
      maybeLight:
        (device.name !== null && LIGHT_NAME.test(device.name)) || companies.some((each) => LIGHT_CHIP_MAKERS.has(each)),
      lastHeardAt: device.lastHeardAt,
    };
  };

  const read = (): BluetoothScan => ({
    available: watch !== undefined,
    problem,
    scanning,
    seconds,
    startedAt,
    finishedAt,
    devices: [...heard.values()]
      .map(describe)
      .toSorted((a, b) => Number(b.maybeLight) - Number(a.maybeLight) || b.signal - a.signal),
  });

  const hear = (into: Map<string, Heard>) => (line: WatchLine) => {
    if (line.kind === "stopped") {
      problem = whyStopped(line.why);
      return;
    }
    if (line.kind !== "advert") return;
    const { advert } = line;
    const now = new Date().toISOString();
    const device = into.get(advert.address);
    if (device === undefined) {
      into.set(advert.address, {
        address: advert.address,
        randomAddress: advert.randomAddress,
        name: advert.name,
        signal: advert.signal,
        companies: new Set(advert.companies),
        uuids: new Set(advert.uuids),
        lastHeardAt: now,
      });
      return;
    }
    device.name = advert.name ?? device.name;
    device.signal = Math.max(device.signal, advert.signal);
    for (const each of advert.companies) device.companies.add(each);
    for (const each of advert.uuids) device.uuids.add(each);
    device.lastHeardAt = now;
  };

  return {
    read,

    scan: () => {
      if (scanning || watch === undefined) return read();
      scanning = true;
      problem = null;
      startedAt = new Date().toISOString();
      finishedAt = null;
      // Shown as they are heard, so the list fills while it listens.
      heard = new Map();
      log(`Listening for Bluetooth devices for ${String(seconds)} s`);
      working = watch(seconds, hear(heard))
        .catch((error: unknown) => {
          problem = error instanceof BluetoothUnavailable ? error.message : "Listening for Bluetooth devices failed.";
          console.error("The Bluetooth scan failed", error);
        })
        .finally(() => {
          scanning = false;
          finishedAt = new Date().toISOString();
          for (const device of heard.values()) sawIt(device);
          keep();
          log(`Heard ${String(heard.size)} Bluetooth devices${problem === null ? "" : `: ${problem}`}`);
        });
      return read();
    },

    setName: (address, name) => {
      if (!heard.has(address)) return undefined;
      devices.setName(`bluetooth:${address}`, name);
      const device = heard.get(address);
      if (device !== undefined) sawIt(device);
      return read();
    },

    setRoom: (address, roomId) => {
      const device = heard.get(address);
      if (device === undefined) return undefined;
      devices.setRoom(`bluetooth:${address}`, roomId);
      sawIt(device);
      return read();
    },

    settled: async () => {
      await working;
    },
  };
};
