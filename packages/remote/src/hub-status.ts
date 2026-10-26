import { HUB_INFO_PATH, type HubInfo } from "@media-centre/shared";

export type HubStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "connected"; readonly info: HubInfo }
  | { readonly kind: "unreachable" };

/**
 * Asks the Hub who it is. Anything but a well-formed answer counts as the Hub
 * being unreachable, because without the Hub the Remote can do nothing (ADR 0001).
 */
export const checkHub = async (fetchFn: typeof fetch = fetch): Promise<HubStatus> => {
  try {
    const response = await fetchFn(HUB_INFO_PATH);
    if (!response.ok) return { kind: "unreachable" };
    const info: unknown = await response.json();
    return isHubInfo(info) ? { kind: "connected", info } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
};

export const describeHubStatus = (status: HubStatus): string => {
  switch (status.kind) {
    case "checking":
      return "Connecting to the Hub…";
    case "connected":
      return "Connected to the Hub";
    case "unreachable":
      return "Can't reach the Hub";
  }
};

const isHubInfo = (value: unknown): value is HubInfo =>
  typeof value === "object" &&
  value !== null &&
  "product" in value &&
  value.product === "media-centre" &&
  "version" in value &&
  typeof value.version === "string" &&
  "hubId" in value &&
  typeof value.hubId === "string";
