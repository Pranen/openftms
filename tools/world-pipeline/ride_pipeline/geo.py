"""Coordinate helpers: WGS84 <-> Swiss LV95 (EPSG:2056) and the Ride world frame.

The LV95 formulas are copied from C:/data/ski/pipeline/lib/geo.py (swisstopo's
approximate formulas, ~1 m accuracy in and near Switzerland and Liechtenstein).

World frame (shared with the client, see apps/ride/PLAN.md):
    x = E - E0   (east)
    y = height   (metres above sea level)
    z = N0 - N   (south)
"""

from __future__ import annotations

import numpy as np

# Region origin (roughly the centre of Feldkirch – Landquart – Walenstadt – Oberriet).
E0 = 2_754_000.0
N0 = 1_222_000.0


def wgs84_to_lv95(lat, lon):
    """Latitude/longitude in degrees -> (E, N) in metres. Works on scalars and arrays."""
    p = (np.asarray(lat) * 3600 - 169028.66) / 10000
    l = (np.asarray(lon) * 3600 - 26782.5) / 10000
    e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l**3
    n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p**3
    return e, n


def lv95_to_wgs84(e, n):
    """(E, N) in metres -> (lat, lon) in degrees."""
    y = (np.asarray(e) - 2600000) / 1e6
    x = (np.asarray(n) - 1200000) / 1e6
    lon = (2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y**3) * 100 / 36
    lat = (16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x**3) * 100 / 36
    return lat, lon


def to_world(e, n):
    """LV95 -> world x/z."""
    return np.asarray(e) - E0, N0 - np.asarray(n)


def polyline_length(line: np.ndarray) -> float:
    return float(np.hypot(*np.diff(line, axis=0).T).sum()) if len(line) > 1 else 0.0


def cumulative(line: np.ndarray) -> np.ndarray:
    """Arc length at every vertex of an (n, 2) polyline."""
    return np.r_[0.0, np.cumsum(np.hypot(*np.diff(line, axis=0).T))]


def sample_at(line: np.ndarray, s: np.ndarray) -> np.ndarray:
    """Points of the polyline at arc lengths s."""
    seg = cumulative(line)
    return np.c_[np.interp(s, seg, line[:, 0]), np.interp(s, seg, line[:, 1])]


def simplify(line: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker, keeps both end points."""
    if len(line) < 3:
        return line
    keep = np.zeros(len(line), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = line[a], line[b]
        d = q - p
        L = float(np.hypot(*d))
        pts = line[a + 1:b]
        if L < 1e-9:
            dist = np.hypot(*(pts - p).T)
        else:
            dist = np.abs(d[0] * (pts[:, 1] - p[1]) - d[1] * (pts[:, 0] - p[0])) / L
        i = int(np.argmax(dist))
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return line[keep]


def smooth_1d(values: np.ndarray, window: int) -> np.ndarray:
    """Moving average with end padding (window in samples, odd)."""
    if window < 3 or len(values) < 3:
        return values
    window = min(window, len(values) | 1)
    k = np.ones(window) / window
    pad = window // 2
    padded = np.r_[np.full(pad, values[0]), values, np.full(pad, values[-1])]
    return np.convolve(padded, k, mode="valid")[: len(values)]
