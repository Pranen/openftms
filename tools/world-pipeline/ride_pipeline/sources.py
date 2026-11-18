"""Download and cache source data.

Copied (trimmed) from C:/data/ski/pipeline/lib/sources.py:
- OSM: Geofabrik country extracts (.osm.pbf), no Overpass API; clipped once per box.
- Elevation: swissALTI3D 2 m GeoTIFF tiles via the swisstopo STAC API (covers CH and FL).
Austria (BEV laser scan) comes in with the region build (M2); see ski's bev_raster.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .geo import lv95_to_wgs84

CACHE = Path(__file__).resolve().parent.parent / ".cache"
USER_AGENT = "ride-world-pipeline/0.1 (offline asset build)"
OSM_REGIONS = {
    "liechtenstein": "https://download.geofabrik.de/europe/liechtenstein-latest.osm.pbf",
    "switzerland": "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf",
    "austria": "https://download.geofabrik.de/europe/austria-latest.osm.pbf",
}
STAC_ITEMS = "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items"


def _get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(_get(url))
    tmp.replace(dest)
    print(f"  downloaded {dest.name}")
    return dest


def _stream(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r, dest.open("wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def osm_extract(region: str) -> Path:
    """Geofabrik extract of a region, refreshed when older than 30 days."""
    if region not in OSM_REGIONS:
        raise ValueError(f"unknown OSM region {region!r}; known: {list(OSM_REGIONS)}")
    dest = CACHE / "osm" / f"{region}-latest.osm.pbf"
    if dest.exists() and time.time() - dest.stat().st_mtime < 30 * 86400:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".pbf.part")
    print(f"  downloading {dest.name} ...")
    _stream(OSM_REGIONS[region], tmp)
    tmp.replace(dest)
    return dest


def osm_clip(src: Path, key: str, e_min: float, n_min: float, e_max: float, n_max: float,
             margin_m: float = 500) -> Path:
    """The objects of `src` touching the LV95 box (plus a margin), with everything they
    reference, as a small file. Rebuilt when the source is newer."""
    import osmium

    dest = CACHE / "osm" / f"{key}.osm.pbf"
    if dest.exists() and dest.stat().st_mtime > src.stat().st_mtime:
        return dest
    corners = [lv95_to_wgs84(e, n) for e in (e_min - margin_m, e_max + margin_m)
               for n in (n_min - margin_m, n_max + margin_m)]
    lat0, lat1 = min(c[0] for c in corners), max(c[0] for c in corners)
    lon0, lon1 = min(c[1] for c in corners), max(c[1] for c in corners)

    def inside(loc) -> bool:
        return loc.valid() and lat0 < loc.lat < lat1 and lon0 < loc.lon < lon1

    print(f"  clipping {src.name} -> {dest.name} ...")
    ways: set[int] = set()
    tmp = dest.with_name(f"{key}.part.osm.pbf")  # osmium picks the format from the suffix
    with osmium.BackReferenceWriter(str(tmp), ref_src=str(src), overwrite=True) as out:
        for obj in osmium.FileProcessor(str(src)).with_locations().with_filter(osmium.filter.EmptyTagFilter()):
            if obj.is_node():
                if inside(obj.location):
                    out.add(obj)
            elif obj.is_way():
                if any(inside(n.location) for n in obj.nodes):
                    ways.add(obj.id)
                    out.add(obj)
            elif obj.is_relation():
                if any(m.type == "w" and m.ref in ways for m in obj.members):
                    out.add(obj)
    tmp.replace(dest)
    return dest


def dem_tiles(e_min: float, n_min: float, e_max: float, n_max: float) -> list[Path]:
    """All 1 km swissALTI3D 2 m tiles touching the LV95 box (newest year per tile)."""
    lat0, lon0 = lv95_to_wgs84(e_min, n_min)
    lat1, lon1 = lv95_to_wgs84(e_max, n_max)
    bbox = f"{min(lon0, lon1)},{min(lat0, lat1)},{max(lon0, lon1)},{max(lat0, lat1)}"
    url = f"{STAC_ITEMS}?{urllib.parse.urlencode({'bbox': bbox, 'limit': 100})}"

    newest: dict[str, tuple[int, str]] = {}
    while url:
        page = json.loads(_get(url, timeout=60))
        for feat in page.get("features", []):
            _, year, tile = feat["id"].split("_")  # swissalti3d_<year>_<E>-<N>
            href = next((a["href"] for k, a in feat["assets"].items() if k.endswith("_2_2056_5728.tif")), None)
            if href and int(year) >= newest.get(tile, (0, ""))[0]:
                newest[tile] = (int(year), href)
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)

    paths = []
    for tile, (_, href) in sorted(newest.items()):
        e, n = (int(v) for v in tile.split("-"))
        if e * 1000 >= e_max or (e + 1) * 1000 <= e_min or n * 1000 >= n_max or (n + 1) * 1000 <= n_min:
            continue
        paths.append(download(href, CACHE / "dem" / Path(urllib.parse.urlparse(href).path).name))
    if not paths:
        raise RuntimeError("no swissALTI3D tiles found for the requested area")
    return paths
