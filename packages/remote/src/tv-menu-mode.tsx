import { useRef, useState } from "preact/hooks";

import type { Appliance, MenuShortcut, RemoteKey } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { useModalDialog } from "./dialog.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { D_PAD, type Key } from "./tv-keys.tsx";
import { NOW_PLAYING_REFRESH_MS, TvNowPlaying } from "./tv-now-playing.tsx";

/** One of TV Menu mode's shortcuts: what it presses, and what it is called. It shows no setting's value (FR-25). */
interface Shortcut {
  readonly shortcut: MenuShortcut;
  readonly name: string;
}

/** Every shortcut of FR-24, in the PRD's order. */
export const SHORTCUTS: readonly Shortcut[] = [
  { shortcut: "picture-mode", name: "Picture mode" },
  { shortcut: "picture-size", name: "Picture size" },
  { shortcut: "sleep-timer", name: "Sleep timer" },
  { shortcut: "energy-saving", name: "Energy saving" },
  { shortcut: "captions", name: "Captions" },
  { shortcut: "audio-description", name: "Audio description" },
  { shortcut: "audio-track", name: "Audio track" },
  { shortcut: "input-source", name: "Input source" },
];

const MENU_KEYS: readonly Key[] = [
  { key: "back", name: "Back" },
  { key: "home", name: "Home" },
  { key: "menu", name: "Menu" },
  { key: "tools", name: "Tools" },
];

/**
 * What the person is told: a key or shortcut the Hub couldn't press, a
 * shortcut the TV said it ignored, or one sent that the TV said nothing of.
 */
interface Notice {
  readonly kind: "problem" | "ignored" | "unconfirmed";
  readonly text: string;
}

export interface TvMenuModeProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV, which every key and shortcut is pressed on. */
  readonly tv: Appliance;
  /** The Selected TV as the Remote names it: "Room · Name". */
  readonly title: string;
  readonly onClose: () => void;
  /** {@link NOW_PLAYING_REFRESH_MS} but in tests. */
  readonly nowPlayingRefreshMs?: number;
}

/**
 * TV Menu mode (FR-23): the whole screen, for driving the TV's own menu while
 * watching the TV, with a large D-pad and OK, Back, Home, Menu and Tools, and
 * one-tap shortcuts that open or cycle the TV's settings (FR-24), and the
 * now-playing bar while the TV's Player plays a Media File (FR-36). Keys and
 * shortcuts go to the Hub at once, one after another in the order tapped
 * (FR-22); a shortcut's key is sent before the Hub has heard back from the
 * TV, so a key tapped next doesn't wait for that.
 *
 * A TV acknowledges no key, so after each shortcut the person is told either
 * that the TV said it ignored it, or that the TV said nothing, so that one it
 * ignores without a word isn't taken as done. Nothing here shows what a
 * setting is, which the Hub can't read (FR-25).
 */
export const TvMenuMode = ({
  appliances,
  tv,
  title,
  onClose,
  nowPlayingRefreshMs = NOW_PLAYING_REFRESH_MS,
}: TvMenuModeProps) => {
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  /** The last key or shortcut tapped, settled either way, which the next waits for. */
  const pressing = useRef<Promise<void>>(Promise.resolve());
  /** How many shortcuts have been tapped: only the last one's outcome is shown. */
  const shortcutsTapped = useRef(0);
  // Modal, so that nothing behind it can be reached while it covers the screen.
  const dialog = useModalDialog(true, onClose);

  const pressKey = (key: RemoteKey): void => {
    pressing.current = pressing.current.then(() =>
      appliances.pressKey(tv.id, key).then(
        () => {
          // What a shortcut said stays: the person is likely moving through what it opened.
          setNotice((shown) => (shown?.kind === "problem" ? undefined : shown));
        },
        (error: unknown) => {
          setNotice({ kind: "problem", text: messageFor(error) });
        },
      ),
    );
  };

  const pressShortcut = ({ shortcut, name }: Shortcut): void => {
    shortcutsTapped.current += 1;
    const tapped = shortcutsTapped.current;
    const isLatest = (): boolean => tapped === shortcutsTapped.current;
    pressing.current = pressing.current.then(() =>
      appliances.pressShortcut(tv.id, shortcut).then(
        ({ outcome }) => {
          if (isLatest()) setNotice(undefined);
          void outcome.then((said) => {
            if (!isLatest()) return;
            setNotice(
              said === "ignored"
                ? {
                    kind: "ignored",
                    text: `${title} ignored ${name}: its model or firmware doesn't take that shortcut. Find the setting with Menu instead.`,
                  }
                : {
                    kind: "unconfirmed",
                    text: `Sent ${name} to ${title}, which doesn't say whether it took it. If nothing changed on the TV, it ignores this shortcut: find the setting with Menu instead.`,
                  },
            );
          });
        },
        (error: unknown) => {
          if (isLatest()) setNotice({ kind: "problem", text: messageFor(error) });
        },
      ),
    );
  };

  const keyButton = ({ key, name, shows }: Key) => (
    <button
      key={key}
      type="button"
      class={`key key-${key}`}
      aria-label={shows === undefined ? undefined : name}
      onClick={() => {
        pressKey(key);
      }}
    >
      {shows ?? name}
    </button>
  );

  return (
    <dialog ref={dialog} class="tv-menu-mode" aria-labelledby="tv-menu-mode-heading">
      <div class="menu-mode-header">
        <div>
          <h2 id="tv-menu-mode-heading">TV Menu mode</h2>
          <p class="menu-mode-tv">{title}</p>
        </div>
        <button type="button" class="menu-mode-close" data-autofocus onClick={onClose}>
          <Icon name="x" />
          Close
        </button>
      </div>
      {notice !== undefined && notice.kind !== "unconfirmed" && (
        <p class="problem" role="alert">
          {notice.text}
        </p>
      )}
      <p class="menu-mode-status" role="status">
        {notice?.kind === "unconfirmed" ? notice.text : ""}
      </p>
      <TvNowPlaying appliances={appliances} tv={tv} refreshMs={nowPlayingRefreshMs} />
      <div class="menu-mode-keys" role="group" aria-label="Menus">
        {MENU_KEYS.map(keyButton)}
      </div>
      <div class="d-pad menu-mode-d-pad" role="group" aria-label="D-pad">
        {D_PAD.map(keyButton)}
      </div>
      <div class="menu-mode-shortcuts" role="group" aria-label="Shortcuts">
        {SHORTCUTS.map((each) => (
          <button
            key={each.shortcut}
            type="button"
            class={`key shortcut-${each.shortcut}`}
            onClick={() => {
              pressShortcut(each);
            }}
          >
            {each.name}
          </button>
        ))}
      </div>
    </dialog>
  );
};
