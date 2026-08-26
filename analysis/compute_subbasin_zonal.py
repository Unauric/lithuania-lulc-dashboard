# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

"""
Pre-compute land-cover class counts per sub-basin polygon for each exported GeoTIFF year.

This keeps the dashboard fast: the browser only loads a CSV and plots — no client-side
GeoTIFF sampling (which caused lag).

Uses **rasterio** + **numpy** only (no rasterstats / Fiona). On Windows, ``rasterstats`` imports
Fiona, which often fails with ``DLL load failed`` even when packages show as installed; this script avoids that.

Requirements:
  pip install rasterio numpy

Run from repo root:
  python analysis/compute_subbasin_zonal.py
  python analysis/compute_subbasin_zonal.py --dataset hilda

Outputs (one CSV per dataset):
  outputs/subbasin_zonal_hilda.csv
  ...

CSV columns: year,basin_index,class_id,count
  class_id=0: total pixels within basin polygon (includes classified + unclassified)
  class_id=1: Water
  class_id=2: Wetland
  class_id=3: Urban
  class_id=4: Agriculture
  class_id=5: Forest / HYDE “Natural (residual)”
  (class values match GeoTIFF raster values)

"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SUBBASINS_PATH = BASE / "lt_subbasins.json"
OUT_DIR = BASE / "outputs"

# Note: "esri" and "corine" are intentionally absent here — both write their own
# subbasin_zonal_{name}.csv directly (export_esri_lithuania.py,
# export_corine_lithuania.py), computed from their native-resolution source
# rasters rather than the coarser shared-grid dashboard GeoTIFF this script
# reads. Re-adding either here would silently overwrite the full-precision
# version with a degraded one.
DATASETS: dict[str, tuple[Path, str]] = {
    "hilda": (BASE / "rasters" / "hilda" / "geotiff", "hilda"),
    "hildaknn": (BASE / "rasters" / "hildaknn" / "geotiff", "hildaknn"),
    "hildaesri": (BASE / "rasters" / "hildaesri" / "geotiff", "hildaesri"),
    "lucas": (BASE / "rasters" / "lucas" / "geotiff", "lucas"),
    "hyde": (BASE / "rasters" / "hyde" / "geotiff", "hyde"),
    "luh2": (BASE / "rasters" / "luh2" / "geotiff", "luh2"),
    "grpk": (BASE / "rasters" / "grpk" / "geotiff", "grpk"),
}


def load_features() -> list[dict]:
    with open(SUBBASINS_PATH, "r", encoding="utf-8") as f:
        fc = json.load(f)
    return fc.get("features") or []


def list_years(geotiff_dir: Path, prefix: str) -> list[int]:
    if not geotiff_dir.is_dir():
        return []
    years: list[int] = []
    for p in geotiff_dir.glob(f"{prefix}_*.tif"):
        try:
            years.append(int(p.stem.split("_")[-1]))
        except (ValueError, IndexError):
            continue
    return sorted(set(years))


def count_classes_in_basin(src, feature: dict) -> tuple[dict[int, int], int]:
    """Return (class_counts, total_pixels_within_polygon).

    total_pixels counts ALL pixels inside the polygon (classified + unclassified).
    Unclassified = total_pixels - sum(class_counts).
    Uses filled=False so the polygon mask is geometry-only; pixels with value 0
    inside the basin are counted (they are unclassified, not masked out).
    """
    import numpy as np
    from rasterio.mask import mask

    geom = feature.get("geometry")
    if not geom:
        return {}, 0

    try:
        out_image, _ = mask(src, [geom], crop=True, indexes=1, filled=False)
    except ValueError:
        return {}, 0

    data = out_image
    if data.ndim == 3:
        data = data[0]

    if isinstance(data, np.ma.MaskedArray):
        within = ~np.ma.getmaskarray(data)
        raw = data.data
    else:
        within = np.ones(data.shape, dtype=bool)
        raw = data

    total = int(within.sum())
    if total == 0:
        return {}, 0

    classified = raw[within & (raw >= 1) & (raw <= 5)]
    if classified.size == 0:
        return {}, total

    uniq, cnts = np.unique(classified, return_counts=True)
    return {int(u): int(c) for u, c in zip(uniq, cnts, strict=False)}, total


def process_dataset(ds_key: str, features: list[dict]) -> None:
    import rasterio

    folder, prefix = DATASETS[ds_key]
    years = list_years(folder, prefix)
    if not years:
        print(f"[{ds_key}] No GeoTIFF files under {folder} — skip.")
        return

    out_path = OUT_DIR / f"subbasin_zonal_{ds_key}.csv"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rows_written = 0
    with open(out_path, "w", encoding="utf-8") as out:
        out.write("year,basin_index,class_id,count\n")
        for year in years:
            tif = folder / f"{prefix}_{year}.tif"
            if not tif.is_file():
                continue
            print(f"  [{ds_key}] {year} ({tif.name}) …")
            with rasterio.open(tif) as src:
                for basin_index, feat in enumerate(features):
                    counts, total_pixels = count_classes_in_basin(src, feat)
                    if total_pixels > 0:
                        # class_id=0: total pixels within polygon (classified + unclassified)
                        out.write(f"{year},{basin_index},0,{total_pixels}\n")
                        rows_written += 1
                    for cid in range(1, 6):
                        c = counts.get(cid, 0)
                        if c > 0:
                            out.write(f"{year},{basin_index},{cid},{c}\n")
                            rows_written += 1

    print(f"[{ds_key}] Wrote {out_path} ({rows_written} data rows)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pre-compute sub-basin zonal stats from GeoTIFFs.")
    parser.add_argument(
        "--dataset",
        choices=list(DATASETS.keys()),
        help="Only process one dataset (default: all)",
    )
    args = parser.parse_args()

    try:
        import numpy  # noqa: F401
        import rasterio  # noqa: F401
    except ImportError as e:
        print(
            "Missing dependency. Install with:\n  pip install rasterio numpy\n"
            f"Original error: {e}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not SUBBASINS_PATH.is_file():
        print(f"Missing {SUBBASINS_PATH}", file=sys.stderr)
        sys.exit(1)

    features = load_features()
    if not features:
        print("No features in sub-basins GeoJSON.", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(features)} sub-basin polygons from {SUBBASINS_PATH.name}")

    keys = [args.dataset] if args.dataset else list(DATASETS.keys())
    for ds_key in keys:
        print(f"\n=== {ds_key} ===")
        process_dataset(ds_key, features)

    print("\nDone.")


if __name__ == "__main__":
    main()
