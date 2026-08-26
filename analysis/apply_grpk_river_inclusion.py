# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Adds Lithuania's river network (River_System_LTU.shp, repo root) into GRPK's
map display and stats as Water, wherever GRPK's own cadastral parcels don't
cover it.

Why: GRPK PLOTAI only rasterizes registered cadastral plots. A river channel
isn't a privately-owned/registered plot, so wherever a river runs with no
parcel over it, GRPK shows a real gap -- unclassified (blank), not Water --
even for major rivers like the Nemunas or Neris. Other datasets don't have
this gap since they classify every pixel from continuous satellite/model
data, not discrete land parcels.

This ONLY fills pixels/areas GRPK currently has as unclassified -- it never
overwrites an already-classified parcel, so the cadastre stays authoritative
wherever it actually has data.

Source: River_System_LTU.shp (repo root, OSM-derived line network), filtered
to fclass == "river" (2,929 named/major rivers) -- streams/drains/canals are
excluded, since those are far narrower than GRPK's own ~50-500m display
resolution and weren't part of the reported problem ("major rivers show as
unclassified"). Most features have no tagged width (OSM width=0 means
"untagged", not "zero metres wide") -- those get a flat default half-width;
the ~4% of features with a real tagged width use that instead.

Like apply_grpk_water_exclusion.py, this works entirely from already-computed
GRPK outputs (national.tif, regional chunks, vector cells) -- NOT the raw
~1.95M-feature PLOTAI shapefiles -- so it runs in a couple of minutes instead
of repeating the ~2 hour full shapefile stream.

Run from Data/:
  python analysis/apply_grpk_river_inclusion.py

Then, same as the water-exclusion script:
  python analysis/export_grpk_xyz_tiles.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiling_utils import LT_EAST, LT_NORTH, LT_SOUTH, LT_WEST, cell_bounds

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
REPO_ROOT = BASE.parent.parent  # .../Matas_Internship_Final_V2
RIVER_SHP = REPO_ROOT / "River_System_LTU.shp"

RASTER_PATHS = [
    BASE / "rasters" / "grpk" / "geotiff" / "grpk_2026.tif",
    BASE / "rasters" / "grpk" / "tiles" / "national" / "national.tif",
    *sorted((BASE / "rasters" / "grpk" / "tiles" / "regional").glob("[0-9]_[0-9].tif")),
]

VECTOR_DIR = BASE / "rasters" / "grpk" / "tiles" / "vector"
MANIFEST_PATH = BASE / "rasters" / "grpk" / "tiles" / "manifest.json"
TIMESERIES_CSV = BASE / "outputs" / "grpk_lithuania_timeseries.csv"
REFERENCE_JSON = BASE / "outputs" / "grpk_reference_shares.json"

CLASS_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"]
WATER_ID = 1

# Half-width used for OSM features with no real tagged width (the vast
# majority) -- a modest default so small/medium rivers read as a visible
# band rather than a hairline, without ballooning into neighbouring parcels.
DEFAULT_HALF_WIDTH_M = 15.0


def load_river_lines() -> gpd.GeoDataFrame:
    gdf = gpd.read_file(RIVER_SHP)
    rivers = gdf[gdf["fclass"] == "river"].copy()
    print(f"Loaded {len(rivers)} river-class line features (of {len(gdf)} total, CRS {gdf.crs})")
    return rivers


def buffered_polygons_4326(rivers: gpd.GeoDataFrame) -> gpd.GeoSeries:
    """Per-feature buffer (real tagged width/2, or the default half-width),
    done in the source's own projected CRS (EPSG:3346, metres) so the
    distance is a real metre value, then reprojected to WGS84 to match
    GRPK's display grid."""
    half_width = rivers["width"].where(rivers["width"] > 0, DEFAULT_HALF_WIDTH_M * 2) / 2.0
    buffered = rivers.geometry.buffer(half_width)
    return gpd.GeoSeries(buffered, crs=rivers.crs).to_crs(4326)


def fill_raster(path: Path, river_lines_4326: gpd.GeoSeries) -> None:
    with rasterio.open(path) as src:
        arr = src.read(1)
        profile = src.profile
        transform = src.transform
    # Raw centerlines with all_touched=True paint every pixel the line
    # actually passes through, at whatever this raster's own resolution is --
    # no width guess needed here (unlike the vector tier, a raster pixel is
    # already an area, so a 1-pixel-wide painted path is the correct fill).
    river_mask = rasterize(
        ((geom, 1) for geom in river_lines_4326),
        out_shape=arr.shape,
        transform=transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    )
    gap_mask = (arr == 0) & (river_mask == 1)
    n_filled = int(np.count_nonzero(gap_mask))
    if n_filled == 0:
        print(f"  {path.relative_to(BASE)}: no unclassified river gaps found, unchanged")
        return
    arr[gap_mask] = WATER_ID
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)
    print(f"  {path.relative_to(BASE)}: filled {n_filled} unclassified pixels as Water")


def fill_vector_cells(river_union) -> None:
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        manifest = json.load(f)
    grid = manifest["vector_tier"]["grid"]
    populated = {tuple(rc) for rc in manifest["vector_tier"]["cells"]}

    # Only cells whose bounds actually intersect the buffered river network
    # are worth touching -- quick bbox reject before any real geometry work.
    minx, miny, maxx, maxy = river_union.bounds
    lon_step = (LT_EAST - LT_WEST) / grid
    lat_step = (LT_NORTH - LT_SOUTH) / grid
    col_min = max(0, int((minx - LT_WEST) // lon_step))
    col_max = min(grid - 1, int((maxx - LT_WEST) // lon_step))
    row_min = max(0, int((miny - LT_SOUTH) // lat_step))
    row_max = min(grid - 1, int((maxy - LT_SOUTH) // lat_step))

    candidates = [(r, c) for r in range(row_min, row_max + 1) for c in range(col_min, col_max + 1)]
    print(f"Checking {len(candidates)} candidate cells (grid={grid}) against the river network...")

    new_cells = 0
    patched_cells = 0
    for (row, col) in candidates:
        west, south, east, north = cell_bounds(grid, row, col)
        river_here = river_union.intersection(box(west, south, east, north))
        if river_here.is_empty:
            continue

        path = VECTOR_DIR / f"{row}_{col}.geojson"
        feats = []
        gap = river_here
        if path.exists():
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            feats = data["features"]
            if feats:
                existing_union = unary_union([shape(ft["geometry"]) for ft in feats])
                gap = river_here.difference(existing_union)

        if gap.is_empty:
            continue

        feats.append({
            "type": "Feature",
            "properties": {"class_id": WATER_ID, "class_name": "Water"},
            "geometry": mapping(gap),
        })
        with open(path, "w", encoding="utf-8") as f:
            f.write('{"type":"FeatureCollection","features":[')
            f.write(",".join(json.dumps(ft, separators=(",", ":")) for ft in feats))
            f.write("]}")

        if (row, col) in populated:
            patched_cells += 1
        else:
            populated.add((row, col))
            new_cells += 1

    if new_cells:
        manifest["vector_tier"]["cells"] = [[r, c] for (r, c) in sorted(populated)]
        with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

    print(f"Vector tier: patched {patched_cells} existing cells, created {new_cells} new river-only cells")


def recompute_timeseries_csv() -> None:
    national_tif = BASE / "rasters" / "grpk" / "geotiff" / "grpk_2026.tif"
    with rasterio.open(national_tif) as src:
        arr = src.read(1)
    vals, counts = np.unique(arr[arr != 0], return_counts=True)
    counts_by_id = dict(zip(vals.tolist(), counts.tolist()))
    with open(TIMESERIES_CSV, "w", encoding="utf-8") as f:
        f.write("year,class_id,class_name,count\n")
        for i, name in enumerate(CLASS_ORDER, start=1):
            f.write(f"2026,{i},{name},{counts_by_id.get(i, 0)}\n")
    print(f"Rewrote {TIMESERIES_CSV.relative_to(BASE)}: {dict(zip([CLASS_ORDER[v-1] for v in vals], counts.tolist()))}")


def recompute_reference_shares() -> None:
    national_tif = BASE / "rasters" / "grpk" / "geotiff" / "grpk_2026.tif"
    with rasterio.open(national_tif) as src:
        arr = src.read(1)
        res_lon_deg, res_lat_deg = src.transform.a, -src.transform.e
        center_lat = (src.bounds.top + src.bounds.bottom) / 2.0
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
        data.get("notes", "").rstrip()
        + " Also includes Lithuania's river network (repo-root River_System_LTU.shp, "
        "fclass=='river') burned in as Water wherever GRPK's own cadastral parcels left it "
        "unclassified (analysis/apply_grpk_river_inclusion.py)."
    )
    with open(REFERENCE_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"Rewrote {REFERENCE_JSON.relative_to(BASE)}: shares={shares}")


def main() -> None:
    rivers = load_river_lines()
    river_lines_4326 = gpd.GeoSeries(rivers.geometry, crs=rivers.crs).to_crs(4326)
    river_polys_4326 = buffered_polygons_4326(rivers)
    river_union = unary_union(list(river_polys_4326.geometry))

    print("Filling unclassified river gaps in raster tiers...")
    for p in RASTER_PATHS:
        if p.exists():
            fill_raster(p, river_lines_4326)
        else:
            print(f"  (skip, not found) {p}")

    fill_vector_cells(river_union)
    recompute_timeseries_csv()
    recompute_reference_shares()
    print("\nDone. Next: rerun export_grpk_xyz_tiles.py to regenerate the XYZ PNG tiles from the patched rasters.")


if __name__ == "__main__":
    main()
