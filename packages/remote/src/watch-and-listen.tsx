import { useEffect, useId, useRef, useState } from "preact/hooks";

import type {
  Appliance,
  MediaFile,
  MediaFolder,
  MediaSource,
  PlayFolderRequest,
  PlayRequest,
  PlayStep,
  Route,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { Dialog } from "./dialog.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import { formatDuration, formatSize } from "./media-format.ts";
import type { MediaSourcesApi } from "./media-sources-api.ts";

/** The TV a Media File chosen is played on: the Selected TV. */
export interface PlayOn {
  readonly appliances: AppliancesApi;
  readonly tv: Appliance;
  /** The TV as the Remote names it, "Room · Name". */
  readonly title: string;
}

export interface WatchAndListenProps {
  readonly mediaSources: MediaSourcesApi;
  readonly onOpenSettings: () => void;
  /** Where a Media File chosen plays, or nothing with no TV, when Media Files are only listed. */
  readonly playOn?: PlayOn;
}

/** How playing the Media File chosen, or the folder, is going (FR-35). */
interface Playing {
  /** The Media File's name, or the folder's. */
  readonly file: string;
  /** The TV it is playing on, as it was named when it was chosen. */
  readonly title: string;
  /** Each step the Hub has started, in order. */
  readonly steps: readonly PlayStep[];
  readonly outcome: "going" | "sent" | { readonly failed: string };
}

/**
 * A Media File chosen that has a Resume Position, while the person chooses
 * whether to resume it or start over (FR-40).
 */
interface Offer {
  readonly folder: MediaFolder;
  readonly file: MediaFile;
  readonly positionMs: number;
}

/** "Resume from 1:12:30", or "Resume from 0:30" for under an hour, as the seek bar shows a position. */
const resumeFrom = (positionMs: number): string => `Resume from ${formatDuration(Math.floor(positionMs / 1_000))}`;

/** Each Route, as the glossary names it, which the person reads beside each Media File (FR-34). */
const ROUTE_NAMES: Readonly<Record<Route, string>> = {
  "direct-play": "Direct Play",
  remux: "Remux",
  "audio-conversion": "Audio Conversion",
  "full-conversion": "Full Conversion",
};

/** Each step, in order, as the person reads it in the list. */
const STEPS: readonly (readonly [PlayStep, string])[] = [
  ["waking", "Switch the TV on"],
  ["launching", "Launch the Player"],
  ["connecting", "The Player connects to the Hub"],
  ["sending", "Send the Media File"],
];

/** What the Remote says while each step goes on. */
const STEP_NOW: Readonly<Record<PlayStep, string>> = {
  waking: "Switching the TV on. It can take up to 30 seconds…",
  launching: "Launching the Player…",
  connecting: "Waiting for the Player to connect to the Hub…",
  sending: "Sending the Media File…",
};

type StepState = "done" | "current" | "failed" | "to-do";

const STEP_STATE_TEXT: Readonly<Record<StepState, string>> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  "to-do": "to do",
};

/**
 * Each step of playing a Media File on the TV, as it happens (FR-35): a
 * checklist, the step going on now, and why it failed if it did. Switching
 * the TV on is a step only for a TV that wasn't on.
 */
const PlayProgress = ({ playing, onDismiss }: { readonly playing: Playing; readonly onDismiss: () => void }) => {
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  const { file, title, steps, outcome } = playing;
  const last = steps.at(-1);
  const failed = typeof outcome === "object" ? outcome.failed : undefined;

  // On a phone the person chose it further down the folder, so the steps are brought into view.
  useEffect(() => {
    const shown = panel.current;
    if (shown !== null && "scrollIntoView" in shown) shown.scrollIntoView({ block: "nearest" });
  }, [file, title]);

  const stateOf = (step: PlayStep): StepState => {
    if (outcome === "sent") return "done";
    if (!steps.includes(step)) return "to-do";
    if (step !== last) return "done";
    return failed === undefined ? "current" : "failed";
  };

  const now =
    outcome === "sent"
      ? `Sent to the Player on ${title}.`
      : failed !== undefined
        ? `Couldn't play it on ${title}.`
        : last === undefined
          ? "Asking the Hub…"
          : STEP_NOW[last];

  return (
    <section class="play-progress" aria-labelledby={headingId} ref={panel}>
      <h3 id={headingId}>
        Play {file} on {title}
      </h3>
      <ol class="play-steps">
        {STEPS.filter(([step]) => step !== "waking" || steps.includes("waking")).map(([step, label]) => {
          const state = stateOf(step);
          return (
            <li
              key={step}
              class={`play-step play-step-${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              {label}
              <span class="visually-hidden"> ({STEP_STATE_TEXT[state]})</span>
            </li>
          );
        })}
      </ol>
      <p class="play-now" role="status">
        {now}
      </p>
      {failed !== undefined && (
        <p class="problem" role="alert">
          {failed}
        </p>
      )}
      {outcome !== "going" && (
        <button type="button" class="play-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </section>
  );
};

/** The folder being browsed: its Media Source, and its path inside it, `""` for the Media Source's own. */
interface Place {
  readonly source: MediaSource;
  readonly path: string;
}

/** The names of the folders that lead from the Media Source's own to `path`. */
const namesIn = (path: string): string[] => path.split("/").filter((name) => name !== "");

/** A Media File's path inside its Media Source. */
const pathOf = (inFolder: MediaFolder, file: MediaFile): string => [...namesIn(inFolder.path), file.name].join("/");

/**
 * The TV tab's Watch & Listen (FR-33): each Media Source, browsed as its
 * folder tree, with the folders and Media Files in each folder, by file name,
 * with each file's size and duration. The Hub leaves out every other file.
 * With a Selected TV, each Media File says whether it plays directly or
 * needs converting, its Route to that TV, and Full Conversion is flagged as
 * using a lot of the Hub's CPU (FR-34).
 * Choosing a Media File plays it on the Selected TV, showing each step as the
 * Hub takes it (FR-35); with no TV, Media Files are only listed. One with a
 * Resume Position first offers "Resume from h:mm:ss" or "Start over"
 * (FR-40), as the Hub has it when it is chosen, which another Remote or TV
 * may have changed since the folder was opened. A folder with audio Media
 * Files in it has "Play folder", which plays them on the Selected TV as a
 * Queue, in file-name order, those in its folders left out (FR-46).
 */
export const WatchAndListen = ({ mediaSources, onOpenSettings, playOn }: WatchAndListenProps) => {
  const [sources, setSources] = useState<readonly MediaSource[] | undefined>(undefined);
  const [place, setPlace] = useState<Place | undefined>(undefined);
  const [folder, setFolder] = useState<MediaFolder | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Counts every folder opened, so that one answered late is never shown after a later one. */
  const opened = useRef(0);
  const [playing, setPlaying] = useState<Playing | undefined>(undefined);
  /** Counts every Media File chosen, so that only the last one chosen is shown. */
  const chosen = useRef(0);
  const [offer, setOffer] = useState<Offer | undefined>(undefined);

  /** Has the Hub play the Media File, or the folder, named `name`, showing each step. */
  const startPlaying = async (name: string, request: PlayRequest | PlayFolderRequest): Promise<void> => {
    if (playOn === undefined) return;
    const { appliances, tv, title } = playOn;
    chosen.current += 1;
    const choosing = chosen.current;
    const update = (change: (now: Playing) => Playing): void => {
      if (choosing === chosen.current) setPlaying((now) => (now === undefined ? now : change(now)));
    };
    setPlaying({ file: name, title, steps: [], outcome: "going" });
    try {
      await appliances.play(tv.id, request, (step) => {
        update((now) => ({ ...now, steps: [...now.steps, step] }));
      });
      update((now) => ({ ...now, outcome: "sent" }));
    } catch (error) {
      update((now) => ({ ...now, outcome: { failed: messageFor(error) } }));
    }
  };

  const play = (inFolder: MediaFolder, file: MediaFile, resume: boolean): Promise<void> =>
    startPlaying(file.name, { mediaSourceId: inFolder.mediaSourceId, path: pathOf(inFolder, file), resume });

  /** Plays the Media File chosen, once the person has chosen to resume it or start over, if it has a Resume Position. */
  const choose = async (inFolder: MediaFolder, file: MediaFile): Promise<void> => {
    if (playOn === undefined) return;
    chosen.current += 1;
    const choosing = chosen.current;
    const { title } = playOn;
    // Asking the Hub for its Resume Position is the first thing done to play it.
    setPlaying({ file: file.name, title, steps: [], outcome: "going" });
    let positionMs: number | null;
    try {
      positionMs = await mediaSources.readResumePosition(inFolder.mediaSourceId, pathOf(inFolder, file));
    } catch (error) {
      if (choosing === chosen.current)
        setPlaying({ file: file.name, title, steps: [], outcome: { failed: messageFor(error) } });
      return;
    }
    if (choosing !== chosen.current) return;
    if (positionMs === null) {
      await play(inFolder, file, false);
      return;
    }
    setPlaying(undefined);
    setOffer({ folder: inFolder, file, positionMs });
  };

  /** Closes the offer, playing the Media File as the person chose, or nothing. */
  const answerOffer = (resume: boolean | undefined): void => {
    setOffer(undefined);
    if (offer !== undefined && resume !== undefined) void play(offer.folder, offer.file, resume);
  };

  const showSources = async (): Promise<void> => {
    opened.current += 1;
    const opening = opened.current;
    setPlace(undefined);
    setFolder(undefined);
    setProblem(undefined);
    try {
      const listed = await mediaSources.list();
      if (opening === opened.current) setSources(listed);
    } catch (error) {
      if (opening === opened.current) setProblem(messageFor(error));
    }
  };

  useEffect(() => {
    void showSources();
  }, [mediaSources]);

  // Each Media File's Route is to the Selected TV, so another TV's may differ.
  const tvId = playOn?.tv.id;
  const shownFor = useRef(tvId);
  useEffect(() => {
    if (shownFor.current === tvId) return;
    shownFor.current = tvId;
    if (place !== undefined) void open(place);
  }, [tvId]);

  const open = async (next: Place): Promise<void> => {
    opened.current += 1;
    const opening = opened.current;
    setPlace(next);
    setFolder(undefined);
    setProblem(undefined);
    try {
      const read = await mediaSources.browse(next.source.id, next.path, playOn?.tv.id);
      if (opening === opened.current) setFolder(read);
    } catch (error) {
      if (opening === opened.current) setProblem(messageFor(error));
    }
  };

  const problemShown = problem !== undefined && (
    <p class="problem" role="alert">
      {problem}
    </p>
  );

  return (
    <section class="watch-and-listen" aria-labelledby="watch-and-listen-heading">
      <h2 id="watch-and-listen-heading">Watch &amp; Listen</h2>
      <Dialog
        open={offer !== undefined}
        onClose={() => {
          answerOffer(undefined);
        }}
        title={offer === undefined ? "" : `Play ${offer.file.name}`}
        closeLabel="Close, playing nothing"
        footer={
          offer !== undefined && (
            <>
              <button
                type="button"
                onClick={() => {
                  answerOffer(false);
                }}
              >
                Start over
              </button>
              <button
                type="button"
                class="button-primary"
                onClick={() => {
                  answerOffer(true);
                }}
              >
                {resumeFrom(offer.positionMs)}
              </button>
            </>
          )
        }
      >
        {offer !== undefined && playOn !== undefined && (
          <p>
            Playback last reached {formatDuration(Math.floor(offer.positionMs / 1_000))}. Resume it from there on{" "}
            {playOn.title}, or start over.
          </p>
        )}
      </Dialog>
      {playing !== undefined && (
        <PlayProgress
          playing={playing}
          onDismiss={() => {
            setPlaying(undefined);
          }}
        />
      )}
      {place === undefined ? (
        <>
          {problemShown}
          {sources === undefined ? (
            problem === undefined && <p class="media-note">Loading the Media Sources…</p>
          ) : sources.length === 0 ? (
            <div class="media-note">
              <p>No Media Sources yet. Add the folders of films, shows and music on your PC or NAS in Settings.</p>
              <button type="button" onClick={onOpenSettings}>
                Add a Media Source
              </button>
            </div>
          ) : (
            <ul class="media-list" aria-label="Media Sources">
              {sources.map((source) => (
                <li key={source.id}>
                  <button
                    type="button"
                    class="media-folder"
                    onClick={() => {
                      void open({ source, path: "" });
                    }}
                  >
                    {source.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <nav class="media-path" aria-label="Folder">
            <ol>
              <li>
                <button type="button" onClick={() => void showSources()}>
                  Media Sources
                </button>
              </li>
              {[place.source.name, ...namesIn(place.path)].map((name, index, names) => {
                const path = namesIn(place.path).slice(0, index).join("/");
                return (
                  <li key={path}>
                    {index === names.length - 1 ? (
                      <span aria-current="location">{name}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void open({ source: place.source, path });
                        }}
                      >
                        {name}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          {problemShown}
          {folder === undefined ? (
            problem === undefined && <p class="media-note">Loading…</p>
          ) : folder.folders.length === 0 && folder.files.length === 0 ? (
            <p class="media-note">No folders or Media Files here.</p>
          ) : (
            <>
              {playOn !== undefined && folder.files.length > 0 && (
                <p class="media-note">Choose a Media File to play it on {playOn.title}.</p>
              )}
              {playOn !== undefined && folder.files.some(({ kind }) => kind === "audio") && (
                <button
                  type="button"
                  class="media-play-folder"
                  onClick={() => {
                    void startPlaying(namesIn(folder.path).at(-1) ?? place.source.name, {
                      mediaSourceId: folder.mediaSourceId,
                      folder: folder.path,
                    });
                  }}
                >
                  <Icon name="play" />
                  Play folder
                </button>
              )}
              <ul class="media-list" aria-label={`In ${namesIn(folder.path).at(-1) ?? place.source.name}`}>
                {folder.folders.map((name) => (
                  <li key={`folder:${name}`}>
                    <button
                      type="button"
                      class="media-folder"
                      onClick={() => {
                        void open({ source: place.source, path: [...namesIn(folder.path), name].join("/") });
                      }}
                    >
                      {name}
                    </button>
                  </li>
                ))}
                {folder.files.map((file) => {
                  // The commas are for a screen reader, which reads the file's name, size and length as one.
                  const details = (
                    <>
                      <span class="media-file-name">{file.name}</span>
                      <span class="visually-hidden">, </span>
                      <span class="media-file-details">
                        <span class="media-file-size">{formatSize(file.size)}</span>
                        <span class="visually-hidden">, </span>
                        <span class="media-file-duration">
                          {file.duration === null ? "Length unknown" : formatDuration(file.duration)}
                        </span>
                        {file.route !== null && (
                          <>
                            <span class="visually-hidden">, </span>
                            <span class={`media-file-route media-file-route-${file.route}`}>
                              {ROUTE_NAMES[file.route]}
                            </span>
                          </>
                        )}
                      </span>
                      {file.route === "full-conversion" && (
                        <>
                          <span class="visually-hidden">, </span>
                          <span class="media-file-cpu">Uses a lot of the Hub's CPU</span>
                        </>
                      )}
                    </>
                  );
                  return playOn === undefined ? (
                    <li key={`file:${file.name}`} class={`media-file media-${file.kind}`} aria-label={file.name}>
                      {details}
                    </li>
                  ) : (
                    <li key={`file:${file.name}`} class="media-file-entry" aria-label={file.name}>
                      <button
                        type="button"
                        class={`media-file media-${file.kind}`}
                        onClick={() => {
                          void choose(folder, file);
                        }}
                      >
                        {details}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
};
