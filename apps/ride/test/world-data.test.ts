/**
 * Checks on the checked-in world data (public/world): every L0 tile decodes, scenery lines and landmarks lie
 * inside their tile with plausible heights, and the per-tile road builder gives geometry where the graph runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RouteGraph, type GraphMeta } from 'route-graph';
import { buildRoadTile } from '../src/render/roads';
import { decodeTile } from '../src/world/tile';

const dir = join(__dirname, '..', 'public', 'world');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
  origin: [number, number];
  levels: Record<string, Record<string, string>>;
  graph: { bin: string; json: string };
};
const load = (lvl: string, key: string) => {
  const b = readFileSync(join(dir, `L${lvl}`, manifest.levels[lvl]![key]!));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe('world data', () => {
  const l0 = Object.keys(manifest.levels['0']!);

  it('decodes every L0 tile with lines and landmarks inside the tile', () => {
    const bad: string[] = [];
    let lines = 0;
    let landmarks = 0;
    for (const key of l0) {
      const t = decodeTile(load('0', key));
      const size = t.header.cell * (t.header.n - 1);
      for (const l of t.lines) {
        lines++;
        expect(l.x.length).toBeGreaterThanOrEqual(2);
        // a segment belongs to the tile of its midpoint: its ends may lie outside (power line spans ~400 m)
        const reach = l.kind >= 20 && l.kind < 30 ? 800 : 60;
        for (let i = 0; i < l.x.length; i++) {
          const x = l.x[i]!;
          const h = l.h[i]!;
          if (x < -reach || x > size + reach || h < 300 || h > 3300) bad.push(`${key} kind ${l.kind} x ${x} h ${h}`);
        }
      }
      for (const m of t.landmarks) {
        landmarks++;
        expect(m.cx).toBeGreaterThanOrEqual(0);
        expect(m.cx).toBeLessThan(size);
        expect(m.base).toBeGreaterThan(300);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(lines).toBeGreaterThan(100);
    expect(landmarks).toBeGreaterThan(5);
  }, 60000);

  it('builds roads for a tile the graph crosses', () => {
    const meta = JSON.parse(readFileSync(join(dir, manifest.graph.json), 'utf8')) as GraphMeta;
    const b = readFileSync(join(dir, manifest.graph.bin));
    const g = new RouteGraph(meta, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const [ix, iy] = l0[Math.floor(l0.length / 2)]!.split('_').map(Number) as [number, number];
    const r = buildRoadTile(g, manifest.origin, 2000, ix, iy);
    expect(r.road.position.length).toBeGreaterThan(0);
    expect(r.road.position.length % 9).toBe(0);
    expect(r.road.color.length).toBe(r.road.position.length);
  });
});
