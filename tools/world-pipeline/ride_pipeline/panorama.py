"""Panorama level L4 (64 km tiles, 250 m grid) from the Copernicus DEM GLO-30.

Sampling after C:/data/ski/pipeline/lib/panorama.py: each node is a blend of the
max and the mean over its cell, so summits survive the coarse grid (silhouettes
matter most). Unlike ski's polar ring this is a regular grid in the tile pyramid;
earth curvature is applied in the client's vertex shader relative to the camera.
Inside the area covered by finer tiles the panorama is sunk below the terrain.

Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
2014-2018 provided under COPERNICUS by the European Union and ESA.
"""

from __future__ import annotations

import math

import numpy as np
import rasterio
from rasterio.merge import merge

from . import sources
from .geo import lv95_to_wgs84
from . import tiles as T

LEVEL = 4
SIZE = 64000.0
CELL = SIZE / (T.N - 1)  # 250 m
H_SCALE = 0.1  # m: summits up to 6553 m (Tödi 3614 m is inside L4)
URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{t}_DEM/Copernicus_DSM_COG_10_{t}_DEM.tif"


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

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        col = (lon - self.tf.c) / self.tf.a - 0.5
        row = (lat - self.tf.f) / self.tf.e - 0.5
        i = np.clip(np.floor(col).astype(int), 0, self.h.shape[1] - 2)
        j = np.clip(np.floor(row).astype(int), 0, self.h.shape[0] - 2)
        tx = np.clip(col - i, 0, 1)
        ty = np.clip(row - j, 0, 1)
        h = self.h
        return (h[j, i] * (1 - tx) + h[j, i + 1] * tx) * (1 - ty) + (h[j + 1, i] * (1 - tx) + h[j + 1, i + 1] * tx) * ty


def tile_indices(region: tuple[float, float, float, float]) -> list[tuple[int, int]]:
    e_min, n_min, e_max, n_max = region
    return [(ix, iy) for iy in range(int(n_min // SIZE), int(n_max // SIZE) + 1)
            for ix in range(int(e_min // SIZE), int(e_max // SIZE) + 1)]


def classify(h: np.ndarray, cell: float) -> np.ndarray:
    """Land cover from height and slope (no OSM this far out)."""
    gy, gx = np.gradient(h, cell)
    slope = np.hypot(gx, gy)
    code = np.full(h.shape, T.MEADOW, np.uint8)
    code[h < 650] = T.FARMLAND
    code[(slope > 0.22) & (h < 1800)] = T.FOREST
    code[(h > 1950) | (slope > 0.9)] = T.ROCK
    code[h > 2550] = T.GLACIER
    return code


def build(region: tuple[float, float, float, float], fine_box: tuple[float, float, float, float], out_dir) -> dict[str, str]:
    """L4 tiles covering `region` (LV95); sunk inside `fine_box` (area of the L0 tiles)."""
    idx = tile_indices(region)
    corners = [lv95_to_wgs84(ix * SIZE + dx, iy * SIZE + dy) for ix, iy in idx for dx in (0, SIZE) for dy in (0, SIZE)]
    lat0, lat1 = min(c[0] for c in corners), max(c[0] for c in corners)
    lon0, lon1 = min(c[1] for c in corners), max(c[1] for c in corners)
    dem = Copernicus(lat0, lat1, lon0, lon1)
    (out_dir / f"L{LEVEL}").mkdir(parents=True, exist_ok=True)
    files = {}
    offs = np.linspace(-0.5, 0.5, 5) * CELL
    fe0, fn0, fe1, fn1 = fine_box
    for ix, iy in idx:
        te, tn = ix * SIZE, iy * SIZE
        i = np.arange(T.N)
        E, Nn = np.meshgrid(te + i * CELL, tn + SIZE - i * CELL)
        stack = []
        for du in offs:
            for dv in offs:
                lat, lon = lv95_to_wgs84(E + du, Nn + dv)
                stack.append(dem.sample(lat, lon))
        s = np.stack(stack)
        h = 0.7 * s.max(0) + 0.3 * s.mean(0)
        code = classify(h, CELL)
        # sink below the fine tiles (they draw on top anyway; this keeps gaps and tunnels clean)
        dx = np.maximum(np.maximum(fe0 - E, E - fe1), 0)
        dy = np.maximum(np.maximum(fn0 - Nn, Nn - fn1), 0)
        outside = np.hypot(dx, dy)
        h = h - np.clip(60 - outside / 20, 0, 60)
        name = T.write_tile(out_dir / f"L{LEVEL}", ix, iy,
                            [(b"HGHT", T.encode_heights(h, H_SCALE)), (b"CODE", code.tobytes())],
                            level=LEVEL, size=SIZE, h_scale=H_SCALE)
        files[f"{ix}_{iy}"] = name
        print(f"  L{LEVEL}/{name}  h {h.min():.0f}-{h.max():.0f} m")
    return files
