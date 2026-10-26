import type { Appliance, Room } from "@media-centre/shared";

/** Where Appliances with no Room are listed (FR-8). */
export const NO_ROOM = "No room";

/**
 * How the Remote names an Appliance everywhere: "Room · Name", e.g.
 * "Bedroom · TV", or just the name when it has no Room (FR-9).
 */
export const applianceTitle = (appliance: Pick<Appliance, "name" | "roomId">, rooms: readonly Room[]): string => {
  const room = rooms.find(({ id }) => id === appliance.roomId);
  return room === undefined ? appliance.name : `${room.name} · ${appliance.name}`;
};

export interface RoomGroup {
  /** The Room's name, or {@link NO_ROOM}. */
  readonly heading: string;
  readonly appliances: readonly Appliance[];
}

/**
 * Appliances grouped by Room, in Room order, then those with no Room (FR-8,
 * FR-10). Rooms with none are left out.
 */
export const groupByRoom = (appliances: readonly Appliance[], rooms: readonly Room[]): RoomGroup[] => {
  const groups: RoomGroup[] = rooms
    .map((room) => ({ heading: room.name, appliances: appliances.filter(({ roomId }) => roomId === room.id) }))
    .filter((group) => group.appliances.length > 0);
  const roomless = appliances.filter(({ roomId }) => !rooms.some(({ id }) => id === roomId));
  if (roomless.length > 0) groups.push({ heading: NO_ROOM, appliances: roomless });
  return groups;
};
