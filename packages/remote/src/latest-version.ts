import { LATEST_VERSION_PATH } from "@media-centre/shared";

/** What the Remote knows of the latest version of media-centre, from the Hub (FR-61). */
export type LatestVersionStatus =
  { readonly kind: "checking" } | { readonly kind: "known"; readonly version: string } | { readonly kind: "unknown" };

/**
 * Asks the Hub for the latest version of media-centre, which the Hub reads
 * from GitHub, so the Remote itself only ever talks to the Hub (NFR-3).
 * Anything but a version, such as the internet being disconnected, is unknown.
 */
export const checkLatestVersion = async (fetchFn: typeof fetch = fetch): Promise<LatestVersionStatus> => {
  try {
    const response = await fetchFn(LATEST_VERSION_PATH);
    if (!response.ok) return { kind: "unknown" };
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "version" in body && typeof body.version === "string"
      ? { kind: "known", version: body.version }
      : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
};

/** Whether the latest version is another than this Remote's, so is offered as an update. */
export const isUpdate = (latest: LatestVersionStatus, current: string): latest is { kind: "known"; version: string } =>
  latest.kind === "known" && latest.version !== current;
