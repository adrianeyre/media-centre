import { ISSUES_URL } from "../about.ts";
import { Icon } from "../icons.tsx";

/** The accessibility statement, shown in its dialog from the footer. */
export const AccessibilityStatement = () => (
  <>
    <p class="policy-updated">Prepared: 26 October 2026</p>

    <div class="status-box">
      <Icon name="shield-check" />
      <p>
        <strong>Conformance status:</strong> Media Centre is built to meet the Web Content Accessibility Guidelines
        (WCAG) 2.2 at <strong>Level AA</strong>.
      </p>
    </div>

    <h3>Our commitment</h3>
    <p>
      Everyone in a home should be able to use its remote, including people who use a screen reader, magnification,
      speech input or a keyboard alone, and people who need reduced motion or higher contrast.
    </p>

    <h3>What we have done</h3>
    <ul>
      <li>
        <strong>Keyboard access</strong>: every control and dialog can be reached and used with a keyboard alone, with a
        clear, high-contrast focus outline that is never hidden behind the app bar, the tab bar or the side bar. A
        &ldquo;Skip to content&rdquo; link starts each page, the arrow keys, Home and End move between the tabs, and
        Escape closes the TV picker, TV Menu mode and every dialog, handing focus back to where it was.
      </li>
      <li>
        <strong>Screen readers</strong>: one main heading per screen, labelled landmarks and regions, a name for every
        button, including those shown only as a symbol, and changes such as a TV switching on, or an app launching,
        announced as they happen.
      </li>
      <li>
        <strong>Colour and contrast</strong>: text meets at least 4.5:1 against its background in every theme, light and
        dark, and control borders, icons and focus outlines at least 3:1. Nothing is told by colour alone: the Selected
        TV, the open tab and a pressed Mute are also shown in words or by shape.
      </li>
      <li>
        <strong>Themes</strong>: light or dark, following your device unless you choose one, in six colour themes.
        Windows Contrast Themes are respected.
      </li>
      <li>
        <strong>Text</strong>: one clear typeface, served by your own Hub, at a comfortable size, which the Remote never
        stops you enlarging.
      </li>
      <li>
        <strong>Motion</strong>: animations are short, and all of them are switched off if your device is set to reduce
        motion.
      </li>
      <li>
        <strong>Target sizes</strong>: every control is at least 24 by 24 pixels, and the keys and main actions at least
        44 by 44.
      </li>
      <li>
        <strong>Zoom and reflow</strong>: the Remote reflows to a single column and stays usable at 400% zoom, without
        scrolling in two directions. On a short screen, the tab bar stops sticking to the bottom, to leave room for the
        page.
      </li>
      <li>
        <strong>No dragging needed</strong>: each widget&rsquo;s grip opens a menu that moves it, resizes it and hides
        it; the volume slider has volume up and down buttons beside it; and every corner on the floor plan can be moved
        by tapping instead of dragging.
      </li>
    </ul>

    <h3>Compatibility</h3>
    <p>
      Media Centre is designed for current versions of Safari on iPhone and iPad, Chrome on Android, and Chrome, Edge,
      Firefox and Safari on a computer, with screen readers such as VoiceOver, TalkBack, NVDA and Narrator.
    </p>

    <h3>Known limitations</h3>
    <ul>
      <li>
        This statement is based on our own testing, with automated checks, keyboard-only use and screen readers. There
        has not yet been an independent audit.
      </li>
      <li>
        What appears on the TV itself, such as its menus and apps, is the TV maker&rsquo;s, and outside our control. TV
        Menu mode is for driving them while you watch the TV.
      </li>
      <li>
        Ring&rsquo;s live video and recordings, and the cover art on the Amazon tab, come from Ring and Amazon. They
        have no captions or text descriptions of their own.
      </li>
    </ul>

    <h3>If something does not work for you</h3>
    <p>
      Please tell us: we would rather hear about a problem than leave it in place.{" "}
      <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
        Open an issue on GitHub (opens in a new tab)
      </a>{" "}
      with the screen or feature, what you were trying to do, and the assistive technology you were using.
    </p>
  </>
);
