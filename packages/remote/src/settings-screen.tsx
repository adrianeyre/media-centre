import { useState } from "preact/hooks";

import { AirConditionersSection } from "./air-conditioners-section.tsx";
import type { Appearance } from "./appearance.ts";
import { AppearanceSettings } from "./appearance-settings.tsx";
import type { AppliancesApi } from "./appliances-api.ts";
import { HiveSection } from "./hive-section.tsx";
import type { HubAddressApi } from "./hub-address-api.ts";
import { HubAddressSetting } from "./hub-address-setting.tsx";
import { describeHubStatus, type HubStatus } from "./hub-status.ts";
import { Icon } from "./icons.tsx";
import type { LatestVersionStatus } from "./latest-version.ts";
import { LightsSection } from "./lights-section.tsx";
import type { MediaSourcesApi } from "./media-sources-api.ts";
import { MediaSourcesSection } from "./media-sources-section.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { FloorPlanSection } from "./floor-plan-section.tsx";
import { RoomsSection } from "./rooms-section.tsx";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-sections.ts";
import type { SigningCertificateApi } from "./signing-certificate-api.ts";
import { SigningCertificateSetting } from "./signing-certificate-setting.tsx";
import { TvsSection } from "./tvs-section.tsx";
import { VersionSection } from "./version-section.tsx";

export interface SettingsScreenProps {
  readonly hub: HubStatus;
  /** The latest version of media-centre, for Settings' Version (FR-61). */
  readonly latest: LatestVersionStatus;
  readonly rooms: RoomsApi;
  readonly appliances: AppliancesApi;
  readonly hubAddress: HubAddressApi;
  readonly mediaSources: MediaSourcesApi;
  readonly signingCertificate: SigningCertificateApi;
  /** How this Remote looks, which General sets. */
  readonly appearance: Appearance;
  readonly onAppearanceChange: (appearance: Appearance) => void;
  /** The part of Settings shown, of {@link SETTINGS_SECTIONS}. */
  readonly section: SettingsSection;
  /** Called with the part chosen from the menu. */
  readonly onSection: (section: SettingsSection) => void;
}

/**
 * Settings, where everything about the home is managed from the Remote
 * (FR-3): a menu of its parts, General, Rooms, TV, Aircon, Lights and
 * Heating, down the left edge of the screen, between the app bar and the
 * dock, and the settings of the one chosen beside it, so that each reads on
 * its own. On a phone the menu sits above them, wrapping onto as many lines
 * as it needs.
 */
export const SettingsScreen = ({
  hub,
  latest,
  rooms,
  appliances,
  hubAddress,
  mediaSources,
  signingCertificate,
  appearance,
  onAppearanceChange,
  section,
  onSection,
}: SettingsScreenProps) => {
  // A Room renamed, reordered or deleted changes how each kind of Appliance is listed.
  const [roomsVersion, setRoomsVersion] = useState(0);
  const chosen = SETTINGS_SECTIONS.find(({ id }) => id === section) ?? SETTINGS_SECTIONS[0];

  return (
    <div class="settings-layout">
      <h1 class="settings-title">Settings</h1>
      <nav class="settings-nav" aria-label="Settings">
        <ul>
          {SETTINGS_SECTIONS.map(({ id, label, icon }) => (
            <li key={id}>
              <button
                type="button"
                class="settings-nav-item"
                aria-current={id === chosen.id ? "page" : undefined}
                aria-controls="settings-panel"
                onClick={() => {
                  onSection(id);
                }}
              >
                <Icon name={icon} />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div id="settings-panel" class="settings-panel" aria-label={`${chosen.label} settings`} role="region">
        {chosen.id === "general" ? (
          <>
            <AppearanceSettings appearance={appearance} onChange={onAppearanceChange} />
            <section aria-labelledby="settings-hub">
              <h2 id="settings-hub">Hub</h2>
              <p role="status">{describeHubStatus(hub)}</p>
              {hub.kind === "connected" && <p>Version {hub.info.version}</p>}
              <HubAddressSetting hubAddress={hubAddress} />
            </section>
            <VersionSection latest={latest} />
          </>
        ) : chosen.id === "rooms" ? (
          <>
            <RoomsSection
              rooms={rooms}
              onChange={() => {
                setRoomsVersion((version) => version + 1);
              }}
            />
            <FloorPlanSection rooms={rooms} />
          </>
        ) : chosen.id === "tv" ? (
          <>
            <TvsSection appliances={appliances} rooms={rooms} roomsVersion={roomsVersion} />
            <MediaSourcesSection mediaSources={mediaSources} />
            <SigningCertificateSetting signingCertificate={signingCertificate} />
          </>
        ) : chosen.id === "aircon" ? (
          <AirConditionersSection appliances={appliances} rooms={rooms} roomsVersion={roomsVersion} />
        ) : chosen.id === "lights" ? (
          <LightsSection appliances={appliances} rooms={rooms} roomsVersion={roomsVersion} />
        ) : (
          <HiveSection appliances={appliances} rooms={rooms} roomsVersion={roomsVersion} />
        )}
      </div>
    </div>
  );
};
