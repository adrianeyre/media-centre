import { useState } from "preact/hooks";

import { applianceAppIconPath, type ApplianceApp } from "@media-centre/shared";

/** The first letter of the name, as the person reads it, whatever its script. */
const firstLetter = (name: string): string =>
  (new Intl.Segmenter().segment(name)[Symbol.iterator]().next().value?.segment ?? "").toUpperCase();

export interface AppIconProps {
  /** The Appliance the app is on. */
  readonly applianceId: number;
  readonly app: ApplianceApp;
}

/**
 * An app's icon, from the Hub, where the Appliance gives one, and its first
 * letter where it doesn't, or the icon won't load. It is decoration: the
 * app's name is always beside it.
 */
export const AppIcon = ({ applianceId, app }: AppIconProps) => {
  const [broken, setBroken] = useState(false);
  return app.icon && !broken ? (
    <img
      class="app-icon"
      src={applianceAppIconPath(applianceId, app.id)}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      onError={() => {
        setBroken(true);
      }}
    />
  ) : (
    // Drawn by the style rather than written in, so that it isn't read as part of
    // the name of the button it is on (WCAG 2.5.3).
    <span class="app-icon app-icon-none" data-letter={firstLetter(app.name)} aria-hidden="true" />
  );
};
