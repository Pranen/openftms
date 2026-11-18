"""Build the Ride world (graph + L0 tiles + manifest) for one entry of worlds.json.

    .venv/Scripts/python build.py m1 [--out ../../apps/ride/public/world]

Deterministic: the same inputs give byte-identical output (sorted, no timestamps).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from ride_pipeline import graph as G
from ride_pipeline import tiles as T
from ride_pipeline.dem import Dem
from ride_pipeline.geo import E0, N0
from ride_pipeline.osm_read import read
from ride_pipeline.sources import dem_tiles, osm_clip, osm_extract

HERE = Path(__file__).resolve().parent
ATTRIBUTION = [
    "Höhen: © swisstopo (swissALTI3D, OGD)",
    "Strassen, Bodenbedeckung, Gebäude: © OpenStreetMap-Mitwirkende (ODbL)",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("world")
    ap.add_argument("--out", default=str(HERE.parent.parent / "apps" / "ride" / "public" / "world"))
    args = ap.parse_args()
    cfg = json.loads((HERE / "worlds.json").read_text(encoding="utf-8"))[args.world]
    e_min, n_min, e_max, n_max = cfg["box"]
    out = Path(args.out)
    (out / "L0").mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    print("sources")
    osm_paths = [osm_clip(osm_extract(r), f"{args.world}-{r}", e_min, n_min, e_max, n_max) for r in cfg["osm"]]
    margin = 60
    dem = Dem(dem_tiles(e_min - margin, n_min - margin, e_max + margin, n_max + margin),
              e_min - margin, n_min - margin, e_max + margin, n_max + margin)
    osm = read(osm_paths)
    print(f"  {len(osm.ways)} highway ways, {len(osm.areas)} areas, {len(osm.routes)} route ways")

    print("graph")
    g = G.build(osm, (e_min, n_min, e_max, n_max), dem)
    print("  " + G.stats(g))
    graph_files = G.write(g, out)

    print("tiles")
    roads = T.road_samples(g, G.ROAD_HALF_WIDTH)
    smooth = dem.smoothed(T.CELL)
    level0: dict[str, str] = {}
    for iy in range(int(n_min // T.TILE), int(n_max // T.TILE)):
        for ix in range(int(e_min // T.TILE), int(e_max // T.TILE)):
            te, tn = ix * T.TILE, iy * T.TILE
            h = T.terrain_heights(dem, smooth, te, tn, roads)
            code = T.landcover(osm.areas, te, tn)
            bldg = T.buildings(osm.areas, dem, te, tn)
            name = T.write_tile(out / "L0", ix, iy, [(b"HGHT", T.encode_heights(h)), (b"CODE", code.tobytes()),
                                                      (b"BLDG", bldg)])
            level0[f"{ix}_{iy}"] = name
            print(f"  L0/{name}  h {h.min():.0f}-{h.max():.0f} m, {int.from_bytes(bldg[:4], 'little')} buildings")

    manifest = {
        "format": 1,
        "origin": [E0, N0],
        "frame": "x = E - E0, y = height, z = N0 - N",
        "box": cfg["box"],
        "spawn": cfg["spawn"],
        "tile": {"size": T.TILE, "n": T.N, "cell": T.CELL},
        "levels": {"0": dict(sorted(level0.items()))},
        "graph": graph_files,
        "attribution": ATTRIBUTION,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
                                      encoding="utf-8")
    print(f"done in {time.time() - t0:.0f} s -> {out}")


if __name__ == "__main__":
    main()
