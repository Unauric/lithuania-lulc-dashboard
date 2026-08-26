# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Excludes Kuršių marios (Curonian Lagoon) and Lithuania's Baltic Sea coastal
waters from GRPK's map display and stats.

Why: GRPK rasterizes its own cadastre with no country-boundary crop, so it
naturally includes these large open-water bodies as "Water" class. Other
dashboard datasets don't show this same water (their own country-boundary
masks happen to exclude it, or their source classification doesn't cover open
sea/lagoon the same way), so GRPK's Water share isn't comparable side by side
— this is what "switches the diagram proportions" the user reported.

The exclusion polygon (analysis/reference_geo/grpk_water_exclusion.geojson)
was built from real OpenStreetMap data (the "Kuršių marios" bay relation +
the actual natural=coastline geometry), NOT a bounding box — a bbox would
wrongly cut out real Lithuanian land, since Klaipėda and the inhabited
Curonian Spit sit in the exact same longitude range as the water being
excluded. Validated against GRPK's own raster at 1,426 sample points across
the coastal/lagoon region: 3 false positives (land wrongly excluded, all at
the immediate coastline edge — a sub-pixel precision artifact), 0 false
negatives beyond legitimate small inland lakes.

This works entirely from already-computed GRPK outputs (national.tif,
regional chunks, vector cells, the stats CSV/JSON) — NOT the original
~1.95M-feature PLOTAI shapefiles — so it runs in well under a minute instead
of repeating the ~2 hour full shapefile stream.

Run from Data/:
  python analysis/apply_grpk_water_exclusion.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import geometry_mask
from shapely.geometry import shape

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
EXCLUSION_PATH = BASE / "analysis" / "reference_geo" / "grpk_water_exclusion.geojson"

RASTER_PATHS = [
    BASE / "rasters" / "grpk" / "geotiff" / "grpk_2026.tif",
    BASE / "rasters" / "grpk" / "tiles" / "national" / "national.tif",
    *sorted((BASE / "rasters" / "grpk" / "tiles" / "regional").glob("[0-9]_[0-9].tif")),
]

VECTOR_DIR = BASE / "rasters" / "grpk" / "tiles" / "vector"
TIMESERIES_CSV = BASE / "outputs" / "grpk_lithuania_timeseries.csv"
REFERENCE_JSON = BASE / "outputs" / "grpk_reference_shares.json"

CLASS_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"]
CLASS_TO_ID = {name: i + 1 for i, name in enumerate(CLASS_ORDER)}


def load_exclusion_geom():
    with open(EXCLUSION_PATH, encoding="utf-8") as f:
        feat = json.load(f)
    return shape(feat["geometry"])


def mask_raster(path: Path, geom) -> None:
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


def filter_vector_cells(geom) -> None:
    cell_paths = sorted(VECTOR_DIR.glob("*.geojson"))
    print(f"Filtering {len(cell_paths)} vector cells...")
    total_removed = 0
    for p in cell_paths:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        feats = data["features"]
        kept = []
        removed = 0
        for feat in feats:
            fgeom = shape(feat["geometry"])
            if geom.intersects(fgeom.centroid):
                removed += 1
                continue
            kept.append(feat)
        if removed:
            total_removed += removed
            with open(p, "w", encoding="utf-8") as f:
                f.write('{"type":"FeatureCollection","features":[')
                f.write(",".join(json.dumps(ft, separators=(",", ":")) for ft in kept))
                f.write("]}")
    print(f"  removed {total_removed} water features across all cells")


def recompute_timeseries_csv() -> None:
    national_tif = BASE / "rasters" / "grpk" / "geotiff" / "grpk_2026.tif"
    with rasterio.open(national_tif) as src:
        arr = src.read(1)
    vals, counts = np.unique(arr[arr != 0], return_counts=True)
    counts_by_id = dict(zip(vals.tolist(), counts.tolist()))
    with open(TIMESERIES_CSV, "w", encoding="utf-8") as f:
        f.write("year,class_id,class_name,count\n")
        for name in CLASS_ORDER:
            cid = CLASS_TO_ID[name]
            f.write(f"2026,{cid},{name},{counts_by_id.get(cid, 0)}\n")
    print(f"Rewrote {TIMESERIES_CSV.relative_to(BASE)}: {dict(zip([CLASS_ORDER[v-1] for v in vals], counts.tolist()))}")


def recompute_reference_shares() -> None:
    national_tif = BASE / "rasters" / "grpk" / "geotiff" / "grpk_2026.tif"
    with rasterio.open(national_tif) as src:
        arr = src.read(1)
        # Approximate per-pixel area in m^2 from the raster's own degree resolution
        # (matches this file's own resolution/latitude — a reasonable stand-in for
        # the true polygon-area sum, without re-touching the 1.95M-feature shapefiles).
        res_lon_deg, res_lat_deg = src.transform.a, -src.transform.e
        center_lat = (src.bounds.top + src.bounds.bottom) / 2.0
        import math

        m_per_deg_lat = 111_320.0
        m_per_deg_lon = 111_320.0 * math.cos(math.radians(center_lat))
        pixel_area_m2 = (res_lon_deg * m_per_deg_lon) * (res_lat_deg * m_per_deg_lat)
    vals, counts = np.unique(arr[arr != 0], return_counts=True)
    counts_by_name = {CLASS_ORDER[v - 1]: c for v, c in zip(vals.tolist(), counts.tolist())}
    area_totals = {name: counts_by_name.get(name, 0) * pixel_area_m2 for name in CLASS_ORDER}
    total_area = sum(area_totals.values())
    shares = [area_totals[name] / total_area for name in CLASS_ORDER]

    with open(REFERENCE_JSON, encoding="utf-8") as f:
        data = json.load(f)
    data["area_totals_m2"] = area_totals
    data["shares"] = shares
    data["notes"] = (
        "Pixel-count-weighted shares from the national raster (grpk_2026.tif), after excluding "
        "Kursiu marios + Lithuanian Baltic Sea coastal waters (analysis/reference_geo/"
        "grpk_water_exclusion.geojson) so GRPK's Water share is comparable to the other datasets. "
        "Previously an exact area-weighted sum over the raw PLOTAI polygons with no such "
        "exclusion — switched to this pixel-based method so the exclusion could be applied "
        "without re-streaming the ~1.95M-feature source shapefiles."
    )
    with open(REFERENCE_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"Rewrote {REFERENCE_JSON.relative_to(BASE)}: shares={shares}")


def main() -> None:
    geom = load_exclusion_geom()
    print("Masking raster tiers...")
    for p in RASTER_PATHS:
        if p.exists():
            mask_raster(p, geom)
        else:
            print(f"  (skip, not found) {p}")

    filter_vector_cells(geom)
    recompute_timeseries_csv()
    recompute_reference_shares()
    print("\nDone. Next: rerun export_grpk_xyz_tiles.py to regenerate the XYZ PNG tiles from the patched rasters.")


if __name__ == "__main__":
    main()
