import { useEffect, useRef, useState } from "preact/hooks";

import {
  APPLIANCE_NAME_MAX_LENGTH,
  LIGHT_KEYS_MAX_LENGTH,
  type Appliance,
  type FoundLight,
  type Room,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, groupByRoom } from "./appliance-names.ts";
import { DeviceRow } from "./device-row.tsx";
import { messageFor } from "./hub-request.ts";
import { NameInput } from "./name-input.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { RoomSelect } from "./tvs-section.tsx";

export interface LightsSectionProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Changes whenever the Rooms are changed in Settings, so the Lights are shown in them as they now are. */
  readonly roomsVersion: number;
}

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = { readonly where: "list" | "find" | "add" | "edit" | number; readonly message: string };

/** What "Add a Light by address" holds until it is sent: the key only as long as that. */
interface Adding {
  readonly address: string;
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly roomId: string;
}

const NOTHING_ADDED: Adding = { address: "", id: "", key: "", name: "", roomId: "" };

/** The Local key field of "Add a Light by address", where choosing a found one leaves the person. */
const ADD_KEY_ID = "add-light-key";

/**
 * Settings' Lights (FR-54): find the Lights on the network, or add one by
 * its address, then rename it, move it to another Room or remove it, as any
 * Appliance (FR-8, FR-11). Each is named "Room · Name" (FR-9) and listed
 * under its Room, in Room order, or under "No room". A found one is added
 * through "Add a Light by address", which takes its local key, the key its
 * maker issued it, and, for one the Hub didn't find, its device id. The Hub
 * keeps both, and never sends them back, so the key is held here only until
 * it is sent (FR-4).
 */
export const LightsSection = ({ appliances, rooms, roomsVersion }: LightsSectionProps) => {
  const [lights, setLights] = useState<readonly Appliance[] | undefined>(undefined);
  const [roomList, setRoomList] = useState<readonly Room[]>([]);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [adding, setAdding] = useState<Adding>(NOTHING_ADDED);
  const [editing, setEditing] = useState<{ readonly id: number; readonly name: string; readonly roomId: string }>();
  const [removing, setRemoving] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** Whether a Light is being added, which waits on the Light answering to its key. */
  const [sending, setSending] = useState(false);
  /** What "Find Lights" last found, or undefined before it has finished searching. */
  const [found, setFound] = useState<readonly FoundLight[] | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const changing = useRef(false);
  /** The Lights whose key has been checked since Settings opened. */
  const checked = useRef(new Set<number>());

  const replace = (light: Appliance): void => {
    setLights((current) => current?.map((each) => (each.id === light.id ? light : each)));
  };

  /** Has the Hub read each Light once, so one that no longer answers to its key says so. One that can't be reached is left as it was. */
  const checkKeys = (list: readonly Appliance[]): void => {
    for (const light of list) {
      if (light.pairing !== "paired" || checked.current.has(light.id)) continue;
      checked.current.add(light.id);
      appliances.checkConnection(light.id).then(replace, () => undefined);
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const [all, inOrder] = await Promise.all([appliances.list(), rooms.list()]);
      const list = all.filter(({ kind }) => kind === "light");
      setRoomList(inOrder);
      setLights(list);
      checkKeys(list);
    } catch (error) {
      setProblem({ where: "list", message: messageFor(error) });
    }
  };

  useEffect(() => {
    void reload();
  }, [appliances, rooms, roomsVersion]);

  /**
   * Runs one change on the Hub, calling `onDone` once it is made, then shows
   * the Lights as the Hub now has them, whether or not the change was made:
   * another Remote may have changed them. One change runs at a time.
   */
  const change = async (
    where: Problem["where"],
    work: () => Promise<unknown>,
    onDone: () => void = () => undefined,
  ): Promise<void> => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
      onDone();
    } catch (error) {
      setProblem({ where, message: messageFor(error) });
    }
    await reload();
    changing.current = false;
    setBusy(false);
  };

  /** Has the Hub search its network for Lights (FR-54), which takes a few seconds. */
  const findLights = async (): Promise<void> => {
    setFinding(true);
    setFound(undefined);
    setProblem(undefined);
    try {
      setFound(await appliances.findLights());
    } catch (error) {
      setProblem({ where: "find", message: messageFor(error) });
    }
    setFinding(false);
  };

  /** Fills in "Add a Light by address" with a found one's address, whose id the Hub heard, to give its key there. */
  const choose = (light: FoundLight): void => {
    setAdding({ ...adding, address: light.address, id: "", name: "" });
    setProblem(undefined);
    document.getElementById(ADD_KEY_ID)?.focus();
  };

  const roomIdFrom = (value: string): number | null => (value === "" ? null : Number(value));

  const add = (): void => {
    const id = adding.id.trim();
    setSending(true);
    void change(
      "add",
      async () => {
        const added = await appliances.add({
          kind: "light",
          address: adding.address.trim(),
          name: adding.name,
          roomId: roomIdFrom(adding.roomId),
          light: { key: adding.key, ...(id === "" ? {} : { id }) },
        });
        // Found at the address it was added by, it is that one.
        setFound((current) =>
          current?.map((each) => (each.address === added.address ? { ...each, applianceId: added.id } : each)),
        );
      },
      () => {
        setAdding(NOTHING_ADDED);
      },
    ).then(() => {
      setSending(false);
    });
  };

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where && (
      <p id={`lights-problem-${String(where)}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  const addInvalid = problem?.where === "add";
  const describedByAdd = addInvalid ? { "aria-describedby": "lights-problem-add" } : {};

  return (
    <section aria-labelledby="settings-lights">
      <div class="settings-card-head">
        <div>
          <h2 id="settings-lights">
            Lights
            {lights !== undefined && lights.length > 0 && (
              <span class="count" aria-hidden="true">
                {lights.length}
              </span>
            )}
          </h2>
          <p class="settings-card-lead">
            Each Light the Hub controls. Edit one to rename it or move it to another Room.
          </p>
        </div>
      </div>
      {lights === undefined ? (
        problem === undefined && <p>Loading the Lights…</p>
      ) : lights.length === 0 ? (
        <p>No Lights yet. Find them on the network below, or add one by its address.</p>
      ) : (
        <ul class="device-list">
          {groupByRoom(lights, roomList)
            .flatMap(({ appliances: inGroup }) => inGroup)
            .map((light) => {
              const title = applianceTitle(light, roomList);
              return (
                <li key={light.id} aria-label={title}>
                  {editing?.id === light.id ? (
                    <form
                      class="room-form"
                      aria-label={`Edit ${title}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void change(
                          "edit",
                          () => appliances.update(light.id, { name: editing.name, roomId: roomIdFrom(editing.roomId) }),
                          () => {
                            setEditing(undefined);
                          },
                        );
                      }}
                    >
                      <NameInput
                        label="Light name"
                        value={editing.name}
                        placeholder={`Up to ${String(APPLIANCE_NAME_MAX_LENGTH)} characters`}
                        invalid={problem?.where === "edit"}
                        describedBy="lights-problem-edit"
                        focus
                        onInput={(name) => {
                          setEditing({ ...editing, name });
                        }}
                      />
                      <RoomSelect
                        rooms={roomList}
                        value={editing.roomId}
                        onChange={(roomId) => {
                          setEditing({ ...editing, roomId });
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
                  ) : removing === light.id ? (
                    <div class="room-row">
                      <span class="room-name">Remove {title}? The Hub forgets its key too.</span>
                      <button
                        type="button"
                        class="button-danger"
                        disabled={busy}
                        onClick={() => {
                          void change(light.id, () => appliances.remove(light.id));
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
                      icon="lightbulb"
                      name={light.name}
                      room={roomList.find(({ id }) => id === light.roomId)?.name}
                      details={
                        <>
                          {light.model}, at {light.address}
                        </>
                      }
                    >
                      <button
                        type="button"
                        aria-label={`Edit ${title}`}
                        onClick={() => {
                          setEditing({
                            id: light.id,
                            name: light.name,
                            roomId: light.roomId === null ? "" : String(light.roomId),
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
                          setRemoving(light.id);
                          setEditing(undefined);
                        }}
                      >
                        Remove
                      </button>
                    </DeviceRow>
                  )}
                  {light.pairing === "pair-again" && (
                    <p class="problem">
                      This Light no longer answers to the Hub's key, as after it is paired again in its maker's app.
                      Remove it, and add it again with its new key.
                    </p>
                  )}
                  {problemAt(light.id)}
                </li>
              );
            })}
        </ul>
      )}
      {problemAt("list")}
      <section class="room-form" aria-labelledby="find-lights">
        <h3 id="find-lights" class="form-heading">
          Find Lights
        </h3>
        <p class="form-help">Looks for Lights that are switched on and on the same network as the Hub.</p>
        <button type="button" disabled={finding} onClick={() => void findLights()}>
          Find Lights
        </button>
        {finding && (
          <p class="waiting" role="status">
            Looking for Lights on the network…
          </p>
        )}
        {found !== undefined &&
          (found.length === 0 ? (
            <p class="found-none" role="status">
              No Lights found. Check that it is switched on and on the same network as the Hub, or add it by its address
              and device id under "Add a Light by address" below.
            </p>
          ) : (
            <ul class="rooms found" aria-label="Lights found">
              {found.map((light) => {
                const added = lights?.find(({ id }) => id === light.applianceId);
                return (
                  <li key={light.address} aria-label={`${light.name}, at ${light.address}`}>
                    <div class="room-row">
                      <span class="found-name">{light.name}</span>
                      {added === undefined ? (
                        <button
                          type="button"
                          aria-label={`Add ${light.name}, at ${light.address}`}
                          onClick={() => {
                            choose(light);
                          }}
                        >
                          Add
                        </button>
                      ) : (
                        <span class="found-added">Added, as {applianceTitle(added, roomList)}</span>
                      )}
                    </div>
                    <p class="appliance-details">
                      {light.model}, at {light.address}
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
        aria-label="Add a Light by address"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <h3 class="form-heading">Add a Light by address</h3>
        <p class="form-help">
          Switch it on first. It has to be on the same network as the Hub. The Hub keeps its device id and local key,
          and never shows them again.
        </p>
        <label>
          IP address
          <input
            type="text"
            inputMode="decimal"
            value={adding.address}
            placeholder="e.g. 192.168.1.40"
            autocomplete="off"
            aria-invalid={addInvalid}
            {...describedByAdd}
            onInput={(event) => {
              setAdding({ ...adding, address: event.currentTarget.value });
            }}
          />
        </label>
        <label>
          Device id
          <input
            type="text"
            value={adding.id}
            placeholder="Left empty for a Light found above"
            maxLength={LIGHT_KEYS_MAX_LENGTH}
            autocomplete="off"
            spellcheck={false}
            aria-invalid={addInvalid}
            {...describedByAdd}
            onInput={(event) => {
              setAdding({ ...adding, id: event.currentTarget.value });
            }}
          />
        </label>
        <label>
          Local key
          <input
            id={ADD_KEY_ID}
            type="password"
            value={adding.key}
            required
            maxLength={LIGHT_KEYS_MAX_LENGTH}
            autocomplete="off"
            spellcheck={false}
            aria-invalid={addInvalid}
            {...describedByAdd}
            onInput={(event) => {
              setAdding({ ...adding, key: event.currentTarget.value });
            }}
          />
        </label>
        <NameInput
          label="Name"
          value={adding.name}
          placeholder="Left empty, its maker's name"
          invalid={false}
          describedBy="lights-problem-add"
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
          Add Light
        </button>
        {sending && (
          <p class="waiting" role="status">
            Adding the Light…
          </p>
        )}
        {problemAt("add")}
      </form>
    </section>
  );
};
