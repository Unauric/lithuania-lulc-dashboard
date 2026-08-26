# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export GRPK PLOTAI map-display tiles at three zoom-dependent tiers:
  national — whole country, one raster file, ~250m GSD (coarse default view)
  regional — 4x4 geographic grid, ~50m GSD, one raster file per populated cell
  close    — a finer geographic grid, one GeoJSON file per populated cell
             containing the ACTUAL parcel polygons (true lossless precision,
             not a raster approximation) — only the cell(s) under the current
             viewport ever need loading, so the browser never has to parse
             all ~1.95M parcels at once.

Memory strategy: the source shapefiles have ~1.95M polygons combined
(~3.5GB). Two earlier approaches (loading everything into one GeoDataFrame;
then per-cell geopandas bbox-filtered reads) both caused unbounded memory
growth (>14GB, twice) — geopandas/pyogrio does not release memory reliably
across many repeated reads/reprojections in one process. This version
instead does a SINGLE streaming pass over each shapefile using `pyshp`
(record-by-record, proven low-memory in this codebase already via
build_grpk_reference.py, which streams these exact files today), holding at
most one feature's geometry in memory at a time:
  - raster tiers are painted incrementally into small pre-allocated
    per-cell numpy arrays as each feature streams past (arrays are tiny —
    a few MB total regardless of feature count)
  - vector-tier cells are written incrementally as newline-free JSON
    fragments to per-cell file handles (opened lazily, closed at the end),
    so accumulated feature lists are never held in memory either.

Run from Data/:
  python analysis/export_grpk_tiles.py

Optional env:
  GRPK_SHP_DIR — folder containing PLOTAI_*.shp (default: <repo>/Plots)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pyproj
import rasterio
import shapefile
from rasterio.features import rasterize
from rasterio.transform import Affine, from_bounds
from shapely.geometry import shape as shapely_shape
from shapely.ops import transform as shapely_transform

from export_grpk_lithuania import CLASS_COLORS_HEX, CLASS_TO_ID, PLOTAI_NAMES, find_shp_dir, load_mapping
from tiling_utils import LT_EAST, LT_NORTH, LT_SOUTH, LT_WEST, cell_bounds, deg_per_pixel

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
OUT_DIR = BASE / "rasters" / "grpk" / "tiles"

RASTER_TIERS = {
    "national": {"gsd_m": 250.0, "grid": 1},
    "regional": {"gsd_m": 50.0, "grid": 4},
}

# PLOTAI_1/2/3 are separate cadastral layers that are NOT a clean partition —
# they overlap in real, measured amounts (e.g. broad PLOTAI_2 "sd*"
# agricultural-purpose parcels frequently cover the same ground as PLOTAI_1's
# narrow "hd*" hydrography parcels along rivers). Streaming the files in a
# fixed order and letting the last-processed feature win at each pixel
# (plain rasterize(..., out=bucket.arr)) meant rivers like the Nemunas/Neris
# came out patchy or entirely missing wherever a later-processed overlapping
# parcel happened to cover the same pixel. This priority table makes
# rasterization order-independent: a pixel is only overwritten by a new
# feature if the new feature's class is at least as important as whatever's
# already painted there. Water/wetland (specific, narrow, easy to lose)
# outrank the broad catch-all classes (Agriculture is the untagged default
# and the most likely to be an imprecise/generalized boundary).
CLASS_PRIORITY = {
    CLASS_TO_ID["Water"]: 5,
    CLASS_TO_ID["Wetland"]: 4,
    CLASS_TO_ID["Urban"]: 3,
    CLASS_TO_ID["Forest"]: 2,
    CLASS_TO_ID["Agriculture"]: 1,
}
# Index 0 (nodata/unpainted) always loses to any real class.
_PRIORITY_LUT = np.full(max(CLASS_PRIORITY) + 1, -1, dtype=np.int8)
for _cid, _prio in CLASS_PRIORITY.items():
    _PRIORITY_LUT[_cid] = _prio
# Finer than the raster tiers' grids — vector performance is bounded by
# feature count per cell (~1.95M parcels total), not pixel count, so this
# grid is sized to keep per-cell feature counts in the low thousands.
VECTOR_GRID = 32

_to_wgs84 = pyproj.Transformer.from_crs("EPSG:3346", "EPSG:4326", always_xy=True).transform


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def gkodas_to_class(code: str, rules: list[tuple[str, str]], default: str) -> str:
    c = (code or "").strip().lower()
    if not c:
        return default
    for prefix, cls in rules:
        if c.startswith(prefix):
            return cls
    return default


def cell_index_for_point(lon: float, lat: float, grid: int) -> tuple[int, int] | None:
    if grid <= 1:
        return (0, 0)
    lon_step = (LT_EAST - LT_WEST) / grid
    lat_step = (LT_NORTH - LT_SOUTH) / grid
    col = int((lon - LT_WEST) // lon_step)
    row = int((lat - LT_SOUTH) // lat_step)
    if col < 0 or col >= grid or row < 0 or row >= grid:
        return None
    return (row, col)


def rasterize_priority(geom, cid: int, bucket: "RasterBucket") -> None:
    """Paint `geom` into bucket.arr as class `cid`, but only where `cid`'s
    priority is >= whatever class is already at that pixel (see
    CLASS_PRIORITY) — makes the result independent of which PLOTAI_* file/
    feature happens to reach a given pixel first. Only rasterizes a small
    window scoped to the geometry's own bbox (not the whole bucket array),
    so this stays cheap even at national scale with ~1.95M features."""
    h, w = bucket.arr.shape
    minx, miny, maxx, maxy = geom.bounds
    inv = ~bucket.transform
    c0f, r0f = inv * (minx, maxy)
    c1f, r1f = inv * (maxx, miny)
    col0 = max(0, int(np.floor(min(c0f, c1f))))
    col1 = min(w, int(np.ceil(max(c0f, c1f))) + 1)
    row0 = max(0, int(np.floor(min(r0f, r1f))))
    row1 = min(h, int(np.ceil(max(r0f, r1f))) + 1)
    if col1 <= col0 or row1 <= row0:
        return
    sub_transform = bucket.transform * Affine.translation(col0, row0)
    mask = rasterize([(geom, 1)], out_shape=(row1 - row0, col1 - col0), transform=sub_transform, fill=0, dtype="uint8")
    sub = bucket.arr[row0:row1, col0:col1]
    overwrite = (mask == 1) & (_PRIORITY_LUT[cid] >= _PRIORITY_LUT[sub])
    sub[overwrite] = cid


class RasterBucket:
    __slots__ = ("arr", "transform")

    def __init__(self, west, south, east, north, gsd_m):
        center_lat = (south + north) / 2.0
        res_lon, res_lat = deg_per_pixel(gsd_m, center_lat)
        width = max(1, int(round((east - west) / res_lon)))
        height = max(1, int(round((north - south) / res_lat)))
        self.transform = from_bounds(west, south, east, north, width, height)
        self.arr = np.zeros((height, width), dtype=np.uint8)


class VectorCellWriter:
    """Streams one GeoJSON FeatureCollection per populated close-tier cell,
    writing each feature as it arrives instead of buffering the whole list."""

    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        self._files: dict[tuple[int, int], object] = {}
        self._counts: dict[tuple[int, int], int] = {}

    def add(self, row: int, col: int, class_id: int, class_name: str, geom_wgs84) -> None:
        key = (row, col)
        f = self._files.get(key)
        if f is None:
            self.out_dir.mkdir(parents=True, exist_ok=True)
            f = open(self.out_dir / f"{row}_{col}.geojson", "w", encoding="utf-8")
            f.write('{"type":"FeatureCollection","features":[')
            self._files[key] = f
            self._counts[key] = 0
        if self._counts[key] > 0:
            f.write(",")
        feature = {
            "type": "Feature",
            "properties": {"class_id": int(class_id), "class_name": class_name},
            "geometry": geom_wgs84.__geo_interface__,
        }
        f.write(json.dumps(feature, separators=(",", ":")))
        self._counts[key] += 1

    def close_all(self) -> dict[tuple[int, int], int]:
        for f in self._files.values():
            f.write("]}")
            f.close()
        return dict(self._counts)


def main() -> None:
    shp_dir = find_shp_dir()
    print(f"Streaming GRPK PLOTAI shapefiles from {shp_dir}")

    rules, default = load_mapping()

    raster_buckets: dict[tuple[str, int, int], RasterBucket] = {}
    for tier_name, cfg in RASTER_TIERS.items():
        grid = cfg["grid"]
        gsd_m = cfg["gsd_m"]
        for row in range(grid):
            for col in range(grid):
                west, south, east, north = cell_bounds(grid, row, col)
                raster_buckets[(tier_name, row, col)] = RasterBucket(west, south, east, north, gsd_m)

    vector_writer = VectorCellWriter(OUT_DIR / "vector")

    total_count = 0
    skipped_invalid = 0
    for name in PLOTAI_NAMES:
        shp_path = shp_dir / f"{name}.shp"
        r = shapefile.Reader(str(shp_path))
        field_names = [f[0] for f in r.fields[1:]]
        gkodas_idx = field_names.index("GKODAS")
        file_count = 0
        for shaperec in r.iterShapeRecords():
            file_count += 1
            total_count += 1

            geom_native = shapely_shape(shaperec.shape.__geo_interface__)
            if geom_native.is_empty or not geom_native.is_valid:
                skipped_invalid += 1
                continue

            gkodas = shaperec.record[gkodas_idx]
            cls = gkodas_to_class(str(gkodas) if gkodas is not None else "", rules, default)
            cid = CLASS_TO_ID[cls]

            geom_wgs84 = shapely_transform(_to_wgs84, geom_native)
            minx, miny, maxx, maxy = geom_wgs84.bounds
            cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0

            for tier_name, cfg in RASTER_TIERS.items():
                cell = cell_index_for_point(cx, cy, cfg["grid"])
                if cell is None:
                    continue
                bucket = raster_buckets[(tier_name, *cell)]
                rasterize_priority(geom_wgs84, cid, bucket)

            vcell = cell_index_for_point(cx, cy, VECTOR_GRID)
            if vcell is not None:
                vector_writer.add(vcell[0], vcell[1], cid, cls, geom_wgs84)

            if file_count % 200_000 == 0:
                print(f"  {name}: {file_count} features streamed...")
        print(f"{name}: {file_count} total features")

    print(f"\nStreamed {total_count} features total ({skipped_invalid} invalid/empty skipped)")

    manifest = {
        "bbox": {"south": LT_SOUTH, "west": LT_WEST, "north": LT_NORTH, "east": LT_EAST},
        "raster_tiers": {},
        "vector_tier": {"grid": VECTOR_GRID, "cells": []},
    }

    # --- Write raster tiers ---
    for tier_name, cfg in RASTER_TIERS.items():
        grid = cfg["grid"]
        gsd_m = cfg["gsd_m"]
        written_cells = []
        for row in range(grid):
            for col in range(grid):
                bucket = raster_buckets[(tier_name, row, col)]
                if not np.any(bucket.arr):
                    continue
                out_path = (
                    OUT_DIR / tier_name / "national.tif"
                    if grid == 1
                    else OUT_DIR / tier_name / f"{row}_{col}.tif"
                )
                out_path.parent.mkdir(parents=True, exist_ok=True)
                h, w = bucket.arr.shape
                with rasterio.open(
                    out_path,
                    "w",
                    driver="GTiff",
                    height=h,
                    width=w,
                    count=1,
                    dtype="uint8",
                    crs="EPSG:4326",
                    transform=bucket.transform,
                    nodata=0,
                    compress="deflate",
                    predictor=2,
                ) as dst:
                    dst.write(bucket.arr, 1)
                    dst.write_colormap(
                        1, {code: (*hex_to_rgb(h2), 255) for code, h2 in CLASS_COLORS_HEX.items()}
                    )
                written_cells.append([row, col])
        print(f"[{tier_name}] {len(written_cells)}/{grid * grid} cells written (~{gsd_m:.0f}m GSD)")
        manifest["raster_tiers"][tier_name] = {
            "gsd_m": gsd_m,
            "grid": grid,
            "cells": True if grid == 1 and written_cells else written_cells,
        }

    # --- Close vector-tier files ---
    counts_by_cell = vector_writer.close_all()
    written_vector_cells = [[row, col] for (row, col) in counts_by_cell]
    avg_features = (sum(counts_by_cell.values()) / len(counts_by_cell)) if counts_by_cell else 0
    print(
        f"[vector] {len(written_vector_cells)}/{VECTOR_GRID * VECTOR_GRID} cells written "
        f"(avg {avg_features:.0f} features/cell, max {max(counts_by_cell.values(), default=0)})"
    )
    manifest["vector_tier"]["cells"] = written_vector_cells

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("\nWrote", manifest_path)


if __name__ == "__main__":
    main()
