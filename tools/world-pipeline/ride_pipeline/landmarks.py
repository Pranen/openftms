"""Landmarks: hand-made models (apps/ride/src/render/landmarks.ts) placed on the OSM footprint of famous
buildings, found by name (or as the nearest church to a point). The ordinary buildings under a landmark are
left out of BLDG. Written per L0 tile as section LMRK (spec: PLAN.md, "Kachelformat"):

    count u32, then per landmark: style u8, reserved u8, x i16 dm, z i16 dm (tile-local, NW corner),
    angle u16 (LV95, 0..pi), half length u16 dm, half width u16 dm, base u16 (0.05 m), reserved u16

Idea and model list after C:/data/li-auto/pipeline/objects.py (LANDMARK_STYLES).
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass

import numpy as np
import shapely

from .dem import Dem
from .geo import wgs84_to_lv95
from .osm_read import OsmData

# style ids, shared with apps/ride/src/render/landmarks.ts (LANDMARK)
STYLES = ["castle_vaduz", "cathedral", "rotes_haus", "gutenberg", "church_tower", "church_onion", "cube_black",
          "cube_white", "schattenburg", "werdenberg", "sargans", "ruin", "covered_bridge"]

# (style, OSM names, or (lat, lon) of a church to take the nearest church building)
CATALOGUE: list[tuple[str, tuple[str, ...] | tuple[float, float]]] = [
    ("castle_vaduz", ("Schloss Vaduz",)),
    ("cathedral", ("Kathedrale St. Florin",)),
    ("rotes_haus", ("Rotes Haus",)),
    ("gutenberg", ("Burg Gutenberg",)),
    ("church_tower", ("St. Laurentiuskirche",)),  # Schaan
    ("church_onion", (47.1178, 9.5432)),  # Triesenberg, St. Josef
    ("cube_black", ("Kunstmuseum Liechtenstein",)),
    ("cube_white", ("Hilti Art Foundation",)),
    ("schattenburg", ("Schattenburg",)),
    ("cathedral", ("Dom Sankt Nikolaus", "Dom St. Nikolaus")),  # Feldkirch
    ("werdenberg", ("Schloss Werdenberg",)),
    ("sargans", ("Schloss Sargans",)),
    ("ruin", ("Ruine Alt-Schellenberg",)),
    ("ruin", ("Ruine Neu-Schellenberg",)),
    ("church_tower", (47.2115, 9.5039)),  # Bendern, church on the hill
    ("covered_bridge", ("Alte Rheinbrücke Vaduz", "Alte Rheinbrücke")),
]

CHURCH = {"church", "cathedral", "chapel"}


@dataclass
class Landmark:
    style: int
    foot: shapely.Polygon
    cx: float
    cy: float
    angle: float
    hl: float
    hw: float
    base: float


def _obb(poly: shapely.Polygon) -> tuple[float, float, float, float, float]:
    r = poly.minimum_rotated_rectangle
    c = np.asarray(r.exterior.coords)[:4]
    e1, e2 = c[1] - c[0], c[2] - c[1]
    l1, l2 = float(np.hypot(*e1)), float(np.hypot(*e2))
    if l1 >= l2:
        ang, hl, hw = math.atan2(e1[1], e1[0]), l1 / 2, l2 / 2
    else:
        ang, hl, hw = math.atan2(e2[1], e2[0]), l2 / 2, l1 / 2
    cen = r.centroid
    return cen.x, cen.y, ang % math.pi, hl, hw


def find(osm: OsmData, dem: Dem, box: tuple[float, float, float, float]) -> list[Landmark]:
    named: dict[str, list[shapely.Polygon]] = {}
    churches: list[shapely.Polygon] = []
    for a in osm.areas:
        name = a.tags.get("name", "")
        polys = []
        for outer, _ in a.rings:
            if len(outer) >= 4:
                p = shapely.Polygon(outer)
                polys.append(p if p.is_valid else p.buffer(0))
        if not polys:
            continue
        if name:
            named.setdefault(name, []).extend(polys)
        if a.tags.get("building") in CHURCH or (a.tags.get("amenity") == "place_of_worship" and "building" in a.tags):
            churches.extend(polys)
    e0, n0, e1, n1 = box
    out: list[Landmark] = []
    for style, key in CATALOGUE:
        foot = None
        if isinstance(key[0], float):
            e, n = wgs84_to_lv95(key[0], key[1])
            pt = shapely.Point(float(e), float(n))
            near = [p for p in churches if p.distance(pt) < 120]
            if near:
                foot = min(near, key=lambda p: p.distance(pt))
        else:
            for name in key:
                if name in named:
                    foot = max(named[name], key=lambda p: p.area)
                    break
        if foot is None or foot.is_empty:
            print(f"  landmark {style} {key}: not found")
            continue
        if foot.geom_type != "Polygon":
            foot = max(foot.geoms, key=lambda p: p.area)
        c = foot.centroid
        if not (e0 <= c.x < e1 and n0 <= c.y < n1):
            continue
        cx, cy, ang, hl, hw = _obb(foot)
        ring = np.asarray(foot.exterior.coords)
        hs = dem.sample(ring[:, 0], ring[:, 1])
        # castles on rocks: the walls stand on the highest part; bridges: on the banks
        base = float(np.max(hs)) - 1.0 if style == "covered_bridge" else float(np.median(hs)) - 0.5
        out.append(Landmark(STYLES.index(style), foot, cx, cy, ang, hl, hw, base))
        print(f"  landmark {style}: {hl * 2:.0f} x {hw * 2:.0f} m at {cx:.0f}/{cy:.0f}")
    return out


class LandmarkIndex:
    def __init__(self, lms: list[Landmark]):
        self.lms = lms
        self.tree = shapely.STRtree([l.foot.buffer(1.0) for l in lms]) if lms else None

    def covers(self, poly) -> bool:
        """A building that a landmark replaces (overlaps its footprint by a third)."""
        if self.tree is None:
            return False
        return any(self.lms[i].foot.intersection(poly).area > 0.3 * min(poly.area, self.lms[i].foot.area)
                   for i in self.tree.query(poly, predicate="intersects"))

    def tile(self, te: float, tn: float, size: float, h_scale: float, h_offset: float) -> bytes:
        recs = [l for l in self.lms if te <= l.cx < te + size and tn <= l.cy < tn + size]
        out = bytearray(struct.pack("<I", len(recs)))
        for l in recs:
            out += struct.pack("<BBhhHHHHH", l.style, 0, round((l.cx - te) * 10), round((tn + size - l.cy) * 10),
                               round(l.angle / math.pi * 65535) % 65536, min(65535, round(l.hl * 10)),
                               min(65535, round(l.hw * 10)),
                               max(0, min(65535, round((l.base - h_offset) / h_scale))), 0)
        return bytes(out)
