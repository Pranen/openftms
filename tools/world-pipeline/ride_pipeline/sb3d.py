"""Buildings from swissBUILDINGS3D (swisstopo): footprint, eave and ridge height, roof form, kind.

- Switzerland: version 3.0 (File Geodatabase per 1:25'000 sheet sixteenth, layer `Building_solid`, multipatch
  stored as TIN – read over ctypes, see gdal_raw.py).
- Liechtenstein: version 2.0 (DXF per sheet quarter); 3.0 holds Liechtenstein only in part. Split by the national
  border from OSM: inside Liechtenstein 2.0 only, outside 3.0 only.

The analysis (roof faces → footprint, heights, roof form) is copied from C:/data/li-auto/pipeline/sb3d.py.
Evaluated sheets are cached as .pkl in .cache/sb3d/.
"""

from __future__ import annotations

import json
import pickle
import struct
import urllib.parse
import zipfile
from pathlib import Path

import numpy as np
import shapely

from . import sources
from .geo import lv95_to_wgs84

STAC3 = "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissbuildings3d_3_0/items"
STAC2 = "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissbuildings3d_2/items"
DIR = sources.CACHE / "sb3d"
FORMAT = 2  # content of the .pkl files; raise when the analysis changes
# Liechtenstein (LV95) with a margin: 2.0 sheets are fetched only here
LI_BOX = (2_753_000, 1_211_000, 2_766_000, 1_239_000)

# OBJEKTART / DXF layer -> kind (OSM-like, for styles and colours); others are skipped
KINDS = {
    "Gebaeude Einzelhaus": "yes",
    "Im Bau": "yes",
    "Offenes Gebaeude": "roof",
    "Flugdach": "roof",
    "Sakrales Gebaeude": "church",
    "Kapelle": "chapel",
    "Sakraler Turm": "church",
    "Treibhaus": "greenhouse",
    "Lagertank": "storage_tank",
}


# --- geometry --------------------------------------------------------------------------

def _faces_from_wkb(b: bytes) -> list[np.ndarray]:
    """Faces (n, 3) of an ISO WKB multi-surface (TIN, PolyhedralSurface, MultiPolygon, all with Z)."""
    out: list[np.ndarray] = []

    def geom(o: int) -> int:
        bo = "<" if b[o] == 1 else ">"
        t = (struct.unpack_from(bo + "I", b, o + 1)[0] & 0x0FFFFFFF) % 1000  # ISO (1003) and EWKB (0x80000003) Z flags
        o += 5
        if t in (3, 17):  # polygon / triangle
            nr = struct.unpack_from(bo + "I", b, o)[0]
            o += 4
            for r in range(nr):
                n = struct.unpack_from(bo + "I", b, o)[0]
                o += 4
                pts = np.frombuffer(b, dtype=bo + "f8", count=n * 3, offset=o).reshape(n, 3)
                if r == 0:
                    out.append(pts)
                o += n * 24
            return o
        if t in (6, 7, 15, 16):  # multipolygon, collection, polyhedral surface, TIN
            n = struct.unpack_from(bo + "I", b, o)[0]
            o += 4
            for _ in range(n):
                o = geom(o)
            return o
        raise ValueError(f"unexpected WKB type {t}")

    geom(0)
    return out


def analyse(faces: list[np.ndarray]) -> dict | None:
    """Footprint (roof area seen from above, LV95), ground, eave and ridge above ground, roof form.
    Vectorised over faces (3.0 buildings are TINs with hundreds of triangles)."""
    faces = [v for v in faces if len(v) >= 4]
    if not faces:
        return None
    zmin = min(float(v[:, 2].min()) for v in faces)
    zmax = max(float(v[:, 2].max()) for v in faces)
    # Newell normals of all faces at once: per-edge terms summed per face (reduceat over the stacked rings)
    lens = np.array([len(v) for v in faces])
    V = np.vstack(faces)
    a, c = V[:-1], V[1:]
    terms = np.stack([(a[:, 1] - c[:, 1]) * (a[:, 2] + c[:, 2]),
                      (a[:, 2] - c[:, 2]) * (a[:, 0] + c[:, 0]),
                      (a[:, 0] - c[:, 0]) * (a[:, 1] + c[:, 1])], 1)
    starts = np.r_[0, np.cumsum(lens)[:-1]]
    # the edge from the last vertex of a face to the first of the next is not part of either face
    terms[np.cumsum(lens)[:-1] - 1] = 0
    terms = np.vstack([terms, np.zeros((1, 3))])
    n = np.add.reduceat(terms, starts, axis=0)
    area = np.linalg.norm(n, axis=1) / 2
    ok = area > 1e-3
    n = n[ok] / (2 * area[ok, None])
    area = area[ok]
    top = np.array([float(v[:, 2].max()) for v, k in zip(faces, ok) if k])
    roof = (np.abs(n[:, 2]) >= 0.15) & (top - zmin >= 0.5)
    if not roof.any():
        return None
    rn, ra = n[roof], area[roof]
    rf = [v for v, k in zip([v for v, k in zip(faces, ok) if k], roof) if k]
    total = float(ra.sum())
    flat = np.abs(rn[:, 2]) > 0.97
    if ra[flat].sum() > 0.8 * total:
        form = "flat"
    else:
        # roof faces by direction (45° sectors, weighted by area): one = shed, two = gabled, more = hipped
        sec = np.round(np.degrees(np.arctan2(rn[:, 1], rn[:, 0])) / 45).astype(int) % 8
        w = np.bincount(sec[~flat], weights=ra[~flat], minlength=8)
        sectors = int((w > 0.08 * total).sum())
        form = "skillion" if sectors <= 1 else "gabled" if sectors == 2 else "hipped"
    polys = shapely.polygons([v[:, :2] for v in rf])
    polys = shapely.make_valid(polys)
    foot = shapely.union_all(polys, grid_size=0.05).buffer(0)
    if foot.is_empty:
        return None
    if foot.geom_type != "Polygon":
        parts = [g for g in getattr(foot, "geoms", []) if g.geom_type == "Polygon"]
        if not parts:
            return None
        foot = max(parts, key=lambda p: p.area)
    foot = shapely.Polygon(foot.exterior)  # courtyards are drawn as roof
    eave = min(float(v[:, 2].min()) for v in rf)
    return {"foot": foot, "z": zmin, "eave": eave - zmin, "ridge": zmax - zmin, "roof": form, "eave_abs": eave,
            "ridge_abs": zmax}


# --- sheets ----------------------------------------------------------------------------

def _items(stac: str, box: tuple[float, float, float, float]) -> list[dict]:
    e0, n0, e1, n1 = box
    corners = [lv95_to_wgs84(e, n) for e in (e0, e1) for n in (n0, n1)]
    lats = [float(c[0]) for c in corners]
    lons = [float(c[1]) for c in corners]
    url = f"{stac}?{urllib.parse.urlencode({'bbox': f'{min(lons)},{min(lats)},{max(lons)},{max(lats)}', 'limit': 100})}"
    feats = []
    while url:
        page = json.loads(sources._get(url, timeout=60))
        feats += page["features"]
        url = next((l["href"] for l in page.get("links", []) if l["rel"] == "next"), None)
    return feats


def _latest(feats: list[dict], suffix: str) -> dict[str, tuple[str, str]]:
    """Sheet -> (item id, asset href) of the newest item with an asset ending in `suffix`."""
    import re

    latest: dict[str, tuple[str, str]] = {}
    for f in feats:
        sheet = f["id"].rsplit("_", 1)[1]
        if not re.fullmatch(r"\d{4}-\d{2}", sheet):
            continue  # whole-country datasets (several GB) come with the sheets
        href = next((a["href"] for k, a in f["assets"].items() if k.endswith(suffix)), None)
        if href and (sheet not in latest or f["id"] > latest[sheet][0]):
            latest[sheet] = (f["id"], href)
    return latest


def _cached(key: str, item: str, make) -> list[dict]:
    out = DIR / f"{key}.pkl"
    if out.exists():
        with open(out, "rb") as f:
            data = pickle.load(f)
        if data["format"] == FORMAT and data["id"] == item:
            return data["buildings"]
    buildings = make()
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        pickle.dump({"format": FORMAT, "id": item, "buildings": buildings}, f)
    return buildings


def _sheet3(item: str, href: str) -> list[dict]:
    from .gdal_raw import features

    sheet = item.rsplit("_", 1)[1]

    def make():
        z = sources.download(href, DIR / Path(urllib.parse.urlparse(href).path).name)
        dest = DIR / f"v3_{sheet}"
        with zipfile.ZipFile(z) as zf:
            gdb = next(n.split("/")[0] for n in zf.namelist() if ".gdb/" in n)
            if not (dest / gdb).exists():
                zf.extractall(dest)
        print(f"  swissBUILDINGS3D 3.0: sheet {sheet} ...")
        out = []
        # some sheets hold only roofs (no solids): then the heights are absolute and the ground comes from the DEM
        try:
            feats = list(features(dest / gdb, "Building_solid"))
            roof_only = False
        except KeyError:
            feats = list(features(dest / gdb, "Roof_solid"))
            roof_only = True
        for wkb, attrs in feats:
            kind = KINDS.get(attrs.get("OBJEKTART", ""), "yes" if roof_only else None)
            if wkb is None or kind is None:
                continue
            a = analyse(_faces_from_wkb(wkb))
            if a:
                a["kind"] = kind
                a["roof_only"] = roof_only
                out.append(a)
        return out

    return _cached(f"v3_{sheet}", item, make)


def _sheet2(item: str, href: str) -> list[dict]:
    import pyogrio.raw

    sheet = item.rsplit("_", 1)[1]

    def make():
        z = sources.download(href, DIR / Path(urllib.parse.urlparse(href).path).name)
        with zipfile.ZipFile(z) as zf:
            name = next(n for n in zf.namelist() if n.lower().endswith(".dxf"))
            dxf = DIR / f"v2_{sheet}" / name
            if not dxf.exists():
                zf.extract(name, DIR / f"v2_{sheet}")
        print(f"  swissBUILDINGS3D 2.0: sheet {sheet} ...")
        meta, _, geoms, fields = pyogrio.raw.read(dxf)
        layers = fields[list(meta["fields"]).index("Layer")]
        out = []
        for g, layer in zip(geoms, layers):
            kind = KINDS.get(layer)
            if g is None or kind is None:
                continue
            a = analyse(_faces_from_wkb(bytes(g)))
            if a:
                a["kind"] = kind
                out.append(a)
        return out

    return _cached(f"v2_{sheet}", item, make)


def liechtenstein() -> shapely.Geometry:
    """National border of Liechtenstein (LV95) from the OSM extract, cached."""
    import osmium

    from .geo import wgs84_to_lv95

    cache = DIR / "li_border.wkb"
    if cache.exists():
        return shapely.from_wkb(cache.read_bytes())
    polys = []
    src = sources.osm_extract("liechtenstein")
    for o in osmium.FileProcessor(str(src)).with_locations().with_areas().with_filter(osmium.filter.KeyFilter("boundary")):
        t = o.tags
        if o.is_area() and t.get("boundary") == "administrative" and t.get("admin_level") == "2"                 and "Liechtenstein" in t.get("name", "") + t.get("name:de", ""):
            for outer in o.outer_rings():
                ll = np.array([(n.lat, n.lon) for n in outer])
                e, n = wgs84_to_lv95(ll[:, 0], ll[:, 1])
                polys.append(shapely.Polygon(np.c_[e, n]))
    if not polys:
        raise RuntimeError("no border of Liechtenstein in the OSM extract")
    border = shapely.union_all(polys)
    DIR.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(shapely.to_wkb(border))
    return border


def buildings(box: tuple[float, float, float, float]) -> list[dict]:
    """All buildings (dicts from `analyse` plus `kind`) whose footprint touches the LV95 box: 3.0 everywhere,
    2.0 around Liechtenstein where no 3.0 building overlaps."""
    v3 = _latest(_items(STAC3, box), ".gdb.zip")
    e0, n0, e1, n1 = box
    li_box = (max(e0, LI_BOX[0]), max(n0, LI_BOX[1]), min(e1, LI_BOX[2]), min(n1, LI_BOX[3]))
    v2 = _latest(_items(STAC2, li_box), ".dxf.zip") if li_box[0] < li_box[2] and li_box[1] < li_box[3] else {}
    # downloads in parallel (sheets not evaluated yet), evaluation one by one (memory)
    jobs = []
    for prefix, items in (("v3", v3), ("v2", v2)):
        for item, href in items.values():
            if not (DIR / f"{prefix}_{item.rsplit('_', 1)[1]}.pkl").exists():
                jobs.append((href, DIR / Path(urllib.parse.urlparse(href).path).name))
    sources.parallel_download(jobs, workers=6)
    target = shapely.box(*box)
    a3 = [b for item, href in sorted(v3.values()) for b in _sheet3(item, href)]
    a3 = [b for b in a3 if target.intersects(b["foot"])]
    a2 = [b for item, href in sorted(v2.values()) for b in _sheet2(item, href)]
    a2 = [b for b in a2 if target.intersects(b["foot"])]
    # Liechtenstein from 2.0, Switzerland from 3.0 (3.0 holds parts of Liechtenstein, but incomplete)
    li = liechtenstein()
    shapely.prepare(li)
    a3 = [b for b in a3 if not li.contains(b["foot"].centroid)]
    a2 = [b for b in a2 if li.contains(b["foot"].centroid)]
    print(f"  swissBUILDINGS3D: {len(a3)} buildings from 3.0, {len(a2)} from 2.0")
    return a3 + a2
