import type { Page } from "@playwright/test";

/** The parts of Settings, as its menu names them. */
export type SettingsSectionName = "General" | "Rooms" | "TV" | "Aircon" | "Lights" | "Heating";

/** Opens Settings from the cog in the app bar, then this part of it from its menu, as Settings shows one part at a time. */
export const openSettingsOn = async (page: Page, section: SettingsSectionName): Promise<void> => {
  await page.getByRole("button", { name: "General settings" }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: section, exact: true }).click();
};
