# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Excludes Kursiu marios (Curonian Lagoon) and Lithuania's Baltic Sea coastal
waters from CORINE CLC's map display and national timeseries stats, mirroring
apply_grpk_water_exclusion.py's treatment of the same problem on GRPK.

Why: CORINE's raw source classifies this open water as CLC 512/523 (Water
bodies / Sea and ocean) same as any other water, so it shows up as "Water"
in the dashboard the same way GRPK's cadastre did — inflating Water share
relative to datasets whose own boundary mask happens to exclude it, which is
exactly what made the pie/bar charts not comparable side by side.

Reuses the same exclusion polygon as GRPK (analysis/reference_geo/
grpk_water_exclusion.geojson, built from real OSM coastline + the Kursiu
marios bay relation) since it's dataset-agnostic real-world geometry, not
GRPK-specific.

Unlike GRPK, CORINE's national timeseries/sub-basin CSVs are computed by
export_corine_lithuania.py from a *native EPSG:3035* array that isn't
persisted anywhere (only the WGS84-reprojected dashboard copy is saved) — so
this script recomputes outputs/corine_lithuania_timeseries.csv from the
patched WGS84 dashboard GeoTIFFs (pixel-count based) instead of the exact
native-CRS method the export script used, the same trade-off GRPK's
apply script already made for the same reason (avoids re-running the full,
slow native-resolution export). Sub-basin zonal stats
(outputs/subbasin_zonal_corine.csv) are deliberately left untouched: checked
directly, the exclusion polygon overlaps sub-basin polygons by at most
~0.24% of any one basin's area (thin boundary-alignment slivers, not real
lagoon/sea coverage — sub-basins are river catchments and don't meaningfully
include the open water being excluded here), so recomputing it would not
change any visible number.

Run from Data/:
  python analysis/apply_corine_water_exclusion.py
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from matplotlib.colors import ListedColormap
from rasterio.features import geometry_mask
from shapely.geometry import shape

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
EXCLUSION_PATH = BASE / "analysis" / "reference_geo" / "grpk_water_exclusion.geojson"

GEOTIFF_DIR = BASE / "rasters" / "corine" / "geotiff"
PNG_DIR = BASE / "rasters" / "corine"
TIMESERIES_CSV = BASE / "outputs" / "corine_lithuania_timeseries.csv"

CLASS_ORDER = ["Water", "Wetlands", "Urban", "Agriculture", "Forest"]
CLASS_TO_ID = {name: i + 1 for i, name in enumerate(CLASS_ORDER)}

COLORS = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
CMAP = ListedColormap(COLORS)
CMAP.set_bad((0, 0, 0, 0))
NORM = matplotlib.colors.Normalize(vmin=1, vmax=5)


def load_exclusion_geom():
    with open(EXCLUSION_PATH, encoding="utf-8") as f:
        feat = json.load(f)
    return shape(feat["geometry"])


def mask_raster(path: Path, geom) -> np.ndarray:
    with rasterio.open(path) as src:
        arr = src.read(1)
        profile = src.profile
        transform = src.transform
    excl_mask = geometry_mask([geom], out_shape=arr.shape, transform=transform, invert=True)
    n_before = int(np.count_nonzero(arr == 1))
    arr[excl_mask] = 0
    n_after = int(np.count_nonzero(arr == 1))
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)
    print(f"  {path.relative_to(BASE)}: Water pixels {n_before} -> {n_after} (removed {n_before - n_after})")
    return arr


def rewrite_png(year: int, arr: np.ndarray) -> None:
    arr_float = np.where(arr == 0, np.nan, arr).astype("float32")
    rgba = CMAP(NORM(arr_float))
    out_png = PNG_DIR / f"corine_{year}.png"
    plt.imsave(out_png, rgba)
    print(f"  rewrote {out_png.relative_to(BASE)}")


def recompute_timeseries_csv(patched: dict[int, np.ndarray]) -> None:
    rows = ["year,class_id,class_name,count"]
    for year in sorted(patched):
        arr = patched[year]
        vals, counts = np.unique(arr[arr != 0], return_counts=True)
        counts_by_id = dict(zip(vals.tolist(), counts.tolist()))
        for name in CLASS_ORDER:
            cid = CLASS_TO_ID[name]
            rows.append(f"{year},{cid},{name},{counts_by_id.get(cid, 0)}")
    with open(TIMESERIES_CSV, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    print(f"Rewrote {TIMESERIES_CSV.relative_to(BASE)} ({len(patched)} years)")


def main() -> None:
    geom = load_exclusion_geom()
    tif_paths = sorted(GEOTIFF_DIR.glob("corine_*.tif"))
    if not tif_paths:
        print(f"No CORINE GeoTIFFs found under {GEOTIFF_DIR}")
        return

    print("Masking CORINE dashboard rasters...")
    patched: dict[int, np.ndarray] = {}
    for p in tif_paths:
        year = int(p.stem.split("_")[-1])
        patched[year] = mask_raster(p, geom)

    print("Regenerating PNG overlays...")
    for year, arr in patched.items():
        rewrite_png(year, arr)

    recompute_timeseries_csv(patched)
    print("\nDone. CORINE map display + national timeseries now exclude Kursiu marios / Baltic Sea waters.")


if __name__ == "__main__":
    main()
