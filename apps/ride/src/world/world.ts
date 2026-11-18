import { RouteGraph, type GraphMeta } from 'route-graph';
import type { TileMesh, TileRequest } from '../workers/world-worker';

export interface Manifest {
  format: number;
  origin: [number, number];
  box: [number, number, number, number];
  spawn: [number, number];
  tile: { size: number; n: number; cell: number };
  levels: Record<string, Record<string, string>>;
  graph: { bin: string; json: string; buildHash: string };
  attribution: string[];
}

/** The loaded world: graph, terrain heights for sampling, and tile meshes as they arrive. */
export class World {
  readonly tiles: TileMesh[] = [];

  private constructor(
    readonly base: string,
    readonly manifest: Manifest,
    readonly graph: RouteGraph,
  ) {}

  static async load(base: string, onTile: (t: TileMesh, done: number, total: number) => void): Promise<World> {
    const manifest = (await (await fetch(`${base}manifest.json`)).json()) as Manifest;
    const [meta, bin] = await Promise.all([
      fetch(base + manifest.graph.json).then((r) => r.json() as Promise<GraphMeta>),
      fetch(base + manifest.graph.bin).then((r) => r.arrayBuffer()),
    ]);
    const world = new World(base, manifest, new RouteGraph(meta, bin));
    await world.loadTiles(onTile);
    return world;
  }

  private async loadTiles(onTile: (t: TileMesh, done: number, total: number) => void): Promise<void> {
    // coarse levels first: the panorama is up quickly, the detail follows
    const levels = Object.keys(this.manifest.levels).map(Number).sort((a, b) => b - a);
    const files = levels.flatMap((l) => Object.values(this.manifest.levels[String(l)] ?? {}).map((f) => `L${l}/${f}`));
    const worker = new Worker(new URL('../workers/world-worker.ts', import.meta.url), { type: 'module' });
    const [e0, n0] = this.manifest.origin;
    let done = 0;
    await new Promise<void>((resolve, reject) => {
      if (files.length === 0) resolve();
      worker.onerror = (e) => reject(new Error(e.message));
      worker.onmessage = (ev: MessageEvent<TileMesh>) => {
        this.tiles.push(ev.data);
        this.tiles.sort((a, b) => a.level - b.level); // finest first for height queries
        onTile(ev.data, ++done, files.length);
        if (done === files.length) resolve();
      };
      files.forEach(async (file, id) => {
        const buffer = await (await fetch(this.base + file)).arrayBuffer();
        const req: TileRequest = { id, buffer, e0, n0 };
        worker.postMessage(req, [buffer]);
      });
    });
    worker.terminate();
  }

  /** World x/z of an LV95 point. */
  toWorld(e: number, n: number): { x: number; z: number } {
    return { x: e - this.manifest.origin[0], z: this.manifest.origin[1] - n };
  }

  /** Terrain height at world x/z (exact surface of the triangles), or null outside the loaded tiles. */
  terrainHeight(x: number, z: number): number | null {
    for (const t of this.tiles) {
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
