/**
 * Map on the title screen to pick the start: the whole ride network drawn from the graph (bigger roads
 * brighter), the start places as dots with names; a click on the map or a place starts there (snapped to
 * the nearest road). The choice is kept in localStorage.
 */
import type { RouteGraph } from 'route-graph';
import { START_MAP, START_PLACES } from '../config';

export interface StartPoint {
  edge: number;
  s: number;
  label: string;
}

const KEY = 'ride.start';

export class StartMap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly x0: number;
  private readonly z0: number;
  private chosen: StartPoint | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly placesEl: HTMLElement,
    private readonly labelEl: HTMLElement,
    private readonly graph: RouteGraph,
    box: [number, number, number, number],
    private readonly toWorld: (e: number, n: number) => { x: number; z: number },
    private readonly onPick: (p: StartPoint) => void,
  ) {
    const [e0, n0, e1, n1] = box;
    const w = START_MAP.width;
    this.scale = w / (e1 - e0);
    const h = Math.round((n1 - n0) * this.scale);
    canvas.width = w;
    canvas.height = h;
    const nw = toWorld(e0, n1);
    this.x0 = nw.x;
    this.z0 = nw.z;
    this.ctx = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    this.drawBase();
    canvas.addEventListener('click', (ev) => {
      const r = canvas.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * canvas.width;
      const py = ((ev.clientY - r.top) / r.height) * canvas.height;
      this.pickWorld(this.x0 + px / this.scale, this.z0 + py / this.scale, '');
    });
    placesEl.replaceChildren(
      ...START_PLACES.map(([name, e, n]) => {
        const b = document.createElement('button');
        b.textContent = name.toUpperCase();
        b.onclick = () => {
          const p = toWorld(e, n);
          this.pickWorld(p.x, p.z, name);
        };
        return b;
      }),
    );
    this.restore();
    this.draw();
  }

  private px(x: number, z: number): [number, number] {
    return [(x - this.x0) * this.scale, (z - this.z0) * this.scale];
  }

  private drawBase(): void {
    const g = this.base.getContext('2d')!;
    const C = START_MAP.colours;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.base.width, this.base.height);
    const { geomX, geomZ, edgeGeomStart, edgeGeomCount } = this.graph.a;
    // paths first, then roads, then main roads on top
    for (const [minCls, maxCls, colour, width] of [
      [0, 2, C.path, 0.6],
      [3, 5, C.road, 0.8],
      [6, 15, C.main, 1.4],
    ] as const) {
      g.strokeStyle = colour;
      g.lineWidth = width;
      g.beginPath();
      for (let e = 0; e < this.graph.edgeCount; e++) {
        const c = this.graph.edgeClass(e);
        if (c < minCls || c > maxCls) continue;
        const s = edgeGeomStart[e]!;
        for (let k = 0; k < edgeGeomCount[e]!; k++) {
          const [x, y] = this.px(geomX[s + k]! / 100, geomZ[s + k]! / 100);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      }
      g.stroke();
    }
    g.font = '7px "Press Start 2P", monospace';
    for (const [name, e, n] of START_PLACES) {
      const p = this.toWorld(e, n);
      const [x, y] = this.px(p.x, p.z);
      g.fillStyle = C.place;
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
      g.fillText(name.toUpperCase(), x + 4, y + 3);
    }
  }

  private draw(): void {
    const g = this.ctx;
    g.drawImage(this.base, 0, 0);
    if (!this.chosen) return;
    const p = this.graph.point(this.chosen.edge, this.chosen.s);
    const [x, y] = this.px(p.x, p.z);
    g.strokeStyle = START_MAP.colours.start;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.stroke();
    this.labelEl.textContent = `START: ${this.chosen.label}`;
  }

  /** Nearest point on a road (class from `minClass`) within the snap radius: places start on a street. */
  private nearestRoad(x: number, z: number, minClass: number): { edge: number; s: number } | null {
    const r = START_MAP.snap;
    let best: { edge: number; s: number; d: number } | null = null;
    for (const e of this.graph.edgesIn(x - r, z - r, x + r, z + r)) {
      if (this.graph.edgeClass(e) < minClass) continue;
      const L = this.graph.length(e);
      for (let s = 0; s <= L; s += 5) {
        const p = this.graph.point(e, s);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < r && (!best || d < best.d)) best = { edge: e, s, d };
      }
    }
    return best;
  }

  private pickWorld(x: number, z: number, place: string): void {
    const near = (place ? this.nearestRoad(x, z, START_MAP.placeClass) : null) ?? this.graph.nearest(x, z, START_MAP.snap);
    if (!near) return;
    const street = this.graph.name(near.edge);
    const label = (place ? (street ? `${place} · ${street}` : place) : street || 'WEG').toUpperCase();
    this.chosen = { edge: near.edge, s: near.s, label };
    try {
      localStorage.setItem(KEY, JSON.stringify({ x, z, place }));
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
    this.draw();
    this.onPick(this.chosen);
  }

  /** The start chosen before (this visit or an earlier one), or null for the default spawn. */
  get start(): StartPoint | null {
    return this.chosen;
  }

  private restore(): void {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { x: number; z: number; place: string } | null;
      if (!v) return;
      const near = (v.place ? this.nearestRoad(v.x, v.z, START_MAP.placeClass) : null) ?? this.graph.nearest(v.x, v.z, START_MAP.snap);
      if (!near) return;
      const street = this.graph.name(near.edge);
      this.chosen = { edge: near.edge, s: near.s, label: (v.place ? (street ? `${v.place} · ${street}` : v.place) : street || 'WEG').toUpperCase() };
    } catch {
      /* no or broken entry: default spawn */
    }
  }
}
