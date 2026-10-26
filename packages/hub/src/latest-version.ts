/** How long the Hub keeps the latest version it found, so GitHub is asked at most once an hour. */
const CACHE_MS = 60 * 60 * 1000;

/** How long the Hub waits for GitHub, so a Remote opened offline isn't kept waiting. */
const TIMEOUT_MS = 5000;

/** The latest version of media-centre, or `undefined` when it can't be found out. */
export type LatestVersionOf = () => Promise<string | undefined>;

/**
 * Where the package.json on GitHub's `main` is read from, for the repository
 * URL in media-centre's own package.json: its raw file, served with
 * `Access-Control-Allow-Origin`, and without GitHub's API's rate limit.
 */
export const latestPackageJsonUrl = (repositoryUrl: string): string => {
  const repository = new URL(repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, ""));
  // eslint-disable-next-line media-centre/no-internet-urls -- the one address on the internet the Hub asks, only for a version number, and works without (FR-61, NFR-3)
  return `https://raw.githubusercontent.com${repository.pathname}/main/package.json`;
};

/**
 * Reads the version from the package.json at `url`, keeping it for an hour.
 * A failure, such as the internet being disconnected, isn't kept, so the
 * next Remote to open asks again.
 */
export const latestVersionFrom = (
  url: string,
  { fetchFn = fetch, now = Date.now }: { fetchFn?: typeof fetch; now?: () => number } = {},
): LatestVersionOf => {
  let found: { version: string; at: number } | undefined;

  return async () => {
    if (found !== undefined && now() - found.at < CACHE_MS) return found.version;
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return undefined;
      const json: unknown = await response.json();
      if (typeof json !== "object" || json === null || !("version" in json) || typeof json.version !== "string") {
        return undefined;
      }
      found = { version: json.version, at: now() };
      return json.version;
    } catch {
      return undefined;
    }
  };
};
