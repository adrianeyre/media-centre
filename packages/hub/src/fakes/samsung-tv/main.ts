/**
 * Runs the fake Samsung TV as its own process, for tests that need one outside
 * Vitest, such as the Remote's end-to-end tests:
 *
 *   FAKE_TV_REST_PORT=18001 pnpm --filter @media-centre/hub fake-tv
 *
 * - `FAKE_TV_HOST` is the address to listen on (127.0.0.1 by default).
 * - `FAKE_TV_REST_PORT` is the REST port a real TV has on 8001 (by default
 *   8001; 0 picks a free one).
 * - `FAKE_TV_CONTROL_PORT` is the secure control socket's port, 8002 on a real
 *   TV and by default.
 * - `FAKE_TV_SSDP_PORT` is the UDP port it answers searches for TVs on, 1900
 *   on a real TV and by default. Searches must be sent to its own address: it
 *   doesn't join the multicast group.
 * - `FAKE_TV_WAKE_PORT` is the UDP port it listens for Wake-on-LAN magic
 *   packets on, sent to its own address. By default it picks a free one,
 *   which it prints: port 9, where they are broadcast on a real network,
 *   needs root to listen on.
 * - `FAKE_TV_UPNP_PORT` is the port it answers UPnP rendering-control calls
 *   on, for its volume and mute, 9197 on a real TV and by default.
 * - `FAKE_TV_FRAME=true` makes it a Frame TV, whose power key must be held to
 *   switch it off.
 * - `FAKE_TV_NAME` and `FAKE_TV_MAC` are the name and MAC address its device
 *   info reports, so that two fakes can be told apart.
 *
 * `GET /_fake/requests` returns the REST requests it has recorded,
 * `GET /_fake/connections` the connections to its control socket,
 * `GET /_fake/keys` the keys pressed on it and `GET /_fake/wakes` the packets
 * received on its Wake-on-LAN port; `DELETE` on any of them forgets them.
 * `GET /_fake/volume` returns its volume and mute, and `POST` with
 * `{"volume": 18}`, `{"muted": true}` or both changes them, as its own remote
 * would. `GET /_fake/keyboard` says whether its on-screen keyboard is open,
 * and `POST` with `{"open": true}` or `{"open": false}` opens or closes it, as
 * choosing a search box on the TV would; `GET /_fake/text` returns the text
 * typed into it, and `DELETE` forgets that. `GET /_fake/apps` returns its
 * installed apps, each with whether it is running and visible, and `PUT` with
 * a list such as `[{"id": "111299001912", "name": "YouTube", "icon": true}]`
 * installs those instead, as installing and removing apps on the TV would.
 * `GET /_fake/front` returns the id of the app in front, or null, and `POST`
 * with `{"app": "111299001912"}` brings that app to the front, launching it,
 * or with `{"app": null}` none, as live TV or another input would, as its own
 * remote would; it refuses in standby.
 * `GET /_fake/ignored-keys` returns the keys it ignores, none by default, and
 * `PUT` with `{"keys": ["KEY_PMODE"], "answer": "silence"}` ignores those
 * instead, as a model or firmware without them would: it records them, does
 * nothing with them, and says nothing, as far as we know a real TV doesn't,
 * or with `"answer": "error"` answers each with its error event.
 * `GET /_fake/developer` returns its Developer Mode and Developer IP, as its
 * device info reports them, and `PUT` with `{"mode": "on", "ip": "192.168.1.10"}`
 * changes them, as doing that at the TV and restarting it would, or with
 * `null` leaves both out of its device info, as firmware that doesn't report
 * them; `"ip": null` is none set.
 * Once the Player is installed, e.g. with `PUT /_fake/apps` and
 * `{"id": "MediaCntre.Player", "name": "Media Centre"}`, launching it runs a
 * fake Player, which connects to the Hub at the address it was launched with,
 * from the TV's own address, and plays what the Hub sends it through the
 * Player's fake playback. `GET /_fake/player` says whether it is running, the
 * Hub's address it has, whether it is connected, the URL of every Media File
 * the Hub sent it, and what its playback is doing.
 * `POST /_fake/revoke-access` refuses every token it has issued, as revoking
 * access on a real TV does. `POST /_fake/power` with
 * `{"power": "standby"}` or `{"power": "on"}` puts it in standby or switches it
 * on; stopping the process makes it unreachable.
 */
import { startFakeSamsungTv } from "./fake-samsung-tv.ts";

const portFrom = (variable: string, fallback: number): number => {
  const port = Number(process.env[variable] ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`${variable} must be a port number, not "${String(process.env[variable])}"`);
    process.exit(1);
  }
  return port;
};

const host = process.env.FAKE_TV_HOST ?? "127.0.0.1";
const restPort = portFrom("FAKE_TV_REST_PORT", 8001);
const controlPort = portFrom("FAKE_TV_CONTROL_PORT", 8002);
const ssdpPort = portFrom("FAKE_TV_SSDP_PORT", 1900);
const wakePort = portFrom("FAKE_TV_WAKE_PORT", 0);
const upnpPort = portFrom("FAKE_TV_UPNP_PORT", 9197);
const { FAKE_TV_NAME: name, FAKE_TV_MAC: macAddress, FAKE_TV_FRAME: frame } = process.env;
if (frame !== undefined && frame !== "true" && frame !== "false") {
  console.error(`FAKE_TV_FRAME must be "true" or "false", not "${frame}"`);
  process.exit(1);
}

const tv = await startFakeSamsungTv({
  host,
  restPort,
  controlPort,
  ssdpPort,
  wakePort,
  upnpPort,
  ...(frame === undefined ? {} : { frame: frame === "true" }),
  ...(name === undefined ? {} : { name }),
  ...(macAddress === undefined ? {} : { macAddress }),
});
console.log(
  `Fake Samsung TV listening on http://${tv.host}:${String(tv.restPort)}, control socket on ${String(tv.controlPort)}, ` +
    `answering searches on ${String(tv.ssdpPort)}, volume on ${String(tv.upnpPort)}, ` +
    `waking on ${String(tv.wakePort)}` +
    (frame === "true" ? ", as a Frame TV" : ""),
);

const stop = (): void => {
  void tv.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
