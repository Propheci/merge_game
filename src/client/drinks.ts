import type { Garnish, Point, Tier } from "../shared/tiers.ts";
import { TIERS, tierAt } from "../shared/tiers.ts";

/**
 * Drawing of the vessels.
 *
 * Each drink uses the same outline as its physics body, so the picture and the
 * collision shape agree. Small parts such as a handle, a straw or a garnish
 * reach a little past the outline, as they do on a real table.
 *
 * The picture of a vessel is rich: a dark outline, a tinted glass with glossy
 * highlights, a liquid with depth, ice, bubbles, foam and chunky garnishes.
 * That is too much work for every frame, so each vessel is painted once into
 * an offscreen sprite at high resolution. The game then only copies the sprite.
 */

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

const boundsCache = new Map<Tier, Bounds>();

function boundsOf(tier: Tier): Bounds {
  const cached = boundsCache.get(tier);
  if (cached) return cached;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of tier.outline) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const value: Bounds = { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  boundsCache.set(tier, value);
  return value;
}

/** Half width of the outline at a given height. */
function halfWidthAt(tier: Tier, y: number): number {
  const points = tier.outline;
  const count = points.length;
  let half = 0;
  for (let i = 0; i < count; i += 1) {
    const a = points[i] as Point;
    const b = points[(i + 1) % count] as Point;
    if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
      if (a.y === b.y) {
        half = Math.max(half, Math.abs(a.x), Math.abs(b.x));
      } else {
        const t = (y - a.y) / (b.y - a.y);
        half = Math.max(half, Math.abs(a.x + (b.x - a.x) * t));
      }
    }
  }
  return half;
}

/** Traces a closed outline with soft corners. */
function tracePolygon(ctx: CanvasRenderingContext2D, points: readonly Point[], corner: number) {
  const count = points.length;
  const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const first = middle(points[count - 1] as Point, points[0] as Point);

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 0; i < count; i += 1) {
    const current = points[i] as Point;
    const next = points[(i + 1) % count] as Point;
    const stop = middle(current, next);
    ctx.arcTo(current.x, current.y, stop.x, stop.y, corner);
  }
  ctx.closePath();
}

function cornerOf(box: Bounds): number {
  return Math.min(8, box.width * 0.18);
}

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const light = (max + min) / 2;
  if (max === min) return [0, 0, light];
  const delta = max - min;
  const sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return [hue / 6, sat, light];
}

/**
 * Moves a colour in lightness and saturation. Positive values make the colour
 * lighter or more vivid. This keeps a colour juicy where a plain white mix
 * would make it chalky.
 */
function tone(hex: string, lightness: number, saturation = 0, alpha = 1): string {
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = Math.min(1, Math.max(0, s + saturation));
  const light = Math.min(1, Math.max(0, l + lightness));
  return `hsla(${Math.round(h * 360)}, ${Math.round(sat * 100)}%, ${Math.round(light * 100)}%, ${alpha})`;
}

function isLight(hex: string): boolean {
  const [r, g, b] = parseHex(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 170;
}

/** The dark line around every part. */
const INK = "rgba(34, 52, 88, 0.85)";

/** A small fixed random source, so a vessel looks the same every time. */
function makeRandom(seed: number): () => number {
  let state = (seed * 2654435761 + 12345) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/* ------------------------------------------------------------------ */
/* Parts                                                               */
/* ------------------------------------------------------------------ */

/**
 * Height of the top of the drink. A vessel that narrows to a foot keeps its
 * drink low, so the drink makes the V shape of a cocktail glass.
 */
function liquidSurface(tier: Tier, box: Bounds): number {
  return box.maxY - box.height * tier.fill;
}

/** Height of the rim ellipse. The vessel is seen a little from above. */
function rimY(box: Bounds): number {
  return box.minY + box.height * 0.07;
}

function rimHalfWidth(tier: Tier, box: Bounds): number {
  return Math.max(halfWidthAt(tier, rimY(box)), box.width * 0.2);
}

function lineWidthOf(box: Bounds): number {
  return Math.max(1.5, Math.min(box.width, box.height) * 0.032);
}

/** The pale blue body of the glass, under the liquid. */
function paintGlassBody(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  tracePolygon(ctx, tier.outline, cornerOf(box));
  const body = ctx.createLinearGradient(0, box.minY, 0, box.maxY);
  body.addColorStop(0, "rgba(232, 246, 255, 0.62)");
  body.addColorStop(0.5, "rgba(196, 228, 250, 0.55)");
  body.addColorStop(1, "rgba(150, 200, 238, 0.7)");
  ctx.fillStyle = body;
  ctx.fill();
}

function paintLiquid(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const surface = liquidSurface(tier, box);
  const color = tier.color;

  ctx.save();
  tracePolygon(ctx, tier.outline, cornerOf(box));
  ctx.clip();

  // Depth: bright near the surface, deep at the bottom.
  const depth = ctx.createLinearGradient(0, surface, 0, box.maxY);
  depth.addColorStop(0, tone(color, 0.16, 0.08));
  depth.addColorStop(0.42, tone(color, 0.02, 0.1));
  depth.addColorStop(1, tone(color, -0.2, 0.06));
  ctx.fillStyle = depth;
  ctx.fillRect(box.minX - 2, surface, box.width + 4, box.maxY - surface + 2);

  // Sides: the glass wall darkens the drink at the edges and lights it near
  // the left, where the light comes from.
  const side = ctx.createLinearGradient(box.minX, 0, box.maxX, 0);
  side.addColorStop(0, "rgba(20, 20, 60, 0.28)");
  side.addColorStop(0.16, "rgba(255, 255, 255, 0.12)");
  side.addColorStop(0.45, "rgba(255, 255, 255, 0)");
  side.addColorStop(0.82, "rgba(20, 20, 60, 0.08)");
  side.addColorStop(1, "rgba(20, 20, 60, 0.32)");
  ctx.fillStyle = side;
  ctx.fillRect(box.minX - 2, surface, box.width + 4, box.maxY - surface + 2);

  // A warm glow in the heart of the drink.
  const glow = ctx.createRadialGradient(
    -box.width * 0.1,
    surface + (box.maxY - surface) * 0.4,
    0,
    -box.width * 0.1,
    surface + (box.maxY - surface) * 0.4,
    box.width * 0.55,
  );
  glow.addColorStop(0, tone(color, 0.22, 0.1, 0.55));
  glow.addColorStop(1, tone(color, 0.22, 0.1, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(box.minX - 2, surface, box.width + 4, box.maxY - surface + 2);

  if (isFizzy(tier)) paintBubbles(ctx, tier, box, surface);
  if (tier.kind === "pitcher" || tier.kind === "punchBowl") {
    paintFloatingFruit(ctx, tier, box, surface);
  }

  paintSurface(ctx, tier, box, surface);
  if (hasIce(tier)) paintIce(ctx, tier, box, surface);

  ctx.restore();
}

function isFizzy(tier: Tier): boolean {
  return !tier.foam && tier.kind !== "cup" && tier.kind !== "coupe" && tier.kind !== "roundBowl";
}

function hasIce(tier: Tier): boolean {
  return !tier.foam && tier.kind !== "cup";
}

/** The top of the drink, seen a little from above. */
function paintSurface(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds, surface: number) {
  const rx = halfWidthAt(tier, surface) * 0.97;
  const ry = Math.max(1.6, rx * 0.26);
  const color = tier.color;

  const top = ctx.createLinearGradient(-rx, 0, rx, 0);
  if (tier.kind === "cup") {
    // Crema on the espresso.
    top.addColorStop(0, "#d9a06a");
    top.addColorStop(0.5, "#c2865a");
    top.addColorStop(1, "#a86d44");
  } else {
    top.addColorStop(0, tone(color, 0.3, 0, 0.95));
    top.addColorStop(0.55, tone(color, 0.2, 0.05, 0.95));
    top.addColorStop(1, tone(color, 0.08, 0.05, 0.95));
  }
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.ellipse(0, surface, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // The meniscus, a darker line on the far side of the surface.
  ctx.strokeStyle = tier.kind === "cup" ? "rgba(70, 35, 15, 0.5)" : tone(color, -0.18, 0.1, 0.55);
  ctx.lineWidth = Math.max(1, rx * 0.06);
  ctx.beginPath();
  ctx.ellipse(0, surface, rx, ry, 0, Math.PI, Math.PI * 2);
  ctx.stroke();

  // A glint of light.
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.ellipse(-rx * 0.35, surface - ry * 0.15, rx * 0.3, ry * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
}

function paintBubbles(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds, surface: number) {
  const random = makeRandom(TIERS.indexOf(tier) + 7);
  const depth = box.maxY - surface;
  const count = Math.round(4 + box.width * 0.12);
  for (let i = 0; i < count; i += 1) {
    const y = surface + depth * (0.12 + random() * 0.85);
    const half = halfWidthAt(tier, y) * 0.8;
    const x = (random() * 2 - 1) * half;
    const r = Math.max(0.7, box.width * (0.012 + random() * 0.02));
    ctx.fillStyle = `rgba(255, 255, 255, ${0.2 + random() * 0.3})`;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = r * 0.35;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function paintIce(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds, surface: number) {
  const size = Math.min(box.width * 0.3, Math.max(6, box.height * 0.2));
  const half = halfWidthAt(tier, surface + size * 0.5);
  const count = box.height > 60 ? 3 : box.height > 34 ? 2 : 1;
  const cubes: Array<[number, number, number, number]> =
    count === 1
      ? [[-half * 0.15, surface + size * 0.05, 1, -0.25]]
      : count === 2
        ? [
            [-half * 0.45, surface + size * 0.18, 0.95, -0.35],
            [half * 0.3, surface - size * 0.05, 0.85, 0.3],
          ]
        : [
            [-half * 0.5, surface + size * 0.2, 1, -0.4],
            [half * 0.35, surface - size * 0.02, 0.9, 0.35],
            [-half * 0.05, surface + size * 0.55, 0.8, 0.1],
          ];

  for (const [x, y, factor, angle] of cubes) {
    const s = size * factor;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const cube = ctx.createLinearGradient(-s / 2, -s / 2, s / 2, s / 2);
    cube.addColorStop(0, "rgba(255, 255, 255, 0.85)");
    cube.addColorStop(0.5, "rgba(225, 244, 255, 0.55)");
    cube.addColorStop(1, "rgba(170, 215, 245, 0.7)");
    ctx.fillStyle = cube;
    ctx.strokeStyle = "rgba(90, 140, 200, 0.55)";
    ctx.lineWidth = Math.max(0.8, s * 0.07);
    ctx.beginPath();
    ctx.roundRect(-s / 2, -s / 2, s, s, s * 0.22);
    ctx.fill();
    ctx.stroke();
    // A bright edge and a small window of light.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = Math.max(0.7, s * 0.06);
    ctx.beginPath();
    ctx.roundRect(-s / 2 + s * 0.1, -s / 2 + s * 0.1, s * 0.8, s * 0.8, s * 0.18);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.roundRect(-s * 0.3, -s * 0.32, s * 0.22, s * 0.36, s * 0.08);
    ctx.fill();
    ctx.restore();
  }
}

/** Reflections and the thick base of the glass, over the liquid. */
function paintGlassFront(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const corner = cornerOf(box);
  ctx.save();
  tracePolygon(ctx, tier.outline, corner);
  ctx.clip();

  // Thick glass at the bottom.
  const base = ctx.createLinearGradient(0, box.maxY - box.height * 0.16, 0, box.maxY);
  base.addColorStop(0, "rgba(255, 255, 255, 0)");
  base.addColorStop(0.5, "rgba(255, 255, 255, 0.38)");
  base.addColorStop(1, "rgba(200, 232, 255, 0.7)");
  ctx.fillStyle = base;
  ctx.fillRect(box.minX - 2, box.maxY - box.height * 0.16, box.width + 4, box.height * 0.16 + 2);

  // The wall of the glass darkens the drink near the edge.
  ctx.strokeStyle = "rgba(30, 70, 130, 0.22)";
  ctx.lineWidth = box.width * 0.1;
  tracePolygon(ctx, tier.outline, corner);
  ctx.stroke();

  // A wide, glossy reflection down the left side.
  const left = box.minX + box.width * 0.1;
  const gloss = ctx.createLinearGradient(0, box.minY, 0, box.maxY);
  gloss.addColorStop(0, "rgba(255, 255, 255, 0.72)");
  gloss.addColorStop(0.55, "rgba(255, 255, 255, 0.45)");
  gloss.addColorStop(0.9, "rgba(255, 255, 255, 0.05)");
  ctx.fillStyle = gloss;
  ctx.beginPath();
  ctx.roundRect(
    left,
    box.minY + box.height * 0.1,
    box.width * 0.13,
    box.height * 0.78,
    box.width * 0.065,
  );
  ctx.fill();

  // A thin, bright line at the very edge.
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.roundRect(
    box.minX + box.width * 0.045,
    box.minY + box.height * 0.16,
    box.width * 0.035,
    box.height * 0.45,
    box.width * 0.02,
  );
  ctx.fill();

  // A soft reflection on the right side.
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  ctx.beginPath();
  ctx.roundRect(
    box.maxX - box.width * 0.13,
    box.minY + box.height * 0.2,
    box.width * 0.05,
    box.height * 0.5,
    box.width * 0.025,
  );
  ctx.fill();
  ctx.restore();
}

/** Dark line outside, bright line inside. That is what makes the glass pop. */
function paintOutline(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const corner = cornerOf(box);
  const width = lineWidthOf(box);
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = width;
  tracePolygon(ctx, tier.outline, corner);
  ctx.stroke();

  ctx.save();
  tracePolygon(ctx, tier.outline, corner);
  ctx.clip();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = width * 1.1;
  tracePolygon(ctx, tier.outline, corner);
  ctx.stroke();
  ctx.restore();
}

function paintRim(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const rx = rimHalfWidth(tier, box);
  const ry = Math.max(2, rx * 0.28);
  const y = rimY(box);
  const width = lineWidthOf(box);

  // Inside of the vessel, seen through the opening.
  const inside = ctx.createLinearGradient(0, y - ry, 0, y + ry);
  inside.addColorStop(0, "rgba(40, 90, 150, 0.35)");
  inside.addColorStop(1, "rgba(200, 235, 255, 0.35)");
  ctx.fillStyle = inside;
  ctx.beginPath();
  ctx.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = INK;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  // The near edge of the rim catches the light.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = width * 1.2;
  ctx.beginPath();
  ctx.ellipse(0, y + width * 0.9, rx - width * 0.9, Math.max(1, ry - width * 0.6), 0, 0.15, Math.PI - 0.15);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = width * 0.7;
  ctx.beginPath();
  ctx.ellipse(0, y - width * 0.6, rx - width * 0.9, Math.max(1, ry - width * 0.6), 0, Math.PI + 0.4, Math.PI * 2 - 0.4);
  ctx.stroke();
}

function paintHandle(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const radius = box.height * 0.21;
  const cx = box.maxX * 0.84;
  const cy = box.minY + box.height * 0.47;
  const thick = Math.max(3, box.width * 0.1);
  const arc = () => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI * 0.42, Math.PI * 0.42);
  };
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = thick + lineWidthOf(box) * 1.6;
  arc();
  ctx.stroke();
  ctx.strokeStyle = tier.kind === "cup" ? "#f4efe6" : "rgba(214, 238, 255, 0.95)";
  ctx.lineWidth = thick;
  arc();
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = thick * 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + thick * 0.15, -Math.PI * 0.3, Math.PI * 0.05);
  ctx.stroke();
}

function paintFoam(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const surface = liquidSurface(tier, box);
  const half = rimHalfWidth(tier, box);
  const y = rimY(box);
  const width = lineWidthOf(box);

  // Foam inside the mug, from the beer up to the rim.
  ctx.save();
  tracePolygon(ctx, tier.outline, cornerOf(box));
  ctx.clip();
  const body = ctx.createLinearGradient(0, y, 0, surface);
  body.addColorStop(0, "#fffaf0");
  body.addColorStop(1, "#f3dfb4");
  ctx.fillStyle = body;
  ctx.fillRect(box.minX - 2, y - 4, box.width + 4, surface - y + 4);
  // Bubbles in the head.
  const random = makeRandom(31);
  for (let i = 0; i < 9; i += 1) {
    const bx = (random() * 2 - 1) * half * 0.85;
    const by = y + random() * (surface - y);
    ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + random() * 0.5})`;
    ctx.beginPath();
    ctx.arc(bx, by, box.width * (0.02 + random() * 0.03), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // The head rises above the rim in soft bumps and spills over one side.
  const bumps: Array<[number, number, number]> = [
    [-half * 0.55, y - box.height * 0.05, half * 0.36],
    [-half * 0.05, y - box.height * 0.08, half * 0.42],
    [half * 0.5, y - box.height * 0.04, half * 0.34],
    [half * 0.98, y + box.height * 0.1, half * 0.2],
  ];
  const trace = () => {
    ctx.beginPath();
    for (const [bx, by, r] of bumps) {
      ctx.moveTo(bx + r, by);
      ctx.arc(bx, by, r, 0, Math.PI * 2);
    }
    ctx.ellipse(0, y + 1, half + width * 0.5, box.height * 0.06, 0, 0, Math.PI * 2);
  };
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = width * 2;
  trace();
  ctx.stroke();
  ctx.fillStyle = "#fff8ea";
  trace();
  ctx.fill();
  // Shading on the underside of the bumps.
  ctx.fillStyle = "rgba(220, 180, 120, 0.35)";
  ctx.beginPath();
  ctx.ellipse(0, y + box.height * 0.02, half * 0.96, box.height * 0.035, 0, 0, Math.PI);
  ctx.fill();
  // Highlights on top of the bumps.
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  for (const [bx, by, r] of bumps.slice(0, 3)) {
    ctx.beginPath();
    ctx.ellipse(bx - r * 0.25, by - r * 0.35, r * 0.35, r * 0.2, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintStraw(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const color = tier.straw as string;
  const stripe = isLight(color) ? "#ff4d5e" : "rgba(255, 255, 255, 0.9)";
  const thick = Math.max(3, box.width * 0.1);
  const start = { x: -box.width * 0.06, y: box.minY + box.height * 0.5 };
  const elbow = { x: box.width * 0.24, y: box.minY - box.height * 0.16 };
  const tip = { x: box.width * 0.4, y: box.minY - box.height * 0.27 };
  const rim = rimY(box);

  // Where the straw leaves the glass.
  const t = (rim - start.y) / (elbow.y - start.y);
  const exit = { x: start.x + (elbow.x - start.x) * t, y: rim };

  const strokePath = (from: Point, to: Point, bend?: Point) => {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    if (bend) ctx.lineTo(bend.x, bend.y);
  };
  const paint = (from: Point, to: Point, bend: Point | undefined, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.lineWidth = thick + lineWidthOf(box) * 1.5;
    strokePath(from, to, bend);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = thick;
    strokePath(from, to, bend);
    ctx.stroke();
    // Rings of colour along the straw.
    ctx.strokeStyle = stripe;
    ctx.lineWidth = thick * 0.8;
    ctx.lineCap = "butt";
    ctx.setLineDash([thick * 0.7, thick * 0.9]);
    strokePath(from, to, bend);
    ctx.stroke();
    ctx.setLineDash([]);
    // A line of light down one side.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = thick * 0.22;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(from.x - thick * 0.28, from.y);
    ctx.lineTo(to.x - thick * 0.28, to.y);
    if (bend) ctx.lineTo(bend.x - thick * 0.28, bend.y);
    ctx.stroke();
    ctx.restore();
  };

  // The part in the drink shows through the glass, a little faded.
  paint(start, exit, undefined, 0.6);
  paint(exit, elbow, tip, 1);
}

/* ------------------------------------------------------------------ */
/* Garnishes                                                           */
/* ------------------------------------------------------------------ */

interface Citrus {
  peel: string;
  pith: string;
  flesh: string;
  juice: string;
}

const CITRUS: Record<"lemon" | "lime" | "orange", Citrus> = {
  lemon: { peel: "#f2b81d", pith: "#fff6cf", flesh: "#ffe25a", juice: "#f7c823" },
  lime: { peel: "#4d9a2d", pith: "#effad0", flesh: "#b8ea55", juice: "#8ccf3a" },
  orange: { peel: "#f27a1c", pith: "#ffe9c8", flesh: "#ffb23f", juice: "#ff9421" },
};

function paintCitrusSlice(
  ctx: CanvasRenderingContext2D,
  citrus: Citrus,
  x: number,
  y: number,
  r: number,
  angle: number,
  ink = INK,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.fillStyle = citrus.peel;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = citrus.pith;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.84, 0, Math.PI * 2);
  ctx.fill();
  const flesh = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.05, 0, 0, r * 0.72);
  flesh.addColorStop(0, citrus.flesh);
  flesh.addColorStop(1, citrus.juice);
  ctx.fillStyle = flesh;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
  ctx.fill();
  // Segments.
  ctx.strokeStyle = citrus.pith;
  ctx.lineWidth = Math.max(0.8, r * 0.09);
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    ctx.moveTo(Math.cos(a) * r * 0.12, Math.sin(a) * r * 0.12);
    ctx.lineTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
  }
  ctx.stroke();
  ctx.fillStyle = citrus.pith;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // Shine.
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.ellipse(-r * 0.35, -r * 0.4, r * 0.22, r * 0.12, -0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintCherry(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const line = Math.max(1, r * 0.16);
  // Stems.
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = line * 2.2;
  const stems = () => {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.5, y - r * 0.3);
    ctx.quadraticCurveTo(x + r * 0.3, y - r * 2.2, x + r * 1.1, y - r * 2.6);
    ctx.moveTo(x + r * 0.9, y - r * 0.4);
    ctx.quadraticCurveTo(x + r * 0.9, y - r * 1.8, x + r * 1.1, y - r * 2.6);
  };
  stems();
  ctx.stroke();
  ctx.strokeStyle = "#7a9a2f";
  ctx.lineWidth = line;
  stems();
  ctx.stroke();
  // A leaf at the top of the stems.
  paintLeafShape(ctx, x + r * 1.15, y - r * 2.6, r * 1.1, -0.6);

  // Two cherries.
  for (const [cx, cy, cr] of [
    [x + r * 0.95, y + r * 0.35, r * 0.88],
    [x - r * 0.45, y + r * 0.55, r],
  ] as Array<[number, number, number]>) {
    const body = ctx.createRadialGradient(cx - cr * 0.35, cy - cr * 0.35, cr * 0.1, cx, cy, cr);
    body.addColorStop(0, "#ff7d8a");
    body.addColorStop(0.45, "#e6243f");
    body.addColorStop(1, "#8f0f26");
    ctx.fillStyle = body;
    ctx.strokeStyle = INK;
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.ellipse(cx - cr * 0.35, cy - cr * 0.4, cr * 0.22, cr * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** One leaf with a pointed tip and a midrib. */
function paintLeafShape(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  angle: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const w = length * 0.42;
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-w, -length * 0.45, 0, -length);
    ctx.quadraticCurveTo(w, -length * 0.45, 0, 0);
    ctx.closePath();
  };
  const fill = ctx.createLinearGradient(-w, 0, w, 0);
  fill.addColorStop(0, "#7fd65a");
  fill.addColorStop(0.5, "#4db843");
  fill.addColorStop(1, "#2f8f38");
  ctx.fillStyle = fill;
  ctx.strokeStyle = "rgba(20, 70, 35, 0.85)";
  ctx.lineWidth = Math.max(0.8, length * 0.08);
  ctx.lineJoin = "round";
  shape();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(230, 255, 210, 0.8)";
  ctx.lineWidth = Math.max(0.6, length * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, -length * 0.1);
  ctx.lineTo(0, -length * 0.85);
  ctx.stroke();
  ctx.restore();
}

function paintMint(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const stemTop = y - size * 0.15;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.4, size * 0.14);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.3);
  ctx.lineTo(x, stemTop);
  ctx.stroke();
  ctx.strokeStyle = "#3f9a3a";
  ctx.lineWidth = Math.max(0.8, size * 0.07);
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.3);
  ctx.lineTo(x, stemTop);
  ctx.stroke();
  for (const [dx, dy, len, angle] of [
    [-size * 0.05, size * 0.1, size * 0.95, -1.15],
    [size * 0.05, size * 0.1, size * 0.95, 1.15],
    [-size * 0.02, -size * 0.05, size * 0.9, -0.45],
    [size * 0.02, -size * 0.05, size * 0.9, 0.45],
    [0, -size * 0.15, size * 0.85, 0],
  ] as Array<[number, number, number, number]>) {
    paintLeafShape(ctx, x + dx, stemTop + dy, len, angle);
  }
}

function paintUmbrella(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.45);
  const line = Math.max(1, r * 0.09);
  // Stick.
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = line * 2.6;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.1);
  ctx.lineTo(0, r * 1.5);
  ctx.stroke();
  ctx.strokeStyle = "#d9a066";
  ctx.lineWidth = line * 1.3;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.1);
  ctx.lineTo(0, r * 1.5);
  ctx.stroke();

  // Canopy with a scalloped edge.
  const panels = ["#ff5f6d", "#ffd23f", "#3ccfc3", "#ff8fd0", "#ffa64d", "#7ad0ff"];
  const scallops = 6;
  const canopy = () => {
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    for (let i = 0; i < scallops; i += 1) {
      const a0 = Math.PI + (i / scallops) * Math.PI;
      const a1 = Math.PI + ((i + 1) / scallops) * Math.PI;
      const mid = (a0 + a1) / 2;
      ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
      ctx.quadraticCurveTo(Math.cos(mid) * r * 0.86, Math.sin(mid) * r * 0.86 + r * 0.16, Math.cos(a1) * r, Math.sin(a1) * r);
    }
    ctx.lineTo(0, r * 0.1);
    ctx.closePath();
  };
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = line * 2;
  canopy();
  ctx.stroke();
  for (let i = 0; i < scallops; i += 1) {
    const a0 = Math.PI + (i / scallops) * Math.PI;
    const a1 = Math.PI + ((i + 1) / scallops) * Math.PI;
    ctx.fillStyle = panels[i] as string;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.save();
  canopy();
  ctx.clip();
  ctx.fillStyle = "#fff5e0";
  ctx.fillRect(-r, 0, r * 2, r * 0.3);
  ctx.strokeStyle = "rgba(34, 52, 88, 0.5)";
  ctx.lineWidth = line * 0.8;
  ctx.beginPath();
  for (let i = 1; i < scallops; i += 1) {
    const a = Math.PI + (i / scallops) * Math.PI;
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.beginPath();
  ctx.ellipse(-r * 0.4, -r * 0.5, r * 0.3, r * 0.15, -0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Tip.
  ctx.fillStyle = "#d9a066";
  ctx.strokeStyle = INK;
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(0, -r, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function paintGarnish(
  ctx: CanvasRenderingContext2D,
  garnish: Garnish,
  tier: Tier,
  box: Bounds,
  side: -1 | 1,
): void {
  const half = rimHalfWidth(tier, box);
  const x = side * half * 0.75;
  const y = rimY(box);
  const unit = Math.max(6, Math.min(box.width * 0.2, box.height * 0.16));

  switch (garnish) {
    case "lemon":
    case "lime":
    case "orange":
      paintCitrusSlice(ctx, CITRUS[garnish], x, y - unit * 0.2, unit, side * -0.5);
      return;
    case "cherry":
      paintCherry(ctx, x - side * unit * 0.2, y - unit * 0.3, unit * 0.55);
      return;
    case "leaf":
      paintMint(ctx, x, y - unit * 0.6, unit * 1.25);
      return;
    case "umbrella":
      paintUmbrella(ctx, x, y - unit * 1.2, unit * 1.05);
      return;
    default:
      return;
  }
}

/** Fruit that floats in the big vessels. */
function paintFloatingFruit(
  ctx: CanvasRenderingContext2D,
  tier: Tier,
  box: Bounds,
  surface: number,
): void {
  const r = box.width * 0.085;
  const inkSoft = "rgba(34, 52, 88, 0.35)";
  ctx.save();
  ctx.globalAlpha = 0.9;
  paintCitrusSlice(ctx, CITRUS.orange, -box.width * 0.22, surface + box.height * 0.16, r, 0.4, inkSoft);
  paintCitrusSlice(ctx, CITRUS.lime, box.width * 0.2, surface + box.height * 0.28, r * 0.85, -0.6, inkSoft);
  paintCitrusSlice(ctx, CITRUS.lemon, box.width * 0.03, surface + box.height * 0.45, r * 0.75, 0.9, inkSoft);
  // Berries.
  for (const [x, y, s] of [
    [box.width * 0.28, surface + box.height * 0.1, r * 0.5],
    [-box.width * 0.05, surface + box.height * 0.3, r * 0.45],
    [-box.width * 0.3, surface + box.height * 0.42, r * 0.4],
  ] as Array<[number, number, number]>) {
    const berry = ctx.createRadialGradient(x - s * 0.3, y - s * 0.3, s * 0.1, x, y, s);
    berry.addColorStop(0, "#ff8090");
    berry.addColorStop(1, "#b5122e");
    ctx.fillStyle = berry;
    ctx.strokeStyle = inkSoft;
    ctx.lineWidth = Math.max(0.8, s * 0.15);
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Whole vessels                                                       */
/* ------------------------------------------------------------------ */

function paintFoot(ctx: CanvasRenderingContext2D, box: Bounds): void {
  const rx = box.width * 0.24;
  const ry = Math.max(2, box.height * 0.04);
  const y = box.maxY - ry * 0.4;
  const width = lineWidthOf(box);
  const foot = ctx.createLinearGradient(-rx, 0, rx, 0);
  foot.addColorStop(0, "rgba(240, 250, 255, 0.95)");
  foot.addColorStop(0.5, "rgba(200, 230, 250, 0.95)");
  foot.addColorStop(1, "rgba(160, 205, 240, 0.95)");
  ctx.fillStyle = foot;
  ctx.strokeStyle = INK;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = width * 0.8;
  ctx.beginPath();
  ctx.ellipse(0, y - width * 0.5, rx * 0.8, ry * 0.5, 0, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
}

function paintSpout(ctx: CanvasRenderingContext2D, tier: Tier, box: Bounds): void {
  const width = lineWidthOf(box);
  const y = rimY(box);
  const ry = Math.max(2, rimHalfWidth(tier, box) * 0.28);
  const left = box.minX;
  // A small lip that curls out of the rim on the left.
  const lip = () => {
    ctx.beginPath();
    ctx.moveTo(left + box.width * 0.16, y - ry * 1.1);
    ctx.quadraticCurveTo(left - box.width * 0.02, y - ry * 1.3, left - box.width * 0.09, y + ry * 0.2);
    ctx.quadraticCurveTo(left + box.width * 0.02, y + ry * 1.1, left + box.width * 0.16, y + ry * 1.3);
    ctx.closePath();
  };
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = width * 2;
  lip();
  ctx.stroke();
  const glass = ctx.createLinearGradient(left - box.width * 0.09, 0, left + box.width * 0.16, 0);
  glass.addColorStop(0, "rgba(236, 248, 255, 0.98)");
  glass.addColorStop(1, "rgba(180, 220, 248, 0.98)");
  ctx.fillStyle = glass;
  lip();
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = width * 0.8;
  ctx.beginPath();
  ctx.moveTo(left + box.width * 0.12, y - ry * 0.6);
  ctx.quadraticCurveTo(left + box.width * 0.02, y - ry * 0.7, left - box.width * 0.03, y);
  ctx.stroke();
}

function paintVessel(ctx: CanvasRenderingContext2D, tier: Tier): void {
  const box = boundsOf(tier);

  if (tier.handle) paintHandle(ctx, tier, box);
  if (tier.kind === "coupe" || tier.kind === "roundBowl") paintFoot(ctx, box);

  paintGlassBody(ctx, tier, box);
  paintLiquid(ctx, tier, box);
  paintGlassFront(ctx, tier, box);
  paintOutline(ctx, tier, box);
  if (tier.kind === "pitcher") paintSpout(ctx, tier, box);
  paintRim(ctx, tier, box);
  if (tier.foam) paintFoam(ctx, tier, box);
  if (tier.straw) paintStraw(ctx, tier, box);

  const garnishes = tier.garnishes ?? [];
  garnishes.forEach((garnish, index) => {
    paintGarnish(ctx, garnish, tier, box, index === 0 ? -1 : 1);
  });
}

/* ------------------------------------------------------------------ */
/* Sprites                                                             */
/* ------------------------------------------------------------------ */

/** Canvas pixels for one local unit in a sprite. */
const SPRITE_SCALE = 3;

interface Sprite {
  canvas: HTMLCanvasElement;
  /** Position of the vessel centre inside the sprite, in local units. */
  originX: number;
  originY: number;
  /** Size of the sprite in local units. */
  width: number;
  height: number;
}

const spriteCache = new Map<number, Sprite>();
const shadowCache = new Map<number, Sprite>();

function makeSprite(tierIndex: number, paint: (ctx: CanvasRenderingContext2D, tier: Tier) => void) {
  const tier = tierAt(tierIndex);
  const box = boundsOf(tier);
  const pad = Math.max(box.width, box.height) * 0.5 + 10;
  const width = box.width + pad * 2;
  const height = box.height + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * SPRITE_SCALE);
  canvas.height = Math.ceil(height * SPRITE_SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for the drink sprite");
  const originX = pad - box.minX;
  const originY = pad - box.minY;
  ctx.setTransform(SPRITE_SCALE, 0, 0, SPRITE_SCALE, originX * SPRITE_SCALE, originY * SPRITE_SCALE);
  paint(ctx, tier);
  return { canvas, originX, originY, width, height };
}

function spriteOf(tierIndex: number): Sprite {
  const cached = spriteCache.get(tierIndex);
  if (cached) return cached;
  const sprite = makeSprite(tierIndex, paintVessel);
  spriteCache.set(tierIndex, sprite);
  return sprite;
}

function shadowOf(tierIndex: number): Sprite {
  const cached = shadowCache.get(tierIndex);
  if (cached) return cached;
  const sprite = makeSprite(tierIndex, (ctx, tier) => {
    const box = boundsOf(tier);
    ctx.save();
    ctx.shadowColor = "rgba(60, 40, 20, 0.5)";
    ctx.shadowBlur = Math.max(6, box.width * 0.12) * SPRITE_SCALE;
    ctx.fillStyle = "rgba(60, 40, 20, 0.3)";
    tracePolygon(ctx, tier.outline, cornerOf(box));
    ctx.fill();
    ctx.restore();
  });
  shadowCache.set(tierIndex, sprite);
  return sprite;
}

function blit(ctx: CanvasRenderingContext2D, sprite: Sprite): void {
  ctx.drawImage(sprite.canvas, -sprite.originX, -sprite.originY, sprite.width, sprite.height);
}

/* ------------------------------------------------------------------ */
/* Public drawing                                                      */
/* ------------------------------------------------------------------ */

/** Draws the soft shadow that a vessel casts on the table. */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  tierIndex: number,
  x: number,
  y: number,
  angle: number,
): void {
  const tier = tierAt(tierIndex);
  ctx.save();
  ctx.translate(x + tier.radius * 0.08, y + tier.radius * 0.12);
  ctx.rotate(angle);
  blit(ctx, shadowOf(tierIndex));
  ctx.restore();
}

/** Draws one drink at a position, with a rotation and a size factor. */
export function drawDrink(
  ctx: CanvasRenderingContext2D,
  tierIndex: number,
  x: number,
  y: number,
  angle: number,
  scale = 1,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  blit(ctx, spriteOf(tierIndex));
  ctx.restore();
}

/** Draws a drink so that it fills a square box of the given size. */
export function drawDrinkInBox(
  ctx: CanvasRenderingContext2D,
  tierIndex: number,
  x: number,
  y: number,
  size: number,
): void {
  const tier = tierAt(tierIndex);
  const box = boundsOf(tier);
  const scale = (size * 0.8) / Math.max(box.width, box.height * 1.15);
  drawDrink(ctx, tierIndex, x, y + size * 0.04, 0, scale);
}

export { withAlpha };
