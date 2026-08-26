# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export CORINE (CLC) land cover for Lithuania into:
  - polygon-masked PNG rasters (dashboard style)
  - GeoTIFF rasters (rasters/corine/geotiff/) for web display – zoomable, no quality loss
  - per-class area CSV, comparable to HILDA / LUCAS / HYDE / LUH2.
  - per-sub-basin zonal CSV (outputs/subbasin_zonal_corine.csv)

National and sub-basin counts are computed directly from the native ~100m CORINE
rasters (in their native EPSG:3035 grid) for accuracy — same principle as
export_esri_lithuania.py. The dashboard's map-display GeoTIFF/PNG copy is
reprojected to WGS84 at CORINE's native ~100m pixel size (not downsampled).

Run (in landcover2 env, from Data/):
  python analysis/export_corine_lithuania.py

Optional env:
  CORINE_SOURCE_DIR — folder containing the u2018_clc*_raster100m subfolders
    (default: <repo>/Data/CORINE/Results)

The dashboard uses GeoTIFF when available for CORINE; falls back to PNG otherwise.
"""

from pathlib import Path
import json
import math
import os

from shapely.geometry import shape
from shapely.ops import unary_union
import numpy as np
import pandas as pd
import rasterio
import rasterio.mask
import rasterio.warp
from rasterio.features import geometry_mask
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap


BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
LT_GEOJSON = BASE / "lt_boundary_admin.json"
SUBBASINS_GEOJSON = BASE / "lt_subbasins.json"
CORINE_STATES_DIR = Path(
    os.environ.get(
        "CORINE_SOURCE_DIR",
        str(BASE / "CORINE" / "Results"),
    )
)

# Discover all CORINE GeoTIFFs under States and infer year from filename.
# Each Copernicus download extracts as a single-level "<name>/DATA/<file>.tif".
CORINE_TIFS: dict[int, Path] = {
    1990: CORINE_STATES_DIR
        / "u2000_clc1990_v2020_20u1_raster100m" / "DATA"
        / "U2000_CLC1990_V2020_20u1.tif",
    2000: CORINE_STATES_DIR
        / "u2006_clc2000_v2020_20u1_raster100m" / "DATA"
        / "U2006_CLC2000_V2020_20u1.tif",
    2006: CORINE_STATES_DIR
        / "u2012_clc2006_v2020_20u1_raster100m" / "DATA"
        / "U2012_CLC2006_V2020_20u1.tif",
    2012: CORINE_STATES_DIR
        / "u2018_clc2012_v2020_20u1_raster100m" / "DATA"
        / "U2018_CLC2012_V2020_20u1.tif",
    2018: CORINE_STATES_DIR
        / "u2018_clc2018_v2020_20u1_raster100m" / "DATA"
        / "U2018_CLC2018_V2020_20u1.tif",
}
OUT_RASTERS = BASE / "rasters" / "corine"
OUT_GEOTIFF = OUT_RASTERS / "geotiff"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_GEOTIFF.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "corine_lithuania_timeseries.csv"
OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
OUT_ZONAL_CSV = BASE / "outputs" / "subbasin_zonal_corine.csv"

with open(SUBBASINS_GEOJSON, "r", encoding="utf-8") as f:
    _subbasins_fc = json.load(f)
SUBBASIN_FEATURES = _subbasins_fc.get("features") or []


# Lithuania polygon (GeoJSON already in EPSG:4326) – union of all admin units
with open(LT_GEOJSON, "r", encoding="utf-8") as f:
    lt_data = json.load(f)
geoms = [shape(feat["geometry"]) for feat in lt_data["features"]]
lt_geom = unary_union(geoms)


def load_lt_mask_for_dataset(src: rasterio.io.DatasetReader):
    """Reproject LT polygon to match the raster CRS and return a mask + transform."""
    if src.crs is None:
        raise ValueError("CORINE raster has no CRS; cannot mask.")

    # Reproject geometry to raster CRS
    lt_proj = rasterio.warp.transform_geom(
        "EPSG:4326", src.crs, lt_geom.__geo_interface__
    )
    return lt_proj


# CLC → 5-class mapping (CORINE Level 1 = first digit of the 3-digit CLC code).
#
# Official CORINE nomenclature (EEA): the hundreds digit groups all subclasses:
#   1xx — Artificial land (urban / infrastructure)  → dashboard Urban (id 3)
#   2xx — Agricultural areas                         → dashboard Agriculture (id 4)
#   3xx — Forest and semi-natural (incl. grassland, shrub) → dashboard Forest (id 5)
#   4xx — Wetlands                                   → dashboard Wetlands (id 2)
#   5xx — Water bodies                               → dashboard Water (id 1)
#
# Dashboard ids 1–5 are [Water, Wetlands, Urban, Agriculture, Forest]; they are not the
# same as CORINE’s leading digit (CORINE “1” is urban, not water).
def corine_to_five_classes(arr: np.ndarray) -> np.ndarray:
    """
    Map raster compact class index (1..N) to full CLC codes, then collapse by Level 1
    (first digit × 100) into five harmonised classes:
      1=Water, 2=Wetlands, 3=Urban, 4=Agriculture, 5=Forest.
    Unmapped hundreds / nodata (999) → NaN.
    """
    out = np.full(arr.shape, np.nan, dtype="float32")
    idx = arr.astype("int32")

    # Table: compact index -> full 3‑digit CLC code, in the exact order
    # of the legend snippet you provided.
    index_to_clc = np.array(
        [
            111, 112, 121, 122, 123, 124, 131, 132, 133, 141,
            142, 211, 212, 213, 221, 222, 223, 231, 241, 242,
            243, 244, 311, 312, 313, 321, 322, 323, 324, 331,
            332, 333, 334, 335, 411, 412, 421, 422, 423, 511,
            512, 521, 522, 523, 999,  # last entry = NODATA
        ],
        dtype="int32",
    )

    clc = np.full_like(idx, 999)
    valid = (idx >= 1) & (idx <= len(index_to_clc))
    clc[valid] = index_to_clc[idx[valid] - 1]

    hundreds = (clc // 100) * 100

    out[hundreds == 500] = 1  # Water
    out[hundreds == 400] = 2  # Wetlands
    out[hundreds == 100] = 3  # Urban
    out[hundreds == 200] = 4  # Agriculture
    out[hundreds == 300] = 5  # Forest / semi‑natural

    out[clc == 999] = np.nan
    return out


class_names = {1: "Water", 2: "Wetlands", 3: "Urban", 4: "Agriculture", 5: "Forest"}
colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
cmap = ListedColormap(colors)
cmap.set_bad((0, 0, 0, 0))
norm = matplotlib.colors.Normalize(vmin=1, vmax=5)


records: list[tuple[int, int, str, int]] = []
zonal_rows: list[tuple[int, int, int, int]] = []


def zonal_counts_for_polygon(
    arr_classes_native: np.ndarray, native_transform, geom_native
) -> tuple[dict[int, int], int]:
    """Class counts + total pixel count within one polygon, computed directly
    against the native-resolution classified array (no raster resampling)."""
    within = geometry_mask(
        [geom_native], out_shape=arr_classes_native.shape, transform=native_transform, invert=True
    )
    total = int(within.sum())
    if total == 0:
        return {}, 0
    vals = arr_classes_native[within]
    valid = vals[np.isfinite(vals)].astype(int)
    if valid.size == 0:
        return {}, total
    uniq, cnts = np.unique(valid, return_counts=True)
    return {int(u): int(c) for u, c in zip(uniq, cnts, strict=False)}, total


for year, tif_path in sorted(CORINE_TIFS.items()):
    if not tif_path.exists():
        print(f"Skipping CORINE {year}: {tif_path} does not exist.")
        continue

    print(f"Processing CORINE {year}:", tif_path)

    with rasterio.open(tif_path) as src:
        lt_proj = load_lt_mask_for_dataset(src)
        # Mask to LT polygon in native CRS (EPSG:3035)
        data, transform = rasterio.mask.mask(
            src, [lt_proj], crop=True, nodata=src.nodata
        )
        arr_raw = data[0]
        src_crs = src.crs

        # --- National + sub-basin counts: computed directly from the native
        # ~100m array above, in its native CRS — no resampling, full precision.
        arr_classes_native = corine_to_five_classes(arr_raw)

        flat = arr_classes_native[np.isfinite(arr_classes_native)].astype(int)
        if flat.size:
            uniq, cnts = np.unique(flat, return_counts=True)
            for cls_id, cnt in zip(uniq, cnts, strict=False):
                cls_id = int(cls_id)
                cls_name = class_names.get(cls_id, f"class_{cls_id}")
                records.append((int(year), cls_id, cls_name, int(cnt)))

        for basin_index, feat in enumerate(SUBBASIN_FEATURES):
            geom_native = rasterio.warp.transform_geom("EPSG:4326", src_crs, feat["geometry"])
            counts, total = zonal_counts_for_polygon(arr_classes_native, transform, geom_native)
            if total > 0:
                zonal_rows.append((year, basin_index, 0, total))
                for cid, cnt in counts.items():
                    if cnt > 0:
                        zonal_rows.append((year, basin_index, cid, cnt))

        # --- Reproject masked CORINE to WGS84 grid used by the dashboard's
        # map display only (national/sub-basin counts above are unaffected) --

        dst_crs = "EPSG:4326"

        # Lithuania box used in the dashboard (slightly expanded for better edge match)
        south, west = 53.45, 20.45
        north, east = 56.65, 26.85

        # Match CORINE's native ~100m pixel size instead of downsampling to a
        # coarser shared grid — degrees-per-pixel differs between the lat and
        # lon axes, so convert each separately at the box's center latitude.
        native_gsd_m = 100.0
        center_lat = (south + north) / 2.0
        meters_per_deg_lat = 111_320.0
        meters_per_deg_lon = 111_320.0 * math.cos(math.radians(center_lat))
        res_lat = native_gsd_m / meters_per_deg_lat
        res_lon = native_gsd_m / meters_per_deg_lon
        height = int(round((north - south) / res_lat))
        width = int(round((east - west) / res_lon))

        from rasterio.transform import from_bounds

        dst_transform = from_bounds(west, south, east, north, width, height)

        dst_arr = np.full(
            (height, width),
            src.nodata if src.nodata is not None else 0,
            dtype=arr_raw.dtype,
        )

        rasterio.warp.reproject(
            source=arr_raw,
            destination=dst_arr,
            src_transform=transform,
            src_crs=src.crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            resampling=rasterio.warp.Resampling.nearest,
        )

        arr_wgs84 = dst_arr  # from here on, everything is in WGS84 aligned to the map box

    # Reclass to 5 classes (map-display copy only — national/sub-basin counts
    # were already computed above from the native-resolution array).
    arr_classes = corine_to_five_classes(arr_wgs84)

    # Save PNG in dashboard style, using LT bounds in EPSG:4326
    bounds = [
        [53.5, 20.5],
        [56.6, 26.85],
    ]

    rgba = cmap(norm(arr_classes))
    out_png = OUT_RASTERS / f"corine_{int(year)}.png"
    plt.imsave(out_png, rgba)
    print("Saved", out_png)

    # Save GeoTIFF for web (WGS84, uint8, 1–5=classes, 0=nodata)
    arr_uint8 = np.where(np.isfinite(arr_classes), arr_classes.astype(np.uint8), 0)
    out_tif = OUT_GEOTIFF / f"corine_{int(year)}.tif"
    with rasterio.open(
        out_tif,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=1,
        dtype=arr_uint8.dtype,
        crs=dst_crs,
        transform=dst_transform,
        nodata=0,
    ) as dst:
        dst.write(arr_uint8, 1)
    print("Saved", out_tif)

df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
df.to_csv(OUT_CSV, index=False)
print("Saved CSV:", OUT_CSV)

zonal_df = pd.DataFrame(zonal_rows, columns=["year", "basin_index", "class_id", "count"])
zonal_df.to_csv(OUT_ZONAL_CSV, index=False)
print("Saved sub-basin zonal CSV:", OUT_ZONAL_CSV)

