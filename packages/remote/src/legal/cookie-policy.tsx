import { ISSUES_URL } from "../about.ts";
import { APPEARANCE_KEY } from "../appearance.ts";
import { BLUETOOTH_SCAN_CACHE_KEY, NETWORK_SCAN_CACHE_KEY, NETWORK_VIEW_KEY } from "../network-tab.tsx";
import { ROOMS_TAB_ROOM_KEY } from "../rooms-tab.tsx";
import { SELECTED_TV_KEY } from "../selected-tv.ts";
import { LAST_SETTINGS_SECTION_KEY } from "../settings-sections.ts";
import { LAST_TAB_KEY } from "../tabs.ts";
import {
  AIRCON_WIDGET_LAYOUT_KEY,
  AMAZON_WIDGET_LAYOUT_KEY,
  BLUETOOTH_WIDGET_LAYOUT_KEY,
  HEATING_WIDGET_LAYOUT_KEY,
  LIGHTS_WIDGET_LAYOUT_KEY,
  NETWORK_WIDGET_LAYOUT_KEY,
  RING_WIDGET_LAYOUT_KEY,
  TV_WIDGET_LAYOUT_KEY,
  roomWidgetLayoutKey,
} from "../widget-layout.ts";

/** Everything the Remote keeps in this browser, and why. */
const STORED = [
  {
    name: LAST_TAB_KEY,
    type: "Preference",
    purpose: "The tab you were last on, so the Remote reopens on it.",
  },
  {
    name: SELECTED_TV_KEY,
    type: "Preference",
    purpose: "Your Selected TV, so each phone or tablet controls the TV you last chose on it.",
  },
  {
    name: APPEARANCE_KEY,
    type: "Preference",
    purpose: "Light or dark, and the colour theme you chose for this Remote.",
  },
  {
    name: LAST_SETTINGS_SECTION_KEY,
    type: "Preference",
    purpose: "The part of Settings you were last in, so Settings reopens on it.",
  },
  {
    name: ROOMS_TAB_ROOM_KEY,
    type: "Preference",
    purpose: "The Room you were last looking at on the Rooms tab.",
  },
  {
    name: NETWORK_VIEW_KEY,
    type: "Preference",
    purpose: "Whether the Network tab shows your home network or the Bluetooth devices near the Hub.",
  },
  ...(
    [
      [TV_WIDGET_LAYOUT_KEY, "TV"],
      [AIRCON_WIDGET_LAYOUT_KEY, "Aircon"],
      [LIGHTS_WIDGET_LAYOUT_KEY, "Lights"],
      [HEATING_WIDGET_LAYOUT_KEY, "Heating"],
      [NETWORK_WIDGET_LAYOUT_KEY, "Network"],
      [BLUETOOTH_WIDGET_LAYOUT_KEY, "Bluetooth"],
      [AMAZON_WIDGET_LAYOUT_KEY, "Amazon"],
      [RING_WIDGET_LAYOUT_KEY, "Ring"],
    ] as const
  ).map(([name, tab]) => ({
    name,
    type: "Preference",
    purpose: `Where you put, sized and hid each widget on the ${tab} tab.`,
  })),
  {
    name: roomWidgetLayoutKey("…"),
    type: "Preference",
    purpose: "Where you put, sized and hid each widget for each Room on the Rooms tab, one item per Room.",
  },
  {
    name: NETWORK_SCAN_CACHE_KEY,
    type: "Saved copy",
    purpose:
      "The last network scan this Remote showed: each device's address, maker, name and open ports, so the Network tab opens at once.",
  },
  {
    name: BLUETOOTH_SCAN_CACHE_KEY,
    type: "Saved copy",
    purpose: "The last Bluetooth scan this Remote showed, so the Network tab opens at once.",
  },
] as const;

/** The Cookie Policy, shown in its dialog from the footer. */
export const CookiePolicy = () => (
  <>
    <p class="policy-updated">Effective: 26 October 2026</p>

    <h3>About this policy</h3>
    <p>
      This policy explains how Media Centre uses cookies and similar technologies, such as your browser&rsquo;s local
      storage: small pieces of data saved on your device that help an app work and remember your choices.
    </p>

    <h3>How we use them</h3>
    <p>
      Media Centre sets <strong>no cookies</strong>. It keeps only <strong>strictly necessary</strong> items in local
      storage: your preferences for this Remote, and saved copies that let a tab open at once. There are{" "}
      <strong>no</strong> analytics, tracking, profiling or advertising technologies, and nothing kept here is sent to
      anyone. As nothing is stored that you need to agree to, there is no cookie banner.
    </p>

    <h3>What we store</h3>
    <p>
      Everything stays in this browser, on this device: each phone, tablet or computer is its own Remote, with its own
      preferences.
    </p>
    {/* Wider than a phone, so it scrolls across on its own, rather than the whole page. */}
    <div class="table-scroll" tabIndex={0} role="region" aria-labelledby="cookie-table-caption">
      <table>
        <caption id="cookie-table-caption">What the Remote may save in this browser's local storage.</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Purpose</th>
            <th scope="col">Expiry</th>
          </tr>
        </thead>
        <tbody>
          {STORED.map((item) => (
            <tr key={item.name}>
              <td>
                <code>{item.name}</code>
              </td>
              <td>{item.type}</td>
              <td>{item.purpose}</td>
              <td>Until you clear it</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <h3>Third parties</h3>
    <p>
      The Remote loads no third-party fonts, scripts or trackers. Once you connect them, the Amazon tab shows cover art
      from Amazon&rsquo;s image servers, and the Ring tab plays live video and recordings from Ring&rsquo;s, as the
      Privacy Policy explains. Those requests go straight to Amazon and Ring, under their own cookie policies.
    </p>

    <h3>Managing storage</h3>
    <p>
      You can clear local storage at any time in your browser&rsquo;s settings. The Remote keeps working, but opens on
      the TV tab, with the first TV selected, the default look and every widget where it started.
    </p>

    <h3>Changes to this policy</h3>
    <p>
      If the Remote starts keeping anything new in your browser, this policy changes with it, in the same release, with
      a new effective date.
    </p>

    <h3>Contact us</h3>
    <p>
      If you have a question about this policy, please{" "}
      <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
        open an issue on GitHub (opens in a new tab)
      </a>
      .
    </p>
  </>
);
