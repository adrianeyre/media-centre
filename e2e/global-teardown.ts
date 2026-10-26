import { rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Removes the database the run's Hub kept its state in (see `playwright.config.ts`). */
export default async function globalTeardown(): Promise<void> {
  const database = process.env.E2E_HUB_DATABASE;
  if (database) await rm(dirname(database), { recursive: true, force: true });
}
