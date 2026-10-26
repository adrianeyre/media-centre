import type { DeveloperSettings, NetworkType } from "@media-centre/shared";

/**
 * The Samsung TV Driver's reading of a TV's device info: the REST call
 * `GET http://<tv>:8001/api/v2/`, which a Samsung TV answers without pairing.
 * Only the Driver knows this format (NFR-6); the rest of the Hub sees a
 * {@link SamsungTvDeviceInfo}.
 */

/** The TV's REST port. The secure control socket is on 8002. */
export const SAMSUNG_REST_PORT = 8001;

export const DEVICE_INFO_PATH = "/api/v2/";

/**
 * The `device` part of a Samsung TV's answer, as far as we know it. Samsung
 * sends every value as a string, booleans included ("true", "false"). Older
 * firmware leaves some fields out; the PRD (§11) still has to confirm the
 * developer fields on a real TV.
 */
export interface SamsungDevice {
  readonly name: string;
  readonly modelName: string;
  readonly model: string;
  readonly wifiMac: string;
  readonly ip: string;
  readonly networkType?: string;
  readonly type: string;
  readonly id: string;
  readonly duid: string;
  readonly udn: string;
  readonly OS: string;
  readonly resolution: string;
  readonly countryCode: string;
  readonly Language: string;
  readonly firmwareVersion: string;
  readonly FrameTVSupport: string;
  readonly TokenAuthSupport: string;
  readonly PowerState?: string;
  readonly developerMode?: string;
  readonly developerIP?: string;
}

export interface SamsungDeviceInfoResponse {
  readonly device: SamsungDevice;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly uri: string;
  readonly version: string;
}

/** What the rest of the Hub learns from a TV's device info. */
export interface SamsungTvDeviceInfo {
  /** The TV's own name, which a new TV's name defaults to (FR-14). */
  readonly name: string;
  readonly model: string;
  /** For Wake-on-LAN (FR-14, FR-17). */
  readonly macAddress: string;
  /** "standby" when the TV says so (FR-16). */
  readonly powerState: "on" | "standby";
  /** A Frame TV, whose power key must be held to switch it off (FR-17). */
  readonly frame: boolean;
  /** Or null for a network type the Driver doesn't know, or none (FR-28). */
  readonly networkType: NetworkType | null;
  /** Or null when the TV doesn't report both Developer Mode and the Developer IP (FR-28). */
  readonly developer: DeveloperSettings | null;
}

/** A TV reports its network type as "wireless" or "wired", as far as we know, and older firmware not at all. */
const networkTypeOf = (reported: string | undefined): NetworkType | null =>
  reported === "wireless" || reported === "wired" ? reported : null;

/**
 * A TV's Developer Mode, "1" for on and "0" for off, and its Developer IP,
 * "0.0.0.0" when none is set, as far as we know. With either left out, or not
 * as we know it, the TV doesn't report them.
 */
const developerSettings = ({ developerMode, developerIP }: SamsungDevice): DeveloperSettings | null => {
  if ((developerMode !== "0" && developerMode !== "1") || typeof developerIP !== "string") return null;
  const ip = developerIP.trim();
  return { mode: developerMode === "1" ? "on" : "off", ip: ip === "" || ip === "0.0.0.0" ? null : ip };
};

/** Something answered at the address, but not as a Samsung TV does. */
export class NotASamsungTv extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotASamsungTv";
  }
}

export interface ReadDeviceInfoOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
}

/**
 * Asks the TV at `host` for its device info. Rejects when the TV does not
 * answer in time, and with {@link NotASamsungTv} when it answers with an error
 * or with something that is not a Samsung TV's device info.
 */
export const readDeviceInfo = async (
  host: string,
  { port = SAMSUNG_REST_PORT, timeoutMs = 3_000 }: ReadDeviceInfoOptions = {},
): Promise<SamsungTvDeviceInfo> => {
  const url = `http://${host}:${String(port)}${DEVICE_INFO_PATH}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new NotASamsungTv(`The TV at ${host} answered device info with ${String(response.status)}`);

  const body: unknown = await response.json().catch(() => undefined);
  if (!isDeviceInfoResponse(body)) throw new NotASamsungTv(`The TV at ${host} sent device info we cannot read`);

  const { device } = body;
  return {
    name: device.name,
    model: device.modelName,
    macAddress: device.wifiMac.toLowerCase(),
    // Firmware without PowerState only answers at all when the TV is on.
    powerState: device.PowerState === "standby" ? "standby" : "on",
    frame: device.FrameTVSupport === "true",
    networkType: networkTypeOf(device.networkType),
    developer: developerSettings(device),
  };
};

const isDeviceInfoResponse = (value: unknown): value is SamsungDeviceInfoResponse => {
  if (typeof value !== "object" || value === null || !("device" in value)) return false;
  const { device } = value;
  return (
    typeof device === "object" &&
    device !== null &&
    "name" in device &&
    typeof device.name === "string" &&
    "modelName" in device &&
    typeof device.modelName === "string" &&
    "wifiMac" in device &&
    typeof device.wifiMac === "string"
  );
};
