import { useEffect, useId, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";

import { Icon } from "./icons.tsx";

/**
 * Makes a `<dialog>` modal while `open`, on the platform's own dialog: the
 * page behind it is inert, so focus can't leave it, and it has focus as it
 * opens, on its element marked `data-autofocus`, if any. Escape, the
 * platform's other ways of closing (such as Android's back gesture) and a
 * tap on its backdrop all call `onClose`. Once closed, or gone, focus goes
 * back to whatever had it before it opened: only then, as until it is
 * closed, everything behind it is inert, and refuses focus.
 */
export const useModalDialog = (open: boolean, onClose: () => void) => {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Escape's own `keydown`, held back here, would otherwise close it without a word to `onClose`.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    const onCancel = (event: Event): void => {
      event.preventDefault();
      close.current();
    };
    // A tap on the backdrop lands on the dialog itself; one on its content, on what is in it.
    const onClick = (event: MouseEvent): void => {
      if (event.target === dialog) close.current();
    };
    dialog.addEventListener("keydown", onKeyDown);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onClick);
      // Gone while open, as TV Menu mode goes when it is closed.
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      returnTo.current?.focus();
      returnTo.current = null;
    };
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // A browser without a modal dialog still shows it, just not modally.
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      returnTo.current?.focus();
      returnTo.current = null;
    }
  }, [open]);

  return ref;
};

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  /** What the × in its corner says to a screen reader, such as "Close the Cookie Policy". */
  readonly closeLabel: string;
  readonly children: ComponentChildren;
  /** Buttons kept in view beneath the body, however far it is scrolled. */
  readonly footer?: ComponentChildren;
  /** As wide as the screen allows, for a drawing beside its controls. */
  readonly wide?: boolean;
}

/**
 * A modal dialog: its title and a × to close it in a header, and any buttons
 * in a footer, both kept in place while the body between them scrolls, down
 * or, for content too wide for the screen such as a table, across.
 */
export const Dialog = ({ open, onClose, title, closeLabel, children, footer, wide = false }: DialogProps) => {
  const ref = useModalDialog(open, onClose);
  const titleId = useId();

  return (
    <dialog ref={ref} class={`dialog${wide ? " dialog-wide" : ""}`} aria-labelledby={titleId}>
      {open && (
        <>
          <div class="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              class="button-icon dialog-close"
              aria-label={closeLabel}
              data-autofocus
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          </div>
          {/* Focusable, so it can be scrolled from the keyboard. */}
          <div class="dialog-body" role="region" aria-labelledby={titleId} tabIndex={0}>
            {children}
          </div>
          {footer !== undefined && <div class="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
};
