/**
 * Runs the fake Lepro Light as its own process, for tests that need one
 * outside Vitest, such as the Remote's end-to-end tests:
 *
 *   FAKE_LIGHT_ID=bf0123456789abcdef01 FAKE_LIGHT_KEY=0123456789abcdef pnpm --filter @media-centre/hub fake-light
 *
 * - `FAKE_LIGHT_HOST` is the address to listen on (127.0.0.1 by default).
 * - `FAKE_LIGHT_PORT` is the TCP port a real Light takes connections on,
 *   6668 by default; 0 picks a free one.
 * - `FAKE_LIGHT_DISCOVERY_PORT` is the UDP port it answers searches on, 6667
 *   by default. Searches must be sent to its own address: it hears no
 *   broadcast, and makes none.
 * - `FAKE_LIGHT_HTTP_PORT` is the port of its `/_fake/` paths, which a real
 *   Light hasn't got, 6669 by default.
 * - `FAKE_LIGHT_ID` and `FAKE_LIGHT_KEY` are the id it answers to and the
 *   key, 16 printable characters, that it takes, both needed. It never
 *   prints them.
 * - `FAKE_LIGHT_CAPABILITIES` is what it is: `colour`, the default, which
 *   shows white at a colour temperature or a colour; `white`, white at a
 *   colour temperature only; or `plug`, on/off only.
 *
 * `GET /_fake/state` returns its data points' values, by number, and `POST`
 * with some of them, e.g. `{"20": false}` or `{"21": "colour", "24":
 * "00f003e803e8"}`, changes them, as Lepro's LampUX app would.
 * `GET /_fake/commands` returns the commands it received; `DELETE` forgets
 * them. `GET /_fake/capabilities` returns what it is and its data points.
 * Stopping the process makes it unreachable.
 */
import { FAKE_LIGHT_KINDS, startFakeLeproLight, type FakeLightKind } from "./fake-lepro-light.ts";

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
  FAKE_LIGHT_HOST: host = "127.0.0.1",
  FAKE_LIGHT_ID: id,
  FAKE_LIGHT_KEY: key,
  FAKE_LIGHT_CAPABILITIES: kind = "colour",
} = process.env;

// The id and key are never quoted back, even when wrong.
if (id === undefined || !/^[A-Za-z0-9]{1,64}$/.test(id)) fail("FAKE_LIGHT_ID must be letters and digits");
if (key === undefined || !/^[\x21-\x7e]{16}$/.test(key)) fail("FAKE_LIGHT_KEY must be 16 printable characters");
if (!(FAKE_LIGHT_KINDS as readonly string[]).includes(kind)) {
  fail(`FAKE_LIGHT_CAPABILITIES must be one of ${FAKE_LIGHT_KINDS.join(", ")}, not "${kind}"`);
}

const SAID: Readonly<Record<FakeLightKind, string>> = {
  colour: "a colour Light",
  white: "a white Light",
  plug: "a plug",
};

const light = await startFakeLeproLight({
  host,
  port: portFrom("FAKE_LIGHT_PORT", 6668),
  discoveryPort: portFrom("FAKE_LIGHT_DISCOVERY_PORT", 6667),
  httpPort: portFrom("FAKE_LIGHT_HTTP_PORT", 6669),
  kind: kind as FakeLightKind,
  ...(id === undefined ? {} : { id }),
  ...(key === undefined ? {} : { key }),
}).catch((error: unknown) =>
  fail(`The fake Lepro Light couldn't start: ${error instanceof Error ? error.message : String(error)}`),
);
console.log(
  `Fake Lepro Light listening on ${light.host}:${String(light.port)}, ${SAID[light.kind]}, ` +
    `answering searches on ${String(light.discoveryPort)}, ` +
    `its /_fake/ paths on http://${light.host}:${String(light.httpPort)}`,
);

const stop = (): void => {
  void light.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
