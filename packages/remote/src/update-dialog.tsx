import { LATEST_RELEASE_URL, REMOTE_VERSION } from "./about.ts";
import { Dialog } from "./dialog.tsx";

export interface UpdateDialogProps {
  readonly open: boolean;
  /** The latest version of media-centre, which isn't this Remote's. */
  readonly latest: string;
  readonly onClose: () => void;
}

/**
 * Shown as the Remote opens, when the Hub finds another version of
 * media-centre on GitHub than this one (FR-61): both versions, and the way
 * to the latest release, to download it.
 */
export const UpdateDialog = ({ open, latest, onClose }: UpdateDialogProps) => (
  <Dialog
    open={open}
    onClose={onClose}
    title="Update available"
    closeLabel="Close Update available"
    footer={
      <>
        <button type="button" onClick={onClose}>
          Not now
        </button>
        <a class="button-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noopener noreferrer" onClick={onClose}>
          Go to the release
          <span class="visually-hidden"> (on GitHub, opens in a new tab)</span>
        </a>
      </>
    }
  >
    <p>A new version of Media Centre is ready to download from its release page on GitHub.</p>
    <VersionList latest={latest} />
  </Dialog>
);

/** This Remote's version and the latest, as the update dialog and Settings both show them. */
export const VersionList = ({ latest }: { readonly latest: string }) => (
  <dl class="version-list">
    <dt>Current version</dt>
    <dd>{REMOTE_VERSION}</dd>
    <dt>Latest version</dt>
    <dd>{latest}</dd>
  </dl>
);
