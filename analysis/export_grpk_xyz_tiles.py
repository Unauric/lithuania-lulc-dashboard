# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export a real pre-rendered XYZ tile pyramid for GRPK's national/regional
raster tiers — the same technique used for Esri (see
export_esri_xyz_tiles.py): every tile is a small, already-colored PNG
generated once here, offline, so the browser just requests plain images via
a standard Leaflet tile layer instead of decoding/reprojecting a GeoTIFF
chunk client-side (georaster-layer-for-leaflet at a coarse internal sample
resolution, which is what made GRPK look blocky/pixelated whenever it
wasn't at the close/vector tier).

Unlike Esri, this doesn't need to touch the ~1.95M-feature PLOTAI source
data again — it reprojects the ALREADY-COMPUTED national.tif (250m) and
regional/*.tif chunks (50m, merged into one mosaic) that export_grpk_tiles.py
already produced, so this runs in well under a minute.

GRPK has no year dimension (single cadastre snapshot), so tile paths are
just rasters/grpk/xyz/{z}/{x}/{y}.png — no year subdirectory.

Zoom range: 4-11, matching the national (z4-8ish) / regional (z9-11ish)
resolution split already used by the tiered chunk system. z12+ keeps using
the real vector polygon tier (already correct, lossless) — this script
doesn't touch that.

Run from Data/:
  python analysis/export_grpk_xyz_tiles.py
"""

from __future__ import annotations

from pathlib import Path

import mercantile
import numpy as np
import rasterio
import rasterio.warp
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds

from export_grpk_lithuania import CLASS_COLORS_HEX, hex_to_rgb
from tiling_utils import LT_EAST, LT_NORTH, LT_SOUTH, LT_WEST, deg_per_pixel

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
TILES_DIR = BASE / "rasters" / "grpk" / "tiles"
OUT_DIR = BASE / "rasters" / "grpk" / "xyz"

MIN_ZOOM = 4
MAX_ZOOM = 11
# Below this zoom, reproject from the coarse national.tif; at/above it,
# reproject from the finer regional mosaic — matches TIER_ZOOM_THRESHOLDS.regional (9) in app.js.
REGIONAL_SWITCH_ZOOM = 9

TILE_SIZE = 256
DST_CRS = "EPSG:3857"

CLASS_COLORS_RGBA = {cid: (*hex_to_rgb(hexcolor), 255) for cid, hexcolor in CLASS_COLORS_HEX.items()}


def render_tile(src, tile: mercantile.Tile) -> Image.Image | None:
    bounds = mercantile.xy_bounds(tile)
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


REGIONAL_GSD_M = 50.0


def build_regional_mosaic() -> Path:
    # export_grpk_tiles.py built each regional chunk with its OWN transform,
    # independently rounded from that chunk's own center latitude (see
    # RasterBucket in export_grpk_tiles.py) — adjacent chunks in different
    # rows therefore end up with slightly different pixel widths for the
    # same longitude span (confirmed: row 1 chunks are 2029px wide, row 2
    # chunks covering the identical lon range are 1989px wide). Naively
    # rasterio.merge()-ing grids that don't actually align pixel-for-pixel
    # leaves thin nodata seams exactly at the original chunk boundaries —
    # this is the "white cross"/"parts of the map get cut out" bug. The fix
    # is to reproject every chunk onto ONE single, consistent target grid
    # (one resolution, one origin, computed from the overall bbox) instead
    # of merging mismatched ones — reprojection resamples properly instead
    # of assuming the inputs already share a lattice.
    chunk_paths = sorted((TILES_DIR / "regional").glob("*.tif"))
    if not chunk_paths:
        raise SystemExit(f"No regional chunk tifs found under {TILES_DIR / 'regional'}")
    print(f"Reprojecting {len(chunk_paths)} regional chunks onto one unified grid...")

    center_lat = (LT_SOUTH + LT_NORTH) / 2.0
    res_lon, res_lat = deg_per_pixel(REGIONAL_GSD_M, center_lat)
    width = max(1, round((LT_EAST - LT_WEST) / res_lon))
    height = max(1, round((LT_NORTH - LT_SOUTH) / res_lat))
    dst_transform = from_bounds(LT_WEST, LT_SOUTH, LT_EAST, LT_NORTH, width, height)
    mosaic_arr = np.zeros((height, width), dtype=np.uint8)

    for p in chunk_paths:
        with rasterio.open(p) as src:
            chunk_arr = np.zeros((height, width), dtype=np.uint8)
            rasterio.warp.reproject(
                source=rasterio.band(src, 1),
                destination=chunk_arr,
                dst_transform=dst_transform,
                dst_crs="EPSG:4326",
                src_nodata=0,
                dst_nodata=0,
                resampling=Resampling.nearest,
            )
            mosaic_arr = np.where(chunk_arr != 0, chunk_arr, mosaic_arr)

    # Even on one shared grid, each regional chunk still has its OWN thin
    # nodata strip right at its edges — export_grpk_tiles.py assigns every
    # feature to the single cell containing its centroid, so a feature
    # straddling a cell boundary never gets rasterized into the neighboring
    # cell at all, regardless of grid alignment. That's a genuine gap in the
    # source data, not a mosaic-construction artifact (confirmed: the
    # ORIGINAL per-cell tif already has 50%+ nodata at its own edge pixels,
    # dropping to <1% just ~50px/2.5km inward). Truly fixing that requires
    # re-rasterizing every feature into every cell it overlaps, which means
    # re-streaming the full ~1.95M-feature source — expensive. As a cheap
    # interim fix, backfill any remaining gap pixels from national.tif: it's
    # a SINGLE whole-country bucket (grid=1), so it never had a cell
    # boundary to lose data across in the first place. It's coarser
    # (250m vs regional's 50m) but only fills the narrow seam strips, so the
    # blockiness is confined to a thin band instead of leaving a visible cut.
    national_path = TILES_DIR / "national" / "national.tif"
    if national_path.exists():
        with rasterio.open(national_path) as nsrc:
            fallback_arr = np.zeros((height, width), dtype=np.uint8)
            rasterio.warp.reproject(
                source=rasterio.band(nsrc, 1),
                destination=fallback_arr,
                dst_transform=dst_transform,
                dst_crs="EPSG:4326",
                src_nodata=0,
                dst_nodata=0,
                resampling=Resampling.nearest,
            )
            mosaic_arr = np.where(mosaic_arr != 0, mosaic_arr, fallback_arr)

    mosaic_path = TILES_DIR / "regional" / "_mosaic.tif"
    with rasterio.open(
        mosaic_path,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=dst_transform,
        nodata=0,
    ) as dst:
        dst.write(mosaic_arr, 1)
    return mosaic_path


def main() -> None:
    national_path = TILES_DIR / "national" / "national.tif"
    if not national_path.exists():
        raise SystemExit(f"Missing {national_path} — run export_grpk_tiles.py first.")
    regional_mosaic_path = build_regional_mosaic()

    zoom_levels_national = list(range(MIN_ZOOM, REGIONAL_SWITCH_ZOOM))
    zoom_levels_regional = list(range(REGIONAL_SWITCH_ZOOM, MAX_ZOOM + 1))

    for label, path, zoom_levels in (
        ("national", national_path, zoom_levels_national),
        ("regional", regional_mosaic_path, zoom_levels_regional),
    ):
        if not zoom_levels:
            continue
        tiles = list(mercantile.tiles(LT_WEST, LT_SOUTH, LT_EAST, LT_NORTH, zoom_levels))
        print(f"\n=== {label} source ({path.name}), zoom {zoom_levels[0]}-{zoom_levels[-1]}, {len(tiles)} candidate tiles ===")
        written = 0
        with rasterio.open(path) as src:
            for tile in tiles:
                img = render_tile(src, tile)
                if img is None:
                    continue
                out_path = OUT_DIR / str(tile.z) / str(tile.x) / f"{tile.y}.png"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                img.save(out_path, optimize=True)
                written += 1
        print(f"  wrote {written}/{len(tiles)} tiles")

    print("\nDone.")


if __name__ == "__main__":
    main()
