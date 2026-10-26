import { COLOUR_MODES, THEMES, type Appearance, type ColourMode } from "./appearance.ts";
import { Icon, type IconName } from "./icons.tsx";

const MODE_ICONS: Readonly<Record<ColourMode, IconName>> = { system: "monitor", light: "sun", dark: "moon" };

export interface AppearanceSettingsProps {
  readonly appearance: Appearance;
  /** Called with each choice as it is made, which the Remote takes on at once. */
  readonly onChange: (appearance: Appearance) => void;
}

/**
 * How this Remote looks, in Settings' General, which the cog in the app bar
 * opens: light, dark, or following the device, and one of the themes, each
 * shown in its own colours. Every choice shows at once, and is this Remote's
 * own, kept in the browser.
 */
export const AppearanceSettings = ({ appearance, onChange }: AppearanceSettingsProps) => (
  <section aria-labelledby="settings-appearance" class="appearance-settings">
    <h2 id="settings-appearance">Appearance</h2>
    <fieldset class="appearance-modes">
      <legend>Mode</legend>
      <div class="segmented">
        {COLOUR_MODES.map(({ id, label }) => (
          <label key={id} class="segment">
            <input
              type="radio"
              name="colour-mode"
              value={id}
              checked={appearance.mode === id}
              onChange={() => {
                onChange({ ...appearance, mode: id });
              }}
            />
            <Icon name={MODE_ICONS[id]} />
            {label}
          </label>
        ))}
      </div>
      <p class="appearance-note">System follows your device's light or dark setting.</p>
    </fieldset>
    <fieldset class="appearance-themes">
      <legend>Theme</legend>
      <div class="theme-choices">
        {THEMES.map(({ id, label }) => (
          <label key={id} class="theme-choice" data-theme={id}>
            <input
              type="radio"
              name="theme"
              value={id}
              checked={appearance.theme === id}
              onChange={() => {
                onChange({ ...appearance, theme: id });
              }}
            />
            <span class="theme-swatch" aria-hidden="true">
              <span class="theme-swatch-accent" />
              <span class="theme-swatch-soft" />
              <span class="theme-swatch-surface" />
            </span>
            <span class="theme-name">{label}</span>
            <span class="theme-check" aria-hidden="true">
              <Icon name="check" />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  </section>
);
