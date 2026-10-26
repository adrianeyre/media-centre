import { useEffect, useRef, useState } from "preact/hooks";

import type { Appliance, Room } from "@media-centre/shared";

import { applianceTitle } from "./appliance-names.ts";
import { Icon } from "./icons.tsx";

export interface TvPickerProps {
  /** Every TV, in the order the TV tab lists them. */
  readonly tvs: readonly Appliance[];
  readonly rooms: readonly Room[];
  readonly selected: Appliance;
  readonly onSelect: (id: number) => void;
}

/**
 * The TV picker: names the Selected TV and, one tap on it, lists every TV as
 * "Room · Name" to choose another (FR-9, FR-15). Every TV screen has it at
 * the top. Escape, or a tap anywhere else, closes it without choosing.
 */
export const TvPicker = ({ tvs, rooms, selected, onSelect }: TvPickerProps) => {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);

  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node && picker.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={picker} class="tv-picker">
      <button
        ref={toggle}
        type="button"
        class="tv-picker-toggle"
        aria-expanded={open}
        aria-controls="tv-picker-choices"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span class="tv-picker-label">
          Selected TV: <strong>{applianceTitle(selected, rooms)}</strong>
        </span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <ul id="tv-picker-choices" class="tv-picker-choices" aria-label="Choose a TV">
          {tvs.map((tv) => (
            <li key={tv.id}>
              <button
                type="button"
                aria-pressed={tv.id === selected.id}
                onClick={() => {
                  onSelect(tv.id);
                  close();
                }}
              >
                {applianceTitle(tv, rooms)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
