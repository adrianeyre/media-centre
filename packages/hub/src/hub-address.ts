import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import type { HubAddress } from "@media-centre/shared";

/** The Hub's network interfaces, by name, as `os.networkInterfaces` gives them. */
export type NetworkInterfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

/**
 * Interfaces a machine makes for its own containers and virtual machines, or
 * for a VPN, such as AWS Client VPN's TAP adapter or WireGuard's tunnel, which
 * no TV, nor phone at home, is on.
 */
const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vEthernet|cni|flannel|tun|tap|utun|wg|ppp|tailscale|zt)|vpn|tap-windows|wireguard|openvpn|zerotier/i;

/** The ranges a home network's addresses are in (RFC 1918). */
const isPrivate = (address: string): boolean => {
  const [first = 0, second = 0] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
};

/**
 * The Hub's IPv4 address on the home network, as far as it can tell from its
 * own network interfaces: not loopback, nor link-local, which no router gave
 * it, preferring a real interface to a virtual one and a private address to
 * any other. Null when it has none. A machine on more than one network may
 * choose wrong, which is why Settings can set the address instead.
 */
export const findHubAddress = (interfaces: NetworkInterfaces = networkInterfaces): string | null => {
  const candidates = Object.entries(interfaces()).flatMap(([name, addresses = []]) =>
    addresses
      .filter(({ family, internal, address }) => family === "IPv4" && !internal && !address.startsWith("169.254."))
      .map(({ address }) => ({ address, virtual: VIRTUAL_INTERFACE.test(name) })),
  );
  const rank = ({ address, virtual }: (typeof candidates)[number]): number =>
    (virtual ? 2 : 0) + (isPrivate(address) ? 0 : 1);
  return candidates.toSorted((a, b) => rank(a) - rank(b))[0]?.address ?? null;
};

/** Why the Hub refused an address for itself. The message is written for the person using the Remote. */
export class HubAddressRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubAddressRefusal";
  }
}

export interface HubAddressStore {
  /** The address to use, the one found and the one set in Settings, now. */
  readonly read: () => HubAddress;
  /**
   * Sets the IPv4 address to use instead of the one found, or with null goes
   * back to that one. Refuses anything else.
   */
  readonly setOverride: (override: string | null) => HubAddress;
}

/**
 * The Hub's own address on the home network, which a TV is given as its
 * Developer IP (FR-29). The one it finds is looked for afresh each time, as
 * the network may give it another; the one set in Settings is kept in the
 * Hub's database, so it survives a restart (NFR-4).
 */
export const hubAddressStore = (
  database: DatabaseSync,
  interfaces: NetworkInterfaces = networkInterfaces,
): HubAddressStore => {
  const read = (): HubAddress => {
    const { address_override: override } = database.prepare("SELECT address_override FROM hub").get() as {
      address_override: string | null;
    };
    const found = findHubAddress(interfaces);
    return { address: override ?? found, found, override };
  };

  return {
    read,
    setOverride: (asked) => {
      const override = asked?.trim() ?? "";
      if (override !== "" && isIP(override) !== 4) {
        throw new HubAddressRefusal("Give the Hub's IP address as four numbers with dots, e.g. 192.168.1.10.");
      }
      database.prepare("UPDATE hub SET address_override = ?").run(override === "" ? null : override);
      return read();
    },
  };
};
