import { RouteGraph, type GraphMeta } from 'route-graph';
import { STREAM } from '../config';
import type { GraphMessage, TileMesh, TileRequest } from '../workers/world-worker';
import { tileKey, wantedTiles, type LevelInfo } from './select';

export interface Manifest {
  format: number;
  origin: [number, number];
  box: [number, number, number, number];
  spawn: [number, number];
  tile: { size: number; n: number; cell: number };
  levelInfo: Record<string, LevelInfo>;
  levels: Record<string, Record<string, string>>;
  graph: { bin: string; json: string; buildHash: string };
  attribution: string[];
}

export interface StreamListener {
  /** A tile is decoded and meshed: add it to the scene. */
  ready(t: TileMesh, key: string): void;
  /** A tile is no longer wanted: remove it from the scene. */
  dropped(t: TileMesh, key: string): void;
}

type Slot = { state: 'loading'; started: number } | { state: 'ready'; tile: TileMesh };

/**
 * The world: graph (whole detail area, loaded once) and the tile pyramid, streamed around a
 * focus point (PLAN.md, Höhenpyramide): per level the 3 × 3 tiles around the focus, L4 always.
 * Tiles are decoded and meshed in a worker; listeners add and remove them from the scene.
 */
export class World {
  private readonly slots = new Map<string, Slot>();
  /** Ready tiles, finest level first (height queries). */
  private ready: TileMesh[] = [];
  private readonly worker: Worker;
  private readonly pending = new Map<number, string>();
  private queue: string[] = [];
  private nextId = 1;
  private focus: { e: number; n: number } | null = null;
  /** Bytes fetched so far (debug view). */
  bytes = 0;

  private constructor(
    readonly base: string,
    readonly manifest: Manifest,
    readonly graph: RouteGraph,
    private readonly listener: StreamListener,
  ) {
    this.worker = new Worker(new URL('../workers/world-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<TileMesh>) => this.onMesh(ev.data);
    this.worker.onerror = (e) => console.error('tile worker', e.message);
  }

  static async load(base: string, listener: StreamListener): Promise<World> {
    const manifest = (await (await fetch(`${base}manifest.json`)).json()) as Manifest;
    const [meta, bin] = await Promise.all([
      fetch(base + manifest.graph.json).then((r) => r.json() as Promise<GraphMeta>),
      fetch(base + manifest.graph.bin).then((r) => r.arrayBuffer()),
    ]);
    const world = new World(base, manifest, new RouteGraph(meta, bin), listener);
    const msg: GraphMessage = { graph: { meta, bin: bin.slice(0) } }; // the worker plants trees clear of the roads
    world.worker.postMessage(msg, [msg.graph.bin]);
    return world;
  }

  /** World x/z of an LV95 point. */
  toWorld(e: number, n: number): { x: number; z: number } {
    return { x: e - this.manifest.origin[0], z: this.manifest.origin[1] - n };
  }

  /** LV95 of a world point. */
  toLv95(x: number, z: number): { e: number; n: number } {
    return { e: x + this.manifest.origin[0], n: this.manifest.origin[1] - z };
  }

  /** Move the streaming focus (world x/z): starts loads of newly wanted tiles, drops far ones. */
  update(x: number, z: number): void {
    const { e, n } = this.toLv95(x, z);
    this.focus = { e, n };
    const { levels, levelInfo } = this.manifest;
    const want = wantedTiles(levels, levelInfo, e, n, STREAM.want);
    const keep = new Set(wantedTiles(levels, levelInfo, e, n, STREAM.keep).map((t) => tileKey(t.level, t.ix, t.iy)));
    for (const [key, slot] of this.slots) {
      if (keep.has(key)) continue;
      this.slots.delete(key);
      if (slot.state === 'ready') {
        this.ready = this.ready.filter((t) => t !== slot.tile);
        this.listener.dropped(slot.tile, key);
      }
    }
    this.queue = want.map((t) => tileKey(t.level, t.ix, t.iy)).filter((k) => !this.slots.has(k));
    this.pump();
  }

  /** All wanted tiles are ready (initial load). */
  get settled(): boolean {
    return this.queue.length === 0 && this.pending.size === 0;
  }

  /** State of every tile known to the streamer (debug view). */
  states(): { key: string; state: 'loading' | 'ready' }[] {
    return [...this.slots].map(([key, s]) => ({ key, state: s.state }));
  }

  isReady(key: string): boolean {
    return this.slots.get(key)?.state === 'ready';
  }

  get focusLv95(): { e: number; n: number } | null {
    return this.focus;
  }

  private pump(): void {
    while (this.pending.size < STREAM.parallel && this.queue.length) {
      const key = this.queue.shift()!;
      if (this.slots.has(key)) continue;
      const [lvl, ixy] = key.split('/') as [string, string];
      const file = this.manifest.levels[lvl]?.[ixy];
      if (!file) continue;
      const id = this.nextId++;
      this.slots.set(key, { state: 'loading', started: performance.now() });
      this.pending.set(id, key);
      const [e0, n0] = this.manifest.origin;
      fetch(`${this.base}L${lvl}/${file}`)
        .then((r) => r.arrayBuffer())
        .then((buffer) => {
          this.bytes += buffer.byteLength;
          const req: TileRequest = { id, buffer, e0, n0 };
          this.worker.postMessage(req, [buffer]);
        })
        .catch((err) => {
          console.error(`tile ${key}`, err);
          this.pending.delete(id);
          this.slots.delete(key); // retried on the next update
          this.pump();
        });
    }
  }

  private onMesh(t: TileMesh): void {
    const key = this.pending.get(t.id);
    this.pending.delete(t.id);
    if (key && this.slots.get(key)?.state === 'loading') {
      this.slots.set(key, { state: 'ready', tile: t });
      this.ready.push(t);
      this.ready.sort((a, b) => a.level - b.level);
      this.listener.ready(t, key);
    }
    this.pump();
  }

  /** Terrain height at world x/z (exact surface of the triangles of the finest ready tile), or null. */
  terrainHeight(x: number, z: number): number | null {
    for (const t of this.ready) {
      const fx = (x - t.x0) / t.cell;
      const fz = (z - t.z0) / t.cell;
      if (fx < 0 || fz < 0 || fx > t.n - 1 || fz > t.n - 1) continue;
      const i = Math.min(t.n - 2, Math.floor(fx));
      const j = Math.min(t.n - 2, Math.floor(fz));
      const u = fx - i;
      const v = fz - j;
      const h = (a: number, b: number) => t.heights[b * t.n + a]!;
      return u + v <= 1
        ? h(i, j) + (h(i + 1, j) - h(i, j)) * u + (h(i, j + 1) - h(i, j)) * v
        : h(i + 1, j + 1) + (h(i, j + 1) - h(i + 1, j + 1)) * (1 - u) + (h(i + 1, j) - h(i + 1, j + 1)) * (1 - v);
    }
    return null;
  }
}
