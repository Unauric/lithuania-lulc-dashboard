# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export a real pre-rendered XYZ tile pyramid for Esri 10m Annual LULC, the
same technique real Sentinel-2 viewers (Copernicus Browser, EO Browser,
etc.) use for smooth zoom/pan: every tile is a small, already-colored PNG
generated once here, offline. The browser then just requests whichever
plain image is in view (via a standard Leaflet L.tileLayer) — no per-tile
GeoTIFF decoding, reprojection, or classification happens in the browser at
all, which is what made the client-side georaster-layer-for-leaflet
approach (export_esri_tiles.py) slow and prone to falling behind during
fast zooming no matter how it was tuned.

Zoom range: 4-12. Beyond z12 the tile count explodes (hundreds of thousands
per year) and pre-generating becomes impractical without a live tile
server, which this static site doesn't have — the existing chunk-based
georaster close tier (already fixed for its own race condition) still
handles z13+, where the geographic area in view is small enough for that
approach to perform fine.

Colors are the same fixed per-class palette used everywhere else in the
dashboard, so the browser can reverse-map a tile's pixel colors back to
class IDs for the class-filter feature (see app.js) without needing a
separate class-ID channel.

Run from Data/:
  python analysis/export_esri_xyz_tiles.py

Optional env:
  ESRI_XYZ_MIN_ZOOM, ESRI_XYZ_MAX_ZOOM — override the default 4-12 range.
"""

from __future__ import annotations

import os
from pathlib import Path

import mercantile
import numpy as np
import rasterio
import rasterio.warp
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds

from tiling_utils import LT_EAST, LT_NORTH, LT_SOUTH, LT_WEST

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
SOURCE_DIR = BASE / "rasters" / "esri" / "full_res"
OUT_DIR = BASE / "rasters" / "esri" / "xyz"

MIN_ZOOM = int(os.environ.get("ESRI_XYZ_MIN_ZOOM", "4"))
MAX_ZOOM = int(os.environ.get("ESRI_XYZ_MAX_ZOOM", "12"))

TILE_SIZE = 256
DST_CRS = "EPSG:3857"

# Same fixed per-class palette as everywhere else in the dashboard — the
# client reverse-maps these exact RGB values back to class IDs for filtering.
CLASS_COLORS_RGBA = {
    1: (0x4D, 0xA6, 0xFF, 255),  # Water
    2: (0x7B, 0x68, 0xEE, 255),  # Wetland
    3: (0xFF, 0x4D, 0x4D, 255),  # Urban
    4: (0xFF, 0xD2, 0x4D, 255),  # Agriculture
    5: (0x22, 0x8B, 0x22, 255),  # Forest
}


def discover_years() -> dict[int, Path]:
    years = {}
    for tif in SOURCE_DIR.glob("LITHUANIA_*.tif"):
        date_range = tif.stem.split("_", 1)[1]
        years[int(date_range[:4])] = tif
    return dict(sorted(years.items()))


def render_tile(src, tile: mercantile.Tile) -> Image.Image | None:
    bounds = mercantile.xy_bounds(tile)  # in EPSG:3857 meters
    dst_transform = from_bounds(bounds.left, bounds.bottom, bounds.right, bounds.top, TILE_SIZE, TILE_SIZE)
    dst_arr = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.uint8)

    rasterio.warp.reproject(
        source=rasterio.band(src, 1),
        destination=dst_arr,
        dst_transform=dst_transform,
        dst_crs=DST_CRS,
        src_nodata=0,
        dst_nodata=0,
        resampling=Resampling.nearest,
    )

    if not np.any(dst_arr):
        return None

    rgba = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    for cid, color in CLASS_COLORS_RGBA.items():
        rgba[dst_arr == cid] = color
    return Image.fromarray(rgba, mode="RGBA")


def main() -> None:
    years = discover_years()
    if not years:
        raise SystemExit(f"No LITHUANIA_*.tif files found under {SOURCE_DIR}")
    print(f"Found {len(years)} years: {list(years)}")
    print(f"Zoom range: {MIN_ZOOM}-{MAX_ZOOM}")

    zoom_levels = list(range(MIN_ZOOM, MAX_ZOOM + 1))
    all_tiles = list(mercantile.tiles(LT_WEST, LT_SOUTH, LT_EAST, LT_NORTH, zoom_levels))
    print(f"Total tiles to attempt per year: {len(all_tiles)}")

    for year, src_path in years.items():
        print(f"\n=== {year} ({src_path.name}) ===")
        written = 0
        with rasterio.open(src_path) as src:
            for tile in all_tiles:
                img = render_tile(src, tile)
                if img is None:
                    continue
                out_path = OUT_DIR / str(year) / str(tile.z) / str(tile.x) / f"{tile.y}.png"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                img.save(out_path, optimize=True)
                written += 1
        print(f"  wrote {written}/{len(all_tiles)} tiles")

    print("\nDone.")


if __name__ == "__main__":
    main()
