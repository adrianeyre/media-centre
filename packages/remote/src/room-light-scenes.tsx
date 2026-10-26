import { useId, useRef, useState } from "preact/hooks";

import { LIGHT_SCENE_NAME_MAX_LENGTH, type Appliance, type LightScene, type LightsOutcome } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import type { LightReadings } from "./light-readings.ts";
import { NameInput } from "./name-input.tsx";
import { inWords } from "./room-lights.tsx";

/** How a Room's Light Scenes widget is named, in the Widgets menu and over it. */
export const roomLightScenesTitle = (room: string): string => `${room} Light Scenes`;

const LIGHT_SCENE_NAME_PLACEHOLDER = `Up to ${String(LIGHT_SCENE_NAME_MAX_LENGTH)} characters`;

export interface RoomLightScenesProps {
  readonly appliances: AppliancesApi;
  readonly readings: LightReadings;
  readonly roomId: number;
  /** The Room's name. */
  readonly room: string;
  /** Every Light in the Room. */
  readonly lights: readonly Appliance[];
  /** The Room's Light Scenes, as the Hub last listed them. */
  readonly lightScenes: readonly LightScene[];
  /** How the Remote names each Light, "Room · Name" (FR-9), by its id. */
  readonly titles: ReadonlyMap<number, string>;
  /** Called after every change the person makes, once the Hub has made it or refused, to list them again. */
  readonly onChange: () => void;
}

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = { readonly where: "list" | "save" | "rename"; readonly message: string };

/** What the last save or recall did, and which Lights, by name, it couldn't reach. */
type Said =
  { readonly kind: "saved" | "recalled"; readonly name: string; readonly unreached: readonly string[] } | undefined;

const pluralLights = (count: number): string => `${String(count)} ${count === 1 ? "Light" : "Lights"}`;

/**
 * A Room's Light Scenes (FR-56): "Save as Light Scene", naming it, keeps
 * each of the Room's Lights as it is now, on the Hub; each Light Scene is
 * recalled, setting each of its Lights still in the Room back as it was,
 * and is renamed or deleted. A recall shows each Light's answer in its own
 * widget at once, and, as a save does, names those that didn't answer
 * (FR-57b). One change runs at a time.
 */
export const RoomLightScenes = ({
  appliances,
  readings,
  roomId,
  room,
  lights,
  lightScenes,
  titles,
  onChange,
}: RoomLightScenesProps) => {
  const headingId = useId();
  const problemId = useId();
  const [naming, setNaming] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<{ readonly id: number; readonly name: string } | undefined>(undefined);
  const [deleting, setDeleting] = useState<number | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [said, setSaid] = useState<Said>(undefined);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  // The Lights as the tab last listed them, for a recall still on its way when they changed.
  const latest = useRef({ lights, titles });
  latest.current = { lights, titles };

  const named = (ids: readonly number[]): string[] =>
    ids.map((id) => latest.current.titles.get(id) ?? "a Light since removed");

  /** Runs one change on the Hub, calling `onDone` with what it answered once it is made, then lists them again. */
  const change = async <T,>(where: Problem["where"], work: () => Promise<T>, onDone: (done: T) => void) => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    setSaid(undefined);
    try {
      onDone(await work());
    } catch (error) {
      setProblem({ where, message: messageFor(error) });
    }
    changing.current = false;
    setBusy(false);
    onChange();
  };

  const recall = (lightScene: LightScene): void => {
    const ids = latest.current.lights.map(({ id }) => id);
    void change(
      "list",
      async (): Promise<LightsOutcome> => {
        for (const id of ids) readings.changing(id);
        try {
          return await appliances.recallLightScene(lightScene.id);
        } finally {
          for (const id of ids) readings.changing(id);
        }
      },
      (outcome) => {
        for (const { id, reading } of outcome.lights) readings.answered(id, reading);
        setSaid({ kind: "recalled", name: lightScene.name, unreached: named(outcome.unreached) });
      },
    );
  };

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where && (
      <p id={`${problemId}-${where}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  const saidNote =
    said === undefined ? null : said.unreached.length === 0 ? (
      <p class="lights-done" role="status">
        {`${said.kind === "saved" ? "Saved" : "Recalled"} "${said.name}".`}
      </p>
    ) : (
      <p class="problem" role="alert">
        {said.kind === "saved"
          ? `Saved "${said.name}" without ${inWords(said.unreached)}, which didn't answer.`
          : `Recalled "${said.name}", but couldn't reach ${inWords(said.unreached)}.`}
      </p>
    );

  return (
    <section class="room-light-scenes" aria-labelledby={headingId}>
      <h2 id={headingId}>{roomLightScenesTitle(room)}</h2>
      {lightScenes.length === 0 ? (
        <p class="light-note">No Light Scenes yet. Set the Room's Lights as you like them, then save them as one.</p>
      ) : (
        <ul class="light-scenes" aria-label={`Light Scenes in ${room}`}>
          {lightScenes.map((lightScene) => (
            <li key={lightScene.id}>
              {renaming?.id === lightScene.id ? (
                <form
                  class="room-form"
                  aria-label={`Rename ${lightScene.name}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void change(
                      "rename",
                      () => appliances.renameLightScene(lightScene.id, renaming.name),
                      () => {
                        setRenaming(undefined);
                      },
                    );
                  }}
                >
                  <NameInput
                    label="Light Scene name"
                    value={renaming.name}
                    invalid={problem?.where === "rename"}
                    placeholder={LIGHT_SCENE_NAME_PLACEHOLDER}
                    describedBy={`${problemId}-rename`}
                    focus
                    onInput={(name) => {
                      setRenaming({ id: lightScene.id, name });
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
              ) : deleting === lightScene.id ? (
                <div class="room-row">
                  <span class="room-name">Delete {lightScene.name}?</span>
                  <button
                    type="button"
                    class="button-danger"
                    disabled={busy}
                    onClick={() => {
                      setDeleting(undefined);
                      void change(
                        "list",
                        () => appliances.deleteLightScene(lightScene.id),
                        () => undefined,
                      );
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
                  <span class="room-name">
                    {lightScene.name}
                    <span class="light-scene-lights">{pluralLights(lightScene.lights.length)}</span>
                  </span>
                  <button
                    type="button"
                    class="light-scene-recall"
                    aria-label={`Recall ${lightScene.name}`}
                    disabled={busy}
                    onClick={() => {
                      recall(lightScene);
                    }}
                  >
                    <Icon name="play" />
                    Recall
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${lightScene.name}`}
                    onClick={() => {
                      setRenaming({ id: lightScene.id, name: lightScene.name });
                      setDeleting(undefined);
                      setProblem(undefined);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${lightScene.name}`}
                    onClick={() => {
                      setDeleting(lightScene.id);
                      setRenaming(undefined);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {problemAt("list")}
      {saidNote}
      {naming === undefined ? (
        <button
          type="button"
          class="light-scene-save"
          onClick={() => {
            setNaming("");
            setProblem(undefined);
          }}
        >
          <Icon name="plus" />
          Save as Light Scene
        </button>
      ) : (
        <form
          class="room-form"
          aria-label={`Save ${room}'s Lights as a Light Scene`}
          onSubmit={(event) => {
            event.preventDefault();
            const name = naming;
            void change(
              "save",
              () => appliances.saveLightScene(roomId, name),
              ({ lightScene, unreached }) => {
                setNaming(undefined);
                setSaid({ kind: "saved", name: lightScene.name, unreached: named(unreached) });
              },
            );
          }}
        >
          <NameInput
            label="Light Scene name"
            value={naming}
            invalid={problem?.where === "save"}
            placeholder={LIGHT_SCENE_NAME_PLACEHOLDER}
            describedBy={`${problemId}-save`}
            focus
            onInput={setNaming}
          />
          <button type="submit" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setNaming(undefined);
              setProblem(undefined);
            }}
          >
            Cancel
          </button>
          {problemAt("save")}
        </form>
      )}
    </section>
  );
};
