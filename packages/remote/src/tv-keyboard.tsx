import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import type { Appliance } from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { messageFor } from "./hub-request.ts";

/**
 * How often the Remote asks the Hub again whether the Selected TV's on-screen
 * keyboard is open: often, as the person is waiting to type.
 */
export const KEYBOARD_REFRESH_MS = 1_000;

export interface TvKeyboardProps {
  readonly appliances: AppliancesApi;
  /** The Selected TV, whose keyboard this is. */
  readonly tv: Appliance;
  /** Shown in its place while there is nothing to show, e.g. on the TV tab's grid; nothing, if not given. */
  readonly idle?: ComponentChildren;
  /** {@link KEYBOARD_REFRESH_MS} but in tests. */
  readonly refreshMs?: number;
}

/**
 * Text input for the Selected TV (FR-20): while the TV's on-screen keyboard is
 * open, e.g. for a search box, a text field the person types into with the
 * phone's own keyboard, which takes the focus as it appears. Sending it has
 * the Hub type exactly that into the TV's keyboard and submit it, which closes
 * it. The field goes once the TV's keyboard closes, however it closed, taking
 * any text not sent with it. Text the Hub couldn't send is kept, with its reason.
 */
export const TvKeyboard = ({ appliances, tv, idle = null, refreshMs = KEYBOARD_REFRESH_MS }: TvKeyboardProps) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  /** Reads whether the keyboard is open now, between refreshes; set while it is shown. */
  const readNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const readKeyboard = async (): Promise<void> => {
      // A Hub that didn't answer leaves the field as it was, and what is in it.
      const answer = await appliances.readKeyboard(tv.id).catch(() => undefined);
      if (current && answer !== undefined) setOpen(answer);
    };
    readNow.current = () => void readKeyboard();

    const refresh = async (): Promise<void> => {
      // A phone with the Remote in the background needn't keep asking.
      if (document.visibilityState !== "hidden") await readKeyboard();
      if (current) timer = setTimeout(() => void refresh(), refreshMs);
    };

    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [appliances, tv.id, refreshMs]);

  useEffect(() => {
    if (open) {
      field.current?.focus();
    } else {
      setText("");
      setProblem(undefined);
    }
  }, [open]);

  if (!open) return <>{idle}</>;

  const send = (): void => {
    if (text === "" || sending) return;
    setSending(true);
    void appliances.enterText(tv.id, text).then(
      () => {
        setSending(false);
        setText("");
        setProblem(undefined);
        readNow.current();
      },
      (error: unknown) => {
        setSending(false);
        setProblem(messageFor(error));
      },
    );
  };

  return (
    <form
      class="tv-keyboard"
      aria-label="TV keyboard"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor="tv-keyboard-text">Text for the TV</label>
      <p id="tv-keyboard-note" class="keyboard-note">
        The TV's keyboard is open. What you send is typed into it.
      </p>
      <div class="keyboard-row">
        <input
          ref={field}
          id="tv-keyboard-text"
          type="text"
          value={text}
          autocomplete="off"
          enterkeyhint="send"
          aria-describedby={problem === undefined ? "tv-keyboard-note" : "tv-keyboard-note tv-keyboard-problem"}
          onInput={(event) => {
            setText(event.currentTarget.value);
          }}
        />
        <button type="submit" disabled={text === "" || sending}>
          Send
        </button>
      </div>
      {problem !== undefined && (
        <p id="tv-keyboard-problem" class="problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
};
