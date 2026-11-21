import type { EdgePos, Exit, RouteGraph } from 'route-graph';
import { DEFAULT_LINE, DrivenLine, type Junction, type LineOptions, type LinePoint, type Piece } from './line.js';
import { DEFAULT_RIDER, airDensity, crrForSurface, stepSpeed, type RiderParams } from './physics.js';

export type Turn = 'left' | 'straight' | 'right' | 'back';

export interface TurnOption {
  exit: Exit;
  /** Turn angle in degrees, positive = right. */
  angle: number;
  turn: Turn;
  /** Street name, or empty. */
  name: string;
  routes: number;
}

export interface Upcoming {
  node: number;
  /** Distance to the junction (m). */
  distance: number;
  options: TurnOption[];
  selected: number;
}

export interface RideOptions {
  rider: RiderParams;
  /** Respect OSM oneway rules when offering turns. Default false (the virtual world is freer). */
  respectOneway: boolean;
  /** Distance before a junction from which the choice is shown (m). */
  announceDistance: number;
  /** Closer than this to a junction (m, plus the ring radius at roundabouts) the choice is fixed: the line already bends. */
  lockDistance: number;
  /** The ridden line (keep right, roundabouts, rounded corners). */
  line: LineOptions;
}

const DEFAULT_OPTIONS: RideOptions = { rider: DEFAULT_RIDER, respectOneway: false, announceDistance: 150, lockDistance: 20, line: DEFAULT_LINE };
const PROBE = 15; // m along edges to measure turn directions

/**
 * The rider on the graph: position `(edge, dir, s)`, virtual speed from power,
 * the next junction with its options, and look-ahead queries (grade, curves).
 */
export class Ride {
  readonly options: RideOptions;
  pos: EdgePos;
  /** Virtual speed (m/s). */
  v = 0;
  /** Distance ridden (m). */
  distance = 0;
  /** Moving time (s). */
  movingTime = 0;
  /** Elevation gain (m). */
  ascent = 0;
  /** Current speed limit from curves ahead (m/s). */
  vCap = Infinity;
  /** Graph metres travelled (the ridden line can be longer, see {@link DrivenLine}). */
  travel = 0;
  private next: Upcoming | null = null;
  /** Edges left behind, oldest first (for the line behind the rider). */
  private readonly trail: { edge: number; dir: 1 | -1 }[] = [];
  private lineCache: DrivenLine | null = null;
  private lineKey = '';
  private readonly rings: Map<number, number>;

  constructor(readonly graph: RouteGraph, start: EdgePos, options: Partial<Omit<RideOptions, 'line'>> & { line?: Partial<LineOptions> } = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options, line: { ...DEFAULT_LINE, ...options.line } };
    this.pos = { ...start };
    this.rings = new Map(graph.meta.roundabouts ?? []);
    this.plan();
  }

  /** The ridden line around the rider (rebuilt per metre of travel or when the route ahead changes). */
  get line(): DrivenLine {
    const o = this.options.line;
    const base = Math.floor(this.travel);
    const key = `${base}|${this.pos.edge}|${this.pos.dir}|${this.next?.node}|${this.next?.selected}`;
    if (!this.lineCache || key !== this.lineKey) {
      const { pieces, junctions } = this.route(o.back + 2, o.ahead + 2);
      this.lineCache = new DrivenLine(this.graph, pieces, junctions, base - o.back, o.back + o.ahead + 1, this.travel, o);
      this.lineKey = key;
    }
    return this.lineCache;
  }

  /** Point on the ridden line d metres (of line) ahead of the rider (negative: behind). */
  lineAt(d: number, out?: LinePoint): LinePoint {
    const l = this.line;
    return l.at(l.lengthAt(this.travel) + d, out);
  }

  /** Height of the road under the rider. */
  get height(): number {
    return this.graph.height(this.pos.edge, this.pos.s);
  }

  /** Local true grade (fraction) over ±2.5 m in travel direction. */
  get grade(): number {
    return (this.heightAt(this.walk(2.5)) - this.heightAt(this.walk(-2.5))) / 5 / this.line.stretch(this.travel);
  }

  /** The next junction (always known; show it when `distance` < announceDistance). */
  get upcoming(): Upcoming | null {
    if (!this.next) return null;
    this.next.distance = this.remaining();
    return this.next;
  }

  /** One fixed physics step. */
  step(dt: number, powerW: number): void {
    const g = this.graph;
    const h0 = this.height;
    const crr = crrForSurface(g.surface(this.pos.edge));
    this.vCap = this.curveSpeedLimit();
    this.v = stepSpeed(this.v, { powerW, grade: this.grade, crr, rho: airDensity(h0) }, this.options.rider, dt, this.vCap);
    const d = this.v * dt;
    if (d > 0) {
      this.advance(d / this.line.stretch(this.travel));
      this.distance += d;
      this.movingTime += dt;
      const dh = this.height - h0;
      if (dh > 0) this.ascent += dh;
    }
  }

  // --- junction choice --------------------------------------------------------------

  /** Whether the next junction is too close to change the choice. */
  get locked(): boolean {
    const n = this.next;
    if (!n) return true;
    return this.remaining() < this.options.lockDistance + (this.rings.get(n.node) ?? 0);
  }

  /** Select the option going `turn` at the next junction. Returns false if there is none (or it is too close). */
  choose(turn: Turn): boolean {
    const n = this.next;
    if (!n || this.locked) return false;
    let best = -1;
    n.options.forEach((o, i) => {
      if (o.turn === turn && (best < 0 || Math.abs(o.angle) < Math.abs(n.options[best]!.angle))) best = i;
    });
    if (best < 0) return false;
    n.selected = best;
    return true;
  }

  /** Step through the options (−1: further left, +1: further right). */
  cycle(delta: 1 | -1): void {
    const n = this.next;
    if (!n || n.options.length < 2 || this.locked) return;
    n.selected = Math.min(n.options.length - 1, Math.max(0, n.selected + delta));
  }

  /** Turn options at the end of travelling `pos` (sorted left to right). */
  turnOptions(pos: EdgePos): TurnOption[] {
    const g = this.graph;
    const node = g.endNode(pos.edge, pos.dir);
    const nx = g.nodeX(node);
    const nz = g.nodeZ(node);
    const L = g.length(pos.edge);
    const back = g.point(pos.edge, pos.dir > 0 ? L - Math.min(PROBE, L) : Math.min(PROBE, L));
    let ix = nx - back.x;
    let iz = nz - back.z;
    const il = Math.hypot(ix, iz) || 1;
    ix /= il;
    iz /= il;
    const out: TurnOption[] = [];
    for (const exit of g.exits(node)) {
      if (exit.edge === pos.edge && exit.dir === -pos.dir) continue;
      if (this.options.respectOneway && !g.allowed(exit.edge, exit.dir)) continue;
      const el = g.length(exit.edge);
      const p = g.point(exit.edge, exit.dir > 0 ? Math.min(PROBE, el) : el - Math.min(PROBE, el));
      let ox = p.x - nx;
      let oz = p.z - nz;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      // x east, z south: cross > 0 turns clockwise seen from above = right
      const angle = (Math.atan2(ix * oz - iz * ox, ix * ox + iz * oz) * 180) / Math.PI;
      const a = Math.abs(angle);
      const turn: Turn = a <= 35 ? 'straight' : a >= 150 ? 'back' : angle > 0 ? 'right' : 'left';
      out.push({ exit, angle, turn, name: g.name(exit.edge), routes: g.routes(exit.edge) });
    }
    return out.sort((p, q) => p.angle - q.angle);
  }

  /** Default choice: as straight as possible, preferring the same class and shared cycle routes. */
  defaultChoice(pos: EdgePos, options: TurnOption[]): number {
    const g = this.graph;
    let best = -1;
    let bestScore = Infinity;
    options.forEach((o, i) => {
      const score =
        Math.abs(o.angle) +
        (g.edgeClass(o.exit.edge) === g.edgeClass(pos.edge) ? 0 : 15) -
        ((o.routes & g.routes(pos.edge)) !== 0 ? 25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  // --- movement and look-ahead -------------------------------------------------------

  private remaining(pos: EdgePos = this.pos): number {
    return pos.dir > 0 ? this.graph.length(pos.edge) - pos.s : pos.s;
  }

  private plan(): void {
    const options = this.turnOptions(this.pos);
    this.next = { node: this.graph.endNode(this.pos.edge, this.pos.dir), distance: this.remaining(), options, selected: this.defaultChoice(this.pos, options) };
  }

  /** Move the rider by d metres along the planned path. */
  private advance(d: number): void {
    let left = d;
    for (let guard = 0; guard < 1000 && left > 0; guard++) {
      const rem = this.remaining();
      if (left < rem) {
        this.pos.s += this.pos.dir * left;
        this.travel += left;
        return;
      }
      left -= rem;
      this.travel += rem;
      this.trail.push({ edge: this.pos.edge, dir: this.pos.dir });
      if (this.trail.length > 32) this.trail.shift();
      this.pos = this.leave(this.pos, this.next);
      this.plan();
    }
  }

  /** Position after the end of `pos`'s edge, taking choice `n` (or turning back at a dead end). */
  private leave(pos: EdgePos, n: Upcoming | null): EdgePos {
    const g = this.graph;
    const opt = n && n.selected >= 0 ? n.options[n.selected] : undefined;
    if (!opt) {
      // dead end (or end of the built area): turn around
      return { edge: pos.edge, dir: pos.dir > 0 ? -1 : 1, s: pos.dir > 0 ? g.length(pos.edge) : 0 };
    }
    const { edge, dir } = opt.exit;
    return { edge, dir, s: dir > 0 ? 0 : g.length(edge) };
  }

  /**
   * Position d metres ahead (negative: behind, within the current edge only beyond its start),
   * using the selected option at the next junction and default choices after it.
   */
  walk(d: number, from: EdgePos = this.pos): EdgePos {
    const g = this.graph;
    if (d < 0) {
      const s = from.s - from.dir * -d;
      return { ...from, s: Math.min(g.length(from.edge), Math.max(0, s)) };
    }
    let pos = { ...from };
    let left = d;
    let first = true;
    for (let guard = 0; guard < 200 && left > 0; guard++) {
      const rem = this.remaining(pos);
      if (left <= rem) return { ...pos, s: pos.s + pos.dir * left };
      left -= rem;
      let n: Upcoming | null;
      if (first && pos.edge === this.pos.edge && pos.dir === this.pos.dir) n = this.next;
      else {
        const options = this.turnOptions(pos);
        n = { node: g.endNode(pos.edge, pos.dir), distance: 0, options, selected: this.defaultChoice(pos, options) };
      }
      first = false;
      pos = this.leave(pos, n);
    }
    return pos;
  }

  /** The edges around the rider: `back` metres behind (as far as known) and `ahead` metres along the plan. */
  private route(back: number, ahead: number): { pieces: Piece[]; junctions: Junction[] } {
    const g = this.graph;
    const pieces: Piece[] = [];
    const junctions: Junction[] = [];
    const L0 = g.length(this.pos.edge);
    const behind = this.pos.dir > 0 ? this.pos.s : L0 - this.pos.s;
    pieces.push({ edge: this.pos.edge, dir: this.pos.dir, s0: this.pos.dir > 0 ? 0 : L0, s1: this.pos.s, d0: -behind, d1: 0 });
    let d = -behind;
    let later: { edge: number; dir: 1 | -1 } = { edge: this.pos.edge, dir: this.pos.dir };
    for (let i = this.trail.length - 1; i >= 0 && d > -back; i--) {
      const t = this.trail[i]!;
      const L = g.length(t.edge);
      junctions.unshift({ d, node: g.endNode(t.edge, t.dir), uTurn: t.edge === later.edge && t.dir !== later.dir });
      pieces.unshift({ edge: t.edge, dir: t.dir, s0: t.dir > 0 ? 0 : L, s1: t.dir > 0 ? L : 0, d0: d - L, d1: d });
      d -= L;
      later = t;
    }
    let pos: EdgePos = { ...this.pos };
    d = 0;
    let first = true;
    for (let guard = 0; guard < 200 && d < ahead; guard++) {
      const rem = this.remaining(pos);
      const L = g.length(pos.edge);
      pieces.push({ edge: pos.edge, dir: pos.dir, s0: pos.s, s1: pos.dir > 0 ? L : 0, d0: d, d1: d + rem });
      d += rem;
      let n: Upcoming | null;
      if (first) n = this.next;
      else {
        const options = this.turnOptions(pos);
        n = { node: g.endNode(pos.edge, pos.dir), distance: 0, options, selected: this.defaultChoice(pos, options) };
      }
      first = false;
      const nextPos = this.leave(pos, n);
      junctions.push({ d, node: g.endNode(pos.edge, pos.dir), uTurn: nextPos.edge === pos.edge });
      pos = nextPos;
    }
    return { pieces, junctions };
  }

  heightAt(p: EdgePos): number {
    return this.graph.height(p.edge, p.s);
  }

  /** Mean true grade (%) between `from` and `from + window` metres ahead. */
  gradeAhead(from: number, window: number): number {
    const a = this.heightAt(this.walk(from));
    const b = this.heightAt(this.walk(from + window));
    return ((b - a) / window) * 100;
  }

  /** World x/z (and tangent) at d metres ahead. */
  pointAhead(d: number): { x: number; z: number; tx: number; tz: number; h: number } {
    const p = this.walk(d);
    const q = this.graph.point(p.edge, p.s);
    return { x: q.x, z: q.z, tx: q.tx * p.dir, tz: q.tz * p.dir, h: this.heightAt(p) };
  }

  /** Highest speed from which the virtual rider can still slow down for every curve of the ridden line ahead. */
  private curveSpeedLimit(): number {
    const r = this.options.rider;
    const reach = Math.max(40, (this.v * this.v) / (2 * r.brakeDecel) + 20);
    const line = this.line;
    const c0 = line.lengthAt(this.travel);
    let cap = Infinity;
    for (let i = Math.max(0, Math.floor(this.travel - line.u0)); i < line.n; i++) {
      const d = line.c[i]! - c0;
      if (d > reach) break;
      const k = Math.abs(line.k[i]!);
      if (k < 1e-3) continue;
      const vCurve = Math.sqrt(r.maxLateralAccel / k);
      cap = Math.min(cap, Math.sqrt(vCurve * vCurve + 2 * r.brakeDecel * Math.max(0, d)));
    }
    return cap;
  }
}
