import { describe, expect, it } from 'vitest';
import { chunkChild, tileKey, wantedTiles } from '../src/world/select';

const info = { '0': { size: 2000, cell: 8 }, '1': { size: 4000, cell: 16 }, '4': { size: 64000, cell: 250 } };
const grid = (x0: number, x1: number, y0: number, y1: number) => {
  const o: Record<string, string> = {};
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) o[`${x}_${y}`] = `${x}_${y}.bin`;
  return o;
};

describe('wantedTiles', () => {
  const levels = { '0': grid(1378, 1380, 613, 616), '1': grid(688, 691, 305, 308), '4': grid(42, 43, 18, 19) };

  it('takes the 3 × 3 L0 tiles around the point, all L4 tiles', () => {
    const w = wantedTiles(levels, info, 2759100, 1229100, 1.5); // in tile 1379_614
    const l0 = w.filter((t) => t.level === 0).map((t) => `${t.ix}_${t.iy}`).sort();
    expect(l0).toEqual(['1378_613', '1378_614', '1378_615', '1379_613', '1379_614', '1379_615', '1380_613', '1380_614', '1380_615']);
    expect(w.filter((t) => t.level === 4)).toHaveLength(4);
    expect(w[0]).toMatchObject({ level: 0, ix: 1379, iy: 614 });
  });

  it('clips at the edge of the data', () => {
    const w = wantedTiles(levels, info, 2756100, 1233900, 1.5); // NW corner tile 1378_616
    expect(w.filter((t) => t.level === 0)).toHaveLength(4);
  });

  it('keeps more with the larger hysteresis radius', () => {
    const want = wantedTiles(levels, info, 2759100, 1229100, 1.5).length;
    const keep = wantedTiles(levels, info, 2759100, 1229100, 1.9).length;
    expect(keep).toBeGreaterThanOrEqual(want);
  });
});

describe('chunkChild', () => {
  it('maps chunks of a coarse tile to the finer tiles (rows from the north)', () => {
    // L1 tile 689_307 covers L0 1378..1379 × 614..615; chunk (0, 0) is its north-west quarter
    expect(chunkChild(1, 689, 307, 0, 0, 2)).toBe(tileKey(0, 1378, 615));
    expect(chunkChild(1, 689, 307, 1, 1, 2)).toBe(tileKey(0, 1379, 614));
    // L4 has 4 × 4 L3 children
    expect(chunkChild(4, 42, 18, 3, 0, 4)).toBe(tileKey(3, 171, 75));
  });
});
