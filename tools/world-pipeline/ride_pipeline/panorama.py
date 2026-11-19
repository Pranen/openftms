"""Coarse levels L1–L4 of the tile pyramid from the Copernicus DEM GLO-30.

L4 is the panorama (64 km tiles, 250 m grid): after C:/data/ski/pipeline/lib/panorama.py
each node is a blend of the max and the mean over its cell, so summits survive the coarse
grid (silhouettes matter most). L1–L3 (4/8/16 km tiles, 16/32/64 m grid) take the mean
over the cell, which also flattens the forest canopy of the surface model a little.

Unlike ski's polar ring this is a regular pyramid: each tile has 2 x 2 children one level
down (L4 has 4 x 4 L3 tiles). The client hides the part of a coarse tile that a loaded
finer tile covers, so the coarse levels keep their true heights. Earth curvature is applied
in the client's vertex shader relative to the camera.

L1–L3 should come from swissALTI3D inside CH/FL later (M2); Copernicus is a surface model
(trees and houses included) and 30 m only, good enough beyond the 2 x 2 km around the rider.

Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
2014-2018 provided under COPERNICUS by the European Union and ESA.
"""

from __future__ import annotations

import math

import numpy as np
import rasterio
from rasterio.merge import merge
from scipy import ndimage

from . import sources
from . import tiles as T
from .geo import lv95_to_wgs84
from .osm_read import Area

# level -> tile size (m); every coarse level has 257 x 257 nodes like L0
SIZES = {1: 4000.0, 2: 8000.0, 3: 16000.0, 4: 64000.0}
LEVEL = 4
SIZE = SIZES[LEVEL]
CELL = SIZE / (T.N - 1)  # 250 m
CANOPY = 12.0  # m taken off forest cells of L1–L3 (Copernicus measures the treetops)
H_SCALE = 0.1  # m: summits up to 6553 m (Tödi 3614 m is inside L4)
URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{t}_DEM/Copernicus_DSM_COG_10_{t}_DEM.tif"


def cell(level: int) -> float:
    return SIZES[level] / (T.N - 1)


def _tile_name(lat: int, lon: int) -> str:
    return f"N{lat:02d}_00_E{lon:03d}_00"


class Copernicus:
    """Mosaic of 1° GLO-30 tiles with bilinear sampling in WGS84."""

    def __init__(self, lat0: float, lat1: float, lon0: float, lon1: float):
        paths = []
        for lat in range(math.floor(lat0), math.floor(lat1) + 1):
            for lon in range(math.floor(lon0), math.floor(lon1) + 1):
                t = _tile_name(lat, lon)
                paths.append(sources.download(URL.format(t=t), sources.CACHE / "copernicus" / f"glo30_{t}.tif"))
        ds = [rasterio.open(p) for p in paths]
        try:
            arr, tf = merge(ds)
        finally:
            for d in ds:
                d.close()
        self.h = arr[0].astype(np.float32)
        self.tf = tf

    @classmethod
    def for_box(cls, box: tuple[float, float, float, float]) -> "Copernicus":
        e0, n0, e1, n1 = box
        corners = [lv95_to_wgs84(e, n) for e in (e0, e1) for n in (n0, n1)]
        return cls(min(c[0] for c in corners), max(c[0] for c in corners),
                   min(c[1] for c in corners), max(c[1] for c in corners))

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        col = (lon - self.tf.c) / self.tf.a - 0.5
        row = (lat - self.tf.f) / self.tf.e - 0.5
        i = np.clip(np.floor(col).astype(int), 0, self.h.shape[1] - 2)
        j = np.clip(np.floor(row).astype(int), 0, self.h.shape[0] - 2)
        tx = np.clip(col - i, 0, 1)
        ty = np.clip(row - j, 0, 1)
        h = self.h
        return (h[j, i] * (1 - tx) + h[j, i + 1] * tx) * (1 - ty) + (h[j + 1, i] * (1 - tx) + h[j + 1, i + 1] * tx) * ty

    def sample_lv95(self, e, n) -> np.ndarray:
        lat, lon = lv95_to_wgs84(np.asarray(e, float), np.asarray(n, float))
        return self.sample(lat, lon)


def tile_indices(box: tuple[float, float, float, float], size: float) -> list[tuple[int, int]]:
    """Tiles of the given size touching the box (half-open: a box edge on the grid adds no tile)."""
    e_min, n_min, e_max, n_max = box
    return [(ix, iy) for iy in range(math.floor(n_min / size), math.ceil(n_max / size))
            for ix in range(math.floor(e_min / size), math.ceil(e_max / size))]


def classify(h: np.ndarray, cell_m: float) -> np.ndarray:
    """Land cover from height and slope (where OSM has nothing)."""
    gy, gx = np.gradient(h, cell_m)
    slope = np.hypot(gx, gy)
    code = np.full(h.shape, T.MEADOW, np.uint8)
    code[h < 650] = T.FARMLAND
    code[(slope > 0.22) & (h < 1800)] = T.FOREST
    code[(h > 1950) | (slope > 0.9)] = T.ROCK
    code[h > 2550] = T.GLACIER
    return code


def landcover(areas: list[Area], te: float, tn: float, size: float, h: np.ndarray) -> np.ndarray:
    """OSM land cover where it is mapped; far from any mapped polygon (Austria: not in our
    extracts yet) the height/slope guess, so forests do not turn into meadows there."""
    c = size / (T.N - 1)
    osm = T.landcover(areas, te, tn, size=size, fill=255)
    guess = classify(h, c)
    mapped = osm != 255
    if mapped.all():
        return osm
    far = ndimage.distance_transform_edt(~mapped) * c > 400 if mapped.any() else np.ones_like(mapped)
    out = np.where(mapped, osm, np.where(far, guess, T.MEADOW)).astype(np.uint8)
    return out


def build_level(level: int, box: tuple[float, float, float, float], dem: Copernicus, out_dir,
                areas: list[Area] | None = None) -> dict[str, str]:
    """Tiles of `level` covering `box` (LV95). Land cover from OSM `areas` if given, else guessed."""
    size = SIZES[level]
    c = cell(level)
    (out_dir / f"L{level}").mkdir(parents=True, exist_ok=True)
    files = {}
    if level == 4:  # summits survive: blend of max and mean over the cell
        offs = np.linspace(-0.5, 0.5, 5) * c
    else:
        offs = np.linspace(-0.5, 0.5, 3) * c
    for ix, iy in tile_indices(box, size):
        te, tn = ix * size, iy * size
        i = np.arange(T.N)
        E, Nn = np.meshgrid(te + i * c, tn + size - i * c)
        stack = [dem.sample_lv95(E + du, Nn + dv) for du in offs for dv in offs]
        s = np.stack(stack)
        h = 0.7 * s.max(0) + 0.3 * s.mean(0) if level == 4 else s.mean(0)
        code = landcover(areas, te, tn, size, h) if areas is not None else classify(h, c)
        if level < 4:
            # Copernicus is a surface model: take the forest canopy off, or forests stand as
            # plateaus next to the bare-earth L0 tiles (soft edge, the radar sees partly through)
            forest = ndimage.uniform_filter((code == T.FOREST).astype(np.float32), 3, mode="nearest")
            h = h - CANOPY * forest
        name = T.write_tile(out_dir / f"L{level}", ix, iy,
                            [(b"HGHT", T.encode_heights(h, H_SCALE)), (b"CODE", code.tobytes())],
                            level=level, size=size, h_scale=H_SCALE)
        files[f"{ix}_{iy}"] = name
        print(f"  L{level}/{name}  h {h.min():.0f}-{h.max():.0f} m")
    # drop tiles of earlier builds that are no longer part of the level
    for old in (out_dir / f"L{level}").glob("*.bin"):
        if old.name not in files.values():
            old.unlink()
    return files
