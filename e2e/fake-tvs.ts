/**
 * The fake Samsung TVs the end-to-end run starts beside its Hub, each at its
 * own loopback address, as two TVs on the home network would be. They share
 * ports off a real TV's, which the run's Hub is told to use, and the Hub
 * searches each one's own address for TVs, as multicast can't be relied on here.
 */
export const FAKE_TV_REST_PORT = 18_001;
export const FAKE_TV_CONTROL_PORT = 18_002;
/** Where each fake TV answers searches for TVs, which the run's Hub sends to each, not the multicast group. */
export const FAKE_TV_SSDP_PORT = 11_900;
/** Where each fake TV hears Wake-on-LAN, which the run's Hub sends to each TV's own address, not broadcast. */
export const FAKE_TV_WAKE_PORT = 10_009;
/** Where each fake TV answers for its volume, which the run's Hub is told to use rather than a real TV's port. */
export const FAKE_TV_UPNP_PORT = 19_197;

export const FAKE_TVS = {
  living: { host: "127.0.0.2", name: "[TV] Living room", macAddress: "02:00:00:00:00:02" },
  bedroom: { host: "127.0.0.3", name: "[TV] Bedroom", macAddress: "02:00:00:00:00:03" },
} as const;

/**
 * A third fake TV, on the same ports, which the run doesn't start: a test
 * that needs a TV it can switch off at the wall, or a Frame TV, starts this
 * one itself.
 */
export const SPARE_FAKE_TV = { host: "127.0.0.4", name: "[TV] Spare", macAddress: "02:00:00:00:00:04" } as const;

/** Where a fake TV answers the run, outside what a real TV has (see the fake's `main.ts`). */
export const fakeTvUrl = (
  host: string,
  path:
    | "/_fake/requests"
    | "/_fake/connections"
    | "/_fake/keys"
    | "/_fake/wakes"
    | "/_fake/revoke-access"
    | "/_fake/power"
    | "/_fake/volume"
    | "/_fake/keyboard"
    | "/_fake/text"
    | "/_fake/apps"
    | "/_fake/front"
    | "/_fake/developer"
    | "/_fake/ignored-keys"
    | "/_fake/player",
): string => `http://${host}:${String(FAKE_TV_REST_PORT)}${path}`;

/**
 * A fake TV at the address the browser's Player connects to the Hub from, on
 * the same ports, which the run doesn't start: the Player's tests start it, so
 * that the Hub has a TV for the Player to be on.
 */
export const PLAYER_FAKE_TV = { host: "127.0.0.1", name: "[TV] Player", macAddress: "02:00:00:00:00:01" } as const;
