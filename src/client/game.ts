import Matter from "matter-js";
import { MERGE_POINTS, TIERS, TOP_TIER, tierAt } from "../shared/tiers.ts";
import { createSpawner } from "../shared/rng.ts";
import { drawDrink, drawShadow } from "./drinks.ts";

const { Bodies, Body, Composite, Engine, Events } = Matter;

/**
 * The board is a bar table seen from above.
 *
 * There is no gravity. The table is slippery, so a drink glides until the air
 * and the other drinks slow it down. The player pushes a new drink in from the
 * bottom edge. The drinks pile up against the far side of the table and the
 * pile grows back towards the player. The game ends when a drink comes to rest
 * behind the dashed line.
 */
export const BOARD = {
  width: 400,
  height: 640,
  /** The new drink waits on this line, at the near edge of the table. */
  launchY: 592,
  /** A drink that stops after this line ends the game. */
  deathY: 470,
} as const;

const STEP_MS = 1000 / 60;
const LAUNCH_SPEED = 14;
const LAUNCH_COOLDOWN_MS = 340;
const OVERFLOW_GRACE_MS = 1400;
const OVERFLOW_HOLD_MS = 900;

/** How the table holds a drink back. Small numbers make the table slippery. */
const SURFACE = {
  frictionAir: 0.02,
  friction: 0.06,
  frictionStatic: 0.09,
  restitution: 0.22,
  density: 0.001,
};

interface DrinkMeta {
  tier: number;
  merged: boolean;
  bornAt: number;
}

interface Pop {
  x: number;
  y: number;
  radius: number;
  age: number;
}

export interface GameEvents {
  onScore(score: number): void;
  onNext(tier: number): void;
  onGameOver(): void;
}

export interface GameReport {
  score: number;
  drops: number;
  mergeCounts: number[];
}

export class MergeGame {
  private readonly engine = Engine.create({
    // A table seen from above has no gravity in the plane of the picture.
    gravity: { x: 0, y: 0, scale: 0 },
    // Sleeping is off. A sleeping drink can stay still when its neighbour
    // merges away, because removal does not wake it.
    enableSleeping: false,
  });

  private readonly meta = new Map<number, DrinkMeta>();
  private readonly pending: Array<[Matter.Body, Matter.Body]> = [];
  private readonly pops: Pop[] = [];
  private readonly decoration = makeTableMarks();

  private nextTierOf: () => number = () => 0;
  private clock = 0;
  private lastLaunchAt = -Infinity;
  private overflowSince: number | null = null;

  private currentTier = 0;
  private queuedTier = 0;
  private holdX = BOARD.width / 2;
  private targetX = BOARD.width / 2;

  private score = 0;
  private drops = 0;
  private mergeCounts: number[] = new Array(TIERS.length).fill(0);
  private running = false;

  constructor(private readonly events: GameEvents) {
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 8;
    this.addRails();
    Events.on(this.engine, "collisionStart", (event) => this.collectMerges(event));
  }

  /* ---------------------------------------------------------------- */
  /* Game control                                                      */
  /* ---------------------------------------------------------------- */

  start(seed: number): void {
    for (const body of Composite.allBodies(this.engine.world)) {
      if (this.meta.has(body.id)) Composite.remove(this.engine.world, body);
    }
    this.meta.clear();
    this.pending.length = 0;
    this.pops.length = 0;

    this.nextTierOf = createSpawner(seed);
    this.clock = 0;
    this.lastLaunchAt = -Infinity;
    this.overflowSince = null;
    this.score = 0;
    this.drops = 0;
    this.mergeCounts = new Array(TIERS.length).fill(0);
    this.currentTier = this.nextTierOf();
    this.queuedTier = this.nextTierOf();
    this.holdX = BOARD.width / 2;
    this.targetX = BOARD.width / 2;
    this.running = true;

    this.events.onScore(0);
    this.events.onNext(this.queuedTier);
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  report(): GameReport {
    return { score: this.score, drops: this.drops, mergeCounts: [...this.mergeCounts] };
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  aimAt(x: number): void {
    const margin = tierAt(this.currentTier).width / 2 + 6;
    this.targetX = Math.min(Math.max(x, margin), BOARD.width - margin);
  }

  nudge(direction: number): void {
    this.aimAt(this.targetX + direction * 22);
  }

  /** Pushes the waiting drink onto the table. */
  drop(): void {
    if (!this.running) return;
    if (this.clock - this.lastLaunchAt < LAUNCH_COOLDOWN_MS) return;
    this.lastLaunchAt = this.clock;

    const body = this.addDrink(this.currentTier, this.holdX, BOARD.launchY);
    Body.setVelocity(body, { x: 0, y: -LAUNCH_SPEED });
    this.drops += 1;

    this.currentTier = this.queuedTier;
    this.queuedTier = this.nextTierOf();
    this.aimAt(this.targetX);
    this.events.onNext(this.queuedTier);
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  /** Advances the physics by one fixed step. */
  step(): void {
    this.holdX += (this.targetX - this.holdX) * 0.35;
    for (const pop of this.pops) pop.age += STEP_MS;
    while (this.pops.length > 0 && (this.pops[0]?.age ?? 0) > 320) this.pops.shift();

    if (!this.running) return;
    this.clock += STEP_MS;
    Engine.update(this.engine, STEP_MS);
    this.resolveMerges();
    this.checkOverflow();
  }

  /** The four rails of the table. Nothing leaves the table. */
  private addRails(): void {
    const thickness = 200;
    const options = { isStatic: true, friction: 0.1, restitution: 0.12 };
    const width = BOARD.width;
    const height = BOARD.height;
    Composite.add(this.engine.world, [
      Bodies.rectangle(width / 2, -thickness / 2, width + thickness * 2, thickness, options),
      Bodies.rectangle(width / 2, height + thickness / 2, width + thickness * 2, thickness, options),
      Bodies.rectangle(-thickness / 2, height / 2, thickness, height + thickness * 2, options),
      Bodies.rectangle(width + thickness / 2, height / 2, thickness, height + thickness * 2, options),
    ]);
  }

  private addDrink(tier: number, x: number, y: number): Matter.Body {
    const outline = tierAt(tier).outline.map((point) => ({ x: point.x, y: point.y }));
    const body = Bodies.fromVertices(x, y, [outline], { ...SURFACE, label: "drink" });
    // A glass stands on the table. It slides, but it does not turn, so the
    // picture always agrees with the collision outline.
    Body.setInertia(body, Infinity);
    this.meta.set(body.id, { tier, merged: false, bornAt: this.clock });
    Composite.add(this.engine.world, body);
    return body;
  }

  private collectMerges(event: Matter.IEventCollision<Matter.Engine>): void {
    for (const pair of event.pairs) {
      const first = this.meta.get(pair.bodyA.id);
      const second = this.meta.get(pair.bodyB.id);
      if (!first || !second) continue;
      if (first.merged || second.merged) continue;
      if (first.tier !== second.tier) continue;
      if (first.tier >= TOP_TIER) continue;
      first.merged = true;
      second.merged = true;
      this.pending.push([pair.bodyA, pair.bodyB]);
    }
  }

  private resolveMerges(): void {
    for (const [first, second] of this.pending) {
      const tier = this.meta.get(first.id)?.tier;
      if (tier === undefined) continue;
      const x = (first.position.x + second.position.x) / 2;
      const y = (first.position.y + second.position.y) / 2;
      // The new drink keeps the movement of the two that made it.
      const vx = (first.velocity.x + second.velocity.x) / 2;
      const vy = (first.velocity.y + second.velocity.y) / 2;

      Composite.remove(this.engine.world, first);
      Composite.remove(this.engine.world, second);
      this.meta.delete(first.id);
      this.meta.delete(second.id);

      const grown = tier + 1;
      const body = this.addDrink(grown, x, y);
      Body.setVelocity(body, { x: vx * 0.5, y: vy * 0.5 });

      this.mergeCounts[grown] = (this.mergeCounts[grown] ?? 0) + 1;
      this.score += MERGE_POINTS[grown] ?? 0;
      this.pops.push({ x, y, radius: tierAt(grown).radius, age: 0 });
    }
    if (this.pending.length > 0) {
      this.pending.length = 0;
      this.events.onScore(this.score);
    }
  }

  private checkOverflow(): void {
    let overflowing = false;
    for (const body of Composite.allBodies(this.engine.world)) {
      const meta = this.meta.get(body.id);
      if (!meta) continue;
      if (this.clock - meta.bornAt < OVERFLOW_GRACE_MS) continue;
      if (Math.hypot(body.velocity.x, body.velocity.y) > 0.6) continue;
      if (body.bounds.max.y > BOARD.deathY) {
        overflowing = true;
        break;
      }
    }

    if (!overflowing) {
      this.overflowSince = null;
      return;
    }
    if (this.overflowSince === null) {
      this.overflowSince = this.clock;
      return;
    }
    if (this.clock - this.overflowSince >= OVERFLOW_HOLD_MS) {
      this.running = false;
      this.events.onGameOver();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Drawing                                                           */
  /* ---------------------------------------------------------------- */

  render(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, BOARD.width, BOARD.height);
    this.drawTable(ctx);
    this.drawDeathLine(ctx);

    for (const body of Composite.allBodies(this.engine.world)) {
      const meta = this.meta.get(body.id);
      if (!meta) continue;
      drawShadow(ctx, meta.tier, body.position.x, body.position.y, body.angle);
    }
    for (const body of Composite.allBodies(this.engine.world)) {
      const meta = this.meta.get(body.id);
      if (!meta) continue;
      drawDrink(ctx, meta.tier, body.position.x, body.position.y, body.angle);
    }

    for (const pop of this.pops) {
      const progress = pop.age / 320;
      ctx.save();
      ctx.globalAlpha = (1 - progress) * 0.7;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4 * (1 - progress) + 1;
      ctx.beginPath();
      ctx.arc(pop.x, pop.y, pop.radius * (1 + progress * 0.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (this.running) this.drawWaitingDrink(ctx);
  }

  private drawTable(ctx: CanvasRenderingContext2D): void {
    const wood = ctx.createLinearGradient(0, 0, 0, BOARD.height);
    wood.addColorStop(0, "#f3e2bf");
    wood.addColorStop(0.55, "#faeed3");
    wood.addColorStop(1, "#f0dcb4");
    ctx.fillStyle = wood;
    ctx.fillRect(0, 0, BOARD.width, BOARD.height);

    // Shells and starfish printed on the table top.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#b98d5a";
    for (const mark of this.decoration) {
      ctx.save();
      ctx.translate(mark.x, mark.y);
      ctx.rotate(mark.angle);
      ctx.beginPath();
      for (let arm = 0; arm < 5; arm += 1) {
        const angle = (arm / 5) * Math.PI * 2;
        ctx.lineTo(Math.cos(angle) * mark.size, Math.sin(angle) * mark.size);
        ctx.lineTo(
          Math.cos(angle + Math.PI / 5) * mark.size * 0.42,
          Math.sin(angle + Math.PI / 5) * mark.size * 0.42,
        );
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // The far rail is a little darker, so the table reads as a surface.
    const edge = ctx.createLinearGradient(0, 0, 0, 70);
    edge.addColorStop(0, "rgba(140, 100, 55, 0.28)");
    edge.addColorStop(1, "rgba(140, 100, 55, 0)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, BOARD.width, 70);
  }

  private drawDeathLine(ctx: CanvasRenderingContext2D): void {
    const warning = this.overflowSince !== null;
    ctx.save();
    ctx.setLineDash([16, 12]);
    ctx.lineCap = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = warning ? "rgba(226, 62, 62, 0.95)" : "rgba(255, 255, 255, 0.9)";
    ctx.beginPath();
    ctx.moveTo(10, BOARD.deathY);
    ctx.lineTo(BOARD.width - 10, BOARD.deathY);
    ctx.stroke();
    ctx.restore();
  }

  private drawWaitingDrink(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.setLineDash([7, 11]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(120, 95, 60, 0.35)";
    ctx.beginPath();
    ctx.moveTo(this.holdX, BOARD.launchY);
    ctx.lineTo(this.holdX, 20);
    ctx.stroke();
    ctx.restore();

    drawShadow(ctx, this.currentTier, this.holdX, BOARD.launchY, 0);
    drawDrink(ctx, this.currentTier, this.holdX, BOARD.launchY, 0);
  }
}

interface TableMark {
  x: number;
  y: number;
  size: number;
  angle: number;
}

/** Fixed marks on the table top. They never move, so the table looks solid. */
function makeTableMarks(): TableMark[] {
  const seeds: Array<[number, number, number, number]> = [
    [62, 128, 15, 0.4],
    [318, 96, 11, 1.9],
    [206, 206, 13, 2.8],
    [96, 318, 10, 0.9],
    [332, 286, 14, 2.2],
    [148, 424, 12, 1.3],
    [286, 402, 10, 0.2],
    [58, 528, 13, 2.6],
    [340, 552, 11, 1.1],
  ];
  return seeds.map(([x, y, size, angle]) => ({ x, y, size, angle }));
}
