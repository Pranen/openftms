"""Ride network from OSM: filter, topology, junction simplification, height profiles,
and the binary format graph.bin + graph.json (spec: apps/ride/PLAN.md, "Strassengraph").

Bridge/tunnel interpolation follows C:/data/li-auto/pipeline/route.py.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import median_filter

from .dem import Dem
from .geo import E0, N0, cumulative, sample_at, simplify, smooth_1d
from .osm_read import OsmData

# --- enums shared with packages/route-graph/src/format.ts ---------------------------
CLASSES = ["cycleway", "path", "track", "residential", "living_street", "unclassified", "tertiary", "secondary", "primary"]
SURFACES = ["asphalt", "concrete", "paving", "fine_gravel", "gravel", "unpaved", "unknown"]
ATTR_ACCESS_FWD = 1 << 7
ATTR_ACCESS_BWD = 1 << 8
ATTR_CYCLELANE = 1 << 9
ATTR_ONEWAY = 1 << 10  # one carriageway of a one-way road (narrower band, no centre line)
SEC_BRIDGE = 1
SEC_TUNNEL = 2
SEC_GALLERY = 4
NODE_ROUNDABOUT = 1
NODE_BOUNDARY = 2

# half width of the road band per class (m); the client draws the band with the same values
ROAD_HALF_WIDTH = [1.5, 1.2, 1.6, 2.6, 2.4, 2.6, 3.0, 3.3, 3.6]

PROFILE_STEP = 5.0  # m
HEIGHT_SCALE = 0.05  # m per profile unit
JUNCTION_MERGE = 15.0  # m: shorter edges collapse into one decision point
STUB_MIN = 20.0  # m: shorter dead ends are dropped
SMOOTH_WINDOW = 5  # profile samples (25 m)
GRADE_CAP_ROAD = 18.0  # %: max 20 m grade of a road profile before extra smoothing stops
GRADE_CAP_PATH = 28.0  # %: the same for tracks and paths
GRADE_DROP_PATH = 40.0  # %: tracks and paths steeper than this (20 m, smoothed) are left out
NODE_BLEND = 40.0  # m over which an edge end is pulled to its node height
END_BLEND = 35.0  # m over which an edge end is bent to its moved junction node (no kink at the junction)
SIDE_DIST = 12.0  # m: a cycleway/path this close to a road and parallel to it is a sidepath
SIDE_DIST_TAGGED = 20.0  # m: the same for ways tagged as sidepath / sidewalk
SIDE_ANGLE = 25.0  # deg: max angle between sidepath and road
SIDE_MIN = 30.0  # m: shorter parallel stretches (crossings, short joins) stay
SIDE_CONNECT = 25.0  # m: a remaining piece of a cut sidepath reconnects to a road node this close
SPLIT_GAP = 30.0  # m: one-way carriageway pairs whose ends are this close merge into one road
SPLIT_MAX = 250.0  # m: only short splits (islands at junctions and roundabouts)
MAJOR = {"residential", "living_street", "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link",
         "primary", "primary_link"}
ONEWAY_WIDTH = 0.6  # band width factor of one-way carriageways (dual carriageways, ramps, roundabouts)

# use_sidepath is ridable here: the parallel cycleway is dropped (one network, the bigger road wins)
NO_BIKE = {"no", "private", "dismount"}
BIKE_OK = {"yes", "designated", "permissive"}
SOFT = {"grass", "ground", "dirt", "earth", "mud", "sand", "grass_paver", "woodchips"}
PAVED = {"asphalt", "concrete", "paved", "concrete:plates", "paving_stones", "sett", "chipseal"}


def road_class(t: dict[str, str]) -> int | None:
    hw = t.get("highway", "")
    if t.get("area") == "yes" or t.get("motorroad") == "yes":
        return None
    bike = t.get("bicycle", "")
    if bike in NO_BIKE:
        return None
    if t.get("access") in ("no", "private") and bike not in BIKE_OK:
        return None
    if hw == "cycleway":
        return 0
    if hw in ("path", "footway", "pedestrian", "bridleway"):
        # mountain trails (hiking grade above T1, MTB scale 2+) are no place for a trainer ride
        if t.get("sac_scale", "hiking") != "hiking" or t.get("mtb:scale", "0")[:1] not in ("", "0", "1"):
            return None
        return 1 if bike in BIKE_OK else None
    if hw == "track":
        # farm roads (the Riet): ridable unless marked rough; no tracktype is the common case
        if t.get("surface") in PAVED:
            return 2
        if t.get("tracktype") in ("grade4", "grade5") or t.get("surface") in SOFT:
            return None
        return 2
    if hw == "service":
        # plain service roads (farm and industrial access); driveways, parking aisles etc. are not
        if t.get("service") or t.get("access") in ("no", "private", "customers", "delivery"):
            return 2 if bike in BIKE_OK else None
        return None if t.get("surface") in SOFT else 2
    return {"residential": 3, "living_street": 4, "unclassified": 5, "tertiary": 6, "tertiary_link": 6,
            "secondary": 7, "secondary_link": 7, "primary": 8, "primary_link": 8}.get(hw)


def surface_of(t: dict[str, str], cls: int) -> int:
    s = t.get("surface", "")
    if s in ("asphalt", "chipseal", "paved"):
        return 0
    if s in ("concrete", "concrete:plates", "concrete:lanes"):
        return 1
    if s in ("paving_stones", "sett", "cobblestone", "unhewn_cobblestone"):
        return 2
    if s in ("fine_gravel", "compacted"):
        return 3
    if s in ("gravel", "pebblestone"):
        return 4
    if s in ("unpaved", "dirt", "ground", "earth", "grass", "mud", "sand"):
        return 5
    if cls == 2 and t.get("highway") == "service":
        return 0
    if cls == 2:
        return {"grade1": 0, "grade2": 3, "grade3": 4}.get(t.get("tracktype", ""), 6)
    return 0 if cls >= 3 or cls == 0 else 6


def access_bits(t: dict[str, str]) -> int:
    fwd = bwd = True
    ow = t.get("oneway", "")
    contra = t.get("oneway:bicycle") == "no" or t.get("cycleway", "").startswith("opposite")
    if t.get("junction") in ("roundabout", "circular") and ow == "":
        ow = "yes"
    if ow in ("yes", "1", "true") and not contra:
        bwd = False
    elif ow == "-1" and not contra:
        fwd = False
    return (ATTR_ACCESS_FWD if fwd else 0) | (ATTR_ACCESS_BWD if bwd else 0)


def structure_flags(t: dict[str, str]) -> int:
    f = 0
    if t.get("bridge") not in (None, "no"):
        f |= SEC_BRIDGE
    if t.get("tunnel") not in (None, "no", "building_passage"):
        f |= SEC_TUNNEL
    if t.get("tunnel") == "avalanche_protector":
        f |= SEC_GALLERY
    return f


@dataclass
class Piece:
    """A run of one OSM way between two split nodes."""
    a: int  # node id
    b: int
    en: np.ndarray
    cls: int
    surface: int
    attrs: int  # access + lane bits
    struct: int
    routes: int
    name: str
    way: int


@dataclass
class Edge:
    a: int  # cluster id
    b: int
    pieces: list[tuple[np.ndarray, int]] = field(default_factory=list)  # (en, struct flags) in order
    cls: int = 0
    surface: int = 0
    attrs: int = 0
    routes: int = 0
    name: str = ""
    way: int = 0

    @property
    def en(self) -> np.ndarray:
        out = [self.pieces[0][0]]
        for p, _ in self.pieces[1:]:
            out.append(p[1:])
        return np.vstack(out)

    @property
    def length(self) -> float:
        return float(cumulative(self.en)[-1])


class _UF:
    def __init__(self):
        self.p: dict[int, int] = {}

    def find(self, x: int) -> int:
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def build(osm: OsmData, box: tuple[float, float, float, float], dem: Dem) -> dict:
    e_min, n_min, e_max, n_max = box

    # routes: bit per relation (sorted for determinism)
    route_keys = sorted({k for ks in osm.routes.values() for k in ks})[:32]
    route_bit = {k: 1 << i for i, k in enumerate(route_keys)}

    # 1. kept ways, cut to runs inside the box
    runs: list[tuple[list[int], np.ndarray, dict[str, str], int, int]] = []
    for wid in sorted(osm.ways):
        w = osm.ways[wid]
        cls = road_class(w.tags)
        if cls is None:
            continue
        inside = (w.en[:, 0] >= e_min) & (w.en[:, 0] <= e_max) & (w.en[:, 1] >= n_min) & (w.en[:, 1] <= n_max)
        i = 0
        while i < len(inside):
            if not inside[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(inside) and inside[j + 1]:
                j += 1
            if j > i:
                runs.append((w.nodes[i:j + 1], w.en[i:j + 1], w.tags, cls, wid))
            i = j + 1

    runs = _drop_sidepaths(runs, osm)

    # 2. split at shared nodes
    use = defaultdict(int)
    for nodes, *_ in runs:
        for k, nid in enumerate(nodes):
            use[nid] += 1 if 0 < k < len(nodes) - 1 else 2  # run ends always split
    pos: dict[int, np.ndarray] = {}
    pieces: list[Piece] = []
    roundabout_nodes: list[list[int]] = []
    boundary: set[int] = set()
    for nodes, en, tags, cls, wid in runs:
        rbits = 0
        for k in osm.routes.get(wid, ()):
            rbits |= route_bit.get(k, 0)
        lane = ATTR_CYCLELANE if tags.get("cycleway", "") in ("lane", "track") or tags.get("cycleway:right") == "lane" \
            or tags.get("cycleway:both") == "lane" else 0
        car_oneway = tags.get("oneway") in ("yes", "1", "true", "-1") or tags.get("junction") in ("roundabout", "circular")
        attrs = access_bits(tags) | lane | (ATTR_ONEWAY if car_oneway else 0)
        surf = surface_of(tags, cls)
        st = structure_flags(tags)
        name = tags.get("name", "") or tags.get("ref", "")
        if tags.get("junction") in ("roundabout", "circular"):
            roundabout_nodes.append(nodes)
        for k, nid in enumerate(nodes):
            pos[nid] = en[k]
        cut = [0] + [k for k in range(1, len(nodes) - 1) if use[nodes[k]] > 1] + [len(nodes) - 1]
        for a, b in zip(cut, cut[1:]):
            pieces.append(Piece(nodes[a], nodes[b], en[a:b + 1].copy(), cls, surf, attrs, st, rbits, name, wid))
        # run ends at the box edge
        for k in (0, len(nodes) - 1):
            e, n = en[k]
            if min(e - e_min, e_max - e, n - n_min, n_max - n) < 30:
                boundary.add(nodes[k])

    ring_nodes = {n for ring in roundabout_nodes for n in ring}
    pieces, joins = _merge_splits(pieces, ring_nodes)

    # 3. junction clusters: roundabouts and short connectors collapse into one node
    uf = _UF()
    for p in pieces:
        uf.find(p.a), uf.find(p.b)
    for x, y in joins:
        uf.union(x, y)
    rb_roots: set[int] = set()
    for ring in roundabout_nodes:
        for nid in ring[1:]:
            uf.union(ring[0], nid)
    for p in pieces:
        if p.struct == 0 and float(cumulative(p.en)[-1]) < JUNCTION_MERGE:
            uf.union(p.a, p.b)
    for ring in roundabout_nodes:
        rb_roots.add(uf.find(ring[0]))
    members = defaultdict(list)
    for nid in list(uf.p):
        members[uf.find(nid)].append(nid)
    # node position: on the most important road of the cluster (a side path or a parallel cycleway
    # joined by a short connector bends to the main road, not the main road halfway to the path);
    # a roundabout sits at the centre of its ring
    node_cls: dict[int, int] = defaultdict(lambda: -1)
    for p in pieces:
        for nid in (p.a, p.b):
            node_cls[nid] = max(node_cls[nid], p.cls)
    ring_of: dict[int, list[int]] = defaultdict(list)
    for ring in roundabout_nodes:
        ring_of[uf.find(ring[0])] += ring
    cpos = {}
    for c, ms in members.items():
        if c in ring_of:
            cpos[c] = np.mean([pos[n] for n in ring_of[c]], axis=0)
            continue
        top = max(node_cls[n] for n in ms)
        cpos[c] = np.mean([pos[n] for n in ms if node_cls[n] == top], axis=0)

    edges: list[Edge] = []
    for p in pieces:
        ca, cb = uf.find(p.a), uf.find(p.b)
        if ca == cb:
            continue  # inside a junction cluster
        en = _bend_ends(p.en, cpos[ca] - p.en[0], cpos[cb] - p.en[-1])
        edges.append(Edge(ca, cb, [(en, p.struct)], p.cls, p.surface, p.attrs, p.routes, p.name, p.way))

    def incident(es):
        inc = defaultdict(list)
        for i, e in enumerate(es):
            if e is None:
                continue
            inc[e.a].append(i)
            inc[e.b].append(i)
        return inc

    # 4. drop short stubs (repeat: removing one can create another)
    bset = boundary_clusters(boundary, uf)
    changed = True
    while changed:
        changed = False
        inc = incident(edges)
        for i, e in enumerate(edges):
            if e is None:
                continue
            if (len(inc[e.a]) == 1 or len(inc[e.b]) == 1) and e.length < STUB_MIN \
                    and e.a not in bset and e.b not in bset:
                edges[i] = None
                changed = True
        edges = [e for e in edges if e is not None]

    # 5. merge through degree-2 nodes with equal attributes
    def same(x: Edge, y: Edge) -> bool:
        return x.cls == y.cls and x.surface == y.surface and x.attrs == y.attrs

    merged = True
    while merged:
        merged = False
        inc = incident(edges)
        for c in sorted(inc):
            ids = inc[c]
            if len(ids) != 2 or ids[0] == ids[1] or c in rb_roots:
                continue
            x, y = edges[ids[0]], edges[ids[1]]
            if x is None or y is None or not same(x, y):
                continue
            # orient: x ends at c, y starts at c
            if x.a == c:
                x = _reverse(x)
            if y.b == c:
                y = _reverse(y)
            if x.b != c or y.a != c or x.a == y.b == c:
                continue
            m = Edge(x.a, y.b, x.pieces + y.pieces, x.cls, x.surface, x.attrs, x.routes | y.routes,
                     x.name or y.name, min(x.way, y.way))
            edges[ids[0]] = m
            edges[ids[1]] = None
            edges = [e for e in edges if e is not None]
            merged = True
            break

    # 6a. paths and tracks steeper than anything ridable on a trainer (short shortcuts up a slope)
    # (all paths sampled in one batch: the elevation model loads 2 km blocks lazily)
    steep_s, steep_p, steep_e = [], [], []
    for e in edges:
        if e.cls > 2:
            continue
        ss = np.arange(0, float(cumulative(e.en)[-1]) + 1e-9, PROFILE_STEP)
        if len(ss) < 2:
            continue
        steep_e.append(id(e))
        steep_s.append(ss)
        steep_p.append(sample_at(e.en, ss))
    steep = {k for k, ss, h in zip(steep_e, steep_s, dem.sample_many(steep_p))
             if _max_grade(ss, smooth_1d(h, SMOOTH_WINDOW)) > GRADE_DROP_PATH}
    edges = [e for e in edges if id(e) not in steep]

    # 6. largest connected component
    adj = defaultdict(set)
    for e in edges:
        adj[e.a].add(e.b)
        adj[e.b].add(e.a)
    best: set[int] = set()
    seen: set[int] = set()
    for start in sorted(adj):
        if start in seen:
            continue
        comp = {start}
        stack = [start]
        while stack:
            u = stack.pop()
            for v in adj[u]:
                if v not in comp:
                    comp.add(v)
                    stack.append(v)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    edges = [e for e in edges if e.a in best]
    edges.sort(key=lambda e: (e.way, round(float(e.en[0, 0]), 1), round(float(e.en[0, 1]), 1)))

    # 7. nodes, profiles
    node_ids = sorted({e.a for e in edges} | {e.b for e in edges}, key=lambda c: (round(float(cpos[c][0]), 2), round(float(cpos[c][1]), 2)))
    nidx = {c: i for i, c in enumerate(node_ids)}
    bclusters = boundary_clusters(boundary, uf)

    profiles, sections = [], []
    stations, points = [], []
    for e in edges:
        L = float(cumulative(e.en)[-1])
        s = np.r_[np.arange(0, L, PROFILE_STEP), L] if L % PROFILE_STEP > 1e-6 else np.arange(0, L + 1e-9, PROFILE_STEP)
        stations.append(s)
        points.append(sample_at(e.en, s))
    raw_heights = dem.sample_many(points)
    for ei, e in enumerate(edges):
        s = stations[ei]
        L = float(s[-1])
        h = raw_heights[ei].copy()
        # structures: interpolate between the ends (plus a little margin onto the ground)
        acc = 0.0
        for pen, st in e.pieces:
            pl = float(cumulative(pen)[-1])
            if st:
                s0, s1 = max(0.0, acc - 2), min(L, acc + pl + 2)
                sections.append((ei, acc, acc + pl, st))
                m = (s >= s0) & (s <= s1)
                if m.sum() >= 2:
                    h0 = float(np.interp(s0, s, h))
                    h1 = float(np.interp(s1, s, h))
                    h[m] = h0 + (h1 - h0) * (s[m] - s0) / max(s1 - s0, 1e-6)
            acc += pl
        h = smooth_1d(median_filter(h, 3, mode="nearest"), SMOOTH_WINDOW)
        # DEM steps (culverts, gullies, walls next to the road) make short ramps no road has:
        # smooth on until the 20 m grade is plausible for the class (true long grades survive)
        cap = GRADE_CAP_ROAD if e.cls >= 3 else GRADE_CAP_PATH
        for _ in range(40):
            if _max_grade(s, h) <= cap:
                break
            h = smooth_1d(h, SMOOTH_WINDOW)
        profiles.append((s, h))

    node_h = defaultdict(list)
    for e, (s, h) in zip(edges, profiles):
        node_h[e.a].append(h[0])
        node_h[e.b].append(h[-1])
    nh = {c: float(np.mean(v)) for c, v in node_h.items()}
    for k, (e, (s, h)) in enumerate(zip(edges, profiles)):
        L = s[-1]
        blend = min(NODE_BLEND, L / 2)
        d0, d1 = nh[e.a] - h[0], nh[e.b] - h[-1]
        w0 = np.clip(1 - s / max(blend, 1e-6), 0, 1)
        w1 = np.clip(1 - (L - s) / max(blend, 1e-6), 0, 1)
        profiles[k] = (s, h + d0 * w0 + d1 * w1)

    h_all = np.concatenate([h for _, h in profiles])
    h_offset = float(np.floor(h_all.min()) - 10)
    # roundabout radius (mean distance of its ring vertices to the node): drawn as a ring with an island
    ring_pts = defaultdict(list)
    for ring in roundabout_nodes:
        ring_pts[uf.find(ring[0])] += [pos[n] for n in ring]
    rb_radius = {c: float(np.mean(np.hypot(*(np.array(ring_pts[c]) - cpos[c]).T))) for c in rb_roots if c in nidx}
    return dict(edges=edges, profiles=profiles, sections=sections, node_ids=node_ids, nidx=nidx, cpos=cpos,
                node_h=nh, rb_roots=rb_roots, rb_radius=rb_radius, boundary=bclusters, route_keys=route_keys, h_offset=h_offset)


def _drop_sidepaths(runs, osm: OsmData):
    """Cycleways and paths running alongside a road are dropped there: one network, the bigger road
    wins (no parallel lanes with connectors every few metres, cleaner junctions and roundabouts).
    Only the parallel stretches go; where the path leaves the road, the rest stays and is joined to
    the nearest road node."""
    from scipy.spatial import cKDTree

    pts, tans = [], []
    vpos, vid = [], []
    for w in osm.ways.values():
        if w.tags.get("highway") not in MAJOR or w.tags.get("area") == "yes" or len(w.en) < 2:
            continue
        s = cumulative(w.en)
        ss = np.arange(0, s[-1] + 1e-9, 2.0)
        pts.append(sample_at(w.en, ss))
        seg = np.clip(np.searchsorted(s, ss, side="right") - 1, 0, len(w.en) - 2)
        d = w.en[seg + 1] - w.en[seg]
        tans.append(d / np.maximum(np.hypot(*d.T), 1e-9)[:, None])
        vpos.append(w.en)
        vid += list(w.nodes)
    if not pts:
        return runs
    road = cKDTree(np.vstack(pts))
    tan = np.vstack(tans)
    vtree = cKDTree(np.vstack(vpos))
    cos_max = np.cos(np.radians(SIDE_ANGLE))

    out = []
    for nodes, en, tags, cls, wid in runs:
        if cls > 1:
            out.append((nodes, en, tags, cls, wid))
            continue
        tagged = tags.get("footway") == "sidewalk" or tags.get("path") == "sidewalk" \
            or tags.get("is_sidepath") == "yes" or tags.get("cycleway") == "sidepath"
        dist = SIDE_DIST_TAGGED if tagged else SIDE_DIST
        par = np.zeros(len(en) - 1, bool)
        for k in range(len(en) - 1):
            d = en[k + 1] - en[k]
            L = float(np.hypot(*d))
            if L <= 0:
                par[k] = True
                continue
            q = en[k] + np.outer(np.linspace(0, 1, max(2, int(L / 2) + 1)), d)
            dd, ii = road.query(q)
            if np.any(dd > dist):
                continue
            par[k] = tagged or bool(np.all(np.abs(tan[ii] @ (d / L)) >= cos_max))
        # drop only parallel stretches of at least SIDE_MIN
        seglen = np.hypot(*np.diff(en, axis=0).T)
        drop = np.zeros_like(par)
        k = 0
        while k < len(par):
            if not par[k]:
                k += 1
                continue
            j = k
            while j + 1 < len(par) and par[j + 1]:
                j += 1
            if seglen[k:j + 1].sum() >= SIDE_MIN:
                drop[k:j + 1] = True
            k = j + 1
        if not drop.any():
            out.append((nodes, en, tags, cls, wid))
            continue
        k = 0
        while k < len(drop):
            if drop[k]:
                k += 1
                continue
            j = k
            while j + 1 < len(drop) and not drop[j + 1]:
                j += 1
            ns, pe = list(nodes[k:j + 2]), en[k:j + 2]
            # rejoin the network where the parallel stretch was cut off
            for at_start, cut in ((True, k > 0), (False, j + 1 < len(drop))):
                if not cut:
                    continue
                d, i = vtree.query(pe[0] if at_start else pe[-1])
                if d <= SIDE_CONNECT and vid[i] not in ns:
                    p = vtree.data[i]
                    if at_start:
                        ns, pe = [vid[i]] + ns, np.vstack([p, pe])
                    else:
                        ns, pe = ns + [vid[i]], np.vstack([pe, p])
            out.append((ns, pe, tags, cls, wid))
            k = j + 1
    return out


def _merge_splits(pieces: list[Piece], ring_nodes: set[int]) -> tuple[list[Piece], list[tuple[int, int]]]:
    """The two one-way halves of a road split around an island (approaches of roundabouts and
    junctions) become one two-way road on their centre line. Returns the pieces and the node
    pairs to join into one junction."""
    def length(p: Piece) -> float:
        return float(cumulative(p.en)[-1])

    cand = [i for i, p in enumerate(pieces) if p.attrs & ATTR_ONEWAY and not (p.a in ring_nodes and p.b in ring_nodes)
            and length(p) <= SPLIT_MAX]
    used: set[int] = set()
    joins: list[tuple[int, int]] = []
    merged: dict[int, Piece] = {}
    for x in cand:
        if x in used:
            continue
        A = pieces[x]
        best, best_d = None, SPLIT_GAP
        for y in cand:
            if y == x or y in used:
                continue
            B = pieces[y]
            if B.name != A.name or B.cls != A.cls or B.way == A.way:
                continue
            la, lb = length(A), length(B)
            if abs(la - lb) > 0.5 * max(la, lb):
                continue
            d = max(float(np.hypot(*(A.en[0] - B.en[-1]))), float(np.hypot(*(A.en[-1] - B.en[0]))))
            if d < best_d:
                best, best_d = y, d
        if best is None:
            continue
        B = pieces[best]
        n = max(len(A.en), len(B.en), int(max(length(A), length(B)) / 2) + 2)
        la, lb = length(A), length(B)
        mid = 0.5 * (sample_at(A.en, np.linspace(0, la, n)) + sample_at(B.en[::-1], np.linspace(0, lb, n)))
        attrs = (A.attrs | B.attrs) & ~ATTR_ONEWAY | ATTR_ACCESS_FWD | ATTR_ACCESS_BWD
        merged[x] = Piece(A.a, A.b, mid, A.cls, A.surface, attrs, A.struct | B.struct, A.routes | B.routes, A.name, A.way)
        used |= {x, best}
        joins += [(A.a, B.b), (A.b, B.a)]
    out = [merged.get(i, p) for i, p in enumerate(pieces) if i not in used or i in merged]
    return out, joins


def _bend_ends(en: np.ndarray, da: np.ndarray, db: np.ndarray) -> np.ndarray:
    """Move the end points by da / db, spreading the shift smoothly over END_BLEND m (densified there),
    instead of only moving the last vertex: that kinked the road at every merged junction."""
    s = cumulative(en)
    L = float(s[-1])
    if L <= 0:
        return en + da
    b = min(END_BLEND, L)
    # densify to 2 m inside the blend zones so the bend is a curve, not one long tilted segment
    extra = np.r_[np.arange(0, b, 2.0), np.arange(L - b, L, 2.0)[1:]]
    ss = np.unique(np.r_[s, extra[(extra > 0) & (extra < L)]])
    out = sample_at(en, ss)
    ta = np.clip(1 - ss / b, 0, 1)
    tb = np.clip(1 - (L - ss) / b, 0, 1)
    wa = ta * ta * (3 - 2 * ta)
    wb = tb * tb * (3 - 2 * tb)
    return out + wa[:, None] * da[None, :] + wb[:, None] * db[None, :]


def boundary_clusters(boundary: set[int], uf: _UF) -> set[int]:
    return {uf.find(n) for n in boundary}


def _reverse(e: Edge) -> Edge:
    pcs = [(p[::-1].copy(), st) for p, st in reversed(e.pieces)]
    fwd, bwd = e.attrs & ATTR_ACCESS_FWD, e.attrs & ATTR_ACCESS_BWD
    attrs = (e.attrs & ~(ATTR_ACCESS_FWD | ATTR_ACCESS_BWD)) | (ATTR_ACCESS_BWD if fwd else 0) | (ATTR_ACCESS_FWD if bwd else 0)
    return Edge(e.b, e.a, pcs, e.cls, e.surface, attrs, e.routes, e.name, e.way)


# --- binary writer ----------------------------------------------------------------------

def encode(g: dict) -> tuple[bytes, dict]:
    edges, profiles = g["edges"], g["profiles"]
    nidx, cpos = g["nidx"], g["cpos"]
    sections: list[tuple[str, np.ndarray]] = []

    def cm(v):
        return np.round(np.asarray(v) * 100).astype("<i4")

    nx = np.array([cpos[c][0] - E0 for c in g["node_ids"]])
    nz = np.array([N0 - cpos[c][1] for c in g["node_ids"]])
    flags = np.array([(NODE_ROUNDABOUT if c in g["rb_roots"] else 0) | (NODE_BOUNDARY if c in g["boundary"] else 0)
                      for c in g["node_ids"]], "<u1")
    sections += [("nodeX", cm(nx)), ("nodeZ", cm(nz)), ("nodeFlags", flags)]

    names = sorted({e.name for e in edges} | {""})
    name_id = {n: i for i, n in enumerate(names)}
    gx, gz, gstart, gcount, pstart, prof = [], [], [], [], [], []
    for e, (s, h) in zip(edges, profiles):
        line = simplify(e.en, 0.5)
        gstart.append(len(gx))
        gcount.append(len(line))
        gx += list(line[:, 0] - E0)
        gz += list(N0 - line[:, 1])
        pstart.append(len(prof))
        prof += list(h)
    E = len(edges)
    sections += [
        ("edgeFrom", np.array([nidx[e.a] for e in edges], "<u4")),
        ("edgeTo", np.array([nidx[e.b] for e in edges], "<u4")),
        ("edgeLength", np.array([round(s[-1] * 100) for s, _ in profiles], "<u4")),
        ("edgeAttrs", np.array([e.cls | (e.surface << 4) | e.attrs for e in edges], "<u4")),
        ("edgeRoutes", np.array([e.routes for e in edges], "<u4")),
        ("edgeGeomStart", np.array(gstart, "<u4")),
        ("edgeGeomCount", np.array(gcount, "<u4")),
        ("edgeProfStart", np.array(pstart, "<u4")),
        ("edgeName", np.array([name_id[e.name] for e in edges], "<u4")),
        ("edgeOsmWay", np.array([e.way for e in edges], "<f8")),
    ]
    # adjacency (CSR): entries = edge << 1 | (1 if the edge leaves the node backwards)
    adj = defaultdict(list)
    for i, e in enumerate(edges):
        adj[nidx[e.a]].append(i << 1)
        adj[nidx[e.b]].append(i << 1 | 1)
    offsets, entries = [0], []
    for n in range(len(g["node_ids"])):
        entries += sorted(adj[n])
        offsets.append(len(entries))
    sections += [("adjOffsets", np.array(offsets, "<u4")), ("adjEntries", np.array(entries, "<u4"))]
    sections += [("geomX", cm(gx)), ("geomZ", cm(gz))]
    q = np.round((np.array(prof) - g["h_offset"]) / HEIGHT_SCALE)
    sections += [("profile", np.clip(q, 0, 65535).astype("<u2"))]
    sec = sorted(g["sections"])
    sections += [
        ("secEdge", np.array([x[0] for x in sec], "<u4")),
        ("secStart", np.array([round(x[1] * 100) for x in sec], "<u4")),
        ("secEnd", np.array([round(x[2] * 100) for x in sec], "<u4")),
        ("secFlags", np.array([x[3] for x in sec], "<u4")),
    ]
    blob = b"".join(n.encode("utf-8") for n in names)
    soff = np.cumsum([0] + [len(n.encode("utf-8")) for n in names]).astype("<u4")
    sections += [("nameOffsets", soff), ("nameBytes", np.frombuffer(blob, "<u1") if blob else np.zeros(0, "<u1"))]

    out = bytearray()
    table = {}
    for name, arr in sections:
        while len(out) % 8:
            out.append(0)
        table[name] = [len(out), int(arr.size), arr.dtype.str.lstrip("<|")]
        out += arr.tobytes()
    meta = {
        "format": 1,
        "nodes": len(g["node_ids"]),
        "edges": E,
        "profileStep": PROFILE_STEP,
        "heightScale": HEIGHT_SCALE,
        "heightOffset": g["h_offset"],
        "origin": [E0, N0],
        "classes": CLASSES,
        "roadHalfWidth": ROAD_HALF_WIDTH,
        "onewayWidth": ONEWAY_WIDTH,
        "roundabouts": sorted([g["nidx"][c], round(r, 1)] for c, r in g["rb_radius"].items()),
        "surfaces": SURFACES,
        "routes": [{"bit": i, "network": k[0], "ref": k[1], "name": k[2]} for i, k in enumerate(g["route_keys"])],
        "sections": table,
    }
    meta["buildHash"] = hashlib.sha1(bytes(out)).hexdigest()[:12]
    return bytes(out), meta


def _max_grade(s: np.ndarray, h: np.ndarray, window: float = 20.0) -> float:
    """Steepest grade (%) over `window` m along a profile."""
    j = np.searchsorted(s, s + window)
    ok = j < len(s)
    if not ok.any():
        return 0.0
    return float(np.abs((h[j[ok]] - h[ok]) / (s[j[ok]] - s[ok])).max() * 100)


def stats(g: dict) -> str:
    L = sum(s[-1] for s, _ in g["profiles"]) / 1000
    # grade over 20 m windows (single 5 m steps are noisy at edge ends)
    gmax = max((_max_grade(s, h) for s, h in g["profiles"]), default=0.0)
    return f"{len(g['node_ids'])} nodes, {len(g['edges'])} edges, {L:.1f} km, {len(g['sections'])} structures, max grade (20 m) {gmax:.1f} %"


def write(g: dict, out_dir) -> dict:
    blob, meta = encode(g)
    h = meta["buildHash"][:8]
    for old in out_dir.glob("graph.*"):
        old.unlink()
    (out_dir / f"graph.{h}.bin").write_bytes(blob)
    (out_dir / f"graph.{h}.json").write_text(json.dumps(meta, indent=1, sort_keys=True), encoding="utf-8", newline="\n")
    return {"bin": f"graph.{h}.bin", "json": f"graph.{h}.json", "buildHash": meta["buildHash"]}
