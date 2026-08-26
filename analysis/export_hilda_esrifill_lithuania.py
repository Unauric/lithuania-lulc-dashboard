# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export "HILDA+ With Esri Fill" for Lithuania — the same problem as
export_hilda_knn_lithuania.py (HILDA+ state 66, "sparse/no vegetation", has no natural home in
the dashboard's 5-class scheme), but filled from the Esri 10m Annual LULC dataset's
classification at that same location/year instead of a same-layer nearest neighbor.

Differences from export_hilda_lithuania.py (left untouched) — identical to
export_hilda_knn_lithuania.py except for how state 66 is resolved:
  - state 40 (Forest, unknown/other subtype) -> Forest (same as the KNN variant).
  - state 55 (Unmanaged grass/shrubland) -> Forest (same as the KNN variant).
  - state 66 (Sparse/no vegetation) -> filled from rasters/esri/geotiff/esri_<year>.tif,
    nearest-neighbor sampled at each blank pixel's (lat, lon). Esri only covers 2017-2025;
    for HILDA years before 2017 (the vast majority: 1910-2016) this uses Esri's earliest
    available year (2017) as a static spatial proxy — i.e. modern land cover filling a
    historical gap. That is a real trade-off, not a substitute for genuine historical data;
    it is documented here and in the dashboard's dataset registry rather than hidden.
  - state 99 (no data: genuine satellite/temporal gaps) is intentionally left unclassified.
  - If Esri itself has no data (0) at a blank pixel's location (rare, e.g. right at the
    coastline/border where the two grids' masks disagree slightly), the pixel is left
    unclassified rather than silently falling back to another method.

Requires: xarray, numpy, pandas, rasterio, matplotlib (same as export_hilda_lithuania.py).
Reads the already-exported rasters/esri/geotiff/esri_<year>.tif files — run
export_esri_lithuania.py first if those are missing.

Run from Data/:
  python analysis/export_hilda_esrifill_lithuania.py
"""

from pathlib import Path
import json
from shapely.geometry import shape, Point
from shapely.ops import unary_union
import numpy as np
import pandas as pd
import xarray as xr
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
import rasterio
from rasterio.transform import rowcol

try:
    BASE = Path(__file__).resolve().parent.parent
except NameError:  # interactive / some notebooks
    BASE = Path.cwd()
    for d in [BASE, *BASE.parents]:
        if (d / "lt_subbasins.json").is_file():
            BASE = d
            break

ESRI_GEOTIFF_DIR = BASE / "rasters" / "esri" / "geotiff"


def polygon_mask(lat_vals, lon_vals, geom):
    """Mask True where grid cell centers fall inside the polygon (no rasterio)."""
    h, w = len(lat_vals), len(lon_vals)
    mask = np.zeros((h, w), dtype=bool)
    for i, lat in enumerate(lat_vals):
        for j, lon in enumerate(lon_vals):
            mask[i, j] = geom.contains(Point(lon, lat))
    return mask


def _hilda_to_png_channel(arr_masked):
    """Map class ids 1,2,3,4,5 -> 0..4 for RGBA PNG; NaN stays masked.
    Unlike export_hilda_lithuania.py / export_hilda_knn_lithuania.py, class 2 (Wetland) is
    included here: HILDA+'s own codes never produce it, but the Esri fill can (Esri has a
    Wetland class HILDA+ doesn't distinguish)."""
    out = np.full(arr_masked.shape, np.nan, dtype=np.float32)
    out[np.isfinite(arr_masked) & (arr_masked == 1)] = 0
    out[np.isfinite(arr_masked) & (arr_masked == 2)] = 1
    out[np.isfinite(arr_masked) & (arr_masked == 3)] = 2
    out[np.isfinite(arr_masked) & (arr_masked == 4)] = 3
    out[np.isfinite(arr_masked) & (arr_masked == 5)] = 4
    return out


def discover_esri_years() -> list[int]:
    years = []
    for tif in ESRI_GEOTIFF_DIR.glob("esri_*.tif"):
        try:
            years.append(int(tif.stem.split("_")[-1]))
        except ValueError:
            continue
    return sorted(years)


def esri_year_for(hilda_year: int, esri_years: list[int]) -> int:
    """Nearest available Esri year, clamped to Esri's actual coverage."""
    return min(esri_years, key=lambda y: (abs(y - hilda_year), y))


_esri_cache: dict[int, tuple[np.ndarray, "rasterio.Affine"]] = {}


def load_esri_year(year: int):
    if year not in _esri_cache:
        with rasterio.open(ESRI_GEOTIFF_DIR / f"esri_{year}.tif") as src:
            _esri_cache[year] = (src.read(1), src.transform)
    return _esri_cache[year]


def esri_fill_values(lats: np.ndarray, lons: np.ndarray, esri_year: int) -> np.ndarray:
    """Nearest-neighbor sample Esri's dashboard-grid classification at arbitrary (lat, lon)
    points (a different grid than HILDA's own). Returns 0 (no data) for out-of-bounds points."""
    arr, transform = load_esri_year(esri_year)
    rows, cols = rowcol(transform, lons, lats)
    rows = np.asarray(rows)
    cols = np.asarray(cols)
    in_bounds = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
    out = np.zeros(lats.shape, dtype=np.uint8)
    out[in_bounds] = arr[rows[in_bounds], cols[in_bounds]]
    return out


def esri_fill(arr, fill_where, lat_grid, lon_grid, esri_year):
    """Replace arr[fill_where] with Esri's class at that (lat, lon), for the given Esri year.
    Where Esri itself has no data there, the pixel is left as-is (still NaN/unclassified)."""
    if not fill_where.any():
        return arr
    lats = lat_grid[fill_where]
    lons = lon_grid[fill_where]
    esri_vals = esri_fill_values(lats, lons, esri_year)
    out = arr.copy()
    fill_idx = np.where(fill_where)
    valid_esri = esri_vals > 0
    rows_to_fill = tuple(idx[valid_esri] for idx in fill_idx)
    out[rows_to_fill] = esri_vals[valid_esri].astype(np.float32)
    return out


def main() -> None:
    esri_years = discover_esri_years()
    if not esri_years:
        raise SystemExit(f"No Esri GeoTIFFs found under {ESRI_GEOTIFF_DIR} — run export_esri_lithuania.py first.")
    print(f"Esri years available for fill: {esri_years}")

    lt_geojson = BASE / "lt_boundary_admin.json"
    hilda_nc = BASE / "HILDA DATA" / "hildaplus_GLOB-2-0_states.nc"
    out_rasters = BASE / "rasters" / "hildaesri"
    out_geotiff = out_rasters / "geotiff"
    out_rasters.mkdir(parents=True, exist_ok=True)
    out_geotiff.mkdir(parents=True, exist_ok=True)
    out_csv = BASE / "outputs" / "hildaesri_lithuania_timeseries.csv"
    out_csv.parent.mkdir(parents=True, exist_ok=True)

    with open(lt_geojson, "r", encoding="utf-8") as f:
        lt_data = json.load(f)
    geoms = [shape(feat["geometry"]) for feat in lt_data["features"]]
    lt_geom = unary_union(geoms)

    lat_min, lat_max = 53.5, 56.6
    lon_min, lon_max = 20.5, 26.85

    print("Opening HILDA dataset:", hilda_nc)
    try:
        ds = xr.open_dataset(hilda_nc, chunks="auto")
    except ImportError:
        ds = xr.open_dataset(hilda_nc)
    da = ds["LULC_states"]

    lat_name = "latitude"
    lon_name = "longitude"
    lats = da[lat_name].values
    lat_slice = slice(lat_max, lat_min) if (len(lats) > 1 and lats[0] > lats[-1]) else slice(lat_min, lat_max)
    da_lt = da.sel(**{lat_name: lat_slice, lon_name: slice(lon_min, lon_max)})

    lat_vals = da_lt[lat_name].values
    lon_vals = da_lt[lon_name].values
    mask = polygon_mask(lat_vals, lon_vals, lt_geom)
    lon_grid, lat_grid = np.meshgrid(lon_vals, lat_vals)  # same shape as mask/arr

    # HILDA+ states (Winkler et al. 2025): 0/77 water, 11 urban, 22-24 crops/agroforestry,
    # 33 pasture/rangeland, 40 forest (unknown/other), 41-45 forest subtypes, 55 unmanaged
    # grass/shrubland, 66 sparse/no vegetation, 99 no data.
    # Same as export_hilda_knn_lithuania.py: 40 and 55 are included in Forest here; 66 is the
    # one code filled below (from Esri instead of a same-layer nearest neighbor); only 99
    # stays unclassified.
    groups = {
        "Water": [0, 77],
        "Urban": [11],
        "Agriculture": [22, 23, 24, 33],
        "Forest": [40, 41, 42, 43, 44, 45, 55],
    }
    ESRI_FILL_CODE = 66  # sparse/no vegetation: no natural 5-class home, fill from Esri

    five_map = {}
    for c in groups["Water"]:
        five_map[c] = 1
    for c in groups["Urban"]:
        five_map[c] = 3
    for c in groups["Agriculture"]:
        five_map[c] = 4
    for c in groups["Forest"]:
        five_map[c] = 5

    # Includes 2: "Wetland" — HILDA+'s own codes never produce it, but the Esri fill can.
    class_names = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}

    png_colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
    cmap_png = ListedColormap(png_colors)
    cmap_png.set_bad((0, 0, 0, 0))
    norm_png = matplotlib.colors.Normalize(vmin=-0.5, vmax=4.5)

    def reclass_to_five(layer):
        data = layer.values
        out = np.full_like(data, fill_value=np.nan, dtype="float32")
        for orig, unified in five_map.items():
            out[data == orig] = unified
        esri_fill_where = data == ESRI_FILL_CODE
        return out, esri_fill_where

    time_vals = da_lt["time"].values
    pairs = []
    for ti, t_val in enumerate(time_vals):
        y = int(round(float(t_val)))
        if 1910 <= y <= 2020:
            pairs.append((y, ti, float(t_val)))
    pairs.sort(key=lambda x: (x[0], x[2]))
    year_to_ti = {}
    for y, ti, _ in pairs:
        if y not in year_to_ti:
            year_to_ti[y] = ti
    years_export = np.array(sorted(year_to_ti.keys()), dtype=int)
    print("Exporting HILDA+ With Esri Fill years:", years_export[:10], "...", years_export[-5:])

    for stale in out_geotiff.glob("hildaesri_*.tif"):
        try:
            stale.unlink()
        except OSError:
            pass

    records = []
    for year in years_export:
        ti = year_to_ti[int(year)]
        layer = da_lt.isel(time=ti)
        arr, fill_where = reclass_to_five(layer)
        arr_masked = np.where(mask, arr, np.nan)
        fill_masked = mask & fill_where

        esri_year = esri_year_for(int(year), esri_years)
        arr_masked = esri_fill(arr_masked, fill_masked, lat_grid, lon_grid, esri_year)

        flat = arr_masked[np.isfinite(arr_masked)].astype(int)
        if flat.size:
            uniq, cnts = np.unique(flat, return_counts=True)
            for cls_id, cnt in zip(uniq, cnts, strict=False):
                records.append(
                    (int(year), int(cls_id), class_names.get(int(cls_id), f"class_{cls_id}"), int(cnt))
                )

        rgba = cmap_png(norm_png(_hilda_to_png_channel(arr_masked)))
        out_path = out_rasters / f"hildaesri_{int(year)}.png"
        plt.imsave(out_path, rgba)

        h, w = arr_masked.shape
        west, east = float(np.min(lon_vals)), float(np.max(lon_vals))
        south, north = float(np.min(lat_vals)), float(np.max(lat_vals))
        arr_uint8 = np.zeros(arr_masked.shape, dtype=np.uint8)
        valid = np.isfinite(arr_masked)
        for v in (1, 2, 3, 4, 5):
            arr_uint8[valid & (arr_masked == v)] = v
        from rasterio.transform import from_bounds as _from_bounds

        transform = _from_bounds(west, south, east, north, w, h)
        out_tif = out_geotiff / f"hildaesri_{int(year)}.tif"
        with rasterio.open(
            out_tif,
            "w",
            driver="GTiff",
            height=h,
            width=w,
            count=1,
            dtype=arr_uint8.dtype,
            crs="EPSG:4326",
            transform=transform,
            nodata=0,
        ) as dst:
            dst.write(arr_uint8, 1)
        print(f"Saved {out_tif} (esri_fill_year={esri_year})")

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    df.to_csv(out_csv, index=False)
    print("Saved CSV:", out_csv)


if __name__ == "__main__":
    main()
