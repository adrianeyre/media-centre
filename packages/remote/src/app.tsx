import { useEffect, useRef, useState } from "preact/hooks";

import { REMOTE_VERSION } from "./about.ts";
import { AirconTab } from "./aircon-tab.tsx";
import type { AmazonApi } from "./amazon-api.ts";
import { AmazonTab } from "./amazon-tab.tsx";
import { AppFooter } from "./app-footer.tsx";
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from "./appearance.ts";
import type { AppliancesApi } from "./appliances-api.ts";
import type { HubAddressApi } from "./hub-address-api.ts";
import { HeatingTab } from "./heating-tab.tsx";
import { describeHubStatus, type HubStatus } from "./hub-status.ts";
import { Icon, type IconName } from "./icons.tsx";
import { isUpdate, type LatestVersionStatus } from "./latest-version.ts";
import { LightsTab } from "./lights-tab.tsx";
import type { NetworkApi } from "./network-api.ts";
import { NetworkTab } from "./network-tab.tsx";
import type { RingApi } from "./ring-api.ts";
import { RingTab } from "./ring-tab.tsx";
import { RoomsTab } from "./rooms-tab.tsx";
import type { MediaSourcesApi } from "./media-sources-api.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { SettingsScreen } from "./settings-screen.tsx";
import {
  FIRST_SETTINGS_SECTION,
  loadLastSettingsSection,
  saveLastSettingsSection,
  type SettingsSection,
} from "./settings-sections.ts";
import type { SigningCertificateApi } from "./signing-certificate-api.ts";
import { TABS, loadLastTab, saveLastTab, type RemoteScreen, type RemoteTab } from "./tabs.ts";
import { TvTab } from "./tv-tab.tsx";
import { UpdateDialog } from "./update-dialog.tsx";

export interface AppProps {
  /** Where the Remote remembers its last tab, its Selected TV and how it looks: `localStorage` in a browser. */
  readonly storage: RemoteStorage;
  readonly loadHubStatus: () => Promise<HubStatus>;
  /** The latest version of media-centre, which the Hub looks up on GitHub (FR-61). */
  readonly loadLatestVersion: () => Promise<LatestVersionStatus>;
  readonly rooms: RoomsApi;
  readonly appliances: AppliancesApi;
  readonly hubAddress: HubAddressApi;
  readonly mediaSources: MediaSourcesApi;
  readonly signingCertificate: SigningCertificateApi;
  readonly network: NetworkApi;
  readonly amazon: AmazonApi;
  readonly ring: RingApi;
}

const TAB_ICONS: Readonly<Record<RemoteTab, IconName>> = {
  tv: "tv",
  aircon: "air-vent",
  lights: "lightbulb",
  heating: "thermometer",
  network: "network",
  amazon: "speaker",
  ring: "doorbell",
  rooms: "home",
};

/** The Hub's connection in a word or two, for the app bar. Settings says it in full. */
const HUB_CHIP: Readonly<Record<HubStatus["kind"], string>> = {
  checking: "Connecting",
  connected: "Hub online",
  unreachable: "Hub offline",
};

/** From this width the tabs stand in a rail down the left, beside the screen, rather than along the bottom. */
const RAIL_QUERY = "(min-width: 64rem)";

/** Whether the tabs stand in the rail, kept up to date as the window is resized. */
const useRail = (): boolean => {
  const [rail, setRail] = useState(() => typeof matchMedia === "function" && matchMedia(RAIL_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(RAIL_QUERY);
    const change = (): void => {
      setRail(query.matches);
    };
    change();
    query.addEventListener("change", change);
    return () => {
      query.removeEventListener("change", change);
    };
  }, []);
  return rail;
};

/**
 * The Remote: an app bar, kept at the top as the page scrolls, with the cog
 * that opens Settings' General, the screen, then one tab per kind of Appliance
 * (FR-6), along the bottom, where a thumb reaches them on a phone (NFR-2), or
 * in a rail down the left on a wide screen, and the footer, one slim line along
 * the very bottom.
 */
export const App = ({
  storage,
  loadHubStatus,
  loadLatestVersion,
  rooms,
  appliances,
  hubAddress,
  mediaSources,
  signingCertificate,
  network,
  amazon,
  ring,
}: AppProps) => {
  const [tab, setTab] = useState<RemoteScreen>(() => loadLastTab(storage));
  const [hub, setHub] = useState<HubStatus>({ kind: "checking" });
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance(storage));
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() => loadLastSettingsSection(storage));
  const [latest, setLatest] = useState<LatestVersionStatus>({ kind: "checking" });
  const [updateOpen, setUpdateOpen] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const appBar = useRef<HTMLElement>(null);
  const rail = useRail();

  useEffect(() => {
    applyAppearance(document.documentElement, appearance);
  }, [appearance]);

  useEffect(() => {
    let current = true;
    void loadHubStatus().then((status) => {
      if (current) setHub(status);
    });
    return () => {
      current = false;
    };
  }, [loadHubStatus]);

  // Asked once, as the Remote opens, which offers an update if there is one.
  useEffect(() => {
    let current = true;
    void loadLatestVersion().then((status) => {
      if (!current) return;
      setLatest(status);
      if (isUpdate(status, REMOTE_VERSION)) setUpdateOpen(true);
    });
    return () => {
      current = false;
    };
  }, [loadLatestVersion]);

  // The page keeps clear of the dock and the footer, however tall they are, so
  // that nothing, and no focused control, is ever hidden behind them (WCAG
  // 2.4.11). So too of the app bar, kept at the top.
  useEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const measured: [HTMLElement | null, string][] = [
      [dock.current, "--dock-height"],
      [footer.current, "--footer-height"],
      [appBar.current, "--app-bar-height"],
    ];
    const observer = new ResizeObserver(() => {
      for (const [element, property] of measured) {
        if (element) document.documentElement.style.setProperty(property, `${String(element.offsetHeight)}px`);
      }
    });
    for (const [element] of measured) if (element) observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const changeAppearance = (next: Appearance): void => {
    setAppearance(next);
    saveAppearance(storage, next);
  };

  const open = (next: RemoteScreen): void => {
    setTab(next);
    saveLastTab(storage, next);
  };

  // Every tab, always, Heating too: signed out of Hive, it says how to sign in.
  const tabs = TABS;

  /** Shows this part of Settings, and remembers it. */
  const showSettingsSection = (section: SettingsSection): void => {
    setSettingsSection(section);
    saveLastSettingsSection(storage, section);
  };

  /** Opens Settings on this part of it, as the cog and each tab's "Open Settings" do. */
  const openSettings = (section: SettingsSection): void => {
    showSettingsSection(section);
    open("settings");
  };

  /** The arrow keys, Home and End move between the tabs, as for any set of tabs, up and down them in the rail. */
  const moveTab = (event: KeyboardEvent): void => {
    const at = tabs.findIndex(({ id }) => id === tab);
    const to = {
      ArrowLeft: at - 1,
      ArrowRight: at + 1,
      Home: 0,
      End: tabs.length - 1,
      ...(rail ? { ArrowUp: at - 1, ArrowDown: at + 1 } : {}),
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    if (next === undefined) return;
    open(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div class="remote">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header ref={appBar} class="app-bar">
        <span class="brand">
          <Icon name="tv" />
          Media Centre
        </span>
        <span class="app-bar-end">
          <span class={`hub-chip hub-chip-${hub.kind}`}>
            <span class="hub-dot" aria-hidden="true" />
            {HUB_CHIP[hub.kind]}
          </span>
          <button
            type="button"
            class="button-icon app-bar-cog"
            aria-label="General settings"
            onClick={() => {
              openSettings(FIRST_SETTINGS_SECTION);
            }}
          >
            <Icon name="cog" />
          </button>
        </span>
      </header>
      {isUpdate(latest, REMOTE_VERSION) && (
        <UpdateDialog
          open={updateOpen}
          latest={latest.version}
          onClose={() => {
            setUpdateOpen(false);
          }}
        />
      )}
      {hub.kind === "unreachable" && (
        <p class="banner" role="alert">
          {describeHubStatus(hub)}
        </p>
      )}
      <main id="main" class={tab === "settings" ? "screen screen-settings" : "screen"} tabIndex={-1}>
        <div id="screen" {...(tab === "settings" ? {} : { role: "tabpanel", "aria-labelledby": `tab-${tab}` })}>
          {tab === "tv" ? (
            <TvTab
              appliances={appliances}
              hubAddress={hubAddress}
              mediaSources={mediaSources}
              rooms={rooms}
              storage={storage}
              onOpenSettings={openSettings}
            />
          ) : tab === "aircon" ? (
            <AirconTab
              appliances={appliances}
              rooms={rooms}
              storage={storage}
              onOpenSettings={() => {
                openSettings("aircon");
              }}
            />
          ) : tab === "lights" ? (
            <LightsTab
              appliances={appliances}
              rooms={rooms}
              storage={storage}
              onOpenSettings={() => {
                openSettings("lights");
              }}
            />
          ) : tab === "rooms" ? (
            <RoomsTab
              appliances={appliances}
              rooms={rooms}
              network={network}
              amazon={amazon}
              ring={ring}
              storage={storage}
              onOpenTab={open}
              onOpenSettings={openSettings}
            />
          ) : tab === "network" ? (
            <NetworkTab network={network} rooms={rooms} storage={storage} />
          ) : tab === "amazon" ? (
            <AmazonTab amazon={amazon} rooms={rooms} storage={storage} />
          ) : tab === "ring" ? (
            <RingTab ring={ring} rooms={rooms} storage={storage} />
          ) : tab === "heating" ? (
            <HeatingTab
              appliances={appliances}
              rooms={rooms}
              storage={storage}
              onOpenSettings={() => {
                openSettings("heating");
              }}
            />
          ) : (
            <SettingsScreen
              hub={hub}
              latest={latest}
              rooms={rooms}
              appliances={appliances}
              hubAddress={hubAddress}
              mediaSources={mediaSources}
              signingCertificate={signingCertificate}
              appearance={appearance}
              onAppearanceChange={changeAppearance}
              section={settingsSection}
              onSection={showSettingsSection}
            />
          )}
        </div>
      </main>
      <div ref={dock} class="dock">
        <div class="tab-bar" role="tablist" aria-label="Remote" aria-orientation={rail ? "vertical" : "horizontal"}>
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              aria-selected={id === tab}
              aria-controls="screen"
              tabIndex={id === tab ? 0 : -1}
              onKeyDown={moveTab}
              onClick={() => {
                open(id);
              }}
            >
              <Icon name={TAB_ICONS[id]} />
              <span class="tab-label">{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div ref={footer} class="footer-dock">
        <AppFooter />
      </div>
    </div>
  );
};
