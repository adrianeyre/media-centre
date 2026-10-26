import { useState } from "preact/hooks";
import type { ComponentType } from "preact";

import { REMOTE_VERSION, REPOSITORY_URL } from "./about.ts";
import { ChangelogNotes } from "./changelog-notes.tsx";
import { Dialog } from "./dialog.tsx";
import { Icon } from "./icons.tsx";
import { AccessibilityStatement } from "./legal/accessibility-statement.tsx";
import { CookiePolicy } from "./legal/cookie-policy.tsx";
import { PrivacyPolicy } from "./legal/privacy-policy.tsx";
import { TermsAndConditions } from "./legal/terms-and-conditions.tsx";

interface Policy {
  readonly id: string;
  readonly title: string;
  /** As much of the title as a phone's footer shows; the rest is still read out. */
  readonly short?: string;
  readonly Text: ComponentType;
}

/** The policies the footer opens, in the order it lists them. */
export const POLICIES: readonly Policy[] = [
  { id: "privacy", title: "Privacy Policy", short: "Privacy", Text: PrivacyPolicy },
  { id: "terms", title: "Terms and Conditions", short: "Terms", Text: TermsAndConditions },
  { id: "cookies", title: "Cookie Policy", Text: CookiePolicy },
  { id: "accessibility", title: "Accessibility", Text: AccessibilityStatement },
];

/** A title, its end hidden on a phone but not from a screen reader, so the visible words are always in its name. */
const Shortened = ({ title, short }: { readonly title: string; readonly short: string | undefined }) =>
  short === undefined || !title.startsWith(short) ? (
    <>{title}</>
  ) : (
    <>
      {short}
      <span class="footer-long">{title.slice(short.length)}</span>
    </>
  );

/** What changed in each version, opened from the footer's version (FR-60). */
const CHANGELOG: Policy = { id: "changelog", title: "Changelog", Text: () => <ChangelogNotes /> };

/**
 * One slim line along the very bottom of every screen, under the tab bar:
 * who made the Remote, its version, which opens the Changelog, and its
 * policies, each opened in a dialog.
 */
export const AppFooter = () => {
  const [open, setOpen] = useState<Policy | undefined>(undefined);
  const close = (): void => {
    setOpen(undefined);
  };
  const opener = (policy: Policy) => (event: { readonly currentTarget: HTMLButtonElement }) => {
    // Safari doesn't focus a button it taps, and the dialog hands focus back to it.
    event.currentTarget.focus();
    setOpen(policy);
  };

  return (
    <>
      <footer class="app-footer">
        <nav aria-label="About Media Centre">
          <ul>
            <li>
              <a class="footer-link" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
                <Icon name="github" />
                <span class="footer-long">Website design</span>
                <span class="visually-hidden"> (source on GitHub, opens in a new tab)</span>
              </a>
            </li>
            <li>
              <button
                type="button"
                class="footer-link footer-version"
                aria-haspopup="dialog"
                aria-label={`Version: ${REMOTE_VERSION}, ${CHANGELOG.title}`}
                onClick={opener(CHANGELOG)}
              >
                <span class="footer-long">Version: </span>
                {REMOTE_VERSION}
              </button>
            </li>
            {POLICIES.map((policy) => (
              <li key={policy.id}>
                <button type="button" class="footer-link" aria-haspopup="dialog" onClick={opener(policy)}>
                  <Shortened title={policy.title} short={policy.short} />
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </footer>
      {[CHANGELOG, ...POLICIES].map((policy) => (
        <Dialog
          key={policy.id}
          open={open?.id === policy.id}
          onClose={close}
          title={policy.title}
          closeLabel={`Close ${policy.title}`}
          footer={
            <button type="button" class="button-primary" onClick={close}>
              Done
            </button>
          }
        >
          <policy.Text />
        </Dialog>
      ))}
    </>
  );
};
