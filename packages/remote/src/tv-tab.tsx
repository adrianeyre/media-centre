import { useEffect, useRef, useState } from "preact/hooks";

import type { Appliance, PowerState, Room } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, groupByRoom } from "./appliance-names.ts";
import type { HubAddressApi } from "./hub-address-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import type { MediaSourcesApi } from "./media-sources-api.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { loadSelectedTv, saveSelectedTv, selectedTvAmong } from "./selected-tv.ts";
import { APPS_REFRESH_MS, TvApps } from "./tv-apps.tsx";
import { DEVELOPER_REFRESH_MS, TvDeveloper } from "./tv-developer.tsx";
import { KEYBOARD_REFRESH_MS, TvKeyboard } from "./tv-keyboard.tsx";
import { TvKeys } from "./tv-keys.tsx";
import { TvMenuMode } from "./tv-menu-mode.tsx";
import { NOW_PLAYING_REFRESH_MS, TvNowPlaying } from "./tv-now-playing.tsx";
import { NOW_SHOWING_REFRESH_MS, TvNowShowing } from "./tv-now-showing.tsx";
import { TvPicker } from "./tv-picker.tsx";
import { TvPower } from "./tv-power.tsx";
import { TvVolume } from "./tv-volume.tsx";
import { WatchAndListen } from "./watch-and-listen.tsx";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import { TV_WIDGET_LAYOUT_KEY, type Layout } from "./widget-layout.ts";

/** How often the TV tab asks the Hub again for the TVs and whether each is on. */
export const TV_REFRESH_MS = 3_000;

const POWER_LABELS: Readonly<Record<PowerState, string>> = {
  on: "On",
  standby: "Standby",
  unreachable: "Unreachable",
};

export interface TvTabProps {
  readonly appliances: AppliancesApi;
  /** Where the Hub's own IP address is, for the Developer section. */
  readonly hubAddress: HubAddressApi;
  /** The Media Sources Watch & Listen browses. */
  readonly mediaSources: MediaSourcesApi;
  readonly rooms: RoomsApi;
  /** Where this Remote remembers its Selected TV. */
  readonly storage: RemoteStorage;
  /**
   * Opens Settings: on TV, where TVs and Media Sources are added, or, from
   * the Developer steps, on General, where the Hub's IP address is set.
   */
  readonly onOpenSettings: (section: "tv" | "general") => void;
  /** {@link TV_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
  /** {@link KEYBOARD_REFRESH_MS} but in tests. */
  readonly keyboardRefreshMs?: number;
  /** {@link APPS_REFRESH_MS} but in tests. */
  readonly appsRefreshMs?: number;
  /** {@link NOW_SHOWING_REFRESH_MS} but in tests. */
  readonly nowShowingRefreshMs?: number;
  /** {@link NOW_PLAYING_REFRESH_MS} but in tests. */
  readonly nowPlayingRefreshMs?: number;
  /** {@link DEVELOPER_REFRESH_MS} but in tests. */
  readonly developerRefreshMs?: number;
}

const at = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/**
 * Where each of the TV tab's widgets starts, fitted together with no gaps, for
 * a desktop's 12 columns, a tablet's 8 and a phone's 4, in rows of the
 * board's grid. On a phone, Power and the keys come first, so that the
 * D-pad is in sight as the tab opens (NFR-2).
 */
export const TV_WIDGET_LAYOUTS: Readonly<Record<number, Layout>> = {
  12: {
    "now-playing": at(0, 0, 6, 6),
    keys: at(0, 6, 6, 12),
    "now-showing": at(6, 0, 3, 4),
    power: at(6, 4, 3, 4),
    volume: at(6, 8, 3, 5),
    keyboard: at(6, 13, 3, 5),
    apps: at(9, 0, 3, 10),
    "watch-and-listen": at(9, 10, 3, 8),
    tvs: at(0, 18, 6, 5),
    developer: at(6, 18, 6, 5),
  },
  8: {
    keys: at(0, 0, 5, 12),
    "now-showing": at(5, 0, 3, 4),
    power: at(5, 4, 3, 4),
    volume: at(5, 8, 3, 5),
    "now-playing": at(0, 12, 5, 6),
    keyboard: at(5, 13, 3, 5),
    apps: at(0, 18, 4, 10),
    "watch-and-listen": at(4, 18, 4, 10),
    tvs: at(0, 28, 4, 5),
    developer: at(4, 28, 4, 5),
  },
  4: {
    power: at(0, 0, 4, 4),
    keys: at(0, 4, 4, 22),
    volume: at(0, 26, 4, 5),
    "now-showing": at(0, 31, 4, 4),
    "now-playing": at(0, 35, 4, 6),
    keyboard: at(0, 41, 4, 4),
    apps: at(0, 45, 4, 10),
    "watch-and-listen": at(0, 55, 4, 10),
    tvs: at(0, 65, 4, 5),
    developer: at(0, 70, 4, 3),
  },
};

interface Home {
  readonly tvs: readonly Appliance[];
  readonly rooms: readonly Room[];
}

/**
 * The TV tab: the TV picker and the Widgets menu, then a board of widgets,
 * each of which can be moved, made bigger or smaller, or hidden (FR-58): the
 * now-playing bar while the Selected TV's Player plays a Media File (FR-36), a
 * text field while the Selected TV's on-screen keyboard is open (FR-20), each
 * saying what it is for while it isn't, the Selected TV's Now Showing card,
 * with the app in front (FR-26), its Power button (FR-17) beside the way into
 * TV Menu mode (FR-23), its volume (FR-19), keys (FR-18), apps (FR-21), Watch
 * & Listen (FR-33), whose Media Files play on the Selected TV (FR-35), its
 * Developer section (FR-28, FR-29), and every TV grouped by Room, in Room
 * order, with "No room" last, each with its power state (FR-10, FR-15, FR-16).
 * The picker and the list follow the Hub as it changes, e.g. a TV put in
 * standby with its own remote, or added or removed on another Remote. With no
 * TVs, it shows how to add one (FR-6), and Watch & Listen still browses the
 * Media Sources.
 */
export const TvTab = ({
  appliances,
  hubAddress,
  mediaSources,
  rooms,
  storage,
  onOpenSettings,
  refreshMs = TV_REFRESH_MS,
  keyboardRefreshMs = KEYBOARD_REFRESH_MS,
  appsRefreshMs = APPS_REFRESH_MS,
  nowShowingRefreshMs = NOW_SHOWING_REFRESH_MS,
  nowPlayingRefreshMs = NOW_PLAYING_REFRESH_MS,
  developerRefreshMs = DEVELOPER_REFRESH_MS,
}: TvTabProps) => {
  const [home, setHome] = useState<Home | undefined>(undefined);
  const [power, setPower] = useState<ReadonlyMap<number, PowerState>>(new Map());
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [remembered, setRemembered] = useState(() => loadSelectedTv(storage));
  const [menuMode, setMenuMode] = useState(false);
  /** Reads one TV's power state now, between refreshes; set while the tab is shown. */
  const readPowerNow = useRef<(id: number) => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const powerOf = (id: number, state: PowerState | undefined): void => {
      if (!current) return;
      setPower((known) => {
        const next = new Map(known);
        if (state === undefined) next.delete(id);
        else next.set(id, state);
        return next;
      });
    };

    readPowerNow.current = (id) => {
      void appliances.readPower(id).then(
        (state) => {
          powerOf(id, state);
        },
        () => undefined,
      );
    };

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") {
        try {
          const [all, inOrder] = await Promise.all([appliances.list(), rooms.list()]);
          if (!current) return;
          const tvs = all.filter(({ kind }) => kind === "tv");
          setHome({ tvs, rooms: inOrder });
          setProblem(undefined);
          // Each as it answers, so one TV slow to answer holds up no other.
          await Promise.all(
            tvs.map(async ({ id }) => {
              powerOf(id, await appliances.readPower(id).catch(() => undefined));
            }),
          );
        } catch (error) {
          if (!current) return;
          setProblem(messageFor(error));
          setPower(new Map());
        }
      }
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [appliances, rooms, refreshMs]);

  const groups = home === undefined ? [] : groupByRoom(home.tvs, home.rooms);
  const listed = groups.flatMap((group) => group.appliances);
  const selected = selectedTvAmong(listed, remembered);

  const select = (id: number): void => {
    setRemembered(id);
    saveSelectedTv(storage, id);
  };

  // The first TV, selected for want of one remembered, is remembered too, so
  // that adding a TV in an earlier Room doesn't change which one this Remote
  // controls.
  useEffect(() => {
    if (selected !== undefined && selected.id !== remembered) select(selected.id);
  }, [selected?.id, remembered]);

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  if (home === undefined) {
    return (
      <>
        <h1>TV</h1>
        {problemShown || <p>Loading the TVs…</p>}
      </>
    );
  }

  if (selected === undefined) {
    return (
      <>
        <h1>TV</h1>
        {problemShown}
        <section class="empty" aria-labelledby="no-tvs">
          <h2 id="no-tvs">No TVs yet</h2>
          <p>
            Add a TV in Settings: tap <strong>Find TVs</strong> to look for the Samsung TVs on your home network, or add
            one by its IP address.
          </p>
          <p>Switch the TV on first. It has to be on the same network as the Hub.</p>
          <button
            type="button"
            onClick={() => {
              onOpenSettings("tv");
            }}
          >
            Open Settings
          </button>
        </section>
        <WatchAndListen
          mediaSources={mediaSources}
          onOpenSettings={() => {
            onOpenSettings("tv");
          }}
        />
      </>
    );
  }

  const title = applianceTitle(selected, home.rooms);
  const tvPower = power.get(selected.id);

  // Each widget's content is its own for each TV, so that a problem with one isn't shown for the next.
  const widgets: WidgetDefinition[] = [
    {
      id: "now-playing",
      title: "Now playing",
      ownHeading: true,
      children: (
        <TvNowPlaying
          key={`now-playing-${String(selected.id)}`}
          appliances={appliances}
          tv={selected}
          refreshMs={nowPlayingRefreshMs}
          idle={
            <div class="widget-idle now-playing-idle">
              <h2>Now playing</h2>
              <span class="now-playing-idle-mark" aria-hidden="true">
                <Icon name="play" />
              </span>
              <p>Nothing is playing on {title}. Choose a Media File in Watch &amp; Listen.</p>
            </div>
          }
        />
      ),
    },
    {
      id: "keyboard",
      title: "TV keyboard",
      children: (
        <TvKeyboard
          key={`keyboard-${String(selected.id)}`}
          appliances={appliances}
          tv={selected}
          refreshMs={keyboardRefreshMs}
          idle={<p class="widget-idle">When {title} shows its on-screen keyboard, type here.</p>}
        />
      ),
    },
    {
      id: "now-showing",
      title: "Now Showing",
      ownHeading: true,
      children: (
        <TvNowShowing
          key={`now-showing-${String(selected.id)}`}
          appliances={appliances}
          tv={selected}
          title={title}
          power={tvPower}
          refreshMs={nowShowingRefreshMs}
          playbackRefreshMs={nowPlayingRefreshMs}
        />
      ),
    },
    {
      id: "power",
      title: "Power",
      children: (
        <div class="tv-quick">
          <TvPower
            key={`power-${String(selected.id)}`}
            appliances={appliances}
            tv={selected}
            title={title}
            power={tvPower}
            onSwitched={() => {
              readPowerNow.current(selected.id);
            }}
          />
          <button
            type="button"
            class="menu-mode-open"
            onClick={(event) => {
              // Safari doesn't focus a button it taps, and TV Menu mode hands focus back to it.
              event.currentTarget.focus();
              setMenuMode(true);
            }}
          >
            TV Menu mode
          </button>
        </div>
      ),
    },
    {
      id: "volume",
      title: "Volume",
      children: (
        <TvVolume key={`volume-${String(selected.id)}`} appliances={appliances} tv={selected} refreshMs={refreshMs} />
      ),
    },
    {
      id: "keys",
      title: "Keys",
      children: <TvKeys key={selected.id} appliances={appliances} tv={selected} />,
    },
    {
      id: "apps",
      title: "Apps",
      ownHeading: true,
      children: (
        <TvApps
          key={`apps-${String(selected.id)}`}
          appliances={appliances}
          tv={selected}
          title={title}
          power={tvPower}
          refreshMs={appsRefreshMs}
        />
      ),
    },
    {
      id: "watch-and-listen",
      title: "Watch & Listen",
      ownHeading: true,
      children: (
        <WatchAndListen
          mediaSources={mediaSources}
          onOpenSettings={() => {
            onOpenSettings("tv");
          }}
          playOn={{ appliances, tv: selected, title }}
        />
      ),
    },
    {
      id: "developer",
      title: "Developer",
      ownHeading: true,
      children: (
        <TvDeveloper
          key={`developer-${String(selected.id)}`}
          appliances={appliances}
          hubAddress={hubAddress}
          tv={selected}
          title={title}
          power={tvPower}
          onOpenSettings={() => {
            onOpenSettings("general");
          }}
          refreshMs={developerRefreshMs}
        />
      ),
    },
    {
      id: "tvs",
      title: "TVs",
      ownHeading: true,
      children: (
        <section class="tv-list" aria-labelledby="tv-list">
          <h2 id="tv-list">TVs</h2>
          {groups.map((group) => (
            <section key={group.heading} class="room-group" aria-label={group.heading}>
              <h3>{group.heading}</h3>
              <ul class="rooms">
                {group.appliances.map((tv) => {
                  const state = power.get(tv.id);
                  const isSelected = tv.id === selected.id;
                  return (
                    <li
                      key={tv.id}
                      class={isSelected ? "tv selected" : "tv"}
                      aria-label={applianceTitle(tv, home.rooms)}
                      aria-current={isSelected ? "true" : undefined}
                    >
                      <span class="room-name">{applianceTitle(tv, home.rooms)}</span>
                      {isSelected && <span class="selected-mark">Selected</span>}
                      <span class={`power power-${state ?? "unknown"}`}>
                        {state === undefined ? "Checking…" : POWER_LABELS[state]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>
      ),
    },
  ];

  return (
    <>
      {problemShown}
      <WidgetBoard
        widgets={widgets}
        defaults={TV_WIDGET_LAYOUTS}
        storage={storage}
        storageKey={TV_WIDGET_LAYOUT_KEY}
        tab="TV"
        toolbar={
          <>
            <h1>TV</h1>
            <TvPicker tvs={listed} rooms={home.rooms} selected={selected} onSelect={select} />
          </>
        }
      />
      {menuMode && (
        <TvMenuMode
          key={`menu-${String(selected.id)}`}
          appliances={appliances}
          tv={selected}
          title={title}
          nowPlayingRefreshMs={nowPlayingRefreshMs}
          onClose={() => {
            setMenuMode(false);
          }}
        />
      )}
    </>
  );
};
