/**
 * The Samsung TV Driver's search for TVs over SSDP (FR-12): an `M-SEARCH`
 * sent to the SSDP multicast group, which every Samsung TV on the subnet
 * answers with where it is. Multicast doesn't cross routers, so it only finds
 * TVs on the Hub's own subnet (FR-2, ADR 0007). Only the Driver knows this
 * protocol (NFR-6).
 */
import { createSocket, type RemoteInfo } from "node:dgram";
import { isIP } from "node:net";

/** Where a search goes on a home network: everything that answers SSDP listens here. */
export const SSDP_MULTICAST: SsdpTarget = { host: "239.255.255.250", port: 1900 };

/** The UPnP type a 2016 or later Samsung TV answers as, and the one searched for. */
export const SAMSUNG_TV_SEARCH_TARGET = "urn:samsung.com:device:RemoteControlReceiver:1";

/** The search target that asks everything on the subnet to answer. */
export const SEARCH_ALL = "ssdp:all";

/** Where to send a search: the multicast group, or one TV's own address. */
export interface SsdpTarget {
  readonly host: string;
  readonly port: number;
}

/** One SSDP message: its start line and its headers, whose names are lower-cased. */
export interface SsdpMessage {
  readonly startLine: string;
  readonly headers: ReadonlyMap<string, string>;
}

/**
 * How long a TV may wait to answer, in seconds. Each waits a random part of
 * it, so that a subnet full of them doesn't answer at once.
 */
const MAX_WAIT_SECONDS = 2;

/** The `M-SEARCH` for Samsung TVs. */
export const searchRequest = (target: SsdpTarget): string =>
  [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${target.host}:${String(target.port)}`,
    'MAN: "ssdp:discover"',
    `MX: ${String(MAX_WAIT_SECONDS)}`,
    `ST: ${SAMSUNG_TV_SEARCH_TARGET}`,
    "",
    "",
  ].join("\r\n");

/** Reads an SSDP message, which is HTTP over UDP: a start line, then headers. */
export const parseSsdpMessage = (text: string): SsdpMessage => {
  const [startLine = "", ...lines] = text.split(/\r?\n/);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { startLine: startLine.trim(), headers };
};

/**
 * The address of the TV that sent `message`, or undefined if it isn't a
 * Samsung TV's answer to the search. A TV says where it is in `LOCATION`;
 * failing that, it is where the answer came from.
 */
export const answeringTv = (message: SsdpMessage, from: RemoteInfo): string | undefined => {
  if (!/^HTTP\/1\.1 200\b/i.test(message.startLine)) return undefined;
  if (message.headers.get("st") !== SAMSUNG_TV_SEARCH_TARGET) return undefined;
  const location = message.headers.get("location");
  const host = location === undefined || !URL.canParse(location) ? "" : new URL(location).hostname;
  return isIP(host) === 4 ? host : from.address;
};

export interface SearchOptions {
  /** By default, the multicast group. Tests send to each fake TV instead. */
  readonly targets?: readonly SsdpTarget[];
  /** How long to listen for answers: a real TV may take up to 2 seconds. */
  readonly windowMs: number;
}

/**
 * Searches for Samsung TVs and resolves, once `windowMs` has passed, with the
 * address of each that answered, once each. Rejects if the search can't be
 * sent at all, e.g. with no network.
 */
export const searchForSamsungTvs = ({ targets = [SSDP_MULTICAST], windowMs }: SearchOptions): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4" });
    const found = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error === undefined) resolve([...found]);
      else reject(error);
    };

    socket.on("error", finish);
    socket.on("message", (data, from) => {
      const address = answeringTv(parseSsdpMessage(data.toString("utf8")), from);
      if (address !== undefined) found.add(address);
    });
    socket.bind(0, () => {
      // Two hops, as UPnP asks, so a search never leaves the home.
      socket.setMulticastTTL(2);
      let sending = targets.length;
      const sent = (error: Error | null): void => {
        if (error) {
          finish(error);
          return;
        }
        sending -= 1;
        if (sending === 0) timer = setTimeout(finish, windowMs);
      };
      for (const target of targets) {
        try {
          socket.send(searchRequest(target), target.port, target.host, sent);
        } catch (error) {
          finish(error as Error);
          return;
        }
      }
      if (targets.length === 0) finish();
    });
  });
