# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Excludes Kursiu marios (Curonian Lagoon) and Lithuania's Baltic Sea coastal
waters from all three HILDA+ variants' map display and national timeseries
stats — same treatment already applied to GRPK and CORINE, via the same
reused OSM-derived exclusion polygon.

Unlike CORINE, each HILDA variant's national timeseries CSV
(outputs/{prefix}_lithuania_timeseries.csv) is computed by its export
script directly from the SAME array that becomes the dashboard GeoTIFF (see
export_hilda_lithuania.py's `records.append(...)` right next to its
`out_tif` write) — so masking the already-exported dashboard GeoTIFFs in
place and recomputing the CSV from those same rasters is exact, not a
resolution/method trade-off (contrast apply_corine_water_exclusion.py,
which had to change method because CORINE's CSV comes from a separate,
unsaved native-CRS array).

PNG overlays are also regenerated per variant, since each uses its own
class-id-to-channel mapping and color palette:
  hilda, hildaknn   — 4 classes: 1=Water, 3=Urban, 4=Agriculture, 5=Forest
  hildaesri         — 5 classes: 1=Water, 2=Wetland, 3=Urban, 4=Agriculture,
                       5=Forest (the Esri fill can produce Wetland, which
                       HILDA+'s own codes never do)

Sub-basin zonal stats (outputs/subbasin_zonal_{hilda,hildaesri,hildaknn}.csv)
are deliberately left untouched, same reasoning as the CORINE script: the
exclusion polygon overlaps sub-basin polygons by at most ~0.24% of any one
basin's area (checked directly, geometry-only so identical regardless of
dataset) — not enough to move any visible number.

Run from Data/:
  python analysis/apply_hilda_water_exclusion.py
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

VARIANTS = {
    "hilda": {
        "class_names": {1: "Water", 3: "Urban", 4: "Agriculture", 5: "Forest"},
        "png_colors": ["#4DA6FF", "#FF4D4D", "#FFD24D", "#228B22"],
        "channel_map": {1: 0, 3: 1, 4: 2, 5: 3},
    },
    "hildaesri": {
        "class_names": {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"},
        "png_colors": ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"],
        "channel_map": {1: 0, 2: 1, 3: 2, 4: 3, 5: 4},
    },
    "hildaknn": {
        "class_names": {1: "Water", 3: "Urban", 4: "Agriculture", 5: "Forest"},
        "png_colors": ["#4DA6FF", "#FF4D4D", "#FFD24D", "#228B22"],
        "channel_map": {1: 0, 3: 1, 4: 2, 5: 3},
    },
}


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
    return arr, n_before, n_after


def rewrite_png(out_rasters: Path, prefix: str, year: int, arr: np.ndarray, cfg: dict) -> None:
    channel = np.full(arr.shape, np.nan, dtype="float32")
    for cls_id, ch in cfg["channel_map"].items():
        channel[arr == cls_id] = ch
    cmap = ListedColormap(cfg["png_colors"])
    cmap.set_bad((0, 0, 0, 0))
    norm = matplotlib.colors.Normalize(vmin=-0.5, vmax=len(cfg["png_colors"]) - 0.5)
    rgba = cmap(norm(channel))
    out_png = out_rasters / f"{prefix}_{year}.png"
    plt.imsave(out_png, rgba)


def process_variant(prefix: str, cfg: dict, geom) -> None:
    geotiff_dir = BASE / "rasters" / prefix / "geotiff"
    out_rasters = BASE / "rasters" / prefix
    out_csv = BASE / "outputs" / f"{prefix}_lithuania_timeseries.csv"

    tif_paths = sorted(geotiff_dir.glob(f"{prefix}_*.tif"))
    if not tif_paths:
        print(f"[{prefix}] No GeoTIFFs found under {geotiff_dir} — skip.")
        return

    print(f"[{prefix}] Masking {len(tif_paths)} dashboard rasters...")
    patched: dict[int, np.ndarray] = {}
    total_removed = 0
    for p in tif_paths:
        try:
            year = int(p.stem.split("_")[-1])
        except ValueError:
            continue
        arr, n_before, n_after = mask_raster(p, geom)
        patched[year] = arr
        total_removed += n_before - n_after
    print(f"[{prefix}] Removed {total_removed} Water pixels total across {len(patched)} years.")

    print(f"[{prefix}] Regenerating PNG overlays...")
    for year, arr in patched.items():
        rewrite_png(out_rasters, prefix, year, arr, cfg)

    rows = ["year,class_id,class_name,count"]
    for year in sorted(patched):
        arr = patched[year]
        vals, counts = np.unique(arr[arr != 0], return_counts=True)
        counts_by_id = dict(zip(vals.tolist(), counts.tolist()))
        for cid, name in sorted(cfg["class_names"].items()):
            rows.append(f"{year},{cid},{name},{counts_by_id.get(cid, 0)}")
    with open(out_csv, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    print(f"[{prefix}] Rewrote {out_csv.relative_to(BASE)} ({len(patched)} years)")


def main() -> None:
    geom = load_exclusion_geom()
    for prefix, cfg in VARIANTS.items():
        process_variant(prefix, cfg, geom)
    print("\nDone. All three HILDA variants now exclude Kursiu marios / Baltic Sea waters.")


if __name__ == "__main__":
    main()
