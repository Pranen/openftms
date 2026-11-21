/**
 * Landmark models (LMRK section) and church towers, built in the world worker into the textured building
 * mesh. Recognition by silhouette, colour and place (idea after C:/data/li-auto/src/render/landmarks.ts):
 * castles with keeps and steep red roofs, churches with towers and spires or an onion dome, the black cube
 * of the Kunstmuseum, the covered wooden bridge over the Rhine.
 *
 * Models are drawn in a local frame: u along the footprint's long axis, v across, y up from the base.
 */
import { Color } from 'three';
import { TEX } from '../world/atlas';
import type { LandmarkRecord } from '../world/tile';

/** Landmark styles, index = style byte of LMRK (tools/world-pipeline landmarks.py STYLES). */
export const LANDMARK = [
  'castle_vaduz',
  'cathedral',
  'rotes_haus',
  'gutenberg',
  'church_tower',
  'church_onion',
  'cube_black',
  'cube_white',
  'schattenburg',
  'werdenberg',
  'sargans',
  'ruin',
  'covered_bridge',
] as const;

export type { LandmarkRecord };

type RGB = [number, number, number];
export type Tri = (a: number[], b: number[], c: number[], colour: RGB, ta: number[], tb: number[], tc: number[], tile: number) => void;

const rgb = (hex: number): RGB => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const K = {
  white: rgb(0xf0ece2),
  plaster: rgb(0xe6dcc6),
  limestone: rgb(0xd8d2c2),
  stone: rgb(0xb4ac9c),
  darkStone: rgb(0x8e877a),
  red: rgb(0xa8402e),
  redRoof: rgb(0x9a3a2a),
  slate: rgb(0x5a5f68),
  copper: rgb(0x5f9a84),
  black: rgb(0x2a2a2e),
  wood: rgb(0x8a5a36),
  shingle: rgb(0x6a4a34),
  gold: rgb(0xd8b850),
};

/** Local-frame geometry helpers writing into the building mesh. */
export class Model {
  constructor(
    private readonly tri: Tri,
    private readonly ox: number,
    private readonly oz: number,
    private readonly y0: number,
    private readonly ux: number,
    private readonly uz: number,
  ) {}

  /** World point of local (u, y, v). */
  p(u: number, y: number, v: number): number[] {
    return [this.ox + this.ux * u - this.uz * v, this.y0 + y, this.oz + this.uz * u + this.ux * v];
  }

  /** Box walls (and flat top) from y0 to y1, textured with `tile` (axis / storey in m). */
  box(cu: number, cv: number, y0: number, y1: number, hu: number, hv: number, c: RGB, tile: number, top = true, axis = 3, storey = 3): void {
    const P = [
      [cu - hu, cv - hv],
      [cu + hu, cv - hv],
      [cu + hu, cv + hv],
      [cu - hu, cv + hv],
    ];
    for (let k = 0; k < 4; k++) {
      const [au, av] = P[k]!;
      const [bu, bv] = P[(k + 1) % 4]!;
      const len = Math.hypot(bu! - au!, bv! - av!);
      const uu = Math.max(1, Math.round(len / axis));
      const v0 = y0 / storey;
      const v1 = y1 / storey;
      const A = this.p(au!, y0, av!);
      const B = this.p(bu!, y0, bv!);
      const C = this.p(bu!, y1, bv!);
      const D = this.p(au!, y1, av!);
      this.tri(A, B, C, c, [0, v0], [uu, v0], [uu, v1], tile);
      this.tri(A, C, D, c, [0, v0], [uu, v1], [0, v1], tile);
    }
    if (top) {
      const t = P.map(([u, v]) => this.p(u!, y1, v!));
      this.tri(t[0]!, t[1]!, t[2]!, c, [0, 0], [1, 0], [1, 1], TEX.roofFlat);
      this.tri(t[0]!, t[2]!, t[3]!, c, [0, 0], [1, 1], [0, 1], TEX.roofFlat);
    }
  }

  /** Gabled roof along u on a box (hu, hv) at height y, rising `rise`; gable ends in the wall colour. */
  gable(cu: number, cv: number, y: number, hu: number, hv: number, rise: number, c: RGB, wall: RGB, tile: number = TEX.roofTiles): void {
    const o = 0.4;
    const A = this.p(cu - hu - o, y, cv - hv - o);
    const B = this.p(cu + hu + o, y, cv - hv - o);
    const C = this.p(cu + hu + o, y, cv + hv + o);
    const D = this.p(cu - hu - o, y, cv + hv + o);
    const R0 = this.p(cu - hu - o, y + rise, cv);
    const R1 = this.p(cu + hu + o, y + rise, cv);
    const s = Math.hypot(hv + o, rise) / 2;
    const L = (hu + o) / 1;
    this.tri(A, B, R1, c, [-L, 0], [L, 0], [L, s], tile);
    this.tri(A, R1, R0, c, [-L, 0], [L, s], [-L, s], tile);
    this.tri(C, D, R0, c, [L, 0], [-L, 0], [-L, s], tile);
    this.tri(C, R0, R1, c, [L, 0], [-L, s], [L, s], tile);
    const g0 = this.p(cu - hu, y, cv - hv);
    const g1 = this.p(cu - hu, y, cv + hv);
    const g2 = this.p(cu + hu, y, cv - hv);
    const g3 = this.p(cu + hu, y, cv + hv);
    this.tri(g0, g1, this.p(cu - hu, y + rise, cv), wall, [0, 0], [2, 0], [1, 1], TEX.plain);
    this.tri(g3, g2, this.p(cu + hu, y + rise, cv), wall, [0, 0], [2, 0], [1, 1], TEX.plain);
  }

  /** Pyramid (n = 4) or cone (n > 4) roof / spire with radius r at y, apex at y + rise. */
  spire(cu: number, cv: number, y: number, r: number, rise: number, c: RGB, n = 4, tile: number = TEX.roofSlate): void {
    const apex = this.p(cu, y + rise, cv);
    const s = Math.hypot(r, rise) / 2;
    for (let k = 0; k < n; k++) {
      const a0 = ((k + 0.5) / n) * Math.PI * 2;
      const a1 = ((k + 1.5) / n) * Math.PI * 2;
      const R = n === 4 ? r * Math.SQRT2 : r;
      this.tri(this.p(cu + Math.cos(a0) * R, y, cv + Math.sin(a0) * R), this.p(cu + Math.cos(a1) * R, y, cv + Math.sin(a1) * R), apex, c, [0, 0], [r, 0], [r / 2, s], tile);
    }
  }

  /** Round tower (n-gon prism). */
  cylinder(cu: number, cv: number, y0: number, y1: number, r: number, c: RGB, tile: number, n = 10): void {
    const circ = (2 * Math.PI * r) / n;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2;
      const a1 = ((k + 1) / n) * Math.PI * 2;
      const A = this.p(cu + Math.cos(a0) * r, y0, cv + Math.sin(a0) * r);
      const B = this.p(cu + Math.cos(a1) * r, y0, cv + Math.sin(a1) * r);
      const C = this.p(cu + Math.cos(a1) * r, y1, cv + Math.sin(a1) * r);
      const D = this.p(cu + Math.cos(a0) * r, y1, cv + Math.sin(a0) * r);
      const uu = circ / 3;
      this.tri(A, B, C, c, [0, y0 / 3], [uu, y0 / 3], [uu, y1 / 3], tile);
      this.tri(A, C, D, c, [0, y0 / 3], [uu, y1 / 3], [0, y1 / 3], tile);
    }
  }

  /** Onion dome: a lathe of a few rings. */
  onion(cu: number, cv: number, y: number, w: number, c: RGB): void {
    const k = w / 7;
    const prof = [
      [3.0, 0],
      [4.4, 1.0],
      [4.8, 2.4],
      [3.9, 4.0],
      [2.2, 5.4],
      [0.9, 6.6],
      [0.4, 7.8],
      [0.6, 8.4],
      [0.0, 9.6],
    ];
    const n = 8;
    for (let i = 0; i + 1 < prof.length; i++) {
      const [r0, h0] = prof[i]!;
      const [r1, h1] = prof[i + 1]!;
      for (let j = 0; j < n; j++) {
        const a0 = (j / n) * Math.PI * 2;
        const a1 = ((j + 1) / n) * Math.PI * 2;
        const P = (r: number, h: number, a: number) => this.p(cu + Math.cos(a) * r * k, y + h * k, cv + Math.sin(a) * r * k);
        this.tri(P(r0!, h0!, a0), P(r0!, h0!, a1), P(r1!, h1!, a1), c, [0, 0], [1, 0], [1, 1], TEX.roofMetal);
        if (r1! > 0) this.tri(P(r0!, h0!, a0), P(r1!, h1!, a1), P(r1!, h1!, a0), c, [0, 0], [1, 1], [0, 1], TEX.roofMetal);
      }
    }
  }

  /** Battlements along the top of a box. */
  crenels(cu: number, cv: number, y: number, hu: number, hv: number, c: RGB): void {
    for (const [len, along] of [
      [hu, true],
      [hv, false],
    ] as const) {
      const n = Math.max(2, Math.round(len / 1.6));
      for (let i = 0; i < n; i++) {
        const t = -len + ((i + 0.5) * 2 * len) / n;
        for (const side of [1, -1]) {
          const u = along ? cu + t : cu + side * hu;
          const v = along ? cv + side * hv : cv + t;
          this.box(u, v, y, y + 1.1, 0.4, 0.4, c, TEX.stone, true, 1, 1);
        }
      }
    }
  }
}

/** A church tower with a spire (or onion) at one end of a church nave (generic village churches). */
export function churchTower(m: Model, hu: number, hv: number, height: number, end: number, onion: boolean, wall: RGB = K.white): void {
  const w = Math.max(3.5, Math.min(8, hv * 0.9));
  const u = end * (hu + w / 2 - 1);
  m.box(u, 0, -2, height, w / 2, w / 2, wall, TEX.plain, false, 3, 3);
  m.box(u, 0, height - 5, height - 3, w / 2 + 0.05, w / 2 + 0.05, K.black, TEX.plain, false, w, 2); // belfry band
  if (onion) m.onion(u, 0, height, w, K.copper);
  else m.spire(u, 0, height, w / 2 + 0.3, w * 2.2, K.slate);
}

export function modelAt(tri: Tri, x0: number, z0: number, cx: number, cz: number, angle: number, base: number): Model {
  return new Model(tri, x0 + cx, z0 + cz, base, Math.cos(angle), Math.sin(angle));
}

function hash(a: number, b: number): number {
  let h = Math.imul(Math.round(a * 10), 374761393) + Math.imul(Math.round(b * 10), 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Draws one landmark into the building mesh (tile-local record, x0/z0 = world NW corner of the tile). */
export function buildLandmark(tri: Tri, l: LandmarkRecord, x0: number, z0: number): void {
  const m = modelAt(tri, x0, z0, l.cx, l.cz, l.angle, l.base);
  const hu = Math.max(4, l.hl);
  const hv = Math.max(3, l.hw);
  const r = hash(l.cx, l.cz);
  switch (LANDMARK[l.style]) {
    case 'castle_vaduz': {
      // Schloss Vaduz: white walls on the rock, red roofs, the round bastion and the tall keep
      m.box(0, 0, -6, 16, hu * 0.85, hv * 0.8, K.white, TEX.house);
      m.gable(0, 0, 16, hu * 0.85, hv * 0.8, hv * 0.7, K.redRoof, K.white);
      m.cylinder(-hu * 0.75, 0, -6, 13, hv * 0.55, K.white, TEX.stone, 12);
      m.spire(-hu * 0.75, 0, 13, hv * 0.6, 6, K.redRoof, 12, TEX.roofTiles);
      m.box(hu * 0.55, 0, -6, 34, 5, 5, K.white, TEX.plain);
      m.spire(hu * 0.55, 0, 34, 5.4, 9, K.redRoof, 4, TEX.roofTiles);
      break;
    }
    case 'cathedral': {
      // neo-gothic nave with steep slate roof, polygonal choir, west tower with a tall spire
      const nave = hv * 0.75;
      m.box(-hu * 0.05, 0, -3, 17, hu * 0.75, nave, K.limestone, TEX.stone);
      m.gable(-hu * 0.05, 0, 17, hu * 0.75, nave, nave * 1.3, K.slate, K.limestone, TEX.roofSlate);
      m.cylinder(hu * 0.72, 0, -3, 15, nave * 0.9, K.limestone, TEX.stone, 8);
      m.spire(hu * 0.72, 0, 15, nave, 9, K.slate, 8);
      m.box(-hu * 0.85, 0, -3, 42, 4.5, 4.5, K.limestone, TEX.stone);
      m.spire(-hu * 0.85, 0, 42, 4.8, 26, K.slate, 8);
      break;
    }
    case 'rotes_haus': {
      // Rotes Haus: red house with stepped gables and a square tower
      m.box(0, 0, -2, 9, hu * 0.8, hv * 0.8, K.red, TEX.house);
      m.gable(0, 0, 9, hu * 0.8, hv * 0.8, hv * 0.9, K.redRoof, K.red);
      for (const end of [-1, 1])
        for (let k = 0; k < 3; k++) m.box(end * hu * 0.8, 0, 9 + k * 1.6, 10.6 + k * 1.6, 0.3, hv * 0.8 * (1 - k * 0.3), K.red, TEX.plain, true, 2, 2);
      m.box(-hu * 0.75, hv * 0.3, -2, 20, 3, 3, K.plaster, TEX.stone);
      m.spire(-hu * 0.75, hv * 0.3, 20, 3.3, 6, K.redRoof, 4, TEX.roofTiles);
      break;
    }
    case 'gutenberg': {
      // Burg Gutenberg (Balzers): curtain wall on the hilltop, keep with a gable roof, chapel
      for (const [u, v, a, b] of [
        [0, hv, hu, 0.8],
        [0, -hv, hu, 0.8],
        [hu, 0, 0.8, hv],
        [-hu, 0, 0.8, hv],
      ] as const)
        m.box(u, v, -4, 8, a, b, K.stone, TEX.stone, true, 2.5, 2.5);
      m.crenels(0, 0, 8, hu, hv, K.stone);
      m.box(hu * 0.3, 0, -4, 28, 5.5, 5.5, K.stone, TEX.stone);
      m.gable(hu * 0.3, 0, 28, 5.5, 5.5, 6, K.redRoof, K.stone);
      m.box(-hu * 0.5, -hv * 0.3, -2, 9, 4, 3, K.white, TEX.plain);
      m.gable(-hu * 0.5, -hv * 0.3, 9, 4, 3, 3.5, K.redRoof, K.white);
      break;
    }
    case 'church_tower':
    case 'church_onion': {
      m.box(0, 0, -3, 12, hu * 0.85, hv * 0.85, K.white, TEX.plain);
      m.gable(0, 0, 12, hu * 0.85, hv * 0.85, hv * 0.9, K.redRoof, K.white);
      churchTower(m, hu * 0.85, hv * 0.85, 32 + r * 14, r < 0.5 ? -1 : 1, LANDMARK[l.style] === 'church_onion', K.white);
      break;
    }
    case 'cube_black':
    case 'cube_white': {
      const black = LANDMARK[l.style] === 'cube_black';
      m.box(0, 0, -2, black ? 13 : 11, hu, hv, black ? K.black : K.white, black ? TEX.plain : TEX.plain);
      break;
    }
    case 'schattenburg': {
      // Schattenburg (Feldkirch): tall keep with a steep hipped roof, white palas
      m.box(-hu * 0.3, 0, -4, 18, hu * 0.7, hv * 0.8, K.white, TEX.house);
      m.gable(-hu * 0.3, 0, 18, hu * 0.7, hv * 0.8, hv, K.redRoof, K.white);
      m.box(hu * 0.6, 0, -4, 34, 5, 5, K.white, TEX.stone);
      m.spire(hu * 0.6, 0, 34, 5.5, 11, K.redRoof, 4, TEX.roofTiles);
      break;
    }
    case 'werdenberg': {
      // Schloss Werdenberg: tall white palas with a steep red roof and a square tower
      m.box(0, 0, -4, 22, hu * 0.85, hv * 0.8, K.white, TEX.house);
      m.gable(0, 0, 22, hu * 0.85, hv * 0.8, hv * 1.2, K.redRoof, K.white);
      m.box(hu * 0.8, hv * 0.4, -4, 30, 4.5, 4.5, K.white, TEX.stone);
      m.spire(hu * 0.8, hv * 0.4, 30, 5, 9, K.redRoof, 4, TEX.roofTiles);
      break;
    }
    case 'sargans': {
      // Schloss Sargans: keep with a red hipped roof next to the palas
      m.box(-hu * 0.35, 0, -4, 16, hu * 0.6, hv * 0.8, K.plaster, TEX.house);
      m.gable(-hu * 0.35, 0, 16, hu * 0.6, hv * 0.8, hv * 0.9, K.redRoof, K.plaster);
      m.box(hu * 0.55, 0, -4, 32, 5.5, 5.5, K.stone, TEX.stone);
      m.spire(hu * 0.55, 0, 32, 6, 8, K.redRoof, 4, TEX.roofTiles);
      break;
    }
    case 'ruin': {
      // a ruin: broken stone walls of different heights, the rest of a keep
      for (let k = 0; k < 4; k++) {
        const along = k < 2;
        const s = k % 2 ? 1 : -1;
        const h = 4 + hash(l.cx + k, l.cz) * 7;
        if (along) m.box(0, s * hv, -3, h, hu * (0.6 + 0.4 * hash(k, l.cz)), 0.9, K.darkStone, TEX.stone, true, 2.5, 2.5);
        else m.box(s * hu, 0, -3, h, 0.9, hv * (0.5 + 0.5 * hash(l.cx, k)), K.darkStone, TEX.stone, true, 2.5, 2.5);
      }
      m.box(-hu * 0.4, 0, -3, 14, 4, 4, K.darkStone, TEX.stone, true, 2.5, 2.5);
      break;
    }
    case 'covered_bridge': {
      // covered wooden bridge (Alte Rheinbrücke Vaduz–Sevelen): wooden sides and a shingle roof on piers
      const w = Math.max(2.5, Math.min(hv, 3.5));
      m.box(0, 0, -0.6, 0.2, hu, w + 0.3, K.darkStone, TEX.plain);
      for (const s of [1, -1]) m.box(0, s * w, 0.2, 3.2, hu, 0.15, K.wood, TEX.barn, false, 2, 2.6);
      m.gable(0, 0, 3.2, hu, w, 1.8, K.shingle, K.wood, TEX.roofTiles);
      const n = Math.max(2, Math.round((2 * hu) / 25));
      for (let k = 1; k < n; k++) m.box(-hu + (k * 2 * hu) / n, 0, -12, -0.6, 1.2, w, K.stone, TEX.stone);
      break;
    }
  }
}
