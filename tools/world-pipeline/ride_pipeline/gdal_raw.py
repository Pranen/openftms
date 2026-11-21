"""Minimal GDAL/OGR access over ctypes for layers pyogrio cannot open (swissBUILDINGS3D 3.0: multipatch
stored as TIN, OGR type 1016 – GDAL reads it, pyogrio's type table does not know it).

Uses the GDAL library bundled with pyogrio, so no extra install is needed.
"""

from __future__ import annotations

import ctypes
import glob
import os
from collections.abc import Iterator
from pathlib import Path

import pyogrio  # noqa: F401  (loads the bundled GDAL and sets GDAL_DATA / PROJ paths)

_lib = None


def _gdal():
    global _lib
    if _lib is None:
        libs = Path(pyogrio.__file__).resolve().parent.parent / "pyogrio.libs"
        os.add_dll_directory(str(libs))
        _lib = ctypes.CDLL(glob.glob(str(libs / "gdal-*.dll"))[0])
        L = _lib
        L.GDALAllRegister()
        L.GDALOpenEx.restype = ctypes.c_void_p
        L.GDALOpenEx.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        L.GDALClose.argtypes = [ctypes.c_void_p]
        L.GDALDatasetGetLayerByName.restype = ctypes.c_void_p
        L.GDALDatasetGetLayerByName.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        L.OGR_L_ResetReading.argtypes = [ctypes.c_void_p]
        L.OGR_L_GetNextFeature.restype = ctypes.c_void_p
        L.OGR_L_GetNextFeature.argtypes = [ctypes.c_void_p]
        L.OGR_F_Destroy.argtypes = [ctypes.c_void_p]
        L.OGR_F_GetGeometryRef.restype = ctypes.c_void_p
        L.OGR_F_GetGeometryRef.argtypes = [ctypes.c_void_p]
        L.OGR_F_GetFieldCount.argtypes = [ctypes.c_void_p]
        L.OGR_F_GetFieldDefnRef.restype = ctypes.c_void_p
        L.OGR_F_GetFieldDefnRef.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.OGR_Fld_GetNameRef.restype = ctypes.c_char_p
        L.OGR_Fld_GetNameRef.argtypes = [ctypes.c_void_p]
        L.OGR_F_IsFieldSetAndNotNull.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.OGR_F_GetFieldAsString.restype = ctypes.c_char_p
        L.OGR_F_GetFieldAsString.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.OGR_G_WkbSize.argtypes = [ctypes.c_void_p]
        L.OGR_G_ExportToIsoWkb.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p]
    return _lib


def features(path: Path, layer: str) -> Iterator[tuple[bytes | None, dict[str, str]]]:
    """(ISO WKB of the geometry, attributes as strings) of every feature of a vector layer."""
    L = _gdal()
    ds = L.GDALOpenEx(str(path).encode(), 0x04, None, None, None)  # GDAL_OF_VECTOR
    if not ds:
        raise OSError(f"GDAL cannot open {path}")
    try:
        lay = L.GDALDatasetGetLayerByName(ds, layer.encode())
        if not lay:
            raise KeyError(f"no layer {layer} in {path}")
        L.OGR_L_ResetReading(lay)
        while True:
            f = L.OGR_L_GetNextFeature(lay)
            if not f:
                break
            try:
                attrs = {}
                for i in range(L.OGR_F_GetFieldCount(f)):
                    if L.OGR_F_IsFieldSetAndNotNull(f, i):
                        name = L.OGR_Fld_GetNameRef(L.OGR_F_GetFieldDefnRef(f, i)).decode()
                        attrs[name] = L.OGR_F_GetFieldAsString(f, i).decode("utf-8", "replace")
                g = L.OGR_F_GetGeometryRef(f)
                wkb = None
                if g:
                    n = L.OGR_G_WkbSize(g)
                    buf = ctypes.create_string_buffer(n)
                    L.OGR_G_ExportToIsoWkb(g, 1, buf)  # wkbNDR
                    wkb = buf.raw
                yield wkb, attrs
            finally:
                L.OGR_F_Destroy(f)
    finally:
        L.GDALClose(ds)
