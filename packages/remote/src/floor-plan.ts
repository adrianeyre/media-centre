import { FLOOR_PLAN_IMAGE_PATH, type FloorPlanDrawing, type FloorPlanLayout } from "@media-centre/shared";

/**
 * The Remote's built-in drawing of the home, `public/images/floor-plan.svg`,
 * served beside the Remote's own files: upstairs on the left and downstairs
 * on the right, 1200 by 800.
 */
export const BUILT_IN_FLOOR_PLAN_URL = "/images/floor-plan.svg";

/**
 * The built-in drawing's layout: each floor the part of it that floor is,
 * and the outline of each place on it that can be a Room, in the drawing's
 * own units. A place has an id and no name: which Room it is, the Hub keeps,
 * as it is chosen on the plan itself. It is the plan until another is drawn.
 */
export const BUILT_IN_FLOOR_PLAN: FloorPlanLayout = {
  width: 1200,
  height: 800,
  floors: [
    {
      name: "Upstairs",
      viewBox: "115 118 435 535",
      places: [
        { id: "upstairs-1", points: "136,186 276,186 276,400 136,400" },
        { id: "upstairs-2", points: "282,186 372,186 372,318 282,318" },
        { id: "upstairs-3", points: "378,186 522,186 522,330 455,330 455,392 378,392" },
        { id: "upstairs-4", points: "458,333 522,333 522,445 458,445" },
        { id: "upstairs-5", points: "136,406 280,406 280,560 136,560" },
        { id: "upstairs-6", points: "378,455 522,455 522,605 503,605 490,640 415,640 402,605 378,605" },
        { id: "upstairs-7", points: "282,322 376,322 376,562 282,562" },
      ],
    },
    {
      name: "Downstairs",
      viewBox: "655 118 435 535",
      places: [
        { id: "downstairs-1", points: "676,186 752,186 752,252 676,252" },
        { id: "downstairs-2", points: "676,256 764,256 764,296 676,296" },
        { id: "downstairs-3", points: "768,186 1070,186 1070,380 915,380 915,340 828,340 828,300 768,300" },
        { id: "downstairs-4", points: "918,386 1070,386 1070,612 1045,612 1032,640 955,640 942,612 918,612" },
        { id: "downstairs-5", points: "678,312 814,312 814,588 678,588" },
        { id: "downstairs-6", points: "822,344 912,344 912,572 822,572" },
      ],
    },
  ],
};

/** The plan as the Rooms tab shows it: where its drawing is, and its layout. */
export interface FloorPlan {
  readonly url: string;
  readonly layout: FloorPlanLayout;
}

/**
 * The plan to show for the drawing the Hub has: the image and layout given
 * for this home, or the built-in ones where none was. The Hub's image is
 * asked for by its version, so a changed one is never the old one from a cache.
 */
export const floorPlanOf = (drawing: FloorPlanDrawing): FloorPlan => ({
  url: drawing.image === null ? BUILT_IN_FLOOR_PLAN_URL : `${FLOOR_PLAN_IMAGE_PATH}?v=${String(drawing.image.version)}`,
  layout: drawing.layout ?? BUILT_IN_FLOOR_PLAN,
});

/** Whether a layout is the built-in one, place for place. */
export const isBuiltInLayout = (layout: FloorPlanLayout): boolean =>
  JSON.stringify(layout) === JSON.stringify(BUILT_IN_FLOOR_PLAN);

/** A point in the drawing's units. */
export type Point = readonly [x: number, y: number];

/** The corners of an outline, from an SVG polygon's points. */
export const parsePoints = (points: string): Point[] =>
  points.split(" ").map((pair) => {
    const [x = 0, y = 0] = pair.split(",").map(Number);
    return [x, y];
  });

/** An SVG polygon's points for these corners, each rounded to a whole unit. */
export const formatPoints = (corners: readonly Point[]): string =>
  corners.map(([x, y]) => `${String(Math.round(x))},${String(Math.round(y))}`).join(" ");

/** The middle of an outline's bounds, where its Room's name is written, and how wide they are. */
export const middleOf = (points: string): { readonly x: number; readonly y: number; readonly width: number } => {
  const corners = parsePoints(points);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    width: Math.max(...xs) - Math.min(...xs),
  };
};

/**
 * How big a Room's name is written, in the drawing's units: as big as fits
 * across its outline, at most `most`: 15 on the built-in drawing, a floor
 * 435 wide, and as much of any other floor's width.
 */
export const labelSize = (name: string, width: number, most = 15): number =>
  Math.min(most, Math.floor((width - 8) / (name.length * 0.58)));

/** The distance from `point` to the line through `from` and `to`. */
const distanceToLine = ([x, y]: Point, [x1, y1]: Point, [x2, y2]: Point): number => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dx, dy);
};

/**
 * A freehand line with fewer corners: every corner that is within `tolerance`
 * of the straight line between its neighbours is left out, so that a line
 * drawn by hand becomes an outline of as few corners as make its shape
 * (Ramer–Douglas–Peucker).
 */
export const simplifyOutline = (corners: readonly Point[], tolerance: number): Point[] => {
  if (corners.length <= 2) return [...corners];
  const first = corners[0] as Point;
  const last = corners[corners.length - 1] as Point;
  let farthest = 0;
  let at = 0;
  corners.forEach((corner, index) => {
    const distance = distanceToLine(corner, first, last);
    if (distance > farthest) {
      farthest = distance;
      at = index;
    }
  });
  if (farthest <= tolerance) return [first, last];
  return [
    ...simplifyOutline(corners.slice(0, at + 1), tolerance).slice(0, -1),
    ...simplifyOutline(corners.slice(at), tolerance),
  ];
};

/** The id for the next place drawn: "place-" and a number no place on the plan has. */
export const nextPlaceId = (layout: FloorPlanLayout): string => {
  const taken = new Set(layout.floors.flatMap((floor) => floor.places.map((place) => place.id)));
  let number = 1;
  while (taken.has(`place-${String(number)}`)) number += 1;
  return `place-${String(number)}`;
};

/** The floor a point is on: the first whose part of the drawing holds it, else the first floor. */
export const floorAt = (layout: FloorPlanLayout, [x, y]: Point): number => {
  const index = layout.floors.findIndex(({ viewBox }) => {
    const [left = 0, top = 0, width = 0, height = 0] = viewBox.split(" ").map(Number);
    return x >= left && x <= left + width && y >= top && y <= top + height;
  });
  return index === -1 ? 0 : index;
};
