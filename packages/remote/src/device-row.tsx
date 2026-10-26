import type { ComponentChildren } from "preact";

import { Icon, type IconName } from "./icons.tsx";

export interface DeviceRowProps {
  readonly icon: IconName;
  /** The Appliance's own name, without its Room's, which the Room chip beside it says. */
  readonly name: string;
  /** Its Room's name, or undefined for "No room", which is marked as wanting one. */
  readonly room: string | undefined;
  /** What else is worth knowing of it at a glance, e.g. its make and address. */
  readonly details?: ComponentChildren;
  /** Its actions, e.g. Edit. */
  readonly children?: ComponentChildren;
}

/**
 * One Appliance in a Settings list: an icon for what it is, its name, its
 * Room as a chip, or "No room" marked as wanting one, and what else is
 * worth knowing, with its actions beside them, so that each row reads on
 * its own and a Room is said once.
 */
export const DeviceRow = ({ icon, name, room, details, children }: DeviceRowProps) => (
  <div class="device-row">
    <span class="device-icon">
      <Icon name={icon} />
    </span>
    <div class="device-text">
      <span class="device-name">{name}</span>
      <span class="device-meta">
        {room === undefined ? <span class="chip chip-warning">No room</span> : <span class="chip">{room}</span>}
        {details !== undefined && <span class="device-details">{details}</span>}
      </span>
    </div>
    {children !== undefined && <div class="device-actions">{children}</div>}
  </div>
);
