# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export Esri 10m Annual LULC map-display tiles at three zoom-dependent
resolution tiers, so the dashboard can show true native 10m detail once
zoomed in, without ever asking the browser to decode more than a few
million pixels in one GeoTIFF.

Reads the same full-resolution source rasters as export_esri_lithuania.py
(rasters/esri/full_res/) — this script only produces the zoomed map-display
tiles; national/sub-basin counts (used for validation) are untouched and
still come from export_esri_lithuania.py.

Tiers (all covering the same fixed Lithuania WGS84 box as the rest of the
dashboard):
  national — whole country, one file/year, ~250m GSD (default/zoomed-out view)
  regional — 4x4 geographic grid, ~50m GSD, one file per populated cell/year
  close    — 16x16 geographic grid, true native 10m GSD, one file per
             populated cell/year (only the cell(s) under the current
             viewport ever need to be fetched by the dashboard)

Cells with no data (e.g. a corner cell entirely outside Lithuania, or over
a neighboring country) are skipped and omitted from the manifest.

Run from Data/:
  python analysis/export_esri_tiles.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
import rasterio.warp
from rasterio.enums import Resampling
from rasterio.transform import from_bounds

from tiling_utils import LT_EAST, LT_NORTH, LT_SOUTH, LT_WEST, cell_bounds, deg_per_pixel

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
SOURCE_DIR = BASE / "rasters" / "esri" / "full_res"
OUT_DIR = BASE / "rasters" / "esri" / "tiles"

DST_CRS = "EPSG:4326"

CLASS_COLORS_HEX = {
    1: "#4DA6FF",
    2: "#7B68EE",
    3: "#FF4D4D",
    4: "#FFD24D",
    5: "#228B22",
}

TIERS = {
    # 100m matches CORINE's proven-safe single-file map resolution (~14M px
    # for the whole country) — the default/zoomed-out view no longer looks
    # noticeably coarser than the other datasets.
    "national": {"gsd_m": 100.0, "grid": 1},
    "regional": {"gsd_m": 50.0, "grid": 4},
    "close": {"gsd_m": 10.0, "grid": 16},
}


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def discover_years() -> dict[int, Path]:
    years = {}
    for tif in SOURCE_DIR.glob("LITHUANIA_*.tif"):
        date_range = tif.stem.split("_", 1)[1]
        years[int(date_range[:4])] = tif
    return dict(sorted(years.items()))


def write_tile(src, out_path: Path, bounds: tuple[float, float, float, float], gsd_m: float) -> bool:
    """Reproject the portion of `src` overlapping `bounds` to WGS84 at gsd_m.

    Returns False (writes nothing) if the resulting tile is entirely nodata.
    """
    west, south, east, north = bounds
    center_lat = (south + north) / 2.0
    res_lon, res_lat = deg_per_pixel(gsd_m, center_lat)
    width = max(1, int(round((east - west) / res_lon)))
    height = max(1, int(round((north - south) / res_lat)))
    dst_transform = from_bounds(west, south, east, north, width, height)
    dst_arr = np.zeros((height, width), dtype=np.uint8)

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
        return False

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=1,
        dtype="uint8",
        crs=DST_CRS,
        transform=dst_transform,
        nodata=0,
        compress="deflate",
        predictor=2,
    ) as dst:
        dst.write(dst_arr, 1)
        dst.write_colormap(1, {code: (*hex_to_rgb(h), 255) for code, h in CLASS_COLORS_HEX.items()})
    return True


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Export Esri map-display tiles.")
    parser.add_argument(
        "--tiers", nargs="+", choices=list(TIERS.keys()), default=None,
        help="Only (re)generate these tiers (default: all). Existing manifest entries for "
        "other tiers are preserved.",
    )
    args = parser.parse_args()
    tiers_to_run = {name: cfg for name, cfg in TIERS.items() if not args.tiers or name in args.tiers}

    years = discover_years()
    if not years:
        raise SystemExit(f"No LITHUANIA_*.tif files found under {SOURCE_DIR}")
    print(f"Found {len(years)} years: {list(years)}")
    print(f"Regenerating tiers: {list(tiers_to_run)}")

    manifest_path = OUT_DIR / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {
            "bbox": {"south": LT_SOUTH, "west": LT_WEST, "north": LT_NORTH, "east": LT_EAST},
            "tiers": {},
        }
    for name, cfg in tiers_to_run.items():
        manifest["tiers"][name] = {"gsd_m": cfg["gsd_m"], "grid": cfg["grid"], "years": {}}

    for year, src_path in years.items():
        print(f"\n=== {year} ({src_path.name}) ===")
        with rasterio.open(src_path) as src:
            for tier_name, cfg in tiers_to_run.items():
                grid = cfg["grid"]
                gsd_m = cfg["gsd_m"]
                written_cells = []
                for row in range(grid):
                    for col in range(grid):
                        bounds = cell_bounds(grid, row, col)
                        out_path = (
                            OUT_DIR / tier_name / f"{year}.tif"
                            if grid == 1
                            else OUT_DIR / tier_name / str(year) / f"{row}_{col}.tif"
                        )
                        ok = write_tile(src, out_path, bounds, gsd_m)
                        if ok:
                            written_cells.append([row, col])
                print(
                    f"  [{tier_name}] {len(written_cells)}/{grid * grid} cells written "
                    f"(~{gsd_m:.0f}m GSD)"
                )
                manifest["tiers"][tier_name]["years"][str(year)] = (
                    True if grid == 1 and written_cells else written_cells
                )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("\nWrote", manifest_path)


if __name__ == "__main__":
    main()
