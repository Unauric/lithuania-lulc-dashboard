# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Re-splits the already-exported GRPK vector-tier cells
(rasters/grpk/tiles/vector/*.geojson, 32x32 grid) into a much finer grid.

Why: the worst-case cell (dense Vilnius/Kaunas urban core) was 10,704
features / ~40MB. Loading it required real main-thread time to JSON.parse
and to have Leaflet construct+render that many Path features — confirmed via
browser timing (fetch completes near-instantly on localhost, but visible
coverage only reached ~50% at 1.1s and ~100% at 1.7s after that). That delay
is what read as "zoom in, doesn't load" — it always finished on its own,
just slowly enough to look broken, and "zoom in and out again" only
appeared to fix it by giving the same in-flight render more real time
before the next check.

This reads the EXISTING per-cell files, not the original ~1.95M-feature
PLOTAI shapefiles, so it runs in minutes instead of repeating the ~2 hour
full shapefile stream. Two passes to avoid holding thousands of file
handles open at once (Windows' per-process fd limit is typically small):
  1. stream each old cell's features into per-new-cell newline-delimited
     JSON files (opened/appended/closed per old-cell/new-cell pair, not per
     feature)
  2. wrap each .jsonl file into a proper GeoJSON FeatureCollection

Run from Data/:
  python analysis/resplit_grpk_vector_tiles.py
"""

from __future__ import annotations

import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiling_utils import LT_EAST, LT_NORTH, LT_SOUTH, LT_WEST

BASE = Path(__file__).resolve().parent.parent  # .../LEI/Data
OLD_DIR = BASE / "rasters" / "grpk" / "tiles" / "vector"
RAW_DIR = BASE / "rasters" / "grpk" / "tiles" / "vector_raw_tmp"
MANIFEST_PATH = BASE / "rasters" / "grpk" / "tiles" / "manifest.json"

NEW_GRID = 128


def centroid_of_geometry(geom: dict) -> tuple[float, float]:
    coords: list[list[float]] = []

    def walk(c):
        if isinstance(c[0], (int, float)):
            coords.append(c)
        else:
            for cc in c:
                walk(cc)

    walk(geom["coordinates"])
    n = len(coords)
    return (sum(c[0] for c in coords) / n, sum(c[1] for c in coords) / n)


def cell_for_point(lon: float, lat: float, grid: int) -> tuple[int, int] | None:
    lon_step = (LT_EAST - LT_WEST) / grid
    lat_step = (LT_NORTH - LT_SOUTH) / grid
    col = int((lon - LT_WEST) // lon_step)
    row = int((lat - LT_SOUTH) // lat_step)
    if col < 0 or col >= grid or row < 0 or row >= grid:
        return None
    return (row, col)


def pass1_resplit() -> dict[tuple[int, int], int]:
    old_files = sorted(OLD_DIR.glob("*.geojson"))
    print(f"Pass 1: re-splitting {len(old_files)} existing cells (grid=32) into grid={NEW_GRID}...")
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    counts: dict[tuple[int, int], int] = defaultdict(int)
    total_in = 0

    for i, path in enumerate(old_files):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        feats = data["features"]
        total_in += len(feats)

        by_new_cell: dict[tuple[int, int], list[str]] = defaultdict(list)
        for feat in feats:
            cx, cy = centroid_of_geometry(feat["geometry"])
            cell = cell_for_point(cx, cy, NEW_GRID)
            if cell is None:
                continue
            by_new_cell[cell].append(json.dumps(feat, separators=(",", ":")))

        for cell, lines in by_new_cell.items():
            row, col = cell
            with open(RAW_DIR / f"{row}_{col}.jsonl", "a", encoding="utf-8") as out:
                out.write("\n".join(lines) + "\n")
            counts[cell] += len(lines)

        if (i + 1) % 50 == 0:
            print(f"  processed {i+1}/{len(old_files)} old cells...")

    total_out = sum(counts.values())
    print(f"Pass 1 done: {total_in} features read, {total_out} written across {len(counts)} new cells")
    print(f"Max features in any new cell: {max(counts.values()) if counts else 0}")
    return counts


def pass2_finalize(counts: dict[tuple[int, int], int]) -> None:
    print(f"Pass 2: wrapping {len(counts)} .jsonl files into proper GeoJSON FeatureCollections...")
    for (row, col) in counts:
        raw_path = RAW_DIR / f"{row}_{col}.jsonl"
        out_path = OLD_DIR / f"{row}_{col}.geojson"
        with open(raw_path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
        with open(out_path, "w", encoding="utf-8") as f:
            f.write('{"type":"FeatureCollection","features":[')
            f.write(",".join(lines))
            f.write("]}")
    print("Pass 2 done.")


def main() -> None:
    # Remove the old 32x32 cell files first — they'll be replaced by the new
    # finer-grid files written to the same directory (OLD_DIR), and stale
    # ones left behind (e.g. an old cell whose features all moved elsewhere)
    # would otherwise linger as orphaned, incorrect-grid files.
    old_files = sorted(OLD_DIR.glob("*.geojson"))
    counts = pass1_resplit()

    for p in old_files:
        p.unlink()

    pass2_finalize(counts)
    shutil.rmtree(RAW_DIR)

    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["vector_tier"] = {
        "grid": NEW_GRID,
        "cells": [[r, c] for (r, c) in counts.keys()],
    }
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Updated manifest.json: vector_tier.grid={NEW_GRID}, {len(counts)} populated cells")


if __name__ == "__main__":
    main()
