"""2 m elevation mosaic of the build box with bilinear sampling (mosaic logic after
C:/data/ski/pipeline/lib/terrain.py)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from scipy import ndimage


class Dem:
    def __init__(self, paths: list[Path], e_min: float, n_min: float, e_max: float, n_max: float, cell: float = 2.0,
                 fill=None):
        """fill(e, n) -> heights: source for cells swissALTI3D does not cover (Austria next to the
        border: Copernicus until the BEV data comes with M2). Without it, more than 2 % holes fail."""
        datasets = [rasterio.open(p) for p in paths]
        try:
            arr, transform = merge(datasets, bounds=(e_min, n_min, e_max, n_max), res=cell, nodata=-9999)
        finally:
            for d in datasets:
                d.close()
        h = arr[0].astype(np.float64)
        bad = h < -1000
        if bad.any() and fill is not None:
            rows, cols = np.nonzero(bad)
            e = transform.c + (cols + 0.5) * cell
            n = transform.f - (rows + 0.5) * cell
            h[rows, cols] = fill(e, n)
            print(f"  {bad.mean():.1%} of the elevation grid filled from the fallback source")
            bad = h < -1000
        if bad.any():
            if bad.mean() > 0.02:
                raise RuntimeError(f"{bad.mean():.1%} of the elevation grid has no data")
            # fill small holes with the nearest valid value
            idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
            h = h[tuple(idx)]
        self.h = h
        self.cell = cell
        # pixel-is-area: transform origin is the corner; samples are cell centres
        self.e_west = transform.c + cell / 2
        self.n_north = transform.f - cell / 2

    def sample(self, e, n, grid: np.ndarray | None = None) -> np.ndarray:
        """Bilinear height at LV95 points (arrays)."""
        g = self.h if grid is None else grid
        col = (np.asarray(e, float) - self.e_west) / self.cell
        row = (self.n_north - np.asarray(n, float)) / self.cell
        return ndimage.map_coordinates(g, [row, col], order=1, mode="nearest")

    def smoothed(self, size_m: float) -> np.ndarray:
        """Box-filtered grid (average over size_m), e.g. for 8 m terrain nodes."""
        k = max(1, int(round(size_m / self.cell)))
        return ndimage.uniform_filter(self.h, k, mode="nearest")
