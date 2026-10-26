import { useEffect, useRef, useState } from "preact/hooks";

import {
  APPLIANCE_NAME_MAX_LENGTH,
  type Appliance,
  type FoundAppliance,
  type LightScene,
  type Room,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, groupByRoom, NO_ROOM } from "./appliance-names.ts";
import { DeviceRow } from "./device-row.tsx";
import { messageFor } from "./hub-request.ts";
import { NameInput } from "./name-input.tsx";
import type { RoomsApi } from "./rooms-api.ts";

export interface TvsSectionProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Changes whenever the Rooms are changed in Settings, so the TVs are shown in them as they now are. */
  readonly roomsVersion: number;
}

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = { readonly where: "list" | "find" | "add" | "edit" | number; readonly message: string };

/** What the Hub is waiting on the TV for: adding one, or pairing one again. */
type Pairing = "add" | number;

const WAITING_FOR_ALLOW = "Choose Allow on the TV when it asks. The Hub is waiting for it…";

/** The Name field of "Add TV by IP", where choosing a found TV leaves the person. */
const ADD_NAME_ID = "add-tv-name";

/**
 * Settings' TVs: find the TVs on the network, or add a TV by its IP address,
 * pairing with it, then rename it, move it to another Room, choose its film
 * Light Scene, one of its Room's (FR-57), pair it again or remove it (FR-8,
 * FR-11 to FR-14). A found TV is added through "Add TV by IP".
 * Each is named "Room · Name" (FR-9) and listed under its Room, in Room
 * order, or under "No room".
 */
export const TvsSection = ({ appliances, rooms, roomsVersion }: TvsSectionProps) => {
  const [tvs, setTvs] = useState<readonly Appliance[] | undefined>(undefined);
  const [roomList, setRoomList] = useState<readonly Room[]>([]);
  const [lightScenes, setLightScenes] = useState<readonly LightScene[]>([]);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [adding, setAdding] = useState({ address: "", name: "", roomId: "" });
  const [editing, setEditing] = useState<{
    readonly id: number;
    readonly name: string;
    readonly roomId: string;
    /** Its film Light Scene's id, or "" for none. */
    readonly filmLightSceneId: string;
  }>();
  const [removing, setRemoving] = useState<number | undefined>(undefined);
  const [pairing, setPairing] = useState<Pairing | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** What "Find TVs" last found, or undefined before it has finished searching. */
  const [found, setFound] = useState<readonly FoundAppliance[] | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const changing = useRef(false);
  /** The TVs whose pairing has been checked since Settings opened. */
  const checked = useRef(new Set<number>());

  const replace = (tv: Appliance): void => {
    setTvs((current) => current?.map((each) => (each.id === tv.id ? tv : each)));
  };

  /**
   * Has the Hub connect to each paired TV once, so a TV that no longer lets
   * the Hub in shows "Pair again" (FR-13). A TV that can't be reached, e.g.
   * one switched off at the wall, is left as it was.
   */
  const checkPairing = (list: readonly Appliance[]): void => {
    for (const tv of list) {
      if (tv.pairing !== "paired" || checked.current.has(tv.id)) continue;
      checked.current.add(tv.id);
      appliances.checkConnection(tv.id).then(replace, () => undefined);
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const [all, inOrder, scenes] = await Promise.all([appliances.list(), rooms.list(), appliances.lightScenes()]);
      const list = all.filter(({ kind }) => kind === "tv");
      setRoomList(inOrder);
      setLightScenes(scenes);
      setTvs(list);
      checkPairing(list);
    } catch (error) {
      setProblem({ where: "list", message: messageFor(error) });
    }
  };

  useEffect(() => {
    void reload();
  }, [appliances, rooms, roomsVersion]);

  /**
   * Runs one change on the Hub, calling `onDone` once it is made, then shows
   * the TVs as the Hub now has them, whether or not the change was made:
   * another Remote may have changed them. One change runs at a time.
   */
  const change = async (
    where: Problem["where"],
    work: () => Promise<unknown>,
    onDone: () => void = () => undefined,
    waitingOn?: Pairing,
  ): Promise<void> => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    setPairing(waitingOn);
    try {
      await work();
      onDone();
    } catch (error) {
      setProblem({ where, message: messageFor(error) });
    }
    setPairing(undefined);
    await reload();
    changing.current = false;
    setBusy(false);
  };

  /** Has the Hub search its network for TVs (FR-12), which takes a few seconds. */
  const findTvs = async (): Promise<void> => {
    setFinding(true);
    setFound(undefined);
    setProblem(undefined);
    try {
      setFound(await appliances.find("tv"));
    } catch (error) {
      setProblem({ where: "find", message: messageFor(error) });
    }
    setFinding(false);
  };

  /**
   * Fills in "Add TV by IP" with a found TV's address, and leaves the person
   * there to name it and choose its Room, as for any TV added by IP.
   */
  const choose = (tv: FoundAppliance): void => {
    setAdding({ ...adding, address: tv.address, name: "" });
    setProblem(undefined);
    document.getElementById(ADD_NAME_ID)?.focus();
  };

  /** The TV a found one already is, by the MAC address both read from it. */
  const addedAs = (tv: FoundAppliance): Appliance | undefined =>
    tvs?.find(({ macAddress }) => macAddress === tv.macAddress.toLowerCase());

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where && (
      <p id={`tvs-problem-${String(where)}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  /** The TV's film Light Scene, if it has one the Remote has heard of. */
  const filmLightScene = (tv: Appliance): LightScene | undefined =>
    lightScenes.find(({ id }) => id === tv.filmLightSceneId);

  const waiting = (on: Pairing) =>
    pairing === on && (
      <p class="waiting" role="status">
        {WAITING_FOR_ALLOW}
      </p>
    );

  const roomIdFrom = (value: string): number | null => (value === "" ? null : Number(value));

  /** The Light Scenes of the Room, by its id as the Room select has it, "" for "No room", which has none. */
  const scenesOf = (roomId: string): LightScene[] =>
    roomId === "" ? [] : lightScenes.filter((scene) => String(scene.roomId) === roomId);

  return (
    <section aria-labelledby="settings-tvs">
      <div class="settings-card-head">
        <div>
          <h2 id="settings-tvs">
            TVs
            {tvs !== undefined && tvs.length > 0 && (
              <span class="count" aria-hidden="true">
                {tvs.length}
              </span>
            )}
          </h2>
          <p class="settings-card-lead">
            Each Samsung TV the Hub controls. Edit one to rename it, move it to another Room or choose its film Light
            Scene.
          </p>
        </div>
      </div>
      {tvs === undefined ? (
        problem === undefined && <p>Loading the TVs…</p>
      ) : tvs.length === 0 ? (
        <p>
          No TVs yet. Find them on the network below, or add one by its IP address, which the TV shows in its network
          settings.
        </p>
      ) : (
        <ul class="device-list">
          {groupByRoom(tvs, roomList)
            .flatMap(({ appliances: inGroup }) => inGroup)
            .map((tv) => {
              const title = applianceTitle(tv, roomList);
              return (
                <li key={tv.id} aria-label={title}>
                  {editing?.id === tv.id ? (
                    <form
                      class="room-form"
                      aria-label={`Edit ${title}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void change(
                          "edit",
                          () =>
                            appliances.update(tv.id, {
                              name: editing.name,
                              roomId: roomIdFrom(editing.roomId),
                              filmLightSceneId:
                                editing.filmLightSceneId === "" ? null : Number(editing.filmLightSceneId),
                            }),
                          () => {
                            setEditing(undefined);
                          },
                        );
                      }}
                    >
                      <NameInput
                        label="TV name"
                        value={editing.name}
                        placeholder={`Up to ${String(APPLIANCE_NAME_MAX_LENGTH)} characters`}
                        invalid={problem?.where === "edit"}
                        describedBy="tvs-problem-edit"
                        focus
                        onInput={(name) => {
                          setEditing({ ...editing, name });
                        }}
                      />
                      <RoomSelect
                        rooms={roomList}
                        value={editing.roomId}
                        onChange={(roomId) => {
                          // A film Light Scene is one of the TV's own Room's.
                          const kept = scenesOf(roomId).some(({ id }) => String(id) === editing.filmLightSceneId);
                          setEditing({ ...editing, roomId, filmLightSceneId: kept ? editing.filmLightSceneId : "" });
                        }}
                      />
                      <FilmLightSceneSelect
                        id={`tv-${String(tv.id)}-film-light-scene`}
                        inRoom={editing.roomId !== ""}
                        lightScenes={scenesOf(editing.roomId)}
                        value={editing.filmLightSceneId}
                        onChange={(filmLightSceneId) => {
                          setEditing({ ...editing, filmLightSceneId });
                        }}
                      />
                      <button type="submit" disabled={busy}>
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(undefined);
                          setProblem(undefined);
                        }}
                      >
                        Cancel
                      </button>
                      {problemAt("edit")}
                    </form>
                  ) : removing === tv.id ? (
                    <div class="room-row">
                      <span class="room-name">Remove {title}? The Hub forgets its pairing too.</span>
                      <button
                        type="button"
                        class="button-danger"
                        disabled={busy}
                        onClick={() => {
                          void change(tv.id, () => appliances.remove(tv.id));
                          setRemoving(undefined);
                        }}
                      >
                        Yes, remove
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoving(undefined);
                        }}
                      >
                        No, keep it
                      </button>
                    </div>
                  ) : (
                    <DeviceRow
                      icon="tv"
                      name={tv.name}
                      room={roomList.find(({ id }) => id === tv.roomId)?.name}
                      details={
                        <>
                          {tv.model}, at {tv.address}
                        </>
                      }
                    >
                      <button
                        type="button"
                        aria-label={`Edit ${title}`}
                        onClick={() => {
                          setEditing({
                            id: tv.id,
                            name: tv.name,
                            roomId: tv.roomId === null ? "" : String(tv.roomId),
                            filmLightSceneId: tv.filmLightSceneId === undefined ? "" : String(tv.filmLightSceneId),
                          });
                          setRemoving(undefined);
                          setProblem(undefined);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${title}`}
                        onClick={() => {
                          setRemoving(tv.id);
                          setEditing(undefined);
                        }}
                      >
                        Remove
                      </button>
                    </DeviceRow>
                  )}
                  {filmLightScene(tv) !== undefined && (
                    <p class="appliance-details">Film Light Scene: {filmLightScene(tv)?.name}</p>
                  )}
                  {tv.pairing === "pair-again" && (
                    <div class="room-row">
                      <p id={`tv-${String(tv.id)}-pairing`} class="room-name problem">
                        This TV no longer lets the Hub in.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        aria-describedby={`tv-${String(tv.id)}-pairing`}
                        onClick={() => {
                          void change(tv.id, () => appliances.pairAgain(tv.id), undefined, tv.id);
                        }}
                      >
                        Pair again
                      </button>
                    </div>
                  )}
                  {waiting(tv.id)}
                  {problemAt(tv.id)}
                </li>
              );
            })}
        </ul>
      )}
      {problemAt("list")}
      <section class="room-form" aria-labelledby="find-tvs">
        <h3 id="find-tvs" class="form-heading">
          Find TVs
        </h3>
        <p class="form-help">Looks for TVs that are switched on and on the same network as the Hub.</p>
        <button type="button" disabled={finding} onClick={() => void findTvs()}>
          Find TVs
        </button>
        {finding && (
          <p class="waiting" role="status">
            Looking for TVs on the network…
          </p>
        )}
        {found !== undefined &&
          (found.length === 0 ? (
            <p class="found-none" role="status">
              No TVs found. Check that the TV is switched on and on the same network as the Hub, or add it by its IP
              address under "Add TV by IP" below.
            </p>
          ) : (
            <ul class="rooms found" aria-label="TVs found">
              {found.map((tv) => {
                const added = addedAs(tv);
                return (
                  <li key={`${tv.macAddress} ${tv.address}`} aria-label={`${tv.name}, at ${tv.address}`}>
                    <div class="room-row">
                      <span class="found-name">{tv.name}</span>
                      {added === undefined ? (
                        <button
                          type="button"
                          aria-label={`Add ${tv.name}, at ${tv.address}`}
                          onClick={() => {
                            choose(tv);
                          }}
                        >
                          Add
                        </button>
                      ) : (
                        <span class="found-added">Added, as {applianceTitle(added, roomList)}</span>
                      )}
                    </div>
                    <p class="appliance-details">
                      {tv.model}, at {tv.address}
                    </p>
                  </li>
                );
              })}
            </ul>
          ))}
        {problemAt("find")}
      </section>
      <form
        class="room-form"
        aria-label="Add TV by IP"
        onSubmit={(event) => {
          event.preventDefault();
          const asked = adding;
          void change(
            "add",
            () =>
              appliances.add({
                kind: "tv",
                address: asked.address,
                name: asked.name,
                roomId: roomIdFrom(asked.roomId),
              }),
            () => {
              setAdding({ address: "", name: "", roomId: "" });
            },
            "add",
          );
        }}
      >
        <h3 class="form-heading">Add TV by IP</h3>
        <p class="form-help">Switch the TV on first. It has to be on the same network as the Hub.</p>
        <label>
          IP address
          <input
            type="text"
            inputMode="decimal"
            value={adding.address}
            placeholder="e.g. 192.168.1.20"
            autocomplete="off"
            aria-invalid={problem?.where === "add"}
            {...(problem?.where === "add" ? { "aria-describedby": "tvs-problem-add" } : {})}
            onInput={(event) => {
              setAdding({ ...adding, address: event.currentTarget.value });
            }}
          />
        </label>
        <NameInput
          id={ADD_NAME_ID}
          label="Name"
          value={adding.name}
          placeholder="Left empty, the TV's own name"
          invalid={false}
          describedBy="tvs-problem-add"
          onInput={(name) => {
            setAdding({ ...adding, name });
          }}
        />
        <RoomSelect
          rooms={roomList}
          value={adding.roomId}
          onChange={(roomId) => {
            setAdding({ ...adding, roomId });
          }}
        />
        <button type="submit" disabled={busy}>
          Add TV
        </button>
        {waiting("add")}
        {problemAt("add")}
      </form>
    </section>
  );
};

export interface RoomSelectProps {
  readonly rooms: readonly Room[];
  /** The Room's id, or "" for "No room". */
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export const RoomSelect = ({ rooms, value, onChange }: RoomSelectProps) => (
  <label>
    Room
    <select
      value={value}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      <option value="">{NO_ROOM}</option>
      {rooms.map((room) => (
        <option key={room.id} value={String(room.id)}>
          {room.name}
        </option>
      ))}
    </select>
  </label>
);

export interface FilmLightSceneSelectProps {
  readonly id: string;
  /** Whether the TV is in a Room, as one with none has no Light Scenes. */
  readonly inRoom: boolean;
  /** The Light Scenes of the TV's Room. */
  readonly lightScenes: readonly LightScene[];
  /** The Light Scene's id, or "" for none. */
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/**
 * A TV's film Light Scene (FR-57): one of its own Room's, which the Hub
 * recalls as the Player starts a video on it, or none.
 */
export const FilmLightSceneSelect = ({ id, inRoom, lightScenes, value, onChange }: FilmLightSceneSelectProps) => (
  <>
    <label>
      Film Light Scene
      <select
        value={value}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      >
        <option value="">None</option>
        {lightScenes.map((scene) => (
          <option key={scene.id} value={String(scene.id)}>
            {scene.name}
          </option>
        ))}
      </select>
    </label>
    <p id={`${id}-help`} class="form-help">
      {!inRoom
        ? "A TV with no Room has no Light Scenes to choose from."
        : lightScenes.length === 0
          ? "Its Room has no Light Scenes yet. Save one in the Lights tab."
          : "Recalled as a video starts on this TV. The Room's Lights go back as they were once it stops."}
    </p>
  </>
);
