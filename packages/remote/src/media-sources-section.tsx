import { useEffect, useRef, useState } from "preact/hooks";

import { MEDIA_SOURCE_NAME_MAX_LENGTH, type MediaSource } from "@media-centre/shared";

import { messageFor } from "./hub-request.ts";
import type { MediaSourcesApi } from "./media-sources-api.ts";
import { NameInput } from "./name-input.tsx";

export interface MediaSourcesSectionProps {
  readonly mediaSources: MediaSourcesApi;
}

const NAME_PLACEHOLDER = `Up to ${String(MEDIA_SOURCE_NAME_MAX_LENGTH)} characters`;

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = { readonly where: "list" | "add" | "rename"; readonly message: string };

/**
 * Settings' Media Sources: add, rename and remove the folders whose Media
 * Files Watch & Listen browses (FR-32). The Hub checks it can read a folder
 * before adding it, and says why not when it can't.
 */
export const MediaSourcesSection = ({ mediaSources }: MediaSourcesSectionProps) => {
  const [list, setList] = useState<readonly MediaSource[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [renaming, setRenaming] = useState<{ readonly id: number; readonly name: string } | undefined>(undefined);
  const [removing, setRemoving] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);

  const reload = async (): Promise<void> => {
    try {
      setList(await mediaSources.list());
    } catch (error) {
      setProblem({ where: "list", message: messageFor(error) });
    }
  };

  // Loaded once, on opening Settings, and again after every change.
  useEffect(() => {
    void reload();
  }, [mediaSources]);

  /**
   * Runs one change on the Hub, calling `onDone` once it is made, then shows
   * the Media Sources as the Hub now has them, whether or not the change was
   * made: another Remote may have changed them. One change runs at a time.
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

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where && (
      <p id={`media-sources-problem-${where}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  return (
    <section aria-labelledby="settings-media-sources">
      <h2 id="settings-media-sources">Media Sources</h2>
      <p>
        The folders of films, shows and music that Watch &amp; Listen browses: a folder on the Hub's machine, or a
        network share mounted into it.
      </p>
      {list === undefined ? (
        problem === undefined && <p>Loading the Media Sources…</p>
      ) : list.length === 0 ? (
        <p>No Media Sources yet. Add a folder below, e.g. /media/films.</p>
      ) : (
        <ul class="rooms" aria-label="Media Sources">
          {list.map((source) => (
            <li key={source.id} aria-label={source.name}>
              {renaming?.id === source.id ? (
                <form
                  class="room-form"
                  aria-label={`Rename ${source.name}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void change(
                      "rename",
                      () => mediaSources.rename(source.id, renaming.name),
                      () => {
                        setRenaming(undefined);
                      },
                    );
                  }}
                >
                  <NameInput
                    label="Media Source name"
                    value={renaming.name}
                    invalid={problem?.where === "rename"}
                    placeholder={NAME_PLACEHOLDER}
                    describedBy="media-sources-problem-rename"
                    focus
                    onInput={(name) => {
                      setRenaming({ id: source.id, name });
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
              ) : removing === source.id ? (
                <div class="room-row">
                  <span class="room-name">Remove {source.name}? Its files stay where they are.</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void change("list", () => mediaSources.remove(source.id));
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
                <div class="room-row">
                  <span class="room-name">
                    <span class="media-source-name">{source.name}</span>
                    <span class="media-source-path">{source.path}</span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Rename ${source.name}`}
                    onClick={() => {
                      setRenaming({ id: source.id, name: source.name });
                      setRemoving(undefined);
                      setProblem(undefined);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${source.name}`}
                    onClick={() => {
                      setRemoving(source.id);
                      setRenaming(undefined);
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {problemAt("list")}
      <form
        class="room-form"
        aria-label="Add a Media Source"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newName;
          const path = newPath;
          // Only what was just added is cleared, not the next one being typed.
          void change(
            "add",
            () => mediaSources.add(name, path),
            () => {
              setNewName((typed) => (typed === name ? "" : typed));
              setNewPath((typed) => (typed === path ? "" : typed));
            },
          );
        }}
      >
        <h3 class="form-heading">Add a Media Source</h3>
        <label>
          Folder
          <input
            type="text"
            value={newPath}
            placeholder="Its full path on the Hub, e.g. /media/films"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            aria-invalid={problem?.where === "add"}
            {...(problem?.where === "add" ? { "aria-describedby": "media-sources-problem-add" } : {})}
            onInput={(event) => {
              setNewPath(event.currentTarget.value);
            }}
          />
        </label>
        <NameInput
          label="Name"
          value={newName}
          invalid={problem?.where === "add"}
          placeholder="Left empty, the folder's own name"
          describedBy="media-sources-problem-add"
          onInput={setNewName}
        />
        <p class="form-help">
          In Docker, the folder is where it is mounted into the Hub's container, not where it is on the NAS.
        </p>
        <button type="submit" disabled={busy}>
          Add Media Source
        </button>
        {problemAt("add")}
      </form>
    </section>
  );
};
