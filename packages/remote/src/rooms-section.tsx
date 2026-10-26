import { useEffect, useRef, useState } from "preact/hooks";

import { ROOM_NAME_MAX_LENGTH, type Room } from "@media-centre/shared";

import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { NameInput } from "./name-input.tsx";
import type { RoomsApi } from "./rooms-api.ts";

export interface RoomsSectionProps {
  readonly rooms: RoomsApi;
  /** Called after every change the person makes, once the Hub has made it or refused. */
  readonly onChange?: () => void;
}

const ROOM_NAME_PLACEHOLDER = `Up to ${String(ROOM_NAME_MAX_LENGTH)} characters`;

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = { readonly where: "list" | "add" | "rename"; readonly message: string };

/**
 * Settings' Rooms: create, rename, delete and order them (FR-7). The order set
 * here is the Room order every tab groups its Appliances by (FR-10).
 */
export const RoomsSection = ({ rooms, onChange }: RoomsSectionProps) => {
  const [list, setList] = useState<readonly Room[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ readonly id: number; readonly name: string } | undefined>(undefined);
  const [deleting, setDeleting] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);

  const reload = async (): Promise<void> => {
    try {
      setList(await rooms.list());
    } catch (error) {
      setProblem({ where: "list", message: messageFor(error) });
    }
  };

  // Loaded once, on opening Settings, and again after every change.
  useEffect(() => {
    void reload();
  }, [rooms]);

  /**
   * Runs one change on the Hub, calling `onDone` once it is made, then shows
   * the Rooms as the Hub now has them, whether or not the change was made:
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
    onChange?.();
  };

  const move = (index: number, by: -1 | 1): void => {
    if (list === undefined) return;
    const ids = list.map((room) => room.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    void change("list", () => rooms.reorder(ids));
  };

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where && (
      <p id={`rooms-problem-${where}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  return (
    <section aria-labelledby="settings-rooms">
      <h2 id="settings-rooms">Rooms</h2>
      <p>Every tab groups its Appliances by Room, in this order.</p>
      {list === undefined ? (
        problem === undefined && <p>Loading the Rooms…</p>
      ) : list.length === 0 ? (
        <p>No Rooms yet. Add one below, e.g. "Living room".</p>
      ) : (
        <ol class="rooms" aria-label="Room order">
          {list.map((room, index) => (
            <li key={room.id}>
              {renaming?.id === room.id ? (
                <form
                  class="room-form"
                  aria-label={`Rename ${room.name}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void change(
                      "rename",
                      () => rooms.rename(room.id, renaming.name),
                      () => {
                        setRenaming(undefined);
                      },
                    );
                  }}
                >
                  <NameInput
                    label="Room name"
                    value={renaming.name}
                    invalid={problem?.where === "rename"}
                    placeholder={ROOM_NAME_PLACEHOLDER}
                    describedBy="rooms-problem-rename"
                    focus
                    onInput={(name) => {
                      setRenaming({ id: room.id, name });
                    }}
                  />
                  <button type="submit" disabled={busy}>
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(undefined);
                      setProblem(undefined);
                    }}
                  >
                    Cancel
                  </button>
                  {problemAt("rename")}
                </form>
              ) : deleting === room.id ? (
                <div class="room-row">
                  <span class="room-name">Delete {room.name}?</span>
                  <button
                    type="button"
                    class="button-danger"
                    disabled={busy}
                    onClick={() => {
                      void change("list", () => rooms.remove(room.id));
                      setDeleting(undefined);
                    }}
                  >
                    Yes, delete
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleting(undefined);
                    }}
                  >
                    No, keep it
                  </button>
                </div>
              ) : (
                <div class="room-row">
                  <span class="room-name">{room.name}</span>
                  <button
                    type="button"
                    aria-label={`Move ${room.name} up`}
                    disabled={busy || index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                  >
                    <Icon name="arrow-up" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${room.name} down`}
                    disabled={busy || index === list.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                  >
                    <Icon name="arrow-down" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${room.name}`}
                    onClick={() => {
                      setRenaming({ id: room.id, name: room.name });
                      setDeleting(undefined);
                      setProblem(undefined);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${room.name}`}
                    onClick={() => {
                      setDeleting(room.id);
                      setRenaming(undefined);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {problemAt("list")}
      <form
        class="room-form"
        aria-label="Add a Room"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newName;
          // Only the name just added is cleared, not the next one being typed.
          void change(
            "add",
            () => rooms.add(name),
            () => {
              setNewName((typed) => (typed === name ? "" : typed));
            },
          );
        }}
      >
        <NameInput
          label="New Room"
          value={newName}
          invalid={problem?.where === "add"}
          placeholder={ROOM_NAME_PLACEHOLDER}
          describedBy="rooms-problem-add"
          onInput={setNewName}
        />
        <button type="submit" disabled={busy}>
          Add Room
        </button>
        {problemAt("add")}
      </form>
    </section>
  );
};
