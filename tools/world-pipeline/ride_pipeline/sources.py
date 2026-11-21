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
    for attempt in range(4):
        try:
            tmp.write_bytes(_get(url))
            break
        except OSError:
            if attempt == 3:
                raise
            time.sleep(2 + 4 * attempt)
    tmp.replace(dest)
    return dest


def parallel_download(jobs: list[tuple[str, Path]], workers: int = 8) -> list[Path]:
    """Download (url, dest) pairs with a thread pool; already cached files are skipped. Returns the dests in order."""
    import concurrent.futures as cf

    todo = [(u, d) for u, d in jobs if not d.exists()]
    if todo:
        print(f"  downloading {len(todo)} files ...")
        with cf.ThreadPoolExecutor(workers) as pool:
            for f in [pool.submit(download, u, d) for u, d in todo]:
                f.result()
    return [d for _, d in jobs]


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

    # the box is part of the file name: a changed box must not reuse an old clip
    key = f"{key}-{int(e_min)}-{int(n_min)}-{int(e_max)}-{int(n_max)}-{int(margin_m)}"
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
    # two passes without a location index (Austria's would need > 7 GB): node ids inside the box first,
    # then the ways using them; the writer adds every node a kept way or relation references
    nodes: set[int] = set()
    for obj in osmium.FileProcessor(str(src), osmium.osm.NODE):
        if inside(obj.location):
            nodes.add(obj.id)
    ways: set[int] = set()
    tmp = dest.with_name(f"{key}.part.osm.pbf")  # osmium picks the format from the suffix
    with osmium.BackReferenceWriter(str(tmp), ref_src=str(src), overwrite=True) as out:
        for obj in osmium.FileProcessor(str(src)).with_filter(osmium.filter.EmptyTagFilter()):
            if obj.is_node():
                if obj.id in nodes:
                    out.add(obj)
            elif obj.is_way():
                if any(n.ref in nodes for n in obj.nodes):
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

    jobs = []
    for tile, (_, href) in sorted(newest.items()):
        e, n = (int(v) for v in tile.split("-"))
        if e * 1000 >= e_max or (e + 1) * 1000 <= e_min or n * 1000 >= n_max or (n + 1) * 1000 <= n_min:
            continue
        jobs.append((href, CACHE / "dem" / Path(urllib.parse.urlparse(href).path).name))
    paths = parallel_download(jobs)
    if not paths:
        raise RuntimeError("no swissALTI3D tiles found for the requested area")
    return paths


# Copied from C:/data/ski/pipeline/lib/sources.py (BEV window, mosaic, LV95 warp).
# --- Austria: BEV airborne laser scan rasters (1 m, EPSG:3035, one Cloud Optimized
# GeoTIFF per 50 km tile, ~11 GB each). Only the needed window is read over HTTP.
BEV_URL = "https://data.bev.gv.at/download/ALS/{kind}/{date}/ALS_{kind}_CRS3035RES50000mN{n}E{e}.tif"
BEV_DATE = "20240915"
BEV_TILE = 50000


def _bev_window(kind: str, e: int, n: int, x0: float, y0: float, x1: float, y1: float) -> Path:
    """Window (EPSG:3035 metres) of one BEV tile as a local GeoTIFF, read in 1 km strips
    in parallel (each ~7 s over HTTP range requests)."""
    import concurrent.futures as cf

    import numpy as np
    import rasterio
    from rasterio.windows import Window, from_bounds

    dest = CACHE / "bev" / f"{kind}_{BEV_DATE}_{int(x0)}_{int(y0)}_{int(x1)}_{int(y1)}.tif"
    if dest.exists():
        return dest
    url = "/vsicurl/" + BEV_URL.format(kind=kind, date=BEV_DATE, n=n, e=e)
    env = dict(GDAL_HTTP_USERAGENT=USER_AGENT, GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
               CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2")
    with rasterio.Env(**env), rasterio.open(url) as src:
        win = from_bounds(x0, y0, x1, y1, src.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, src.width, src.height))
        transform = src.window_transform(win)
        profile = dict(driver="GTiff", dtype="float32", count=1, crs=src.crs, transform=transform,
                       width=int(win.width), height=int(win.height), nodata=src.nodata,
                       compress="deflate", predictor=3, tiled=True)
    rows = [(r, min(1000, int(win.height) - r)) for r in range(0, int(win.height), 1000)]
    out = np.empty((int(win.height), int(win.width)), np.float32)

    def read(r: int, h: int):
        with rasterio.Env(**env), rasterio.open(url) as src:
            out[r:r + h] = src.read(1, window=Window(win.col_off, win.row_off + r, win.width, h))

    print(f"  BEV {kind}: reading {win.width:.0f} x {win.height:.0f} m from {url.rsplit('/', 1)[1]} ...")
    t = time.time()
    with cf.ThreadPoolExecutor(8) as pool:
        for f in [pool.submit(read, r, h) for r, h in rows]:
            f.result()
    print(f"  BEV {kind}: {time.time() - t:.0f} s")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.stem + ".part.tif")
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(out, 1)
    tmp.replace(dest)
    return dest


def _mosaic_3035(paths: list[Path]):
    """The 1 m windows (same pixel grid, adjacent 50 km tiles) as one array, its
    transform and nodata (cells no window covers are nodata)."""
    import numpy as np
    import rasterio
    from rasterio.transform import Affine

    srcs = [rasterio.open(p) for p in paths]
    try:
        res = srcs[0].transform.a
        left = min(s.bounds.left for s in srcs)
        top = max(s.bounds.top for s in srcs)
        right = max(s.bounds.right for s in srcs)
        bottom = min(s.bounds.bottom for s in srcs)
        nodata = srcs[0].nodata if srcs[0].nodata is not None else -9999.0
        out = np.full((int(round((top - bottom) / res)), int(round((right - left) / res))), nodata, np.float32)
        for s in srcs:
            r0 = int(round((top - s.bounds.top) / res))
            c0 = int(round((s.bounds.left - left) / res))
            a = s.read(1)
            dst = out[r0:r0 + a.shape[0], c0:c0 + a.shape[1]]
            ok = a != nodata
            dst[ok] = a[ok]
        return out, Affine(res, 0, left, 0, -res, top), nodata
    finally:
        for s in srcs:
            s.close()


def _warp_to_lv95(paths: list[Path], e_west: float, n_north: float, cell: float, rows: int, cols: int):
    """1 m EPSG:3035 rasters (mosaicked) averaged onto an LV95 grid (cell edges at e_west / n_north).

    Not rasterio's reproject: outside Switzerland GDAL's warper picks a "ballpark"
    CH1903+ <-> ETRS89 operation without the datum shift, which put Sölden 184 m off
    (Damüls, near the border, was fine). Point transforms use the proper Helmert shift,
    so they map a coarse control grid, interpolated in between (the mapping is smooth)."""
    import numpy as np
    import rasterio
    from rasterio.warp import transform as warp_points
    from scipy import ndimage

    step = 64  # control points every 64 cells
    jc = np.arange(0, rows + step, step, dtype=float)
    ic = np.arange(0, cols + step, step, dtype=float)
    J, I = np.meshgrid(jc, ic, indexing="ij")
    xs, ys = warp_points("EPSG:2056", "EPSG:3035", (e_west + (I + 0.5) * cell).ravel(),
                         (n_north - (J + 0.5) * cell).ravel())
    X = np.asarray(xs).reshape(J.shape)
    Y = np.asarray(ys).reshape(J.shape)
    a, tf, nodata = _mosaic_3035(paths)
    inv = ~tf
    valid = np.ones_like(a, dtype=np.float32) if nodata is None else (a != nodata).astype(np.float32)
    a = np.where(valid > 0, a, 0)
    # source pixel coordinates of every cell centre, by bilinear interpolation of the control grid
    jj, ii = np.mgrid[0:rows, 0:cols].astype(np.float32)
    jj /= step
    ii /= step
    cx = ndimage.map_coordinates(X, [jj, ii], order=1)
    cy = ndimage.map_coordinates(Y, [jj, ii], order=1)
    del jj, ii
    col = inv.a * cx + inv.b * cy + inv.c - 0.5  # pixel-centre index space
    row = inv.d * cx + inv.e * cy + inv.f - 0.5
    del cx, cy
    # average of the source pixels within the cell: a box filter of the cell size, then bilinear
    k = max(1, int(round(cell / abs(tf.a))))
    if k > 1:
        a = ndimage.uniform_filter(a * valid, k, mode="nearest")
        valid = ndimage.uniform_filter(valid, k, mode="nearest")
        a = np.where(valid > 0.5, a / np.maximum(valid, 1e-6), 0)
    v = ndimage.map_coordinates(valid, [row, col], order=1, cval=0)
    h = ndimage.map_coordinates(a, [row, col], order=1, cval=0)
    return np.where(v > 0.5, h, -9999).astype(np.float32)


def bev_raster(kind: str, e_min: float, n_min: float, e_max: float, n_max: float, cell: float) -> Path:
    """BEV ALS raster (kind "DTM" ground or "DSM" surface incl. houses and trees) on the
    LV95 grid of the box (cell size `cell`, same grid as terrain.mosaic), as a GeoTIFF.
    The 1 m source is averaged into the cells."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import transform_bounds

    dest = CACHE / "bev" / f"{kind}_lv95_{int(e_min)}_{int(n_min)}_{int(e_max)}_{int(n_max)}_{cell:g}.tif"
    if dest.exists():
        return dest
    # box in EPSG:3035 with a margin, split by 50 km tile
    x0, y0, x1, y1 = transform_bounds("EPSG:2056", "EPSG:3035", e_min, n_min, e_max, n_max, densify_pts=21)
    x0, y0, x1, y1 = x0 - 50, y0 - 50, x1 + 50, y1 + 50
    windows = []
    for te in range(int(x0 // BEV_TILE), int(x1 // BEV_TILE) + 1):
        for tn in range(int(y0 // BEV_TILE), int(y1 // BEV_TILE) + 1):
            e, n = te * BEV_TILE, tn * BEV_TILE
            windows.append(_bev_window(kind, e, n, max(x0, e), max(y0, n), min(x1, e + BEV_TILE), min(y1, n + BEV_TILE)))
    cols = int(round((e_max - e_min) / cell))
    rows = int(round((n_max - n_min) / cell))
    transform = from_origin(e_min, n_max, cell, cell)
    import numpy as np

    # one mosaic of the windows first: warping them one by one leaves a gap along the seam
    out = _warp_to_lv95(windows, e_min, n_max, cell, rows, cols)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(dest, "w", driver="GTiff", dtype="float32", count=1, crs="EPSG:2056", transform=transform,
                       width=cols, height=rows, nodata=-9999, compress="deflate", predictor=3, tiled=True) as dst:
        dst.write(out, 1)
    return dest
