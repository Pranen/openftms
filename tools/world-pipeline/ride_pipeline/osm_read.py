"""Read the clipped OSM files once: road ways, bicycle route relations and areas
(land cover, water, buildings). Objects present in several regional extracts
(border) are read once."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium

from .geo import wgs84_to_lv95


@dataclass
class Way:
    id: int
    nodes: list[int]
    en: np.ndarray  # (n, 2) LV95
    tags: dict[str, str]


@dataclass
class Area:
    tags: dict[str, str]
    rings: list[tuple[np.ndarray, list[np.ndarray]]]  # (outer, inners), LV95


@dataclass
class OsmData:
    ways: dict[int, Way] = field(default_factory=dict)
    routes: dict[int, set[tuple[str, str, str]]] = field(default_factory=dict)  # way id -> route keys
    areas: list[Area] = field(default_factory=list)


AREA_KEYS = ("building", "landuse", "natural", "leisure", "waterway")


def _ring(nodes) -> np.ndarray:
    ll = np.array([(n.lat, n.lon) for n in nodes], float)
    e, n = wgs84_to_lv95(ll[:, 0], ll[:, 1])
    return np.c_[e, n]


def read(paths: list[Path]) -> OsmData:
    data = OsmData()
    seen_areas: set[int] = set()
    for path in paths:
        for obj in osmium.FileProcessor(str(path)).with_locations().with_areas():
            if obj.is_way():
                if "highway" not in obj.tags or obj.id in data.ways:
                    continue
                try:
                    en = _ring(obj.nodes)
                except osmium.InvalidLocationError:
                    continue
                data.ways[obj.id] = Way(obj.id, [n.ref for n in obj.nodes], en, dict(obj.tags))
            elif obj.is_relation():
                t = obj.tags
                if t.get("route") == "bicycle":
                    key = (t.get("network", ""), t.get("ref", ""), t.get("name", ""))
                    for m in obj.members:
                        if m.type == "w":
                            data.routes.setdefault(m.ref, set()).add(key)
            elif obj.is_area():
                t = obj.tags
                if not any(k in t for k in AREA_KEYS) or obj.id in seen_areas:
                    continue
                seen_areas.add(obj.id)
                rings = []
                try:
                    for outer in obj.outer_rings():
                        rings.append((_ring(outer), [_ring(inner) for inner in obj.inner_rings(outer)]))
                except osmium.InvalidLocationError:
                    continue
                if rings:
                    data.areas.append(Area(dict(t), rings))
    return data
