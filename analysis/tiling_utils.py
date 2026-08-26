# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

"""
Shared helpers for the zoom-dependent map-display tiling scheme used by
export_esri_tiles.py and export_grpk_tiles.py.

Three tiers, all covering the same fixed Lithuania WGS84 box used elsewhere
in the dashboard (LT_SOUTH/WEST/NORTH/EAST):
  national — whole country in one file, coarse GSD (fast default view)
  regional — a small geographic grid, medium GSD (one file per cell)
  close    — a finer geographic grid, native/fine GSD (one file per cell,
             only the cell(s) under the current viewport ever need loading)

A grid of N x N cells partitions the box into equal lon/lat steps. Cell
(row, col) covers row in [0, N) from south to north, col in [0, N) from
west to east — matching how the dashboard's map JS will pick cells from the
current viewport bounds.
"""

from __future__ import annotations

import math

LT_SOUTH, LT_WEST = 53.45, 20.45
LT_NORTH, LT_EAST = 56.65, 26.85


def deg_per_pixel(gsd_m: float, center_lat: float) -> tuple[float, float]:
    """(res_lon_deg, res_lat_deg) for a target ground sample distance in meters.

    Longitude and latitude convert differently (a degree of longitude is
    shorter the further from the equator), so each axis is computed
    separately rather than using one approximate square degree size.
    """
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(center_lat))
    return gsd_m / m_per_deg_lon, gsd_m / m_per_deg_lat


def cell_bounds(grid: int, row: int, col: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of one grid cell within the shared LT box."""
    lon_step = (LT_EAST - LT_WEST) / grid
    lat_step = (LT_NORTH - LT_SOUTH) / grid
    west = LT_WEST + col * lon_step
    east = west + lon_step
    south = LT_SOUTH + row * lat_step
    north = south + lat_step
    return west, south, east, north
