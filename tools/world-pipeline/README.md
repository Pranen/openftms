# world-pipeline

Python pipeline that turns swisstopo/OSM data into the Ride world format (graph + tiles + manifest).
Spec: [apps/ride/PLAN.md](../../apps/ride/PLAN.md).

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python build.py region      # whole region (M2 + M3), writes ../../apps/ride/public/world/
.venv/Scripts/python build.py m1          # small M1 area (Eschen/Schellenberg/Planken)
```

- `worlds.json` – build areas (`region`: Feldkirch – Landquart – Walenstadt – Oberriet; `m1`: Eschen/Planken)
- `ride_pipeline/sources.py` – Geofabrik extracts, swissALTI3D via STAC (cache in `.cache/`, not in git)
- `ride_pipeline/graph.py` – ride network: filter, topology, junctions, profiles, `graph.bin`/`graph.json`
- `ride_pipeline/dem.py` – 2 m elevation model in lazily loaded 2 km blocks (swissALTI3D, BEV in Austria, Copernicus)
- `ride_pipeline/tiles.py` – L0 tiles: 8 m heights with the road carved in, land cover, buildings (BLDG), L1 boxes (BLDQ)
- `ride_pipeline/sb3d.py` – swissBUILDINGS3D: 3.0 for Switzerland (multipatch GDB via `gdal_raw.py`), 2.0 for Liechtenstein
- `ride_pipeline/scenery.py` – motorways, railways, power lines, waterways (LINE)
- `ride_pipeline/landmarks.py` – landmarks by OSM name (LMRK)
- Output is deterministic (byte-identical for the same input); commit world data only at milestones.

Code copied from `C:/data/ski/pipeline/lib` (geo, sources, mosaic, height encoding) and
`C:/data/li-auto/pipeline/route.py` (bridges/tunnels); a shared library will be extracted after M1.
The Swiss extract is ~550 MB and the Austrian ~780 MB; copying existing `*-latest.osm.pbf` files into `.cache/osm/` saves
the downloads. The region build fetches ~1.5 GB of swissALTI3D, ~1.5 GB of swissBUILDINGS3D and BEV windows over HTTP
(first run about an hour; later runs use the cache).
