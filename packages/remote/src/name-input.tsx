import { useEffect, useRef } from "preact/hooks";

export interface NameInputProps {
  /** For a form that moves the focus to it, e.g. on choosing a found TV. */
  readonly id?: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly invalid: boolean;
  readonly describedBy: string;
  /** Takes the focus when it appears, e.g. on tapping Rename. */
  readonly focus?: boolean;
  readonly onInput: (value: string) => void;
}

/**
 * A name for a Room or an Appliance. The Hub decides what is allowed and says
 * why it refuses, so the field doesn't silently cut a long name short.
 */
export const NameInput = ({
  id,
  label,
  value,
  placeholder,
  invalid,
  describedBy,
  focus = false,
  onInput,
}: NameInputProps) => {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  return (
    <label>
      {label}
      <input
        ref={input}
        {...(id === undefined ? {} : { id })}
        type="text"
        value={value}
        placeholder={placeholder}
        autocomplete="off"
        aria-invalid={invalid}
        {...(invalid ? { "aria-describedby": describedBy } : {})}
        onInput={(event) => {
          onInput(event.currentTarget.value);
        }}
      />
    </label>
  );
};
