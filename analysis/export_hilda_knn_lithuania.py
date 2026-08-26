# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export "HILDA+ With KNN" for Lithuania: same source and grid as export_hilda_lithuania.py, but
assigns every HILDA+ state code to one of the dashboard's 5 classes instead of leaving several
codes as unclassified/transparent pixels.

Differences from export_hilda_lithuania.py (which is left untouched — this is a separate
dataset, not a replacement):
  - state 40 (Forest, unknown/other subtype) -> Forest.
    export_hilda_lithuania.py deliberately excludes this to keep the Forest share close to
    Lithuania's national forest inventory (~33%); this variant includes it since it is,
    semantically, still forest.
  - state 55 (Unmanaged grass/shrubland) -> Forest, matching how export_corine_lithuania.py
    already buckets CORINE's whole "3xx Forest and semi-natural" group (grassland/moors/
    heath/shrub included) into this dashboard's Forest class.
  - state 66 (Sparse/no vegetation) has no natural home in the 5-class scheme, so it is
    filled from the nearest already-classified pixel (1-nearest-neighbor by Euclidean
    distance in grid space, via scipy.ndimage's exact distance transform) instead of being
    left blank — the same "nearest-neighbor fill" approach already used upstream for Esri's
    unmapped Bare ground / Clouds / Rangeland codes.
  - state 99 (no data: genuine satellite/temporal gaps) is intentionally left unclassified —
    there is no real land cover to infer there, so filling it would fabricate information.

See also export_hilda_esrifill_lithuania.py — same problem (state 66), filled from the Esri
dataset instead of a same-layer nearest neighbor.

Requires: xarray, numpy, pandas, rasterio, scipy, matplotlib (same as export_hilda_lithuania.py,
plus scipy for the nearest-neighbor fill)

Run from Data/:
  python analysis/export_hilda_knn_lithuania.py
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
from scipy.ndimage import distance_transform_edt

try:
    BASE = Path(__file__).resolve().parent.parent
except NameError:  # interactive / some notebooks
    BASE = Path.cwd()
    for d in [BASE, *BASE.parents]:
        if (d / "lt_subbasins.json").is_file():
            BASE = d
            break


def polygon_mask(lat_vals, lon_vals, geom):
    """Mask True where grid cell centers fall inside the polygon (no rasterio)."""
    h, w = len(lat_vals), len(lon_vals)
    mask = np.zeros((h, w), dtype=bool)
    for i, lat in enumerate(lat_vals):
        for j, lon in enumerate(lon_vals):
            mask[i, j] = geom.contains(Point(lon, lat))
    return mask


def _hilda_to_png_channel(arr_masked):
    """Map class ids 1,3,4,5 -> 0..3 for RGBA PNG; NaN stays masked."""
    out = np.full(arr_masked.shape, np.nan, dtype=np.float32)
    out[np.isfinite(arr_masked) & (arr_masked == 1)] = 0
    out[np.isfinite(arr_masked) & (arr_masked == 3)] = 1
    out[np.isfinite(arr_masked) & (arr_masked == 4)] = 2
    out[np.isfinite(arr_masked) & (arr_masked == 5)] = 3
    return out


def nearest_neighbor_fill(arr, fill_where):
    """Replace arr[fill_where] with the value of the nearest pixel NOT in fill_where and not
    NaN — i.e. a 1-nearest-neighbor classifier over grid-cell (Euclidean) distance. Pixels
    that are NaN (nodata) and not in fill_where are left untouched and never used as sources.
    """
    valid_source = np.isfinite(arr) & ~fill_where
    if not valid_source.any() or not fill_where.any():
        return arr
    # distance_transform_edt(return_indices=True) on "not a source" gives, for every pixel,
    # the index of the nearest True-valued (source) pixel — exactly 1-NN lookup.
    _, (iy, ix) = distance_transform_edt(~valid_source, return_indices=True)
    out = arr.copy()
    out[fill_where] = arr[iy[fill_where], ix[fill_where]]
    return out


def main() -> None:
    lt_geojson = BASE / "lt_boundary_admin.json"
    hilda_nc = BASE / "HILDA DATA" / "hildaplus_GLOB-2-0_states.nc"
    out_rasters = BASE / "rasters" / "hildaknn"
    out_geotiff = out_rasters / "geotiff"
    out_rasters.mkdir(parents=True, exist_ok=True)
    out_geotiff.mkdir(parents=True, exist_ok=True)
    out_csv = BASE / "outputs" / "hildaknn_lithuania_timeseries.csv"
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

    # HILDA+ states (Winkler et al. 2025): 0/77 water, 11 urban, 22-24 crops/agroforestry,
    # 33 pasture/rangeland, 40 forest (unknown/other), 41-45 forest subtypes, 55 unmanaged
    # grass/shrubland, 66 sparse/no vegetation, 99 no data.
    # Unlike export_hilda_lithuania.py, 40 and 55 are included in Forest here; 66 gets a
    # nearest-neighbor fill below instead of being dropped; only 99 stays unclassified.
    groups = {
        "Water": [0, 77],
        "Urban": [11],
        "Agriculture": [22, 23, 24, 33],
        "Forest": [40, 41, 42, 43, 44, 45, 55],
    }
    NN_FILL_CODE = 66  # sparse/no vegetation: no natural 5-class home, so nearest-neighbor fill it

    five_map = {}
    for c in groups["Water"]:
        five_map[c] = 1
    for c in groups["Urban"]:
        five_map[c] = 3
    for c in groups["Agriculture"]:
        five_map[c] = 4
    for c in groups["Forest"]:
        five_map[c] = 5

    class_names = {1: "Water", 3: "Urban", 4: "Agriculture", 5: "Forest"}

    png_colors = ["#4DA6FF", "#FF4D4D", "#FFD24D", "#228B22"]
    cmap_png = ListedColormap(png_colors)
    cmap_png.set_bad((0, 0, 0, 0))
    norm_png = matplotlib.colors.Normalize(vmin=-0.5, vmax=3.5)

    def reclass_to_five(layer):
        data = layer.values
        out = np.full_like(data, fill_value=np.nan, dtype="float32")
        for orig, unified in five_map.items():
            out[data == orig] = unified
        nn_fill_where = data == NN_FILL_CODE
        return out, nn_fill_where

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
    print("Exporting HILDA+ With KNN years:", years_export[:10], "...", years_export[-5:])

    try:
        import rasterio
        from rasterio.transform import from_bounds as _from_bounds
    except ImportError:
        rasterio = None
        _from_bounds = None

    if rasterio is not None:
        for stale in out_geotiff.glob("hildaknn_*.tif"):
            try:
                stale.unlink()
            except OSError:
                pass
    else:
        print(
            "Note: rasterio not importable — skipped clearing rasters/hildaknn/geotiff/*.tif "
            "(fix env: conda install -c conda-forge rasterio gdal; then re-run to refresh GeoTIFFs)."
        )

    records = []
    for year in years_export:
        ti = year_to_ti[int(year)]
        layer = da_lt.isel(time=ti)
        arr, nn_fill_where = reclass_to_five(layer)
        arr_masked = np.where(mask, arr, np.nan)
        nn_fill_masked = mask & nn_fill_where

        arr_masked = nearest_neighbor_fill(arr_masked, nn_fill_masked)

        flat = arr_masked[np.isfinite(arr_masked)].astype(int)
        if flat.size:
            uniq, cnts = np.unique(flat, return_counts=True)
            for cls_id, cnt in zip(uniq, cnts, strict=False):
                records.append(
                    (int(year), int(cls_id), class_names.get(int(cls_id), f"class_{cls_id}"), int(cnt))
                )

        rgba = cmap_png(norm_png(_hilda_to_png_channel(arr_masked)))
        out_path = out_rasters / f"hildaknn_{int(year)}.png"
        plt.imsave(out_path, rgba)
        print("Saved", out_path)

        if rasterio is None:
            pass
        else:
            try:
                h, w = arr_masked.shape
                west, east = float(np.min(lon_vals)), float(np.max(lon_vals))
                south, north = float(np.min(lat_vals)), float(np.max(lat_vals))
                arr_uint8 = np.zeros(arr_masked.shape, dtype=np.uint8)
                valid = np.isfinite(arr_masked)
                for v in (1, 3, 4, 5):
                    arr_uint8[valid & (arr_masked == v)] = v
                transform = _from_bounds(west, south, east, north, w, h)
                out_tif = out_geotiff / f"hildaknn_{int(year)}.tif"
                profile = dict(
                    driver="GTiff",
                    height=h,
                    width=w,
                    count=1,
                    dtype=arr_uint8.dtype,
                    transform=transform,
                    nodata=0,
                )
                last_err = None
                for crs_arg in ("EPSG:4326", None):
                    try:
                        kw = {**profile, **({} if crs_arg is None else {"crs": crs_arg})}
                        with rasterio.open(out_tif, "w", **kw) as dst:
                            dst.write(arr_uint8, 1)
                        note = " (no CRS tag; still WGS84 bounds in transform)" if crs_arg is None else ""
                        print(f"Saved {out_tif}{note}")
                        break
                    except Exception as e:
                        last_err = e
                else:
                    assert last_err is not None
                    raise last_err
            except Exception as e:
                print(f"Warning: GeoTIFF skipped for {year}: {e}")

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    df.to_csv(out_csv, index=False)
    print("Saved CSV:", out_csv)


if __name__ == "__main__":
    main()
