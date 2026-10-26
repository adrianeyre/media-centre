import { useEffect, useState } from "preact/hooks";

import type {
  Appliance,
  ApplianceDeviceInfo,
  DeviceInfo,
  HubAddress,
  NetworkType,
  PowerState,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import type { HubAddressApi } from "./hub-address-api.ts";
import { messageFor } from "./hub-request.ts";
import { TvPlayerTools } from "./tv-player-tools.tsx";

/**
 * How often the Remote asks the Hub again, while the Developer section is
 * open, for the Selected TV's device info, which changes once Developer Mode
 * is switched on at the TV, and for the Hub's own address. It asks at once
 * when the TV's power state changes, as it does on restarting.
 */
export const DEVELOPER_REFRESH_MS = 5_000;

export interface TvDeveloperProps {
  readonly appliances: AppliancesApi;
  readonly hubAddress: HubAddressApi;
  /** The Selected TV. */
  readonly tv: Appliance;
  /** It as the Remote names it, "Room · Name" (FR-9). */
  readonly title: string;
  /** Its power state, as the TV tab last read it, or undefined before the first read. */
  readonly power: PowerState | undefined;
  /** Opens Settings, where the Hub's IP address can be set. */
  readonly onOpenSettings: () => void;
  /** {@link DEVELOPER_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

const NETWORK_LABELS: Readonly<Record<NetworkType, string>> = { wireless: "Wi-Fi", wired: "Wired" };

/** One reading of the device info and the Hub's address, each with why it couldn't be read, if it couldn't. */
interface Reading {
  readonly deviceInfo: ApplianceDeviceInfo | undefined;
  readonly deviceInfoProblem: string | undefined;
  readonly address: HubAddress | undefined;
  readonly addressProblem: string | undefined;
}

const DeviceInfoList = ({ info, title }: { readonly info: DeviceInfo; readonly title: string }) => (
  <>
    <dl class="device-info">
      <dt>Model</dt>
      <dd>{info.model}</dd>
      <dt>Name</dt>
      <dd>{info.name}</dd>
      <dt>MAC address</dt>
      <dd>{info.macAddress}</dd>
      <dt>Network</dt>
      <dd>{info.networkType === null ? "Not reported" : NETWORK_LABELS[info.networkType]}</dd>
      <dt>Frame TV</dt>
      <dd>{info.frame ? "Yes" : "No"}</dd>
      {info.developer !== null && (
        <>
          <dt>Developer Mode</dt>
          <dd>{info.developer.mode === "on" ? "On" : "Off"}</dd>
          <dt>Developer IP</dt>
          <dd>{info.developer.ip ?? "None set"}</dd>
        </>
      )}
    </dl>
    {info.developer === null && (
      <p class="developer-note">{title} doesn't report whether Developer Mode is on, nor its Developer IP.</p>
    )}
  </>
);

/**
 * The Selected TV's Developer section (FR-28, FR-29), closed until the person
 * opens it: the device info the TV reports, with Developer Mode and the
 * Developer IP if it reports them and a word that it doesn't if not, and the
 * steps to switch Developer Mode on at the TV with the Hub's own IP address
 * as the Developer IP, which Samsung allows only with the TV's physical
 * remote. Only once the TV reports both, Developer Mode on and the Hub's IP
 * as its Developer IP, can it install, launch and uninstall the Player
 * (FR-31). While open, both are read again every few seconds, and at once when
 * the TV's power state changes, so that it follows the TV as it restarts.
 * Reading them changes nothing on the TV.
 */
export const TvDeveloper = ({
  appliances,
  hubAddress,
  tv,
  title,
  power,
  onOpenSettings,
  refreshMs = DEVELOPER_REFRESH_MS,
}: TvDeveloperProps) => {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Reading | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Counts every reading begun, so that one answered late is never shown after a later one. */
    let readings = 0;

    const readBoth = async (): Promise<void> => {
      readings += 1;
      const reading = readings;
      const [deviceInfo, address] = await Promise.allSettled([appliances.readDeviceInfo(tv.id), hubAddress.read()]);
      if (!current || reading !== readings) return;
      setRead({
        deviceInfo: deviceInfo.status === "fulfilled" ? deviceInfo.value : undefined,
        deviceInfoProblem: deviceInfo.status === "rejected" ? messageFor(deviceInfo.reason) : undefined,
        address: address.status === "fulfilled" ? address.value : undefined,
        addressProblem: address.status === "rejected" ? messageFor(address.reason) : undefined,
      });
    };

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await readBoth();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, appliances, hubAddress, tv.id, refreshMs, power]);

  const hubIp = read?.address?.address ?? null;
  const developer = read?.deviceInfo?.known === true ? read.deviceInfo.info.developer : null;
  const ready = hubIp !== null && developer?.mode === "on" && developer.ip === hubIp;

  return (
    <section class="tv-developer" aria-labelledby="tv-developer-heading">
      <h2 id="tv-developer-heading">
        <button
          type="button"
          class="developer-toggle"
          aria-expanded={open}
          aria-controls="tv-developer-body"
          onClick={() => {
            // Closed, it forgets what it read, so that it never shows that again as if it were now.
            if (open) setRead(undefined);
            setOpen(!open);
          }}
        >
          Developer
          <span class="developer-toggle-mark" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        </button>
      </h2>
      {open && (
        <div id="tv-developer-body">
          <h3>Device info</h3>
          {read?.deviceInfoProblem !== undefined && (
            <p class="problem" role="alert">
              {read.deviceInfoProblem}
            </p>
          )}
          {read === undefined ? (
            <p class="developer-note">Reading {title}'s device info…</p>
          ) : read.deviceInfo === undefined ? null : read.deviceInfo.known ? (
            <DeviceInfoList info={read.deviceInfo.info} title={title} />
          ) : (
            <p class="developer-note">{title} isn't answering, so its device info can't be read.</p>
          )}

          <h3>Turn on Developer Mode</h3>
          <p>
            Developer Mode lets the Hub install the Player on the TV. Samsung only lets it be switched on at the TV
            itself, with the TV's physical remote, not from here. On {title}:
          </p>
          {read?.addressProblem !== undefined && (
            <p class="problem" role="alert">
              {read.addressProblem}
            </p>
          )}
          <ol class="developer-steps">
            <li>
              Press <strong>Home</strong> on the physical remote, and open <strong>Apps</strong>.
            </li>
            <li>
              In Apps, press <strong>1 2 3 4 5</strong> on the physical remote's number keys, or on the number pad the
              TV shows if the remote has none. The Developer Mode window opens.
            </li>
            <li>
              Switch <strong>Developer mode</strong> to <strong>On</strong>.
            </li>
            <li>
              Where it asks for an IP address, enter the Hub's IP
              {hubIp === null ? "" : ", "}
              {hubIp !== null && <strong class="hub-ip">{hubIp}</strong>}, then choose <strong>OK</strong>.
              {read?.address?.address === null && (
                <> The Hub couldn't find its own IP address on your home network, so set it in Settings first.</>
              )}
            </li>
            <li>Restart the TV: hold the physical remote's power button until the TV switches off and on again.</li>
            <li>Once it is back on, Developer Mode is on, with the Hub's IP as its Developer IP.</li>
          </ol>
          <p class="developer-note">
            Not the Hub's IP on your home network?{" "}
            <button type="button" class="link-button" onClick={onOpenSettings}>
              Set it in Settings
            </button>
          </p>

          <TvPlayerTools key={tv.id} appliances={appliances} tv={tv} title={title} ready={ready} />
        </div>
      )}
    </section>
  );
};
