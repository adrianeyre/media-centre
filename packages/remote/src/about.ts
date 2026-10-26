declare const __REMOTE_VERSION__: string;
declare const __REPOSITORY_URL__: string;

/** The Remote's version, from the repository's package.json, which the footer shows. */
export const REMOTE_VERSION = __REMOTE_VERSION__;

/**
 * media-centre's source, which the footer's "Website design" credit links to.
 * It is only ever followed by the person, in a new tab: the Remote loads
 * nothing from it, and works without it when the internet is disconnected (NFR-3).
 */
export const REPOSITORY_URL = __REPOSITORY_URL__;

/** Where a question about a policy, or a problem with accessibility, is raised. */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

/**
 * Where the latest release of media-centre is downloaded from, which the
 * Remote offers when the Hub finds a newer version than its own (FR-61).
 */
export const LATEST_RELEASE_URL = `${REPOSITORY_URL}/releases/latest`;
