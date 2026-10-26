/**
 * Writes `packages/hub/src/bluetooth/assigned-numbers.json` from the Bluetooth
 * SIG's assigned numbers: the company each id in a device's advertisement
 * stands for, and the name of each 16-bit service UUID, the SIG's own and
 * its members'. The Hub reads it to name what it hears in a Bluetooth scan,
 * offline (NFR-3). Run it again to take in what the SIG has added since.
 *
 *   node scripts/bluetooth-assigned-numbers.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers";

/** Each `value:` or `uuid:` and the `name:` after it, as the SIG's YAML lists them. */
const entriesIn = (yaml: string, key: "value" | "uuid"): [string, string][] => {
  const entries: [string, string][] = [];
  const pattern = new RegExp(
    `-\\s+${key}:\\s*0x([0-9A-Fa-f]+)\\s*\\n\\s+name:\\s*(?:'((?:[^']|'')*)'|"([^"]*)"|(.+))`,
    "g",
  );
  for (const match of yaml.matchAll(pattern)) {
    const [, number = "", single, double, plain] = match;
    const name = (single?.replaceAll("''", "'") ?? double ?? plain ?? "").trim().replace(/\s+/g, " ");
    entries.push([number.toLowerCase().padStart(4, "0"), name]);
  }
  return entries;
};

const fetchYaml = async (path: string): Promise<string> => {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) throw new Error(`The Bluetooth SIG's ${path} answered ${String(response.status)}`);
  return response.text();
};

const companies = entriesIn(await fetchYaml("company_identifiers/company_identifiers.yaml"), "value");
const services = [
  ...entriesIn(await fetchYaml("uuids/service_uuids.yaml"), "uuid"),
  ...entriesIn(await fetchYaml("uuids/member_uuids.yaml"), "uuid"),
];
if (companies.length < 1_000 || services.length < 50) {
  throw new Error(`Read only ${String(companies.length)} companies and ${String(services.length)} services`);
}

const sorted = (entries: [string, string][]) =>
  Object.fromEntries(entries.toSorted(([a], [b]) => Number.parseInt(a, 16) - Number.parseInt(b, 16)));
const file = resolve(import.meta.dirname, "../packages/hub/src/bluetooth/assigned-numbers.json");
writeFileSync(file, `${JSON.stringify({ companies: sorted(companies), services: sorted(services) }, null, 1)}\n`);
console.log(`Wrote ${String(companies.length)} companies and ${String(services.length)} services to ${file}`);
