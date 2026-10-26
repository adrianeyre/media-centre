import { PLAYER_SOCKET_PATH } from "@media-centre/shared";

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HUB_ADDRESS = new RegExp(`^(?:(\\d{1,3}(?:\\.\\d{1,3}){3})|${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`);

/**
 * The Hub's address, as the Player is given it: an IPv4 address or a host
 * name, and the Hub's port, e.g. `192.168.1.10:41080`. Anything else is null,
 * so the Player never connects to, nor shows, whatever it was launched with.
 */
export const hubAddressIn = (text: string | null | undefined): string | null => {
  const address = (text ?? "").trim();
  const match = HUB_ADDRESS.exec(address);
  if (match === null) return null;
  const [, ipv4, port] = match;
  if (ipv4 !== undefined && ipv4.split(".").some((part) => Number(part) > 255)) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return null;
  return address;
};

/** Where the Player opens its WebSocket to the Hub at this address (ADR 0003). */
export const hubSocketUrl = (address: string): string => `ws://${address}${PLAYER_SOCKET_PATH}`;
