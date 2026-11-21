"""2 m elevation model of the region, loaded lazily in 2 km blocks (mosaic logic after
C:/data/ski/pipeline/lib/terrain.py).

The whole region at 2 m would be ~6 GB as one array, so the model keeps a few blocks (with a margin, so
bilinear sampling and the 8 m box filter agree across block borders) in an LRU cache. Sources per block:
swissALTI3D (CH, FL), where it has no data the BEV laser scan (Austria, 1 m averaged to 2 m), then the
fallback (Copernicus) and finally the nearest valid value for small holes.
"""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from scipy import ndimage

from . import sources

BLOCK = 2000.0
MARGIN = 64.0
SMOOTH = 8.0  # box filter of the "smoothed" grid (one terrain cell)


class Dem:
    def __init__(self, paths: list[Path], e_min: float, n_min: float, e_max: float, n_max: float, cell: float = 2.0,
                 fill=None, austria: bool = True, cache_blocks: int = 36):
        """paths: swissALTI3D 1 km tiles (file names carry E-N in km). fill(e, n) -> heights for cells no
        laser scan covers. austria: use the BEV scan where swissALTI3D has no data."""
        self.tiles: dict[tuple[int, int], Path] = {}
        for p in paths:
            e, n = (int(v) for v in p.name.split("_")[2].split("-"))
            self.tiles[(e, n)] = p
        self.box = (e_min, n_min, e_max, n_max)
        self.cell = cell
        self.fill = fill
        self.austria = austria
        self.cache: OrderedDict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = OrderedDict()
        self.cache_blocks = cache_blocks
        self.filled = 0  # cells taken from BEV / fallback (statistics)

    # --- blocks ------------------------------------------------------------------------

    def _origin(self, bi: int, bj: int) -> tuple[float, float]:
        """Cell-centre coordinates of the first column (west) and row (north) of a block."""
        return bi * BLOCK - MARGIN + self.cell / 2, (bj + 1) * BLOCK + MARGIN - self.cell / 2

    def _load(self, bi: int, bj: int) -> tuple[np.ndarray, np.ndarray]:
        e0, n0 = bi * BLOCK - MARGIN, bj * BLOCK - MARGIN
        e1, n1 = (bi + 1) * BLOCK + MARGIN, (bj + 1) * BLOCK + MARGIN
        size = int(round((e1 - e0) / self.cell))
        h = np.full((size, size), -9999.0, np.float32)
        paths = [p for (e, n), p in self.tiles.items()
                 if e * 1000 < e1 and (e + 1) * 1000 > e0 and n * 1000 < n1 and (n + 1) * 1000 > n0]
        if paths:
            datasets = [rasterio.open(p) for p in sorted(paths)]
            try:
                arr, _ = merge(datasets, bounds=(e0, n0, e1, n1), res=self.cell, nodata=-9999)
            finally:
                for d in datasets:
                    d.close()
            h = arr[0].astype(np.float32)
        bad = h < -1000
        if bad.any() and self.austria:
            try:
                bev = sources.bev_raster("DTM", e0, n0, e1, n1, self.cell)
                with rasterio.open(bev) as src:
                    b = src.read(1)
                ok = bad & (b > -1000)
                h[ok] = b[ok]
                bad = h < -1000
            except Exception as ex:  # outside the BEV coverage (or offline): the fallback takes over
                print(f"  BEV for block {bi}_{bj}: {ex}")
        if bad.any() and self.fill is not None:
            rows, cols = np.nonzero(bad)
            e = e0 + (cols + 0.5) * self.cell
            n = n1 - (rows + 0.5) * self.cell
            h[rows, cols] = self.fill(e, n)
            self.filled += int(bad.sum())
            bad = h < -1000
        if bad.any():
            if bad.mean() > 0.5:
                raise RuntimeError(f"block {bi}_{bj}: {bad.mean():.0%} of the elevation grid has no data")
            idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
            h = h[tuple(idx)]
        k = max(1, int(round(SMOOTH / self.cell)))
        return h, ndimage.uniform_filter(h, k, mode="nearest")

    def _block(self, bi: int, bj: int) -> tuple[np.ndarray, np.ndarray]:
        key = (bi, bj)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        b = self._load(bi, bj)
        self.cache[key] = b
        while len(self.cache) > self.cache_blocks:
            self.cache.popitem(last=False)
        return b

    # --- sampling ----------------------------------------------------------------------

    def sample(self, e, n, smooth: bool = False) -> np.ndarray:
        """Bilinear height at LV95 points (arrays of any shape); smooth: from the 8 m box-filtered grid.
        Points are processed block by block, so large batches load each block once."""
        e = np.asarray(e, float)
        n = np.asarray(n, float)
        shape = e.shape
        ef, nf = e.ravel(), n.ravel()
        out = np.empty(ef.shape, np.float64)
        bi = np.floor(ef / BLOCK).astype(np.int64)
        bj = np.floor(nf / BLOCK).astype(np.int64)
        key = bi * 100000 + bj
        order = np.argsort(key, kind="stable")
        ks = key[order]
        starts = np.r_[0, np.nonzero(np.diff(ks))[0] + 1]
        ends = np.r_[starts[1:], len(ks)]
        for a, b in zip(starts, ends):
            sel = order[a:b]
            i, j = int(bi[sel[0]]), int(bj[sel[0]])
            raw, sm = self._block(i, j)
            g = sm if smooth else raw
            ew, nn = self._origin(i, j)
            col = (ef[sel] - ew) / self.cell
            row = (nn - nf[sel]) / self.cell
            out[sel] = ndimage.map_coordinates(g, [row, col], order=1, mode="nearest")
        return out.reshape(shape)

    def sample_many(self, points: list[np.ndarray], smooth: bool = False) -> list[np.ndarray]:
        """Heights for several (k, 2) point arrays in one batch (each block loaded once)."""
        if not points:
            return []
        allp = np.vstack(points)
        h = self.sample(allp[:, 0], allp[:, 1], smooth)
        out, k = [], 0
        for p in points:
            out.append(h[k:k + len(p)])
            k += len(p)
        return out
