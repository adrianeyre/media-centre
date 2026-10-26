import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "./dialog.tsx";

afterEach(cleanup);

/** A button that opens a dialog, as the footer's do. */
const Opener = ({ footer = true }: { readonly footer?: boolean }) => {
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Cookie Policy"
        closeLabel="Close Cookie Policy"
        {...(footer
          ? {
              footer: (
                <button type="button" onClick={close}>
                  Done
                </button>
              ),
            }
          : {})}
      >
        <p>What is stored.</p>
      </Dialog>
    </>
  );
};

const dialog = () => screen.queryByRole("dialog", { name: "Cookie Policy" });

const open = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
};

describe("a dialog", () => {
  it("opens modally, named by its title, with focus on its ×", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(<Opener />);
    expect(dialog()).toBeNull();

    open();

    expect(showModal).toHaveBeenCalledOnce();
    showModal.mockRestore();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close Cookie Policy" }));
  });

  it("has its body as a region that can be scrolled from the keyboard", () => {
    render(<Opener />);
    open();

    const body = screen.getByRole("region", { name: "Cookie Policy" });
    expect(body.textContent).toBe("What is stored.");
    expect(body.tabIndex).toBe(0);
  });

  it.each([
    ["its ×", () => fireEvent.click(screen.getByRole("button", { name: "Close Cookie Policy" }))],
    ["a button in its footer", () => fireEvent.click(screen.getByRole("button", { name: "Done" }))],
    ["Escape", () => fireEvent.keyDown(screen.getByRole("button", { name: "Done" }), { key: "Escape" })],
    ["the platform's cancel", () => fireEvent(dialog() as HTMLElement, new Event("cancel", { cancelable: true }))],
    ["a tap on its backdrop", () => dialog() && fireEvent.click(dialog() as HTMLElement)],
  ])("closes with %s, handing focus back to what opened it", (_, close) => {
    render(<Opener />);
    screen.getByRole("button", { name: "Open" }).focus();
    open();

    close();

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
  });

  it("stays open when its content is tapped", () => {
    render(<Opener />);
    open();

    fireEvent.click(screen.getByText("What is stored."));

    expect(dialog()).not.toBeNull();
  });

  it("has no footer when it has no buttons for one", () => {
    render(<Opener footer={false} />);
    open();

    expect(dialog()?.querySelector(".dialog-foot")).toBeNull();
  });
});
