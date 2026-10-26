import { LATEST_RELEASE_URL, REMOTE_VERSION } from "./about.ts";
import { isUpdate, type LatestVersionStatus } from "./latest-version.ts";
import { VersionList } from "./update-dialog.tsx";

const LATEST: Readonly<Record<LatestVersionStatus["kind"], string>> = {
  checking: "Checking…",
  known: "",
  unknown: "Unknown",
};

export interface VersionSectionProps {
  readonly latest: LatestVersionStatus;
}

/**
 * Settings' Version: this Remote's version and the latest on GitHub, which
 * the Hub looks up, and the way to the latest release when it is another
 * (FR-61).
 */
export const VersionSection = ({ latest }: VersionSectionProps) => (
  <section aria-labelledby="settings-version">
    <h2 id="settings-version">Version</h2>
    <div aria-live="polite">
      <VersionList latest={latest.kind === "known" ? latest.version : LATEST[latest.kind]} />
      {latest.kind === "unknown" && (
        <p class="version-note">
          The Hub couldn't reach GitHub to find out. It tries again when the Remote is next opened.
        </p>
      )}
      {latest.kind === "known" && !isUpdate(latest, REMOTE_VERSION) && <p class="version-note">You're up to date.</p>}
    </div>
    {isUpdate(latest, REMOTE_VERSION) && (
      <a class="button-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noopener noreferrer">
        Update
        <span class="visually-hidden"> to {latest.version} (release page on GitHub, opens in a new tab)</span>
      </a>
    )}
  </section>
);
