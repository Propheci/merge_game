/**
 * Tier table for the merge game.
 *
 * This module is the single source of truth for both the browser and the
 * server. The server uses it to recompute a submitted score, so the client
 * cannot invent its own point values.
 *
 * The board is a table seen from above. There is no gravity. Each drink is a
 * convex outline that slides on the table. The browser draws the vessel on
 * that same outline, so the picture and the physics agree.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Vessel kinds. The browser draws a different picture for each kind. */
export type VesselKind =
  | "tumbler"
  | "cup"
  | "mug"
  | "coupe"
  | "hurricane"
  | "roundBowl"
  | "gourd"
  | "pitcher"
  | "punchBowl";

export type Garnish = "lemon" | "lime" | "orange" | "cherry" | "leaf" | "umbrella";

export interface Tier {
  readonly name: string;
  readonly kind: VesselKind;
  /** Colour of the drink inside the vessel. */
  readonly color: string;
  /** How full the vessel is, from 0 to 1. */
  readonly fill: number;
  /** Convex outline in local units, with the centre of mass at (0, 0). */
  readonly outline: readonly Point[];
  /** Distance from the centre to the most distant corner. */
  readonly radius: number;
  readonly width: number;
  readonly height: number;
  /** Colour of the straw, when the drink has one. */
  readonly straw?: string;
  /** Garnishes on the rim. The first sits on the left, the second on the right. */
  readonly garnishes?: readonly Garnish[];
  readonly foam?: boolean;
  readonly handle?: boolean;
}

/* ------------------------------------------------------------------ */
/* Outline builders                                                    */
/* ------------------------------------------------------------------ */

/** Moves an outline so that its centre of area sits at (0, 0). */
function centred(points: Point[]): Point[] {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  cx /= 6 * area;
  cy /= 6 * area;
  return points.map((point) => ({ x: point.x - cx, y: point.y - cy }));
}

/** A glass that is wide at the rim and narrow at the base. */
function taper(topWidth: number, bottomWidth: number, height: number): Point[] {
  const top = topWidth / 2;
  const bottom = bottomWidth / 2;
  const y0 = -height / 2;
  const y1 = height / 2;
  return centred([
    { x: -top, y: y0 },
    { x: top, y: y0 },
    { x: bottom, y: y1 },
    { x: -bottom, y: y1 },
  ]);
}

/** A rounded box, for mugs and cups. */
function roundedBox(width: number, height: number, corner: number): Point[] {
  const w = width / 2;
  const h = height / 2;
  const c = Math.min(corner, w, h);
  return centred([
    { x: -w + c, y: -h },
    { x: w - c, y: -h },
    { x: w, y: -h + c },
    { x: w, y: h - c },
    { x: w - c, y: h },
    { x: -w + c, y: h },
    { x: -w, y: h - c },
    { x: -w, y: -h + c },
  ]);
}

/** An oval, for bowls and round vessels. */
function oval(width: number, height: number, sides = 14): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: (Math.cos(angle) * width) / 2, y: (Math.sin(angle) * height) / 2 });
  }
  return centred(points);
}

/**
 * A wide bowl that narrows to a small foot, for a coupe or a wine glass.
 * The outline stays convex, so the physics body matches the picture exactly.
 */
function bowlOnFoot(topWidth: number, footWidth: number, height: number): Point[] {
  const t = topWidth / 2;
  const f = footWidth / 2;
  const y0 = -height / 2;
  const y1 = height / 2;
  return centred([
    { x: -t, y: y0 },
    { x: t, y: y0 },
    // The waist sits outside the line from the rim to the foot, so that the
    // outline stays convex whatever the two widths are.
    { x: t - (t - f) * 0.32, y: y0 + height * 0.4 },
    { x: f, y: y1 },
    { x: -f, y: y1 },
    { x: -(t - (t - f) * 0.32), y: y0 + height * 0.4 },
  ]);
}

function measure(outline: readonly Point[]) {
  let radius = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of outline) {
    radius = Math.max(radius, Math.hypot(point.x, point.y));
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { radius, width: maxX - minX, height: maxY - minY };
}

interface TierSpec {
  name: string;
  kind: VesselKind;
  color: string;
  fill: number;
  outline: Point[];
  straw?: string;
  garnishes?: Garnish[];
  foam?: boolean;
  handle?: boolean;
}

/**
 * One factor for every vessel. A smaller factor puts more drinks on the table
 * and makes a game last longer.
 */
const VESSEL_SCALE = 0.85;

function tier(spec: TierSpec): Tier {
  const outline = spec.outline.map((point) => ({
    x: point.x * VESSEL_SCALE,
    y: point.y * VESSEL_SCALE,
  }));
  return { ...spec, outline, ...measure(outline) };
}

/* ------------------------------------------------------------------ */
/* The drinks                                                          */
/* ------------------------------------------------------------------ */

export const TIERS: readonly Tier[] = [
  tier({
    name: "Cola Shot",
    kind: "tumbler",
    color: "#6e2a10",
    fill: 0.62,
    outline: taper(28, 22, 32),
  }),
  tier({
    name: "Espresso",
    kind: "cup",
    color: "#432414",
    fill: 0.55,
    handle: true,
    outline: roundedBox(44, 42, 12),
  }),
  tier({
    name: "Iced Tea",
    kind: "tumbler",
    color: "#e0762a",
    fill: 0.7,
    straw: "#e8465a",
    garnishes: ["lemon"],
    outline: taper(42, 32, 54),
  }),
  tier({
    name: "Lemonade",
    kind: "tumbler",
    color: "#f8d43a",
    fill: 0.74,
    straw: "#3fa9e0",
    garnishes: ["lemon", "leaf"],
    outline: taper(50, 38, 64),
  }),
  tier({
    name: "Draft Beer",
    kind: "mug",
    color: "#f2aa2a",
    fill: 0.72,
    foam: true,
    handle: true,
    outline: roundedBox(62, 76, 15),
  }),
  tier({
    name: "Coupe",
    kind: "coupe",
    color: "#5ad2dc",
    fill: 0.5,
    garnishes: ["cherry"],
    outline: bowlOnFoot(76, 26, 64),
  }),
  tier({
    name: "Mojito",
    kind: "hurricane",
    color: "#6fd35a",
    fill: 0.76,
    straw: "#ffffff",
    garnishes: ["leaf", "lime"],
    outline: taper(58, 44, 96),
  }),
  tier({
    name: "Cosmopolitan",
    kind: "roundBowl",
    color: "#ff4fa6",
    fill: 0.56,
    garnishes: ["lime", "cherry"],
    outline: bowlOnFoot(88, 40, 84),
  }),
  tier({
    name: "Tiki Mug",
    kind: "gourd",
    color: "#b04ee6",
    fill: 0.8,
    straw: "#ffd166",
    garnishes: ["leaf", "cherry"],
    outline: oval(114, 128),
  }),
  tier({
    name: "Fruit Pitcher",
    kind: "pitcher",
    color: "#ff8c2a",
    fill: 0.78,
    handle: true,
    garnishes: ["umbrella", "orange"],
    outline: roundedBox(116, 134, 30),
  }),
  tier({
    name: "Punch Bowl",
    kind: "punchBowl",
    color: "#ff4f70",
    fill: 0.66,
    garnishes: ["orange", "cherry"],
    outline: oval(172, 142, 16),
  }),
];

/** Only the smallest tiers arrive at the launcher. */
export const SPAWNABLE_TIERS = 5;

/** The largest tier does not merge. Two of them only push each other. */
export const TOP_TIER = TIERS.length - 1;

/**
 * Points for each merge, by the tier that the merge creates.
 * Index 0 is never used, because no merge creates the smallest tier.
 */
export const MERGE_POINTS: readonly number[] = TIERS.map((_, i) =>
  i === 0 ? 0 : (i * (i + 1)) / 2,
);

export function tierAt(index: number): Tier {
  const found = TIERS[index];
  if (!found) throw new RangeError(`no tier at index ${index}`);
  return found;
}
