"""Scenery lines (not ridable): motorways and trunk roads, railways, power lines, rivers and streams, plus
points (power towers, level crossings, stations). Written per L0 tile as section LINE (spec: PLAN.md,
"Kachelformat"); motorways and railways are also carved into the terrain like the ride network.

LINE record (little endian, 4-byte aligned):
    kind u8, flags u8, width u16 (dm), count u16, reserved u16,
    count × (x i16 dm, z i16 dm (tile-local, x east / z south from the NW corner), h u16 (0.05 m), f u16)
f per point: bit 0 = the segment to the next point is a bridge, bit 1 = tunnel (not drawn).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

from .dem import Dem
from .geo import cumulative, sample_at, smooth_1d
from .osm_read import OsmData

# kinds, shared with apps/ride/src/world/tile.ts (LINE_KIND)
MOTORWAY, TRUNK, RAIL, POWER, MINOR_POWER, RIVER, STREAM, CANAL = 1, 2, 10, 20, 21, 30, 31, 32
F_BRIDGE, F_TUNNEL = 1, 2

STEP = {MOTORWAY: 6.0, TRUNK: 6.0, RAIL: 6.0, RIVER: 5.0, STREAM: 5.0, CANAL: 5.0}
# half width (m) for carving and the default band width
HALF = {MOTORWAY: 5.5, TRUNK: 4.0, RAIL: 2.6, RIVER: 6.0, STREAM: 0.9, CANAL: 2.5}


@dataclass
class Line:
    kind: int
    en: np.ndarray  # (n, 2) LV95
    h: np.ndarray  # (n,) surface height
    f: np.ndarray  # (n,) flags of the segment starting at each point
    width: float


def _kind(t: dict[str, str]) -> int | None:
    hw = t.get("highway", "")
    if hw in ("motorway", "motorway_link"):
        return MOTORWAY
    if hw in ("trunk", "trunk_link") and t.get("motorroad") == "yes":
        return TRUNK
    if t.get("railway") in ("rail", "light_rail", "narrow_gauge"):
        return RAIL
    if t.get("power") == "line":
        return POWER
    if t.get("power") == "minor_line":
        return MINOR_POWER
    ww = t.get("waterway")
    if ww == "river":
        return RIVER
    if ww == "canal":
        return CANAL
    if ww in ("stream", "ditch", "drain"):
        return STREAM
    return None


def _width(kind: int, t: dict[str, str]) -> float:
    try:
        w = float(t.get("width", "").split()[0])
        if 0.3 < w < 200:
            return w
    except (ValueError, IndexError):
        pass
    if kind == MOTORWAY:
        lanes = t.get("lanes", "2")
        return 3.6 * (int(lanes) if lanes.isdigit() else 2) + 2.5
    return 2 * HALF.get(kind, 1.0)


def collect(osm: OsmData, box: tuple[float, float, float, float], dem: Dem) -> list[Line]:
    """All scenery lines touching the box, with heights (bridges interpolated, profiles smoothed)."""
    e0, n0, e1, n1 = box
    ways = []
    for w in [*osm.ways.values(), *osm.lines.values()]:
        kind = _kind(w.tags)
        if kind is None or len(w.en) < 2:
            continue
        if w.tags.get("waterway") and w.tags.get("intermittent") == "yes" and kind == STREAM:
            continue
        x, y = w.en[:, 0], w.en[:, 1]
        if x.max() < e0 or x.min() > e1 or y.max() < n0 or y.min() > n1:
            continue
        ways.append((w, kind))
    ways.sort(key=lambda p: p[0].id)
    # sample every STEP metres (power lines: only the towers = the way's nodes)
    pts, meta = [], []
    for w, kind in ways:
        if kind in (POWER, MINOR_POWER):
            en = w.en
        else:
            L = float(cumulative(w.en)[-1])
            if L < 1:
                continue
            step = STEP[kind]
            s = np.r_[np.arange(0, L, step), L]
            en = sample_at(w.en, s)
        # only the part inside the box (plus a margin): the elevation model covers the region
        ins = (en[:, 0] > e0 - 100) & (en[:, 0] < e1 + 100) & (en[:, 1] > n0 - 100) & (en[:, 1] < n1 + 100)
        k = 0
        while k < len(ins):
            if not ins[k]:
                k += 1
                continue
            j = k
            while j < len(ins) and ins[j]:
                j += 1
            if j - k >= 2:
                pts.append(en[k:j])
                meta.append((w, kind))
            k = j
    heights = dem.sample_many(pts)
    out = []
    for (w, kind), en, h in zip(meta, pts, heights):
        t = w.tags
        bridge = t.get("bridge", "no") not in ("no",) or t.get("man_made") == "bridge"
        tunnel = t.get("tunnel", "no") not in ("no",) or t.get("covered") == "yes" and kind >= RIVER
        f = np.zeros(len(en), np.uint16)
        if tunnel:
            f[:] = F_TUNNEL
        elif bridge:
            f[:] = F_BRIDGE
        h = h.astype(np.float64)
        if kind in (MOTORWAY, TRUNK, RAIL):
            if (bridge or tunnel) and len(h) >= 2:
                # straight between the abutments / portals (not along the valley below or the hill above)
                h = np.linspace(h[0], h[-1], len(h))
            elif not tunnel:
                h = smooth_1d(h, 5)
        out.append(Line(kind, en, h, f, _width(kind, t)))
    return out


def carve_samples(lines: list[Line]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Points every ~2 m of motorways and railways on the ground (no bridges/tunnels): (en, height, half width)."""
    P, H, W = [], [], []
    for ln in lines:
        if ln.kind not in (MOTORWAY, TRUNK, RAIL) or ln.f[0] & (F_BRIDGE | F_TUNNEL):
            continue
        s = cumulative(ln.en)
        if s[-1] < 1:
            continue
        ss = np.arange(0, s[-1], 2.0)
        P.append(sample_at(ln.en, ss))
        H.append(np.interp(ss, s, ln.h))
        W.append(np.full(len(ss), ln.width / 2))
    if not P:
        return np.zeros((0, 2)), np.zeros(0), np.zeros(0)
    return np.vstack(P), np.concatenate(H), np.concatenate(W)


class LineIndex:
    def __init__(self, lines: list[Line]):
        self.lines = lines
        self.bb = np.array([[l.en[:, 0].min(), l.en[:, 1].min(), l.en[:, 0].max(), l.en[:, 1].max()] for l in lines]) \
            if lines else np.zeros((0, 4))

    def tile(self, te: float, tn: float, size: float, h_scale: float, h_offset: float) -> bytes:
        """LINE section of a tile: every line cut into runs of consecutive segments whose midpoint lies in the
        tile (each segment is drawn by exactly one tile)."""
        b = self.bb
        m = (b[:, 0] < te + size + 50) & (b[:, 2] > te - 50) & (b[:, 1] < tn + size + 50) & (b[:, 3] > tn - 50)
        recs = []
        for i in np.nonzero(m)[0]:
            ln = self.lines[i]
            mid = (ln.en[:-1] + ln.en[1:]) / 2
            ins = (mid[:, 0] >= te) & (mid[:, 0] < te + size) & (mid[:, 1] >= tn) & (mid[:, 1] < tn + size)
            k = 0
            while k < len(ins):
                if not ins[k]:
                    k += 1
                    continue
                j = k
                while j < len(ins) and ins[j]:
                    j += 1
                sl = slice(k, j + 1)  # segments k..j-1 -> points k..j
                recs.append((ln.kind, ln.width, ln.en[sl], ln.h[sl], ln.f[sl]))
                k = j
        out = bytearray(struct.pack("<I", len(recs)))
        for kind, width, en, h, f in recs:
            n = len(en)
            out += struct.pack("<BBHHH", kind, 0, min(65535, round(width * 10)), n, 0)
            x = np.round((en[:, 0] - te) * 10).astype("<i2")
            z = np.round((tn + size - en[:, 1]) * 10).astype("<i2")
            hq = np.clip(np.round((h - h_offset) / h_scale), 0, 65535).astype("<u2")
            arr = np.zeros(n, dtype=[("x", "<i2"), ("z", "<i2"), ("h", "<u2"), ("f", "<u2")])
            arr["x"], arr["z"], arr["h"], arr["f"] = x, z, hq, f
            out += arr.tobytes()
        return bytes(out)


def summary(lines: list[Line]) -> str:
    km: dict[int, float] = {}
    for l in lines:
        km[l.kind] = km.get(l.kind, 0) + float(cumulative(l.en)[-1]) / 1000
    names = {MOTORWAY: "motorway", TRUNK: "trunk", RAIL: "rail", POWER: "power", MINOR_POWER: "minor power",
             RIVER: "river", STREAM: "stream", CANAL: "canal"}
    return ", ".join(f"{names[k]} {v:.0f} km" for k, v in sorted(km.items()))

