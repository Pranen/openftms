# world-pipeline

Python pipeline that turns swisstopo/OSM data into the Ride world format (graph + tiles + manifest).
Spec: [apps/ride/PLAN.md](../../apps/ride/PLAN.md).

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python build.py m1          # writes ../../apps/ride/public/world/
```

- `worlds.json` – build areas (M1: 2 × 2 tiles Eschen/Schellenberg)
- `ride_pipeline/sources.py` – Geofabrik extracts, swissALTI3D via STAC (cache in `.cache/`, not in git)
- `ride_pipeline/graph.py` – ride network: filter, topology, junctions, profiles, `graph.bin`/`graph.json`
- `ride_pipeline/tiles.py` – L0 tiles: 8 m heights with the road carved in, land cover, buildings
- Output is deterministic (byte-identical for the same input); commit world data only at milestones.

Code copied from `C:/data/ski/pipeline/lib` (geo, sources, mosaic, height encoding) and
`C:/data/li-auto/pipeline/route.py` (bridges/tunnels); a shared library will be extracted after M1.
The Swiss extract is ~550 MB; copying an existing `switzerland-latest.osm.pbf` into `.cache/osm/` saves the download.
