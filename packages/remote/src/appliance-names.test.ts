import { describe, expect, it } from "vitest";

import { applianceTitle, groupByRoom } from "./appliance-names.ts";
import { aTv } from "./testing/fake-appliances-api.ts";

const living = { id: 1, name: "Living room" };
const bedroom = { id: 2, name: "Bedroom" };
const office = { id: 3, name: "Office" };

describe("naming an Appliance", () => {
  it('writes "Room · Name"', () => {
    expect(applianceTitle(aTv(1, "TV", living.id), [living, bedroom])).toBe("Living room · TV");
    expect(applianceTitle(aTv(2, "TV", bedroom.id), [living, bedroom])).toBe("Bedroom · TV");
  });

  it("writes just the name when it has no Room", () => {
    expect(applianceTitle(aTv(1, "TV", null), [living])).toBe("TV");
  });

  it("writes just the name when its Room is no longer there", () => {
    expect(applianceTitle(aTv(1, "TV", 99), [living])).toBe("TV");
  });
});

describe("grouping Appliances by Room", () => {
  it('lists the Rooms in Room order, leaves out empty ones, and puts the rest under "No room"', () => {
    const tvs = [aTv(1, "Spare", null), aTv(2, "TV", bedroom.id), aTv(3, "TV", living.id), aTv(4, "Old", 99)];

    expect(
      groupByRoom(tvs, [bedroom, office, living]).map(({ heading, appliances }) => [
        heading,
        appliances.map(({ id }) => id),
      ]),
    ).toEqual([
      ["Bedroom", [2]],
      ["Living room", [3]],
      ["No room", [1, 4]],
    ]);
  });

  it("has no groups for no Appliances", () => {
    expect(groupByRoom([], [living])).toEqual([]);
  });
});
