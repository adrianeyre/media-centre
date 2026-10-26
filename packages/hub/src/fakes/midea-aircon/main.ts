/**
 * Runs the fake Midea Air Conditioner as its own process, for tests that need
 * one outside Vitest, such as the Remote's end-to-end tests:
 *
 *   FAKE_AIRCON_PORT=16444 pnpm --filter @media-centre/hub fake-aircon
 *
 * - `FAKE_AIRCON_HOST` is the address to listen on (127.0.0.1 by default).
 * - `FAKE_AIRCON_PORT` is the TCP port a real unit takes commands on, 6444 by
 *   default; 0 picks a free one.
 * - `FAKE_AIRCON_DISCOVERY_PORT` is the UDP port it answers discovery on,
 *   6445 by default. Searches must be sent to its own address: it hears no
 *   broadcast.
 * - `FAKE_AIRCON_HTTP_PORT` is the port of its `/_fake/` paths, which a real
 *   unit hasn't got, 6446 by default.
 * - `FAKE_AIRCON_VERSION` is its protocol version, 2 by default, or 3, which
 *   needs `FAKE_AIRCON_TOKEN` and `FAKE_AIRCON_KEY`: the token and key, in
 *   hex, 64 and 32 bytes, that it expects in the handshake. It never prints
 *   them.
 * - `FAKE_AIRCON_ID`, `FAKE_AIRCON_SERIAL` and `FAKE_AIRCON_NAME` are the id,
 *   serial number and name it answers discovery with, so that two fakes can
 *   be told apart.
 * - `FAKE_AIRCON_CAPABILITIES` is what it has, its features separated by
 *   commas (see `FAKE_AIRCON_FEATURES`), e.g. `cool,heat,fan-auto,display`,
 *   or `all`, the default.
 *
 * `GET /_fake/state` returns its state, and `POST` with part of it, e.g.
 * `{"power": true, "mode": "heat", "roomTemperature": 19.5}`, changes it, as
 * its own remote, or the weather, would. `GET /_fake/commands` returns the
 * commands it received, and `GET /_fake/connections` the connections made to
 * it, with what became of each one's handshake; `DELETE` on either forgets
 * them. `GET /_fake/capabilities` returns its version, features and
 * temperature ranges. On v3, `POST /_fake/keys` with `{"token": "…", "key":
 * "…"}` has it expect those from then on, refusing the old ones, as after a
 * factory reset. Stopping the process makes it unreachable.
 */
import {
  FAKE_AIRCON_FEATURES,
  startFakeMideaAircon,
  type FakeAirconFeature,
  type FakeMideaAirconOptions,
} from "./fake-midea-aircon.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const portFrom = (variable: string, fallback: number): number => {
  const port = Number(process.env[variable] ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    fail(`${variable} must be a port number, not "${String(process.env[variable])}"`);
  }
  return port;
};

const {
  FAKE_AIRCON_HOST: host = "127.0.0.1",
  FAKE_AIRCON_VERSION: versionText = "2",
  FAKE_AIRCON_TOKEN: token,
  FAKE_AIRCON_KEY: key,
  FAKE_AIRCON_ID: idText,
  FAKE_AIRCON_SERIAL: serialNumber,
  FAKE_AIRCON_NAME: name,
  FAKE_AIRCON_CAPABILITIES: capabilities = "all",
} = process.env;

if (versionText !== "2" && versionText !== "3") fail(`FAKE_AIRCON_VERSION must be 2 or 3, not "${versionText}"`);
const version = versionText === "3" ? 3 : 2;
// The token and key are never quoted back, even when wrong.
if (version === 3 && !/^[0-9a-fA-F]{128}$/.test(token ?? ""))
  fail("FAKE_AIRCON_TOKEN must be 64 bytes, in hex, for v3");
if (version === 3 && !/^[0-9a-fA-F]{64}$/.test(key ?? "")) fail("FAKE_AIRCON_KEY must be 32 bytes, in hex, for v3");
const id = idText === undefined ? undefined : Number(idText);
if (id !== undefined && (!Number.isSafeInteger(id) || id < 0 || id >= 2 ** 48)) {
  fail(`FAKE_AIRCON_ID must be a whole number below 2^48, not "${String(idText)}"`);
}
const features =
  capabilities === "all"
    ? FAKE_AIRCON_FEATURES
    : capabilities
        .split(",")
        .map((each) => each.trim())
        .filter((each) => each !== "");
const unknown = features.filter((each) => !(FAKE_AIRCON_FEATURES as readonly string[]).includes(each));
if (unknown.length > 0) {
  fail(`FAKE_AIRCON_CAPABILITIES has ${unknown.join(", ")}, which aren't among ${FAKE_AIRCON_FEATURES.join(", ")}`);
}

const options: FakeMideaAirconOptions = {
  host,
  port: portFrom("FAKE_AIRCON_PORT", 6444),
  discoveryPort: portFrom("FAKE_AIRCON_DISCOVERY_PORT", 6445),
  httpPort: portFrom("FAKE_AIRCON_HTTP_PORT", 6446),
  version,
  features: features as FakeAirconFeature[],
  ...(version === 3 && token !== undefined && key !== undefined ? { token, key } : {}),
  ...(id === undefined ? {} : { id }),
  ...(serialNumber === undefined ? {} : { serialNumber }),
  ...(name === undefined ? {} : { name }),
};

const aircon = await startFakeMideaAircon(options).catch((error: unknown) =>
  fail(`The fake Midea Air Conditioner couldn't start: ${error instanceof Error ? error.message : String(error)}`),
);
console.log(
  `Fake Midea Air Conditioner listening on ${aircon.host}:${String(aircon.port)}, on protocol v${String(aircon.version)}, ` +
    `answering discovery on ${String(aircon.discoveryPort)}, ` +
    `its /_fake/ paths on http://${aircon.host}:${String(aircon.httpPort)}`,
);

const stop = (): void => {
  void aircon.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
