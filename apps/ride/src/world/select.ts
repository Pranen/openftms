/**
 * Which tiles of the pyramid are wanted around a point, and which coarse chunks a loaded finer
 * tile covers (PLAN.md, Höhenpyramide). Pure functions, tested in test/select.test.ts.
 */

export interface LevelInfo {
  size: number;
  cell: number;
}

export interface TileRef {
  level: number;
  ix: number;
  iy: number;
  /** Distance of the tile centre from the point, in tile sizes (Chebyshev). */
  d: number;
}

export const tileKey = (level: number, ix: number, iy: number) => `${level}/${ix}_${iy}`;

/**
 * Tiles of every level (from the manifest's `levels`) whose centre lies within `radius` tile
 * sizes of the LV95 point (e, n), Chebyshev: 1.5 gives the 3 × 3 tiles around the point's tile.
 * The top level is always wanted completely (the panorama).
 */
export function wantedTiles(
  levels: Record<string, Record<string, string>>,
  info: Record<string, LevelInfo>,
  e: number,
  n: number,
  radius: number,
): TileRef[] {
  const out: TileRef[] = [];
  const all = Object.keys(levels).map(Number);
  const top = Math.max(...all);
  for (const level of all) {
    const size = info[String(level)]?.size;
    if (!size) continue;
    const ce = e / size;
    const cn = n / size;
    for (const key of Object.keys(levels[String(level)]!)) {
      const [ix, iy] = key.split('_').map(Number) as [number, number];
      const d = Math.max(Math.abs(ix + 0.5 - ce), Math.abs(iy + 0.5 - cn));
      if (level === top || d < radius) out.push({ level, ix, iy, d });
    }
  }
  // nearest first; on a tie the coarser level first (it fills the view, the finer refines it)
  return out.sort((a, b) => a.d - b.d || b.level - a.level);
}

/**
 * The finer tile (level − 1) that covers chunk (ci, cj) of a coarse tile split into
 * `chunks` × `chunks` (cj counts rows from the north, LV95 iy grows to the north).
 */
export function chunkChild(level: number, ix: number, iy: number, ci: number, cj: number, chunks: number): string {
  return tileKey(level - 1, ix * chunks + ci, iy * chunks + (chunks - 1 - cj));
}
