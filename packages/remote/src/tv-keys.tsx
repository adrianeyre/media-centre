import { useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import type { Appliance, RemoteKey } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";

/** One key on the key pad: what it presses, what it is called, and what it shows if not its name. */
export interface Key {
  readonly key: RemoteKey;
  readonly name: string;
  readonly shows?: ComponentChildren;
}

const MENU_KEYS: readonly Key[] = [
  { key: "back", name: "Back" },
  { key: "home", name: "Home" },
  { key: "source", name: "Source" },
  { key: "menu", name: "Menu" },
  { key: "tools", name: "Tools" },
  { key: "info", name: "Info" },
];

/** Up, Left, OK, Right and Down, in the order a screen reader reads them, laid out as a cross by the style. */
export const D_PAD: readonly Key[] = [
  { key: "up", name: "Up", shows: <Icon name="chevron-up" /> },
  { key: "left", name: "Left", shows: <Icon name="chevron-left" /> },
  { key: "ok", name: "OK" },
  { key: "right", name: "Right", shows: <Icon name="chevron-right" /> },
  { key: "down", name: "Down", shows: <Icon name="chevron-down" /> },
];

const MEDIA_KEYS: readonly Key[] = [
  { key: "rewind", name: "Rewind", shows: <Icon name="rewind" /> },
  { key: "play", name: "Play", shows: <Icon name="play" /> },
  { key: "pause", name: "Pause", shows: <Icon name="pause" /> },
  { key: "stop", name: "Stop", shows: <Icon name="stop" /> },
  { key: "fast-forward", name: "Fast-forward", shows: <Icon name="fast-forward" /> },
];

/** Shown as their colours alone, as on the TV's own remote. */
const COLOUR_KEYS: readonly Key[] = [
  { key: "red", name: "Red", shows: "" },
  { key: "green", name: "Green", shows: "" },
  { key: "yellow", name: "Yellow", shows: "" },
  { key: "blue", name: "Blue", shows: "" },
];

const NUMBER_KEYS: readonly Key[] = [
  ...(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const).map((key) => ({ key, name: key })),
  {
    key: "channel-up",
    name: "Channel up",
    shows: (
      <>
        Channel <Icon name="chevron-up" />
      </>
    ),
  },
  {
    key: "channel-down",
    name: "Channel down",
    shows: (
      <>
        Channel <Icon name="chevron-down" />
      </>
    ),
  },
];

export interface TvKeysProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV, which every key is pressed on. */
  readonly tv: Appliance;
}

/**
 * The key pad for the Selected TV (FR-18), laid out for a thumb on a phone
 * (NFR-2): the menu keys, the D-pad and OK, the media keys, the coloured keys,
 * and the number pad with channel up and down. Each tap goes to the Hub at
 * once, one after another in the order tapped, so the TV acts on them in that
 * order (FR-22). A key the Hub couldn't press, or refused to (FR-30), is
 * reported with the Hub's reason.
 */
export const TvKeys = ({ appliances, tv }: TvKeysProps) => {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** The last key tapped, settled either way, which the next waits for. */
  const pressing = useRef<Promise<void>>(Promise.resolve());

  const press = (key: RemoteKey): void => {
    pressing.current = pressing.current.then(() =>
      appliances.pressKey(tv.id, key).then(
        () => {
          setProblem(undefined);
        },
        (error: unknown) => {
          setProblem(messageFor(error));
        },
      ),
    );
  };

  const button = ({ key, name, shows }: Key) => (
    <button
      key={key}
      type="button"
      class={`key key-${key}`}
      aria-label={shows === undefined ? undefined : name}
      onClick={() => {
        press(key);
      }}
    >
      {shows ?? name}
    </button>
  );

  return (
    <section class="tv-keys" aria-label="Keys">
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="menu-keys" role="group" aria-label="Menus">
        {MENU_KEYS.map(button)}
      </div>
      <div class="d-pad" role="group" aria-label="D-pad">
        {D_PAD.map(button)}
      </div>
      <div class="media-keys" role="group" aria-label="Media">
        {MEDIA_KEYS.map(button)}
      </div>
      <div class="colour-keys" role="group" aria-label="Colours">
        {COLOUR_KEYS.map(button)}
      </div>
      <div class="number-keys" role="group" aria-label="Numbers and channels">
        {NUMBER_KEYS.map(button)}
      </div>
    </section>
  );
};
