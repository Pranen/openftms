/** Building texture atlas layout, shared by render/textures.ts (drawing) and the world worker (UVs). */
export const ATLAS = { cols: 8, rows: 2, px: 16 } as const;

export const TEX = {
  house: 0,
  apartment: 1,
  barn: 2,
  commercial: 3,
  stone: 4,
  shed: 5,
  plain: 6,
  shop: 7,
  roofTiles: 8,
  roofMetal: 9,
  roofFlat: 10,
  glass: 11,
  roofSlate: 12,
} as const;

/** Building styles (high nibble of the roof byte in BLDG, tools/world-pipeline tiles.py). */
export const STYLE = { house: 0, apartment: 1, farm: 2, commercial: 3, church: 4, small: 5, open: 6, greenhouse: 7 } as const;
