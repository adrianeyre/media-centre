/**
 * Runs the fake Hive cloud as its own process, for tests that need one
 * outside Vitest, such as the Remote's end-to-end tests:
 *
 *   FAKE_HIVE_CLOUD_ACCOUNT=owner@example.com FAKE_HIVE_CLOUD_PASSWORD=… pnpm --filter @media-centre/hub fake-hive-cloud
 *
 * - `FAKE_HIVE_CLOUD_HOST` is the address to listen on (127.0.0.1 by default).
 * - `FAKE_HIVE_CLOUD_PORT` is its port, 8092 by default; 0 picks a free one.
 *   Give the Hub both `HIVE_URL` and `HIVE_AUTH_URL` as `http://<host>:<port>`
 *   to use it.
 * - `FAKE_HIVE_CLOUD_ACCOUNT` and `FAKE_HIVE_CLOUD_PASSWORD` are the Hive
 *   account owner's email and password, the one login it signs in, refusing
 *   any other. It never prints the password.
 * - `FAKE_HIVE_CLOUD_CODE`, when set, is the code it asks for as it signs a
 *   new device in, as Hive texts one, and the only one it takes. Left out, it
 *   asks for none. It never prints it.
 * - `FAKE_HIVE_CLOUD_HEATING` is its Heating zones' names, separated by
 *   commas, "Downstairs,Upstairs" by default; `FAKE_HIVE_CLOUD_RADIATOR_VALVES`
 *   its Radiator Valves, each `<name>:<its Heating's name>`, separated by
 *   commas, "Bedroom:Upstairs,Study:Upstairs,Living Room:Downstairs" by
 *   default; and `FAKE_HIVE_CLOUD_HOT_WATER`, `true`, the default, or
 *   `false`, whether it has the Hot Water. Either list may be empty.
 *
 * `GET /_fake/state` says each product's state, and `POST /_fake/state` with
 * `{"id": "…", …}`, or a list of them, changes one as Hive's app would:
 * `mode`, "schedule", "manual" or "off", or the Hot Water's "on"; `target`;
 * `boost`, in minutes, with a `target`, or null to cancel it; `temperature`;
 * `working`; `online`, false taking a Radiator Valve offline; `battery`; and
 * `refusesChanges`, true for it to refuse every change as Hive refuses one it
 * won't take. `PUT /_fake/products` with `[{"kind": "heating", "name":
 * "Downstairs"}, …]` replaces the products. `POST /_fake/revoke` refuses
 * every token from then on, and with `{"devices": true}` forgets the trusted
 * devices too. `POST /_fake/clock` with `{"minutes": 30}` moves its clock on,
 * counting each Boost down and expiring tokens after 60 minutes and a code's
 * wait after 3. `GET /_fake/requests` lists the requests it answered, each
 * with whether it took it, and `DELETE` forgets them. `POST /_fake/outage`
 * with `{"down": true}` drops every connection but those to `/_fake/`
 * unanswered, as the internet going down, keeping its products, tokens and
 * trusted devices, and `{"down": false}` brings it back, as Hive coming back.
 * Stopping the process is the internet going down too, but it forgets the
 * tokens it issued, so that the Hub must sign in again.
 */
import { startFakeHiveCloud, type FakeHiveProduct } from "./fake-hive-cloud.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const {
  FAKE_HIVE_CLOUD_HOST: host = "127.0.0.1",
  FAKE_HIVE_CLOUD_PORT: portText = "8092",
  FAKE_HIVE_CLOUD_ACCOUNT: account,
  FAKE_HIVE_CLOUD_PASSWORD: password,
  FAKE_HIVE_CLOUD_CODE: code,
  FAKE_HIVE_CLOUD_HEATING: heatingText = "Downstairs,Upstairs",
  FAKE_HIVE_CLOUD_RADIATOR_VALVES: valvesText = "Bedroom:Upstairs,Study:Upstairs,Living Room:Downstairs",
  FAKE_HIVE_CLOUD_HOT_WATER: hotWaterText = "true",
} = process.env;

const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65_535)
  fail(`FAKE_HIVE_CLOUD_PORT must be a port number, not "${portText}"`);
if (account === undefined || account === "") fail("FAKE_HIVE_CLOUD_ACCOUNT must be the account it signs in");
if (password === undefined || password === "") fail("FAKE_HIVE_CLOUD_PASSWORD must be that account's password");
if (hotWaterText !== "true" && hotWaterText !== "false")
  fail(`FAKE_HIVE_CLOUD_HOT_WATER must be true or false, not "${hotWaterText}"`);

const names = (text: string): string[] =>
  text
    .split(",")
    .map((each) => each.trim())
    .filter((each) => each !== "");

const heatings = names(heatingText);
const products: FakeHiveProduct[] = [
  ...heatings.map((name) => ({ kind: "heating" as const, name })),
  ...names(valvesText).map((each) => {
    const [name = "", zone = ""] = each.split(":").map((part) => part.trim());
    if (name === "" || !heatings.includes(zone)) {
      fail(
        `FAKE_HIVE_CLOUD_RADIATOR_VALVES must be <name>:<Heating> separated by commas, each Heating one of FAKE_HIVE_CLOUD_HEATING's, not "${each}"`,
      );
    }
    return { kind: "radiator-valve" as const, name, zone };
  }),
  ...(hotWaterText === "true" ? [{ kind: "hot-water" as const, name: "Hot Water" }] : []),
];

const cloud = await startFakeHiveCloud({
  host,
  port,
  account: account ?? "",
  password: password ?? "",
  ...(code === undefined || code === "" ? {} : { code }),
  products,
}).catch((error: unknown) =>
  fail(`The fake Hive cloud couldn't start: ${error instanceof Error ? error.message : String(error)}`),
);
const count = (kind: FakeHiveProduct["kind"]): string =>
  String(products.filter((product) => product.kind === kind).length);
console.log(
  `Fake Hive cloud listening on ${cloud.url}, with ${count("heating")} Heating zones, ${count(
    "radiator-valve",
  )} Radiator Valves and ${count("hot-water")} Hot Water, ${code === undefined || code === "" ? "asking for no code" : "asking for a code"}`,
);

const stop = (): void => {
  void cloud.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
