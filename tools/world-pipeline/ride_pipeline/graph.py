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

from .dem import Dem
from .geo import E0, N0, cumulative, sample_at, simplify, smooth_1d
from .osm_read import OsmData

# --- enums shared with packages/route-graph/src/format.ts ---------------------------
CLASSES = ["cycleway", "path", "track", "residential", "living_street", "unclassified", "tertiary", "secondary", "primary"]
SURFACES = ["asphalt", "concrete", "paving", "fine_gravel", "gravel", "unpaved", "unknown"]
ATTR_ACCESS_FWD = 1 << 7
ATTR_ACCESS_BWD = 1 << 8
ATTR_CYCLELANE = 1 << 9
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
NODE_BLEND = 40.0  # m over which an edge end is pulled to its node height

NO_BIKE = {"no", "use_sidepath", "private", "dismount"}
BIKE_OK = {"yes", "designated", "permissive"}
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
        return 1 if bike in BIKE_OK else None
    if hw == "track":
        if t.get("tracktype") in ("grade1", "grade2", "grade3") or t.get("surface") in PAVED:
            return 2
        return None
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
        attrs = access_bits(tags) | lane
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

    # 3. junction clusters: roundabouts and short connectors collapse into one node
    uf = _UF()
    for p in pieces:
        uf.find(p.a), uf.find(p.b)
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
    cpos = {c: np.mean([pos[n] for n in ms], axis=0) for c, ms in members.items()}

    edges: list[Edge] = []
    for p in pieces:
        ca, cb = uf.find(p.a), uf.find(p.b)
        if ca == cb:
            continue  # inside a junction cluster
        en = p.en.copy()
        en[0], en[-1] = cpos[ca], cpos[cb]
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
    for ei, e in enumerate(edges):
        en = e.en
        L = float(cumulative(en)[-1])
        s = np.r_[np.arange(0, L, PROFILE_STEP), L] if L % PROFILE_STEP > 1e-6 else np.arange(0, L + 1e-9, PROFILE_STEP)
        pts = sample_at(en, s)
        h = dem.sample(pts[:, 0], pts[:, 1])
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
    return dict(edges=edges, profiles=profiles, sections=sections, node_ids=node_ids, nidx=nidx, cpos=cpos,
                node_h=nh, rb_roots=rb_roots, boundary=bclusters, route_keys=route_keys, h_offset=h_offset)


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
        "surfaces": SURFACES,
        "routes": [{"bit": i, "network": k[0], "ref": k[1], "name": k[2]} for i, k in enumerate(g["route_keys"])],
        "sections": table,
    }
    meta["buildHash"] = hashlib.sha1(bytes(out)).hexdigest()[:12]
    return bytes(out), meta


def stats(g: dict) -> str:
    L = sum(s[-1] for s, _ in g["profiles"]) / 1000
    gmax = 0.0
    for s, h in g["profiles"]:  # grade over 20 m windows (single 5 m steps are noisy at edge ends)
        j = np.searchsorted(s, s + 20)
        ok = j < len(s)
        if ok.any():
            gmax = max(gmax, float(np.abs((h[j[ok]] - h[ok]) / (s[j[ok]] - s[ok])).max() * 100))
    return f"{len(g['node_ids'])} nodes, {len(g['edges'])} edges, {L:.1f} km, {len(g['sections'])} structures, max grade (20 m) {gmax:.1f} %"


def write(g: dict, out_dir) -> dict:
    blob, meta = encode(g)
    h = meta["buildHash"][:8]
    for old in out_dir.glob("graph.*"):
        old.unlink()
    (out_dir / f"graph.{h}.bin").write_bytes(blob)
    (out_dir / f"graph.{h}.json").write_text(json.dumps(meta, indent=1, sort_keys=True), encoding="utf-8")
    return {"bin": f"graph.{h}.bin", "json": f"graph.{h}.json", "buildHash": meta["buildHash"]}
