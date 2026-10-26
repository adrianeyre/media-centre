import { useId, useRef, useState } from "preact/hooks";

import type { Appliance, PlayerAction, PlayerActionStep } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";

export interface TvPlayerToolsProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV. */
  readonly tv: Appliance;
  /** It as the Remote names it, "Room · Name" (FR-9). */
  readonly title: string;
  /** Whether it says, now, that it is in Developer Mode with the Hub's IP as its Developer IP. */
  readonly ready: boolean;
}

/** How an action asked for is going. */
interface Acting {
  readonly action: PlayerAction;
  /** Each step the Hub has started, in order. */
  readonly steps: readonly PlayerActionStep[];
  readonly outcome: "going" | "done" | { readonly failed: string };
}

/** Each action's steps, in order, as the person reads them in the list. */
const STEPS: Readonly<Record<PlayerAction, readonly (readonly [PlayerActionStep, string])[]>> = {
  install: [
    ["connecting", "Connect to the TV"],
    ["signing", "Sign the Player with your certificate"],
    ["installing", "Install it on the TV"],
  ],
  launch: [
    ["connecting", "Connect to the TV"],
    ["launching", "Launch the Player"],
  ],
  uninstall: [
    ["connecting", "Connect to the TV"],
    ["uninstalling", "Uninstall the Player"],
  ],
};

/** What the Remote says while each step goes on. */
const STEP_NOW: Readonly<Record<PlayerActionStep, string>> = {
  connecting: "Connecting to the TV…",
  signing: "Signing the Player with your signing certificate…",
  installing: "Installing the Player. It can take a minute…",
  launching: "Launching the Player…",
  uninstalling: "Uninstalling the Player…",
};

/** Each action, as the heading over its steps and the Hub's outcome say it. */
const ACTION_NAMES: Readonly<Record<PlayerAction, { readonly heading: string; readonly done: string }>> = {
  install: { heading: "Install / update the Player", done: "installed on" },
  launch: { heading: "Launch the Player", done: "launched on" },
  uninstall: { heading: "Uninstall the Player", done: "uninstalled from" },
};

type StepState = "done" | "current" | "failed" | "to-do";

const STEP_STATE_TEXT: Readonly<Record<StepState, string>> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  "to-do": "to do",
};

/** Each step of the action, as it happens: a checklist, the step going on now, and why it failed if it did. */
const ActionProgress = ({ acting, title }: { readonly acting: Acting; readonly title: string }) => {
  const headingId = useId();
  const { action, steps, outcome } = acting;
  const last = steps.at(-1);
  const failed = typeof outcome === "object" ? outcome.failed : undefined;

  const stateOf = (step: PlayerActionStep): StepState => {
    if (outcome === "done") return "done";
    if (!steps.includes(step)) return "to-do";
    if (step !== last) return "done";
    return failed === undefined ? "current" : "failed";
  };

  const now =
    outcome === "done"
      ? `The Player is ${ACTION_NAMES[action].done} ${title}.`
      : failed !== undefined
        ? `Couldn't ${action} the Player on ${title}.`
        : last === undefined
          ? "Asking the Hub…"
          : STEP_NOW[last];

  return (
    <section class="play-progress" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {ACTION_NAMES[action].heading} on {title}
      </h3>
      <ol class="play-steps">
        {STEPS[action].map(([step, label]) => {
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
    </section>
  );
};

/**
 * The Developer section's Player (FR-31): once the TV says it is in
 * Developer Mode with the Hub's IP as its Developer IP, "Install / update
 * Player", which has the Hub sign the Player build it has with the signing
 * certificate in Settings and install it, over any there, and "Launch
 * Player" and "Uninstall Player", which asks first. Each shows its steps as
 * the Hub takes them, and why it failed if it did. One runs at a time; what
 * it did stays shown until another is asked for, even should the TV stop
 * saying it is in Developer Mode meanwhile.
 */
export const TvPlayerTools = ({ appliances, tv, title, ready }: TvPlayerToolsProps) => {
  const [acting, setActing] = useState<Acting | undefined>(undefined);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const running = useRef(false);
  const busy = acting?.outcome === "going";

  const act = async (action: PlayerAction): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setConfirmingUninstall(false);
    setActing({ action, steps: [], outcome: "going" });
    try {
      await appliances.playerAction(tv.id, action, (step) => {
        setActing((now) => (now === undefined ? now : { ...now, steps: [...now.steps, step] }));
      });
      setActing((now) => (now === undefined ? now : { ...now, outcome: "done" }));
    } catch (error) {
      setActing((now) => (now === undefined ? now : { ...now, outcome: { failed: messageFor(error) } }));
    }
    running.current = false;
  };

  return (
    <>
      <h3>Player</h3>
      {ready ? (
        <>
          <p class="developer-note">
            {title} is in Developer Mode with the Hub's IP, so the Hub can install the Player on it, signed with the
            signing certificate in Settings. Installing it again updates it to the Hub's build.
          </p>
          {confirmingUninstall ? (
            <div class="room-row">
              <span class="room-name">Uninstall the Player from {title}?</span>
              <button
                type="button"
                class="button-danger"
                disabled={busy}
                onClick={() => {
                  void act("uninstall");
                }}
              >
                Yes, uninstall
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingUninstall(false);
                }}
              >
                No, keep it
              </button>
            </div>
          ) : (
            <div class="player-tools">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void act("install");
                }}
              >
                Install / update Player
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void act("launch");
                }}
              >
                Launch Player
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingUninstall(true);
                }}
              >
                Uninstall Player
              </button>
            </div>
          )}
        </>
      ) : (
        <p class="developer-note">
          Once Developer Mode is on with the Hub's IP as {title}'s Developer IP, the Hub can install the Player on it
          from here.
        </p>
      )}
      {acting !== undefined && <ActionProgress acting={acting} title={title} />}
    </>
  );
};
