import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RouteGraph, encodeGraph, type GraphMeta } from '../src/index.js';

// A "T": 0 --(e0, 100 m east, 5 % up)--> 1 --(e1, 60 m east)--> 2, and 1 --(e2, 80 m south, oneway)--> 3
function tee(): RouteGraph {
  const { meta, buffer } = encodeGraph({
    nodes: [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 160, z: 0 },
      { x: 100, z: 80 },
    ],
    edges: [
      { from: 0, to: 1, height: (s) => 450 + s * 0.05, name: 'Essanestrasse', sections: [{ start: 40, end: 60, flags: 1 }] },
      { from: 1, to: 2, height: () => 455 },
      { from: 1, to: 3, via: [[100, 40]], height: () => 455, oneway: true, cls: 0 },
    ],
  });
  return new RouteGraph(meta, buffer);
}

describe('RouteGraph', () => {
  it('reads nodes, edges, names and attributes', () => {
    const g = tee();
    expect(g.nodeCount).toBe(4);
    expect(g.edgeCount).toBe(3);
    expect(g.length(0)).toBeCloseTo(100, 2);
    expect(g.length(2)).toBeCloseTo(80, 2);
    expect(g.name(0)).toBe('Essanestrasse');
    expect(g.name(1)).toBe('');
    expect(g.edgeClass(2)).toBe(0);
    expect(g.allowed(2, 1)).toBe(true);
    expect(g.allowed(2, -1)).toBe(false);
    expect(g.sections(0)).toEqual([{ start: 40, end: 60, flags: 1 }]);
  });

  it('interpolates points and heights along an edge', () => {
    const g = tee();
    const p = g.point(0, 25);
    expect(p.x).toBeCloseTo(25, 2);
    expect(p.z).toBeCloseTo(0, 2);
    expect(p.tx).toBeCloseTo(1);
    expect(g.height(0, 0)).toBeCloseTo(450, 1);
    expect(g.height(0, 37.5)).toBeCloseTo(451.875, 1);
    expect(g.height(0, 100)).toBeCloseTo(455, 1);
    const q = g.point(2, 60);
    expect(q.x).toBeCloseTo(100, 2);
    expect(q.z).toBeCloseTo(60, 2);
    expect(q.tz).toBeCloseTo(1);
  });

  it('lists exits with travel direction', () => {
    const g = tee();
    expect(g.exits(1)).toEqual([
      { edge: 0, dir: -1 },
      { edge: 1, dir: 1 },
      { edge: 2, dir: 1 },
    ]);
    expect(g.endNode(0, 1)).toBe(1);
    expect(g.endNode(0, -1)).toBe(0);
  });

  it('finds the nearest point on the network', () => {
    const g = tee();
    const n = g.nearest(130, 4)!;
    expect(n.edge).toBe(1);
    expect(n.s).toBeCloseTo(30, 1);
    expect(n.dist).toBeCloseTo(4, 2);
    expect(g.nearest(1000, 1000, 50)).toBeNull();
  });
});

// Golden check against the pipeline output (skipped when the world has not been built).
const world = fileURLToPath(new URL('../../../apps/ride/public/world/', import.meta.url));
const graphJson = existsSync(world) ? readdirSync(world).find((f) => /^graph\..+\.json$/.test(f)) : undefined;

describe.skipIf(!graphJson)('pipeline graph (apps/ride/public/world)', () => {
  it('is consistent', () => {
    const meta = JSON.parse(readFileSync(world + graphJson!, 'utf8')) as GraphMeta;
    const bin = readFileSync(world + graphJson!.replace(/\.json$/, '.bin'));
    const g = new RouteGraph(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    expect(g.edgeCount).toBeGreaterThan(100);
    for (let e = 0; e < g.edgeCount; e++) {
      // geometry starts and ends at the nodes
      const a = g.point(e, 0);
      const b = g.point(e, g.length(e));
      expect(Math.hypot(a.x - g.nodeX(g.from(e)), a.z - g.nodeZ(g.from(e)))).toBeLessThan(0.05);
      expect(Math.hypot(b.x - g.nodeX(g.to(e)), b.z - g.nodeZ(g.to(e)))).toBeLessThan(0.05);
      // heights plausible for the region: Rhine valley floor (~400 m) up to the Pfälzerhütte (2108 m) above Malbun
      const h = g.height(e, g.length(e) / 2);
      expect(h).toBeGreaterThan(380);
      expect(h).toBeLessThan(2200);
    }
    // every node is reachable via its exits
    for (let n = 0; n < g.nodeCount; n++) expect(g.exits(n).length).toBeGreaterThan(0);
  });
});
