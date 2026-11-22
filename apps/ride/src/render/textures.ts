/**
 * Pixel textures for buildings in one atlas (16 × 16 px per tile, nearest, no mipmaps), drawn in code and
 * light grey so the vertex colour (wall / roof colour) tints them. Patterns after
 * C:/data/li-auto/src/render/textures.ts (facade with shutters, roof tiles, rubble stone).
 *
 * Tile indices (world/atlas.ts) are shared with the world worker, which builds the UVs.
 */
import * as THREE from 'three/webgpu';

import { ATLAS, TEX } from '../world/atlas';

export { ATLAS, TEX };

type Paint = (g: CanvasRenderingContext2D, rnd: () => number) => void;

const rect = (g: CanvasRenderingContext2D, c: string, x: number, y: number, w: number, h: number) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};

const pane = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  rect(g, '#3a4250', x, y, w, h);
  rect(g, '#8a96a8', x + 1, y + 1, 2, 2); // reflection
  rect(g, '#e8e8e8', x, y + h, w, 1); // sill
};

/** One tile each; v = 0 is the bottom of a storey (canvas rows are flipped when sampling). */
const TILES: Record<number, Paint> = {
  [TEX.house]: (g) => {
    rect(g, '#e6e6e6', 0, 15, 16, 1); // storey line
    pane(g, 5, 4, 6, 7);
    rect(g, '#6b4a34', 3, 4, 2, 7); // shutters
    rect(g, '#6b4a34', 11, 4, 2, 7);
  },
  [TEX.apartment]: (g) => {
    rect(g, '#dcdcdc', 0, 14, 16, 2); // floor slab
    pane(g, 3, 4, 10, 7);
    rect(g, '#5a5a5a', 3, 11, 10, 1); // blind box
  },
  [TEX.barn]: (g, rnd) => {
    for (let x = 0; x < 16; x++) {
      const v = 150 + Math.floor(rnd() * 40) - (x % 4 === 0 ? 50 : 0);
      rect(g, `rgb(${v},${v - 8},${v - 18})`, x, 0, 1, 16);
    }
    rect(g, '#2a2420', 6, 5, 4, 3); // hatch
  },
  [TEX.commercial]: (g) => {
    rect(g, '#d0d0d0', 0, 0, 16, 3);
    rect(g, '#3a4658', 0, 4, 16, 7); // ribbon window
    rect(g, '#7a8698', 0, 4, 16, 1);
    rect(g, '#b8b8b8', 7, 4, 1, 7); // mullion
  },
  [TEX.stone]: (g, rnd) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const v = 200 + Math.floor(rnd() * 55);
        rect(g, `rgb(${v},${v},${v - 6})`, x, y, 1, 1);
      }
    for (let y = 3; y < 16; y += 4) {
      rect(g, '#8c8c86', 0, y, 16, 1);
      for (let x = y % 8 === 3 ? 2 : 6; x < 16; x += 7) rect(g, '#8c8c86', x, y - 3, 1, 3);
    }
  },
  [TEX.shed]: (g) => {
    rect(g, '#c8c8c8', 2, 4, 12, 12); // garage door
    for (let y = 6; y < 16; y += 2) rect(g, '#a0a0a0', 2, y, 12, 1);
  },
  [TEX.plain]: (g, rnd) => {
    for (let k = 0; k < 6; k++) rect(g, '#f0f0f0', Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1, 1);
  },
  [TEX.shop]: (g) => {
    rect(g, '#2e3a4c', 1, 3, 14, 13); // shop window
    rect(g, '#7a8698', 2, 4, 4, 2);
    rect(g, '#c0c0c0', 8, 3, 1, 13);
  },
  [TEX.roofTiles]: (g) => {
    for (let y = 0; y < 16; y += 4) {
      rect(g, '#b0b0b0', 0, y, 16, 1);
      for (let x = (y / 4) % 2 ? 2 : 6; x < 16; x += 8) rect(g, '#c4c4c4', x, y, 1, 4);
    }
  },
  [TEX.roofMetal]: (g) => {
    for (let x = 0; x < 16; x += 4) rect(g, '#c8c8c8', x, 0, 1, 16);
  },
  [TEX.roofFlat]: (g, rnd) => {
    for (let k = 0; k < 40; k++) rect(g, rnd() < 0.5 ? '#d8d8d8' : '#f8f8f8', Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1, 1);
  },
  [TEX.glass]: (g) => {
    rect(g, '#b8d0d8', 0, 0, 16, 16);
    rect(g, '#f0f0f0', 0, 0, 16, 1);
    rect(g, '#f0f0f0', 0, 0, 1, 16);
    rect(g, '#f0f0f0', 8, 0, 1, 16);
  },
  [TEX.roofSlate]: (g) => {
    for (let y = 0; y < 16; y += 3) {
      rect(g, '#a8a8a8', 0, y, 16, 1);
      for (let x = (y / 3) % 2 ? 1 : 4; x < 16; x += 6) rect(g, '#b4b4b4', x, y, 1, 3);
    }
  },
};

/** The building atlas as a texture (light patterns, tinted by the vertex colours). */
export function buildingAtlas(): THREE.Texture {
  const { cols, rows, px } = ATLAS;
  const c = document.createElement('canvas');
  c.width = cols * px;
  c.height = rows * px;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  for (const [k, paint] of Object.entries(TILES)) {
    const i = Number(k);
    let seed = 7 + i * 31;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.save();
    g.translate((i % cols) * px, Math.floor(i / cols) * px);
    g.beginPath();
    g.rect(0, 0, px, px);
    g.clip();
    paint(g, rnd);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  return t;
}
