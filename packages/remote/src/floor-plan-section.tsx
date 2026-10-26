import { useEffect, useState } from "preact/hooks";

import type { FloorPlanDrawing } from "@media-centre/shared";

import { BUILT_IN_FLOOR_PLAN } from "./floor-plan.ts";
import { FloorPlanEditor } from "./floor-plan-editor.tsx";
import { messageFor } from "./hub-request.ts";
import { Icon } from "./icons.tsx";
import type { RoomsApi } from "./rooms-api.ts";

export interface FloorPlanSectionProps {
  readonly rooms: RoomsApi;
}

/** What the plan is made of, in a sentence: whose drawing, and how many floors and places. */
export const describeDrawing = ({ layout, image }: FloorPlanDrawing): string => {
  const shown = layout ?? BUILT_IN_FLOOR_PLAN;
  const places = shown.floors.reduce((count, floor) => count + floor.places.length, 0);
  const floors = shown.floors.length === 1 ? "one floor" : `${String(shown.floors.length)} floors`;
  const drawing = image === null ? "The built-in drawing" : "Your own image";
  return `${drawing}, with ${floors} and ${String(places)} places ${layout === null ? "built in" : "drawn on it"}.`;
};

/**
 * Settings' Floor plan: what the Rooms tab's plan is drawn on and how many
 * places it has, the editor that draws it, and the way back to the built-in
 * drawing, with its own places.
 */
export const FloorPlanSection = ({ rooms }: FloorPlanSectionProps) => {
  const [drawing, setDrawing] = useState<FloorPlanDrawing | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    rooms.drawing().then(
      (drawn) => {
        if (current) setDrawing(drawn);
      },
      (error: unknown) => {
        if (current) setProblem(messageFor(error));
      },
    );
    return () => {
      current = false;
    };
  }, [rooms]);

  const reset = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      setDrawing(await rooms.resetDrawing());
    } catch (error) {
      setProblem(messageFor(error));
    }
    setResetting(false);
    setBusy(false);
  };

  const builtIn = drawing !== undefined && drawing.layout === null && drawing.image === null;

  return (
    <section aria-labelledby="settings-floor-plan">
      <div class="settings-card-head">
        <div>
          <h2 id="settings-floor-plan">
            <Icon name="layout-grid" />
            Floor plan
          </h2>
          <p class="settings-card-lead">
            The Rooms tab's plan: draw your own, on your own image of the home, or use the built-in one.
          </p>
        </div>
      </div>
      {drawing === undefined ? (
        problem === undefined && <p>Loading the floor plan…</p>
      ) : (
        <p role="status">{describeDrawing(drawing)}</p>
      )}
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      {drawing !== undefined &&
        (resetting ? (
          <div class="room-row">
            <span class="room-name">Go back to the built-in drawing, and lose the places drawn?</span>
            <button type="button" class="button-danger" disabled={busy} onClick={() => void reset()}>
              Yes, go back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setResetting(false);
              }}
            >
              No, keep it
            </button>
          </div>
        ) : (
          <div class="room-row">
            <button
              type="button"
              onClick={() => {
                setEditing(true);
              }}
            >
              <Icon name="pencil" />
              Draw the plan
            </button>
            {!builtIn && (
              <button
                type="button"
                onClick={() => {
                  setResetting(true);
                }}
              >
                Use the built-in plan
              </button>
            )}
          </div>
        ))}
      {editing && (
        <FloorPlanEditor
          roomsApi={rooms}
          onClose={() => {
            setEditing(false);
          }}
          onSaved={(drawn) => {
            setEditing(false);
            setDrawing(drawn);
          }}
        />
      )}
    </section>
  );
};
