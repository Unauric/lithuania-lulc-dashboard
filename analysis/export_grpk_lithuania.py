# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Export GRPK (Georeferencinis pagrindo kadastras) PLOTAI cadastral plot polygons into the
dashboard ecosystem: a single-snapshot WGS84 GeoTIFF for map display, plus a national
timeseries CSV — same grid/conventions as export_esri_lithuania.py / export_corine_lithuania.py,
so this layer overlays in perfect alignment with the others.

GRPK PLOTAI is a **living cadastre with no per-feature observation year** (unlike HILDA, Esri,
etc.) — it is rasterized as a single snapshot, labelled with the most recent edit date found
across all plot records (Suk_DATA/Red_DATA). That label is a "data current as of" marker, not a
real historical year.

GKODAS -> 5-class mapping reuses analysis/grpk_gkodas_mapping.json, the same rules already
used by build_grpk_reference.py to build the fixed validation reference
(outputs/grpk_reference_shares.json).

Requires: geopandas, rasterio (already used by the other export_*.py scripts in this repo)

Run from Data/:
  python analysis/export_grpk_lithuania.py

Optional env:
  GRPK_SHP_DIR — folder containing PLOTAI_*.shp (default: <repo>/Plots)
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_bounds

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
MAPPING_PATH = BASE / "analysis" / "grpk_gkodas_mapping.json"
OUT_GEOTIFF_DIR = BASE / "rasters" / "grpk" / "geotiff"
OUT_CSV = BASE / "outputs" / "grpk_lithuania_timeseries.csv"

PLOTAI_NAMES = ["PLOTAI_1", "PLOTAI_2", "PLOTAI_3"]

CLASS_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"]
CLASS_TO_ID = {name: i + 1 for i, name in enumerate(CLASS_ORDER)}
CLASS_COLORS_HEX = {
    1: "#4DA6FF",
    2: "#7B68EE",
    3: "#FF4D4D",
    4: "#FFD24D",
    5: "#228B22",
}

# Same WGS84 display box/resolution as export_esri_lithuania.py / export_corine_lithuania.py,
# so all dashboard layers overlay in perfect alignment.
DASHBOARD_SOUTH, DASHBOARD_WEST = 53.45, 20.45
DASHBOARD_NORTH, DASHBOARD_EAST = 56.65, 26.85
DASHBOARD_RES_DEG = 0.005


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def find_shp_dir() -> Path:
    env = os.environ.get("GRPK_SHP_DIR")
    if env:
        return Path(env)
    repo_root_candidate = BASE.parent.parent / "Plots"  # .../<repo>/Plots
    if repo_root_candidate.is_dir():
        return repo_root_candidate
    return BASE / "GRPK_Open_SHP"  # legacy layout, kept for backward compatibility


def load_mapping() -> tuple[list[tuple[str, str]], str]:
    with open(MAPPING_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    rules = sorted(((a[0].lower(), a[1]) for a in cfg["prefix_rules"]), key=lambda x: -len(x[0]))
    default = cfg.get("default_class", "Agriculture")
    return rules, default


def classify_gkodas(codes: pd.Series, rules: list[tuple[str, str]], default: str) -> pd.Series:
    """Vectorized equivalent of build_grpk_reference.py's gkodas_to_class: longest matching
    prefix wins (rules must already be sorted longest-prefix-first)."""
    lc = codes.fillna("").str.strip().str.lower()
    result = pd.Series(default, index=lc.index, dtype=object)
    matched = pd.Series(False, index=lc.index)
    for prefix, cls in rules:
        mask = (~matched) & lc.str.startswith(prefix)
        result[mask] = cls
        matched |= mask
    return result


def load_plots(shp_dir: Path) -> gpd.GeoDataFrame:
    frames = []
    crs = None
    for name in PLOTAI_NAMES:
        shp_path = shp_dir / f"{name}.shp"
        if not shp_path.is_file():
            raise FileNotFoundError(f"Missing {shp_path}")
        gdf = gpd.read_file(shp_path)
        print(f"  {name}: {len(gdf)} plots (CRS {gdf.crs})")
        crs = crs or gdf.crs
        frames.append(gdf[["GKODAS", "Suk_DATA", "Red_DATA", "geometry"]])
    combined = pd.concat(frames, ignore_index=True)
    return gpd.GeoDataFrame(combined, geometry="geometry", crs=crs)


def snapshot_year(gdf: gpd.GeoDataFrame) -> int:
    dates = pd.concat([gdf["Suk_DATA"], gdf["Red_DATA"]]).dropna()
    return int(dates.max().year)


def main() -> None:
    shp_dir = find_shp_dir()
    print(f"Reading GRPK PLOTAI shapefiles from {shp_dir}")

    gdf = load_plots(shp_dir)
    year = snapshot_year(gdf)
    print(f"Snapshot year (latest Suk_DATA/Red_DATA across all plots): {year}")

    rules, default = load_mapping()
    gdf["class_id"] = classify_gkodas(gdf["GKODAS"], rules, default).map(CLASS_TO_ID).astype("uint8")

    gdf = gdf[gdf.geometry.notna() & gdf.geometry.is_valid]
    print(f"Reprojecting {len(gdf)} valid plots to EPSG:4326 for rasterization...")
    gdf = gdf.to_crs(4326)

    height = int(round((DASHBOARD_NORTH - DASHBOARD_SOUTH) / DASHBOARD_RES_DEG))
    width = int(round((DASHBOARD_EAST - DASHBOARD_WEST) / DASHBOARD_RES_DEG))
    dst_transform = from_bounds(DASHBOARD_WEST, DASHBOARD_SOUTH, DASHBOARD_EAST, DASHBOARD_NORTH, width, height)

    print(f"Rasterizing onto {width}x{height} dashboard grid...")
    shapes = ((geom, int(cid)) for geom, cid in zip(gdf.geometry, gdf["class_id"]))
    arr = rasterize(
        shapes,
        out_shape=(height, width),
        transform=dst_transform,
        fill=0,
        dtype="uint8",
    )

    OUT_GEOTIFF_DIR.mkdir(parents=True, exist_ok=True)
    out_tif = OUT_GEOTIFF_DIR / f"grpk_{year}.tif"
    with rasterio.open(
        out_tif,
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
        dst.write(arr, 1)
        dst.write_colormap(1, {code: (*hex_to_rgb(hexcolor), 255) for code, hexcolor in CLASS_COLORS_HEX.items()})
    print("Saved", out_tif)

    values, counts = np.unique(arr[arr != 0], return_counts=True)
    class_names_by_id = {v: k for k, v in CLASS_TO_ID.items()}
    records = [(year, int(v), class_names_by_id.get(int(v), f"class_{v}"), int(c)) for v, c in zip(values, counts)]

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"]).to_csv(OUT_CSV, index=False)
    print("Saved", OUT_CSV)

    total = sum(c for _, _, _, c in records)
    print("National shares (dashboard-grid pixel counts):")
    for _, _, name, cnt in records:
        print(f"  {name}: {cnt / total * 100:.2f}%")


if __name__ == "__main__":
    main()
