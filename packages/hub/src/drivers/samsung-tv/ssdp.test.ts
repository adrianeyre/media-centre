import type { RemoteInfo } from "node:dgram";

import { describe, expect, it } from "vitest";

import { answeringTv, parseSsdpMessage, SAMSUNG_TV_SEARCH_TARGET, searchRequest, SSDP_MULTICAST } from "./ssdp.ts";

/** A TV's address. A URL with it is built, as the Driver builds them, never written out. */
const TV = "192.168.1.20";
const location = `http://${TV}:7676/smp_15_`;

const from = (address: string): RemoteInfo => ({ address, family: "IPv4", port: 1900, size: 0 });

const answer = (headers: Record<string, string>, startLine = "HTTP/1.1 200 OK"): string =>
  [startLine, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n");

describe("an SSDP search for Samsung TVs", () => {
  it("is an M-SEARCH for the type Samsung TVs answer as, sent to the multicast group", () => {
    expect(searchRequest(SSDP_MULTICAST)).toBe(
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 2\r\n" +
        "ST: urn:samsung.com:device:RemoteControlReceiver:1\r\n" +
        "\r\n",
    );
  });

  it("reads headers whatever their case and spacing", () => {
    const message = parseSsdpMessage(`HTTP/1.1 200 OK\r\nst:urn:x\r\nLocation :  ${location}\r\nEXT:\r\n\r\n`);

    expect(message.startLine).toBe("HTTP/1.1 200 OK");
    expect(Object.fromEntries(message.headers)).toEqual({ st: "urn:x", location, ext: "" });
  });

  it("takes a TV's address from where it says it is", () => {
    const message = parseSsdpMessage(answer({ ST: SAMSUNG_TV_SEARCH_TARGET, LOCATION: location }));

    expect(answeringTv(message, from("192.168.1.99"))).toBe(TV);
  });

  it("falls back to where the answer came from, without a usable LOCATION", () => {
    const named = "tv.local";
    for (const where of [undefined, "not a URL", `http://${named}:7676/`]) {
      const headers = { ST: SAMSUNG_TV_SEARCH_TARGET, ...(where === undefined ? {} : { LOCATION: where }) };
      expect(answeringTv(parseSsdpMessage(answer(headers)), from("192.168.1.21"))).toBe("192.168.1.21");
    }
  });

  it("ignores anything that isn't a Samsung TV's answer", () => {
    for (const message of [
      answer({ ST: "urn:schemas-upnp-org:device:MediaRenderer:1", LOCATION: location }),
      answer({ LOCATION: location }),
      answer({ ST: SAMSUNG_TV_SEARCH_TARGET, LOCATION: location }, "HTTP/1.1 404 Not Found"),
      answer({ ST: SAMSUNG_TV_SEARCH_TARGET, HOST: "239.255.255.250:1900" }, "M-SEARCH * HTTP/1.1"),
      answer({ NT: SAMSUNG_TV_SEARCH_TARGET, NTS: "ssdp:alive", LOCATION: location }, "NOTIFY * HTTP/1.1"),
    ]) {
      expect(answeringTv(parseSsdpMessage(message), from(TV))).toBeUndefined();
    }
  });
});
