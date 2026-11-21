"""L0 terrain tiles (2 km, 8 m grid, 257 x 257 nodes) with the road carved in, land cover
and parametric buildings, plus manifest.json (spec: apps/ride/PLAN.md, "Kachelformat").

Height encoding (second-order delta of uint16) as in C:/data/ski/pipeline/lib/tiles.py.
"""

from __future__ import annotations

import hashlib
import math
import struct

import numpy as np
from rasterio import features
from rasterio.transform import Affine
from scipy.spatial import cKDTree

from .dem import Dem
from .geo import E0, N0, cumulative, sample_at
from .graph import ATTR_ONEWAY as G_ATTR_ONEWAY, ONEWAY_WIDTH as G_ONEWAY_WIDTH
from .osm_read import Area

TILE = 2000.0
N = 257
CELL = TILE / (N - 1)  # 8 m
H_SCALE = 0.05
H_OFFSET = 0.0
VERSION = 1

# land cover codes (CODE section), shared with apps/ride/src/world/tile.ts
MEADOW, FOREST, ORCHARD, SETTLEMENT, ROCK, WATER, GLACIER, FARMLAND = range(8)

# carve: full road height up to half width + CARVE_CORE, blended to terrain until + CARVE_FALLOFF.
# The core covers one grid cell: a point on the road band lies in an 8 m triangle whose corners may be
# up to a cell diagonal away, and none of them may stick out above the band (jagged road edges).
CARVE_CORE = 8.0
CARVE_FALLOFF = 22.0
ROAD_DROP = 0.3  # terrain this far below the road surface


def landcover_code(t: dict[str, str]) -> int | None:
    lu, nat = t.get("landuse", ""), t.get("natural", "")
    if nat == "water" or t.get("waterway") == "riverbank" or lu in ("reservoir", "basin"):
        return WATER
    if nat == "glacier":
        return GLACIER
    if nat in ("bare_rock", "scree", "cliff", "rock"):
        return ROCK
    if lu == "forest" or nat == "wood":
        return FOREST
    if lu in ("orchard", "vineyard", "plant_nursery"):
        return ORCHARD
    if lu in ("residential", "industrial", "commercial", "retail", "construction", "railway", "garages") \
            or t.get("leisure") in ("pitch", "sports_centre"):
        return SETTLEMENT
    if lu in ("farmland", "farmyard"):
        return FARMLAND
    if lu in ("meadow", "grass", "village_green", "recreation_ground") or nat in ("grassland", "heath", "scrub"):
        return MEADOW
    return None


PRIORITY = [MEADOW, FARMLAND, SETTLEMENT, ORCHARD, FOREST, ROCK, GLACIER, WATER]


class AreaIndex:
    """Areas with their bounding boxes, so a tile only looks at the areas touching it (the region has
    hundreds of thousands)."""

    def __init__(self, areas: list[Area]):
        self.areas = areas
        bb = np.array([[min(o[:, 0].min() for o, _ in a.rings), min(o[:, 1].min() for o, _ in a.rings),
                        max(o[:, 0].max() for o, _ in a.rings), max(o[:, 1].max() for o, _ in a.rings)]
                       for a in areas]) if areas else np.zeros((0, 4))
        self.bb = bb

    def query(self, e0: float, n0: float, e1: float, n1: float) -> list[Area]:
        b = self.bb
        m = (b[:, 0] < e1) & (b[:, 2] > e0) & (b[:, 1] < n1) & (b[:, 3] > n0)
        return [self.areas[i] for i in np.nonzero(m)[0]]


def _near(areas, e0: float, n0: float, e1: float, n1: float) -> list[Area]:
    return areas.query(e0, n0, e1, n1) if isinstance(areas, AreaIndex) else areas


def _geojson(outer: np.ndarray, inners: list[np.ndarray]) -> dict:
    return {"type": "Polygon", "coordinates": [outer.tolist()] + [r.tolist() for r in inners]}


def road_samples(graph: dict, half_width: list[float], extra=None):
    """Points every 2 m along all edges outside bridges/tunnels, plus `extra` (en, height, half width) samples
    (motorways, railways): (en, height, half width, KD tree of en)."""
    pts, hs, ws = [], [], []
    sec_by_edge: dict[int, list[tuple[float, float]]] = {}
    for ei, s0, s1, _ in graph["sections"]:
        sec_by_edge.setdefault(ei, []).append((s0, s1))
    for ei, (e, (s, h)) in enumerate(zip(graph["edges"], graph["profiles"])):
        L = s[-1]
        ss = np.linspace(0, L, max(2, int(math.ceil(L / 2)) + 1))
        keep = np.ones(len(ss), bool)
        for a, b in sec_by_edge.get(ei, ()):
            keep &= ~((ss >= a - 1) & (ss <= b + 1))
        ss = ss[keep]
        if len(ss) == 0:
            continue
        pts.append(sample_at(e.en, ss))
        hs.append(np.interp(ss, s, h))
        ws.append(np.full(len(ss), half_width[e.cls] * (G_ONEWAY_WIDTH if e.attrs & G_ATTR_ONEWAY else 1.0)))
    if extra is not None and len(extra[0]):
        pts.append(extra[0])
        hs.append(extra[1])
        ws.append(extra[2])
    p = np.vstack(pts)
    return p, np.concatenate(hs), np.concatenate(ws), cKDTree(p)


def terrain_heights(dem: Dem, te: float, tn: float, roads) -> np.ndarray:
    """Node heights of one tile (row 0 = north edge), road carved in. roads: road_samples() plus its KD tree."""
    i = np.arange(N)
    E, Nn = np.meshgrid(te + i * CELL, tn + TILE - i * CELL)
    h = dem.sample(E, Nn, smooth=True)
    pts, rh, rw, tree = roads
    d, idx = tree.query(np.c_[E.ravel(), Nn.ravel()], distance_upper_bound=float(rw.max() + CARVE_FALLOFF + 1))
    ok = np.isfinite(d)
    w = np.zeros(d.shape)
    if ok.any():
        dd = d[ok]
        hw = rw[idx[ok]]
        t = np.clip((dd - (hw + CARVE_CORE)) / (CARVE_FALLOFF - CARVE_CORE), 0, 1)
        w[ok] = 1 - t * t * (3 - 2 * t)
        target = np.zeros(d.shape)
        target[ok] = rh[idx[ok]] - ROAD_DROP
        flat = h.ravel()
        flat[ok] = flat[ok] * (1 - w[ok]) + target[ok] * w[ok]
        h = flat.reshape(h.shape)
    return h


def landcover(areas: list[Area], te: float, tn: float, size: float = TILE, fill: int = MEADOW) -> np.ndarray:
    """Land cover code per node of a tile of the given size; `fill` where no polygon lies."""
    cell = size / (N - 1)
    shapes = []
    for a in _near(areas, te - cell, tn - cell, te + size + cell, tn + size + cell):
        code = landcover_code(a.tags)
        if code is None or "building" in a.tags:
            continue
        for outer, inners in a.rings:
            shapes.append((PRIORITY.index(code), _geojson(outer, inners), code))
    shapes.sort(key=lambda s: s[0])
    transform = Affine(cell, 0, te - cell / 2, 0, -cell, tn + size + cell / 2)
    if not shapes:
        return np.full((N, N), fill, np.uint8)
    return features.rasterize([(g, c) for _, g, c in shapes], out_shape=(N, N), transform=transform,
                              fill=fill, dtype="uint8")


# --- buildings -----------------------------------------------------------------------

BIG_FLAT = {"industrial", "commercial", "retail", "warehouse", "office", "school", "hospital", "supermarket", "sports_hall"}


def _obb(pts: np.ndarray) -> tuple[float, float, float, float, float]:
    """Minimum-area oriented rectangle: centre (x, y), angle, half length, half width."""
    best = None
    for k in range(len(pts) - 1):
        d = pts[k + 1] - pts[k]
        if np.hypot(*d) < 1e-6:
            continue
        a = math.atan2(d[1], d[0])
        c, s = math.cos(a), math.sin(a)
        u = pts @ np.array([c, s])
        v = pts @ np.array([-s, c])
        area = (u.max() - u.min()) * (v.max() - v.min())
        if best is None or area < best[0]:
            cu, cv = (u.max() + u.min()) / 2, (v.max() + v.min()) / 2
            best = (area, cu * c - cv * s, cu * s + cv * c, a, (u.max() - u.min()) / 2, (v.max() - v.min()) / 2)
    _, cx, cy, a, hl, hw = best
    if hw > hl:
        a, hl, hw = a + math.pi / 2, hw, hl
    return cx, cy, a % math.pi, hl, hw


def building_params(t: dict[str, str], area: float, hw: float) -> tuple[float, float, int]:
    kind = t.get("building", "yes")
    levels = t.get("building:levels")
    height = t.get("height")
    shape = t.get("roof:shape", "")
    flat = kind in BIG_FLAT or area > 400 or shape == "flat"
    roof = 0 if flat else (2 if shape == "hipped" else 1)
    roof_h = 0.0 if roof == 0 else min(hw * 0.8, 5.0)
    try:
        if height:
            total = float(height.split()[0])
            eave = max(2.5, total - roof_h)
        elif levels:
            eave = float(levels) * 3.0 + 0.5
        else:
            eave = {"garage": 2.6, "garages": 2.6, "shed": 2.6, "carport": 2.6, "hut": 2.6, "church": 12.0,
                    "apartments": 11.0, "industrial": 8.0, "warehouse": 8.0, "commercial": 9.0}.get(kind, 6.0)
    except ValueError:
        eave = 6.0
    return eave, eave + roof_h, roof


# building styles (high nibble of the roof byte), shared with apps/ride/src/world/atlas.ts (STYLE)
S_HOUSE, S_APARTMENT, S_FARM, S_COMMERCIAL, S_CHURCH, S_SMALL, S_OPEN, S_GREENHOUSE = range(8)
ROOF_FORM = {"flat": 0, "gabled": 1, "hipped": 2, "skillion": 3}
FARM = {"farm_auxiliary", "barn", "stable", "cowshed", "farm", "sty", "silo"}
SMALL = {"garage", "garages", "shed", "carport", "hut", "cabin", "kiosk", "storage_tank", "toilets", "bunker"}
COMMERCIAL = {"commercial", "industrial", "retail", "warehouse", "office", "school", "hospital", "supermarket",
              "sports_hall", "public", "civic", "government", "university", "college", "kindergarten", "hotel",
              "train_station", "fire_station", "manufacture", "service", "transportation", "parking"}


def building_style(osm_kind: str | None, sb_kind: str | None, eave: float, area: float, flat: bool) -> int:
    k = osm_kind or ""
    if sb_kind in ("church", "chapel") or k in ("church", "chapel", "cathedral", "religious", "monastery"):
        return S_CHURCH
    if sb_kind == "greenhouse" or k == "greenhouse":
        return S_GREENHOUSE
    if sb_kind == "roof" or k in ("roof", "carport") and area > 60:
        return S_OPEN
    if k in FARM:
        return S_FARM
    if k in SMALL or area < 35 or eave < 3.2:
        return S_SMALL
    if k in COMMERCIAL or (flat and area > 500):
        return S_COMMERCIAL
    if k in ("apartments", "dormitory", "residential") and eave > 7 or eave > 10:
        return S_APARTMENT
    return S_HOUSE


def _record(ring: np.ndarray, te: float, tn: float, dem: Dem, eave: float, ridge: float, form: int, style: int):
    """ring: closed LV95 footprint. Returns the BLDG record or None."""
    cx, cy, ang, hl, hw = _obb(ring)
    x, y = ring[:, 0], ring[:, 1]
    base = float(dem.sample(x, y).min()) - 0.3
    pts = ring[:-1]
    lx = np.round((pts[:, 0] - te) * 10).astype(int)
    lz = np.round((tn + TILE - pts[:, 1]) * 10).astype(int)
    colour = int(hashlib.sha1(f"{cx:.1f},{cy:.1f}".encode()).digest()[0]) % 8
    return (round((cx - te) * 10), round((tn + TILE - cy) * 10), ang, hl, hw, base, eave, max(eave, ridge),
            form | (style << 4), colour, lx, lz)


class BuildingSource:
    """swissBUILDINGS3D buildings (CH, FL) with OSM tags for their kind, OSM buildings where swissBUILDINGS3D has
    none (Austria, gaps). Indexed once for the region; `tile()` gives the BLDG section of one L0 tile."""

    def __init__(self, sb: list[dict], areas: list[Area]):
        import shapely

        self.sb = sb
        self.sb_tree = shapely.STRtree([b["foot"] for b in sb]) if sb else None
        self.sb_centre = np.array([[b["foot"].centroid.x, b["foot"].centroid.y] for b in sb]) if sb else np.zeros((0, 2))
        osm = []
        for a in areas:
            if "building" not in a.tags or a.tags.get("building") == "no":
                continue
            for outer, _ in a.rings:
                if len(outer) >= 4:
                    p = shapely.Polygon(outer)
                    if not p.is_valid:
                        p = p.buffer(0)
                    if not p.is_empty and p.area >= 12:
                        osm.append((a.tags, outer, p))
        self.osm = osm
        self.osm_tree = shapely.STRtree([p for _, _, p in osm]) if osm else None
        self.osm_centre = np.array([[p.centroid.x, p.centroid.y] for _, _, p in osm]) if osm else np.zeros((0, 2))
        self.used = 0
        self.boxes: list[tuple] = []

    def tile(self, dem: Dem, te: float, tn: float, skip=None) -> bytes:
        """skip(polygon) -> True for footprints a landmark model replaces."""
        import shapely

        recs = []
        inside = lambda c: (c[:, 0] >= te) & (c[:, 0] < te + TILE) & (c[:, 1] >= tn) & (c[:, 1] < tn + TILE)
        for i in np.nonzero(inside(self.sb_centre))[0]:
            b = self.sb[i]
            foot = b["foot"].simplify(0.3)
            if foot.geom_type != "Polygon" or foot.area < 12 or (skip and skip(foot)):
                continue
            kind = None
            if self.osm_tree is not None:
                for j in self.osm_tree.query(foot, predicate="intersects"):
                    if self.osm[j][2].intersection(foot).area > 0.3 * foot.area:
                        kind = self.osm[j][0].get("building")
                        break
            ring = np.asarray(foot.exterior.coords)
            form = ROOF_FORM[b["roof"]]
            eave = max(2.2, b["eave"])
            style = building_style(kind, b["kind"], eave, foot.area, form == 0)
            recs.append(_record(ring, te, tn, dem, eave, b["ridge"], form, style))
        for j in np.nonzero(inside(self.osm_centre))[0]:
            tags, outer, p = self.osm[j]
            if self.sb_tree is not None and any(self.sb[i]["foot"].intersection(p).area > 0.3 * p.area
                                                for i in self.sb_tree.query(p, predicate="intersects")):
                continue
            if skip and skip(p):
                continue
            _, _, _, _, hw = _obb(outer)
            eave, ridge, roof = building_params(tags, p.area, hw)
            style = building_style(tags.get("building"), None, eave, p.area, roof == 0)
            recs.append(_record(outer, te, tn, dem, eave, ridge, roof, style))
        recs.sort(key=lambda r: (r[1], r[0]))
        self.used += len(recs)
        # boxes for the coarse level L1 (absolute LV95): centre, angle, half sizes, base, top, colour, style
        self.boxes.extend((te + cx / 10, tn + TILE - cz / 10, ang, hl, hw, base, ridge, colour, roof >> 4)
                          for cx, cz, ang, hl, hw, base, eave, ridge, roof, colour, lx, lz in recs if hl * hw * 4 >= 50)
        out = bytearray(struct.pack("<I", len(recs)))
        for cx, cz, ang, hl, hw, base, eave, ridge, roof, colour, lx, lz in recs:
            # angle measured in LV95 (E, N); the client converts to its z-south frame
            out += struct.pack("<hhHHHHHHBBH", cx, cz, round(ang / math.pi * 65535) % 65536, min(65535, round(hl * 10)),
                               min(65535, round(hw * 10)), max(0, min(65535, round((base - H_OFFSET) / H_SCALE))),
                               min(65535, round(eave * 10)), min(65535, round(ridge * 10)), roof, colour, len(lx))
            out += np.c_[lx, lz].astype("<i2").tobytes()
        return bytes(out)


def coarse_boxes(boxes: list[tuple], ix: int, iy: int, size: float, h_scale: float) -> bytes:
    """BLDQ section of a coarse tile: buildings as plain boxes (x, z u16 dm from the NW corner, angle u16,
    half length / width u16 dm, base u16 (h_scale), height u16 dm, colour u8, style u8)."""
    te, tn = ix * size, iy * size
    sel = [b for b in boxes if te <= b[0] < te + size and tn <= b[1] < tn + size]
    sel.sort(key=lambda b: (round(b[1], 1), round(b[0], 1)))
    out = bytearray(struct.pack("<I", len(sel)))
    for e, n, ang, hl, hw, base, ridge, colour, style in sel:
        out += struct.pack("<HHHHHHHBB", round((e - te) * 10), round((tn + size - n) * 10),
                           round(ang / math.pi * 65535) % 65536, min(65535, round(hl * 10)), min(65535, round(hw * 10)),
                           max(0, min(65535, round(base / h_scale))), min(65535, round(ridge * 10)), colour, style)
    return bytes(out)


# --- file -----------------------------------------------------------------------------

def encode_heights(h: np.ndarray, scale: float = H_SCALE) -> bytes:
    q = np.clip(np.round((h - H_OFFSET) / scale), 0, 65535).astype(np.int64)
    a = np.diff(q, axis=1, prepend=0)
    d = (np.diff(a, axis=0, prepend=0) % 65536).astype("<u2")
    return d.tobytes()


def write_tile(out_dir, ix: int, iy: int, sections: list[tuple[bytes, bytes]], level: int = 0,
               size: float = TILE, h_scale: float = H_SCALE) -> str:
    """sections: [(4-char id, payload)]. Tile (ix, iy) of `level` covers [ix·size, (ix+1)·size) in E/N.
    Returns the file name (with content hash)."""
    header_size = 48
    table_size = 12 * len(sections)
    body = bytearray()
    table = bytearray()
    offset = header_size + table_size
    for sid, payload in sections:
        while (offset + len(body)) % 4:
            body.append(0)
        table += sid + struct.pack("<II", offset + len(body), len(payload))
        body += payload
    header = b"RIDE" + struct.pack("<HBxiiddHHfff", VERSION, level, ix, iy, ix * size, iy * size, N, len(sections),
                                  size / (N - 1), h_scale, H_OFFSET)
    assert len(header) == header_size, len(header)
    blob = bytes(header + table + body)
    key = f"{ix}_{iy}"
    for old in out_dir.glob(f"{key}.*.bin"):
        old.unlink()
    name = f"{key}.{hashlib.sha1(blob).hexdigest()[:8]}.bin"
    (out_dir / name).write_bytes(blob)
    return name
