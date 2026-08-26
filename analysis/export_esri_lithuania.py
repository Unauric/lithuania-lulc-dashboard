# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export our Esri 10m Annual LULC-derived Lithuania mosaic into the dashboard
ecosystem: national timeseries CSV, sub-basin zonal CSV, and a WGS84 GeoTIFF
per year for map display — same shape/conventions as export_corine_lithuania.py,
compute_subbasin_zonal.py, etc.

Source rasters (produced upstream by a separate raw-tile-merging pipeline) live
under rasters/esri/full_res/ in this same repo — LKS94 (EPSG:3346), 10m, already
Lithuania-clipped, already recoded to the 5-class scheme (1=Water, 2=Wetland,
3=Urban, 4=Agriculture, 5=Forest). National and sub-basin counts are computed
directly from these full-resolution rasters for accuracy; only the dashboard's
map-display copy is resampled to WGS84.

This script (and everything it reads) is self-contained within this repo —
no path outside Data/ is referenced, so the repo can be relocated freely.

Run from Data/:
  python analysis/export_esri_lithuania.py
"""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import rasterio.warp
from rasterio.enums import Resampling
from rasterio.mask import mask
from rasterio.transform import from_bounds

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
SOURCE_DIR = BASE / "rasters" / "esri" / "full_res"
SUBBASINS_SHP = BASE / "Lithuania_Subbasins" / "UpiuPabaseiniai.shp"

OUT_GEOTIFF = BASE / "rasters" / "esri" / "geotiff"
OUT_CSV = BASE / "outputs" / "esri_lithuania_timeseries.csv"
OUT_ZONAL_CSV = BASE / "outputs" / "subbasin_zonal_esri.csv"

CLASS_NAMES = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}
CLASS_COLORS_HEX = {
    1: "#4DA6FF",
    2: "#7B68EE",
    3: "#FF4D4D",
    4: "#FFD24D",
    5: "#228B22",
}

# Same WGS84 display box/resolution as export_corine_lithuania.py, so all
# dashboard layers overlay in perfect alignment.
DASHBOARD_SOUTH, DASHBOARD_WEST = 53.45, 20.45
DASHBOARD_NORTH, DASHBOARD_EAST = 56.65, 26.85
DASHBOARD_RES_DEG = 0.005


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def discover_years() -> dict[int, Path]:
    years = {}
    for tif in SOURCE_DIR.glob("LITHUANIA_*.tif"):
        date_range = tif.stem.split("_", 1)[1]
        years[int(date_range[:4])] = tif
    return dict(sorted(years.items()))


def national_counts(tif_path: Path) -> dict[int, int]:
    with rasterio.open(tif_path) as ds:
        arr = ds.read(1)
    values, counts = np.unique(arr[arr != 0], return_counts=True)
    return {int(v): int(c) for v, c in zip(values, counts)}


def subbasin_counts(tif_path: Path, features: list[dict]) -> list[tuple[int, int, int]]:
    """Rows of (basin_index, class_id, count); class_id=0 = total pixels in polygon."""
    rows: list[tuple[int, int, int]] = []
    with rasterio.open(tif_path) as src:
        for basin_index, geom in enumerate(features):
            try:
                out_image, _ = mask(src, [geom], crop=True, indexes=1, filled=False)
            except ValueError:
                continue
            data = out_image
            if isinstance(data, np.ma.MaskedArray):
                within = ~np.ma.getmaskarray(data)
                raw = data.data
            else:
                within = np.ones(data.shape, dtype=bool)
                raw = data
            total = int(within.sum())
            if total == 0:
                continue
            rows.append((basin_index, 0, total))
            classified = raw[within & (raw >= 1) & (raw <= 5)]
            if classified.size == 0:
                continue
            values, counts = np.unique(classified, return_counts=True)
            for v, c in zip(values, counts):
                rows.append((basin_index, int(v), int(c)))
    return rows


def write_dashboard_geotiff(tif_path: Path, out_path: Path) -> None:
    height = int(round((DASHBOARD_NORTH - DASHBOARD_SOUTH) / DASHBOARD_RES_DEG))
    width = int(round((DASHBOARD_EAST - DASHBOARD_WEST) / DASHBOARD_RES_DEG))
    dst_transform = from_bounds(DASHBOARD_WEST, DASHBOARD_SOUTH, DASHBOARD_EAST, DASHBOARD_NORTH, width, height)
    dst_arr = np.zeros((height, width), dtype=np.uint8)

    with rasterio.open(tif_path) as src:
        rasterio.warp.reproject(
            source=rasterio.band(src, 1),
            destination=dst_arr,
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            src_nodata=0,
            dst_nodata=0,
            resampling=Resampling.nearest,
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path,
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
        dst.write(dst_arr, 1)
        dst.write_colormap(1, {code: (*hex_to_rgb(hexcolor), 255) for code, hexcolor in CLASS_COLORS_HEX.items()})


def main() -> None:
    years = discover_years()
    if not years:
        raise SystemExit(f"No LITHUANIA_*.tif files found under {SOURCE_DIR}")
    print(f"Found {len(years)} years: {list(years)}")

    subbasins = gpd.read_file(SUBBASINS_SHP)
    print(f"Loaded {len(subbasins)} sub-basins from {SUBBASINS_SHP.name} (CRS {subbasins.crs})")
    features = [geom.__geo_interface__ for geom in subbasins.geometry]

    national_records = []
    zonal_rows = []

    for year, tif_path in years.items():
        print(f"\n[{year}] national counts...")
        for cid, cnt in national_counts(tif_path).items():
            national_records.append((year, cid, CLASS_NAMES.get(cid, f"class_{cid}"), cnt))

        print(f"[{year}] sub-basin zonal...")
        for basin_index, class_id, count in subbasin_counts(tif_path, features):
            zonal_rows.append((year, basin_index, class_id, count))

        print(f"[{year}] dashboard GeoTIFF...")
        write_dashboard_geotiff(tif_path, OUT_GEOTIFF / f"esri_{year}.tif")

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(national_records, columns=["year", "class_id", "class_name", "count"]).to_csv(OUT_CSV, index=False)
    print("\nSaved", OUT_CSV)

    pd.DataFrame(zonal_rows, columns=["year", "basin_index", "class_id", "count"]).to_csv(OUT_ZONAL_CSV, index=False)
    print("Saved", OUT_ZONAL_CSV)


if __name__ == "__main__":
    main()
