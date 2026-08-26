# -*- coding: utf-8 -*-
# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.
r"""
Basin-by-basin correlation between land-cover change (Esri 10m Annual LULC,
2017-2025) and hydrology, using the most-downstream in-basin gauging
station on each basin's main river.

## Method

1. **Rivers**: River_System_LTU.shp (OSM-derived, 44,717 features) filtered to
   fclass='river' (the 2,929 major-river features; excludes minor streams/
   drains/canals). Bilingual border segments (e.g. "Nemunas / Немунас") are
   matched on their primary (first) name so upstream reaches near the
   Belarus/Latvia border aren't silently dropped.

2. **Basins**: the dashboard's own 19 sub-basin polygons (lt_subbasins.json).
   13 have a single clearly-named main river; the other 6 are unnamed
   residual/coastal catchments. Of those 6, 4 (Bartuvos, Ventos, Lietuvos
   pajūrio upių, and the small coastal Šventoji near Palanga) were added
   best-effort per a later user decision, matched to the most prominent
   river mapped inside each (see EXTRA_NAMED_BASINS / the extra
   RIVER_UNITS entries below); Dauguvos and Priegliaus remain excluded
   since Lithuania's mapped territory in those two is too small/marginal
   for a meaningful pick. Within the original 13, 3 basins (Nevėžis, Mūša,
   Lielupės mažieji intakai) contain a SECOND river judged comparably
   important (>=60% of the dominant river's mapped length inside the
   basin, and with its own gauging station) -- both are analyzed
   independently, giving 20 river units total (see RIVER_UNITS below).

3. **Most-downstream in-basin station**: there is no DEM/flow-direction
   layer in this project, so this is inferred geometrically, not routed.
   For each river unit:
     a. merge that river's line segments inside the basin polygon into one
        connected LineString (if the basin-clipped pieces don't merge into
        a single LineString -- a real gap in the OSM digitization, or a
        braided/split channel -- the longest component is used for linear
        referencing and the result is flagged with a "geometry_note"),
     b. locate an "outlet" point -- for rivers that drain into another one
        of the 13 basins (e.g. Merkys -> Nemuno mažieji intakai), the outlet
        is the point on the river line nearest the shared basin-boundary;
        for rivers that drain out of the analysis area entirely (into the
        sea, or into Latvia), the outlet is the line's own extremity toward
        the sea / the basin's northernmost point (the max-northing VERTEX of
        the merged line -- this heuristic breaks down for a river that bends
        north mid-course before its true, non-north confluence),
     c. every hydro station tagged with that river's name (see
        hydro_stations.json) is projected onto the line and measured by
        distance-from-outlet; the station is ALSO required to fall inside
        (or within 2km of) the target basin polygon -- this catches river
        name collisions (Lithuania has two unrelated rivers both named
        "Šventoji": the intended Neris tributary, and a small coastal one
        near Palanga -- the coastal station is correctly excluded here),
     d. the station CLOSEST to the outlet is picked -- i.e. the most
        downstream gauge still inside the basin. A downstream gauge
        integrates flow contributed by the whole upstream basin (which is
        what its land cover is being correlated against); a station near
        the headwaters would miss most of the basin's own catchment.
   Every pick in this script was checked by hand against real coordinates
   before being trusted (see the session's own investigation) -- this is an
   inference, not ground truth from a real hydrological model. Some of
   these rivers have catchments extending well beyond the mapped basin
   polygon and even beyond Lithuania (see CATCHMENT_CAVEATS below); for
   those, the downstream station's flow reflects far more than this basin's
   land cover by physical necessity.

4. **Hydrology**: api.meteo.lt's historical endpoint accepts a YYYY-MM date
   (confirmed by direct probing -- NOT documented as such anywhere obvious),
   returning a whole month of daily readings in one request. Values are
   coerced to numeric and physically implausible negative discharge readings
   (sensor errors) are dropped; negative water level is kept, since a stage
   below the gauge's zero datum is physically normal. For each picked
   station and each Esri year (2017-2025), all 12 months are fetched.
   Annualization is monthly-first: a calendar month's mean is only used if
   it has >= MIN_VALID_DAYS_PER_MONTH (20) daily readings, a year is only
   used if it has >= MIN_VALID_MONTHS (11) such valid months, and the annual
   value is the UNWEIGHTED average of those monthly means (not a flat
   average of all daily values) -- this keeps a year with a data-sparse
   winter from being silently dominated by summer readings, and is leap-year
   neutral by construction. Per station, discharge (m^3/s) is used whenever
   it's reported on at least half as many days as water level is (comparing
   discharge coverage to level coverage, rather than requiring an absolute
   majority of all days, correctly classifies discharge-only stations that
   still report a handful of level days); otherwise water level (cm) is
   used for that whole station as a fallback (discharge isn't comparable in
   absolute terms across different-sized rivers, but not every station
   measures it). A station with genuinely zero observations of either
   metric is excluded with an explicit "no observations returned" error
   rather than silently defaulting to an empty "discharge" result.

5. **Land cover**: outputs/subbasin_zonal_esri.csv (already computed by
   export_esri_lithuania.py from the native 10m raster, one row per
   basin/year/class). Class share = count / (sum of classes 1-5) -- "% of
   classified grid cells", matching the convention the dashboard's own trend
   chart already uses.

6. **Correlation**: per basin, per land-cover class (Water/Wetland/Urban/
   Agriculture/Forest), Pearson (linear) and Spearman (rank/monotonic)
   correlation between that class's annual % share and the station's annual
   hydrology mean, paired by year (pairwise-complete: a year missing on
   either side, including a land-cover class with zero mapped pixels that
   year, is dropped for that class only, not zero-filled). Esri's real span
   is only 9 years, and station data availability trims that further -- n
   is typically ~6-9. That is NOT enough for a statistically reliable
   correlation estimate. p-values come from a paired permutation test
   (permuting the hydrology series against the fixed land-cover series;
   exact enumeration for n<=8, 100,000-draw Monte Carlo above that) rather
   than the classic t-distribution approximation, since n this small makes
   the normality assumption behind the t-approximation shaky. Because 5
   classes are tested per river unit, each unit's 5 p-values are also
   Benjamini-Hochberg FDR-adjusted into q-values (separately for the
   Pearson and Spearman families) -- every result is reported with its
   exact n, r, p, AND q so this can be judged honestly rather than asserted
   as fact.

Run from Data/:
  python analysis/basin_hydrology_correlation.py

Outputs:
  outputs/basin_hydrology_correlation.json  (full detail)
  outputs/basin_hydrology_correlation.csv   (flat table of every correlation)
  outputs/basin_hydrology_correlation_report.md  (per-basin narrative summary)
"""

from __future__ import annotations

import json
import sys
import time
from itertools import permutations
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from scipy import stats
from shapely.geometry import Point, shape
from shapely.ops import linemerge, nearest_points

# Windows' console defaults to cp1252, which can't print Lithuanian
# diacritics (basin/river/station names) -- force UTF-8 stdout so this
# script's own progress logging doesn't crash on them.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).resolve().parent.parent  # repo root
REPO = BASE  # River_System_LTU.shp lives at the repo root alongside dashboard/, outputs/, etc.
OUT = BASE / "outputs"
CACHE_DIR = BASE / "analysis" / "_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

RIVER_SHP = REPO / "River_System_LTU.shp"
SUBBASINS_JSON = BASE / "lt_subbasins.json"
STATIONS_JSON = BASE / "dashboard" / "hydro_stations.json"
SEA_EXCLUSION_GEOJSON = BASE / "analysis" / "reference_geo" / "grpk_water_exclusion.geojson"
ESRI_ZONAL_CSV = OUT / "subbasin_zonal_esri.csv"

API_BASE = "https://api.meteo.lt/v1/"
HEADERS = {"User-Agent": "lei-basin-hydrology-analysis/1.0"}
REQUEST_DELAY_S = 0.05  # be polite to a public API we're hitting ~1700 times

ESRI_YEARS = list(range(2017, 2026))
MIN_VALID_DAYS_PER_MONTH = 20  # a calendar month needs this many daily readings to count
MIN_VALID_MONTHS = 11  # a year needs this many valid monthly means to count
CLASS_NAMES = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}
PERMUTATION_SEED = 0
PERMUTATION_N_RESAMPLES = 100_000  # exact for n<=8 (8!=40,320 < this); Monte Carlo above that

# Rough transboundary-catchment caveats (general geographic knowledge, not
# derived from any DEM/catchment delineation in this project) so a reader
# isn't misled into thinking a basin's mapped land-cover polygon explains
# 100% of a gauge's flow when much of the real catchment lies outside
# Lithuania entirely.
CATCHMENT_CAVEATS = {
    "Nemunas": "Mainstem gauge drains a mostly Belarusian catchment — basin land cover explains little of this flow.",
    "Neris": "Roughly 70% of the catchment lies in Belarus.",
    "Merkys": "Part of the catchment lies upstream in Belarus.",
    "Šešupė": "Part of the catchment lies upstream in Poland.",
    "Nemunėlis": "Catchment shared with Latvia.",
}

# (basin_name, river_name, downstream_ref) -- downstream_ref is either
# ("basin", other_basin_name): outlet = point on this river nearest the
#   shared boundary with that (downstream) basin;
# ("sea",): outlet = point on this river nearest the Baltic/lagoon exclusion
#   polygon (reused from the dashboard's own GRPK/CORINE/HILDA water mask);
# ("north",): outlet = this river's own northernmost point (basins draining
#   to Latvia, or a same-basin tributary whose confluence lies north).
RIVER_UNITS: list[tuple[str, str, tuple]] = [
    ("Nemuno mažieji intakai", "Nemunas", ("sea",)),
    ("Merkys", "Merkys", ("basin", "Nemuno mažieji intakai")),
    ("Šešupė", "Šešupė", ("basin", "Nemuno mažieji intakai")),
    ("Neris", "Neris", ("basin", "Nemuno mažieji intakai")),
    ("Žeimena", "Žeimena", ("basin", "Neris")),
    ("Minija", "Minija", ("sea",)),
    ("Šventoji", "Šventoji", ("basin", "Neris")),
    ("Dubysa", "Dubysa", ("basin", "Nemuno mažieji intakai")),
    ("Jūra", "Jūra", ("basin", "Nemuno mažieji intakai")),
    ("Nevėžis", "Nevėžis", ("basin", "Nemuno mažieji intakai")),
    ("Nevėžis", "Šušvė", ("north",)),
    ("Lielupės mažieji intakai", "Švėtė", ("north",)),
    ("Lielupės mažieji intakai", "Platonis", ("north",)),
    ("Mūša", "Mūša", ("north",)),
    ("Mūša", "Lėvuo", ("north",)),
    ("Nemunėlis", "Nemunėlis", ("north",)),
    # The 4 below were originally excluded (docstring, Method step 2) as
    # "unnamed residual/coastal catchments" -- their PAVADINIMA in
    # lt_subbasins.json is "-", so they need EXTRA_NAMED_BASINS (below) to
    # even get a basin_by_name entry. Re-added per a later user decision to
    # best-effort cover them; Dauguvos and Priegliaus (also unnamed) were
    # deliberately left out since Lithuania's mapped territory in those two
    # is too small/marginal for a meaningful river+station pick.
    ("Bartuvos", "Bartuva", ("sea",)),
    ("Ventos", "Venta", ("sea",)),
    # No single named river covers this coastal-rivers basin -- Danė (the
    # Klaipėda-area river matched here) is the most prominent one mapped in
    # OSM inside it. Station waterBody for this river reads "Akmena-Danė"
    # (compound), not "Danė" alone, so pick_downstream_stations' substring
    # fallback (see below) is what actually finds a candidate here.
    ("Lietuvos pajūrio upių", "Danė", ("sea",)),
    # Distinct basin_name from the "Šventoji" unit above (basin: Šventoji,
    # the Neris tributary) -- this is the small, unrelated coastal river of
    # the same name near Palanga (see the module docstring's own note on
    # Lithuania's two same-named Šventoji rivers). Genitive "Šventosios" to
    # match dashboard/basins-config.json's "689": "Šventosios (pajūrio)" --
    # same basin, so the hydrology tab's card title and the map's basin
    # label read as the same place, not two similarly-spelled ones.
    ("Šventosios (pajūrio)", "Šventoji", ("sea",)),
]

# OBJECTID -> basin_name for polygons whose PAVADINIMA is "-" in
# lt_subbasins.json but that a RIVER_UNITS entry above references. Verified
# against real-world landmarks (point-in-polygon) since an earlier labeling
# pass had several of these scrambled -- see dashboard/basins-config.json's
# own description field for the same fix on the display-name side.
EXTRA_NAMED_BASINS: dict[str, int] = {
    "Bartuvos": 687,
    "Ventos": 683,
    "Lietuvos pajūrio upių": 681,
    "Šventosios (pajūrio)": 689,
}


# ── Step 1: rivers, basins, stations, station picking ──────────────────────


def load_geodata():
    rivers = gpd.read_file(RIVER_SHP)
    rivers = rivers[rivers["fclass"] == "river"].to_crs("EPSG:3346")
    rivers["primary_name"] = rivers["name"].str.split("/").str[0].str.strip()

    with open(SUBBASINS_JSON, encoding="utf-8") as f:
        fc = json.load(f)
    basins = gpd.GeoDataFrame.from_features(fc["features"], crs="EPSG:4326").to_crs("EPSG:3346")
    named = basins[basins["PAVADINIMA"] != "-"].reset_index(drop=True)
    basin_by_name = {row["PAVADINIMA"]: row.geometry for _, row in named.iterrows()}
    basin_index_by_name = {row["PAVADINIMA"]: basins.index[basins["PAVADINIMA"] == row["PAVADINIMA"]][0] for _, row in named.iterrows()}
    for name, oid in EXTRA_NAMED_BASINS.items():
        row = basins[basins["OBJECTID"] == oid].iloc[0]
        basin_by_name[name] = row.geometry
        basin_index_by_name[name] = basins.index[basins["OBJECTID"] == oid][0]

    with open(STATIONS_JSON, encoding="utf-8") as f:
        stations = json.load(f)["stations"]
    stations_gdf = gpd.GeoDataFrame(
        stations, geometry=[Point(s["lon"], s["lat"]) for s in stations], crs="EPSG:4326"
    ).to_crs("EPSG:3346")

    with open(SEA_EXCLUSION_GEOJSON, encoding="utf-8") as f:
        sea_feat = json.load(f)
    sea_geom = gpd.GeoSeries([shape(sea_feat["geometry"])], crs="EPSG:4326").to_crs("EPSG:3346").iloc[0]

    return rivers, basin_by_name, basin_index_by_name, stations_gdf, sea_geom


def write_basin_stations_geojson(basin_by_name: dict, stations_gdf) -> None:
    """Every station that geometrically falls inside each of the 13 named
    basins (not just the one or two "most downstream on the main river"
    picks used for correlation) -- so the dashboard's hydrology map mode can show
    the full local gauging context for a basin, not just its analysis
    station(s). Written as {basin_name: [{code, name}, ...]}."""
    out: dict[str, list[dict]] = {}
    for basin_name, poly in basin_by_name.items():
        inside = stations_gdf[stations_gdf.within(poly)]
        out[basin_name] = [{"code": r["code"], "name": r["name"]} for _, r in inside.iterrows()]
    with open(OUT / "basin_hydrology_stations.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def merged_line_for(rivers, poly, river_name):
    """Returns (line, fragmented) where `fragmented` is True if the
    basin-clipped segments didn't merge into one connected LineString (a
    real gap in the OSM digitization, or a braided/split channel) -- in
    that case `line` is the longest component, picked so linear referencing
    (line.project(...)) still works, but the caller should flag this pick
    for audit rather than trust it silently."""
    sub = rivers[(rivers["primary_name"] == river_name) & rivers.intersects(poly)]
    if sub.empty:
        return None, False
    clipped = sub.geometry.intersection(poly)
    flat = []
    for geom in clipped:
        if geom.is_empty:
            continue
        if geom.geom_type == "LineString":
            flat.append(geom)
        elif geom.geom_type == "MultiLineString":
            flat.extend(list(geom.geoms))
        elif geom.geom_type == "GeometryCollection":
            for g in geom.geoms:
                if g.geom_type == "LineString":
                    flat.append(g)
                elif g.geom_type == "MultiLineString":
                    flat.extend(list(g.geoms))
    if not flat:
        return None, False
    merged = linemerge(flat)
    fragmented = merged.geom_type == "MultiLineString"
    if fragmented:
        merged = max(list(merged.geoms), key=lambda g: g.length)
    return merged, fragmented


def pick_downstream_stations(rivers, basin_by_name, stations_gdf, sea_geom):
    """Returns list of dicts, one per RIVER_UNITS entry, with the picked
    (most-downstream in-basin) station + supporting detail (kept for the
    report / audit trail)."""
    results = []
    for basin_name, river_name, ref in RIVER_UNITS:
        poly = basin_by_name[basin_name]
        line, fragmented = merged_line_for(rivers, poly, river_name)
        if line is None or line.is_empty:
            results.append({"basin": basin_name, "river": river_name, "error": "no river geometry found"})
            continue
        geometry_note = "fragmented river line; using longest component" if fragmented else None

        if ref[0] == "basin":
            other_poly = basin_by_name[ref[1]]
            shared = poly.boundary.intersection(other_poly.boundary)
            ref_point = shared.centroid if not shared.is_empty else other_poly.centroid
            outlet_pt, _ = nearest_points(line, ref_point)
        elif ref[0] == "sea":
            outlet_pt, _ = nearest_points(line, sea_geom)
        elif ref[0] == "north":
            # Assumes the merged line's own max-northing VERTEX is the
            # outlet; this breaks down for a river that bends north
            # mid-course before turning back to its true (non-north)
            # confluence -- verify visually for any RIVER_UNITS entry using
            # this ref before trusting its station pick.
            coords = list(line.coords)
            outlet_pt = Point(max(coords, key=lambda c: c[1]))
        else:
            raise ValueError(ref)

        outlet_dist = line.project(outlet_pt)

        name_matched = stations_gdf[stations_gdf["waterBody"] == river_name]
        if name_matched.empty:
            # Some stations sit on a compound-named reach (e.g. waterBody
            # "Akmena-Danė" for a river mapped in OSM as just "Danė") --
            # fall back to substring containment so those aren't silently
            # invisible to a river_name that's only half the compound name.
            name_matched = stations_gdf[stations_gdf["waterBody"].str.contains(river_name, regex=False, na=False)]
        cands = name_matched[name_matched.within(poly.buffer(2000))].copy()
        dropped = sorted(set(name_matched["code"]) - set(cands["code"]))
        if cands.empty:
            results.append({
                "basin": basin_name, "river": river_name, "_line_geom_3346": line,
                "geometry_note": geometry_note,
                "error": "no in-basin station found", "name_matched_but_excluded": dropped,
            })
            continue

        cands["dist_from_outlet_m"] = (cands.geometry.apply(lambda g: line.project(g)) - outlet_dist).abs()
        # Ascending: the station CLOSEST to the outlet is most downstream in
        # this basin, and is what we pick (see the module docstring, Method
        # step 3d) -- it integrates flow from the whole upstream basin.
        cands = cands.sort_values("dist_from_outlet_m", ascending=True)
        top = cands.iloc[0]

        results.append({
            "basin": basin_name,
            "river": river_name,
            "_line_geom_3346": line,  # stripped before JSON dump; used for the GeoJSON export
            "geometry_note": geometry_note,
            "catchment_caveat": CATCHMENT_CAVEATS.get(river_name),
            "station_code": top["code"],
            "station_name": top["name"],
            "station_water_body": top["waterBody"],
            "station_lat": float(top["lat"]),
            "station_lon": float(top["lon"]),
            "dist_from_outlet_km": round(top["dist_from_outlet_m"] / 1000, 1),
            "river_length_in_basin_km": round(line.length / 1000, 1),
            "other_candidates": [
                {"code": r["code"], "name": r["name"], "dist_from_outlet_km": round(r["dist_from_outlet_m"] / 1000, 1)}
                for _, r in cands.iloc[1:].iterrows()
            ],
            "name_matched_but_excluded": dropped,
        })
    return results


# ── Step 2: fetch + aggregate hydrology from api.meteo.lt ──────────────────


def fetch_month_cached(code: str, ym: str) -> list[dict]:
    """Disk-cached fetch of one station-month. Only a genuine HTTP 200 (real
    data, possibly an empty list e.g. before the station existed) or a
    genuine 404 (real "no such resource", cached as a {"status": "no-data"}
    sentinel) are ever written to disk -- a retry-ladder exhaustion or any
    other error status returns [] for THIS run only and leaves no cache
    file behind, so a transient outage can't permanently poison the cache
    with a false "no data" that a later re-run would trust forever."""
    cache_file = CACHE_DIR / f"{code}_{ym}.json"
    if cache_file.exists():
        with open(cache_file, encoding="utf-8") as f:
            cached = json.load(f)
        if isinstance(cached, dict) and cached.get("status") == "no-data":
            return []
        return cached

    url = f"{API_BASE}hydro-stations/{code}/observations/historical/{ym}"
    obs: list[dict] | None = None
    got_404 = False
    for attempt in range(3):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
        except requests.RequestException:
            time.sleep(1.0)
            continue
        if resp.status_code == 200:
            obs = resp.json().get("observations", [])
            break
        if resp.status_code == 404:
            got_404 = True
            break
        if resp.status_code == 429:
            time.sleep(2.0 * (attempt + 1))
            continue
        break  # other non-retryable status: cache nothing, just return []

    time.sleep(REQUEST_DELAY_S)

    if obs is not None:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(obs, f)
        return obs
    if got_404:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({"status": "no-data"}, f)
        return []
    return []


def fetch_station_series(code: str) -> pd.DataFrame:
    """All daily observations for `code` across ESRI_YEARS, one row per day.
    waterLevel/waterDischarge are coerced to numeric, and negative discharge
    (a sensor error -- flow can't be negative) is dropped. Negative water
    level is NOT clamped: a stage below the gauge's zero datum is physically
    valid."""
    rows = []
    for year in ESRI_YEARS:
        for month in range(1, 13):
            ym = f"{year}-{month:02d}"
            for o in fetch_month_cached(code, ym):
                rows.append({
                    "year": year,
                    "date": o.get("observationDateUtc"),
                    "waterLevel": o.get("waterLevel"),
                    "waterDischarge": o.get("waterDischarge"),
                })
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    for c in ("waterLevel", "waterDischarge"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df.loc[df["waterDischarge"] < 0, "waterDischarge"] = pd.NA
    return df


def choose_metric_and_annualize(df: pd.DataFrame) -> tuple[str | None, dict[int, dict]]:
    """Decide discharge-vs-level for this station, then build a seasonally
    unbiased {year: {mean, n_days, n_months}} for that metric.

    Metric selection compares discharge coverage AGAINST level coverage
    (not against total days) so a genuinely discharge-only station -- which
    still reports a handful of level days at many sites -- isn't
    misclassified as "level" and silently dropped.

    Annualization is monthly-first: a calendar month's mean only counts if
    it has >= MIN_VALID_DAYS_PER_MONTH daily values; a year only counts if
    it has >= MIN_VALID_MONTHS such valid months; the annual mean is the
    UNWEIGHTED average of those monthly means. Every month contributes
    equally regardless of its day count, so this is leap-year neutral by
    construction and isn't skewed by whichever season happened to report
    more complete data in a given year."""
    if df.empty:
        return None, {}
    level_days = int(df["waterLevel"].notna().sum())
    disch_days = int(df["waterDischarge"].notna().sum())
    if disch_days == 0 and level_days == 0:
        return None, {}
    metric = "discharge" if disch_days >= 0.5 * level_days else "level"
    col = "waterDischarge" if metric == "discharge" else "waterLevel"

    df = df.copy()
    df["month"] = df["date"].astype(str).str.slice(5, 7)

    annual: dict[int, dict] = {}
    for year, g in df.groupby("year"):
        monthly_means = []
        n_days_total = 0
        for _month, mg in g.groupby("month"):
            vals = mg[col].dropna()
            if len(vals) < MIN_VALID_DAYS_PER_MONTH:
                continue
            monthly_means.append(float(vals.mean()))
            n_days_total += len(vals)
        if len(monthly_means) < MIN_VALID_MONTHS:
            continue
        annual[int(year)] = {
            "mean": float(np.mean(monthly_means)),
            "n_days": n_days_total,
            "n_months": len(monthly_means),
        }
    return metric, annual


# ── Step 3: land cover shares from the Esri sub-basin zonal CSV ────────────


def load_esri_shares(basin_index_by_name: dict) -> dict:
    """{basin_name: {year: {class_name: pct}}}"""
    df = pd.read_csv(ESRI_ZONAL_CSV)
    out: dict = {}
    for basin_name, idx in basin_index_by_name.items():
        sub = df[df["basin_index"] == idx]
        per_year = {}
        for year, g in sub.groupby("year"):
            classed = g[g["class_id"] != 0]
            total = classed["count"].sum()
            if total <= 0:
                continue
            shares = {CLASS_NAMES[cid]: (cnt / total * 100.0) for cid, cnt in zip(classed["class_id"], classed["count"])}
            per_year[int(year)] = shares
        out[basin_name] = per_year
    return out


# ── Step 4: correlation ─────────────────────────────────────────────────────


def _rank(a: np.ndarray) -> np.ndarray:
    """Average-rank transform (tied values get the mean of their tied
    ranks) -- equivalent to scipy.stats.rankdata, reimplemented locally so
    the vectorized permutation loop below never calls back into scipy once
    per resample."""
    order = np.argsort(a, kind="mergesort")
    sorted_a = a[order]
    ranks = np.empty(len(a), dtype=float)
    n = len(a)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sorted_a[j + 1] == sorted_a[i]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def permutation_p_value(x, y, kind: str) -> float:
    """Two-sided, paired permutation p-value for Pearson r or Spearman rho.
    y is repeatedly shuffled against the fixed x; the p-value is the
    fraction of shuffles whose |statistic| is at least as extreme as the
    one actually observed.

    Fully vectorized rather than looping scipy.stats.pearsonr/spearmanr
    once per resample (a straightforward `scipy.stats.permutation_test(...,
    vectorized=False)` call does exactly that, and is prohibitively slow at
    n_resamples=100_000 across this script's ~160 tests -- tens of minutes
    of wall time for what should be a few seconds of numpy). The trick:
    permuting y does not change y's own mean or variance (it's the same
    values in a different order), so the Pearson-r denominator
    sqrt(Sxx * Syy) is IDENTICAL across every resample -- the correlation
    for a given permutation reduces to one dot product between the
    mean-centered x and that resample's permuted, mean-centered y. Every
    resample's r is therefore one row of a single big matrix multiply
    instead of 100,000+ individual Python-level scipy calls. Spearman uses
    the exact same trick on rank-transformed x/y (Spearman's rho IS
    Pearson's r computed on ranks, and permuting y's raw values then
    ranking yields the same multiset of ranks permuted the same way, so
    this is mathematically exact, not an approximation of scipy's own
    result).

    n_resamples=PERMUTATION_N_RESAMPLES=100,000: EXACT (every distinct
    permutation enumerated) for n<=8, since 8!=40,320 < 100,000; a seeded
    Monte Carlo estimate for n=9 (9!=362,880)."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if kind == "spearman":
        x, y = _rank(x), _rank(y)

    n = len(x)
    dx = x - x.mean()
    dy = y - y.mean()
    sxx = np.sum(dx * dx)
    syy = np.sum(dy * dy)
    denom = np.sqrt(sxx * syy)
    if denom == 0:
        return 1.0
    observed = abs(np.dot(dx, dy) / denom)

    if n <= 8:
        perms = np.array(list(permutations(range(n))))  # (n!, n) index rows -- exact test
    else:
        rng = np.random.default_rng(PERMUTATION_SEED)
        perms = np.array([rng.permutation(n) for _ in range(PERMUTATION_N_RESAMPLES)])

    dy_perm = dy[perms]  # (n_resamples, n) -- every row a permutation of dy
    r_dist = (dy_perm @ dx) / denom  # (n_resamples,) -- one matrix-vector multiply
    return float(np.mean(np.abs(r_dist) >= observed - 1e-12))


def benjamini_hochberg(pvals: list[float]) -> list[float]:
    """Benjamini-Hochberg FDR-adjusted q-values, returned in the same order
    as `pvals`. Standard procedure: sort ascending, adj_(i) = p_(i) * m / i,
    then take the cumulative minimum from the largest rank down (so
    q-values are monotone non-decreasing with p), capped at 1.0."""
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    ranked = [pvals[i] for i in order]
    adj = [ranked[i] * m / (i + 1) for i in range(m)]
    for i in range(m - 2, -1, -1):
        adj[i] = min(adj[i], adj[i + 1])
    adj = [min(1.0, a) for a in adj]
    q = [0.0] * m
    for rank_i, orig_i in enumerate(order):
        q[orig_i] = adj[rank_i]
    return q


def correlate(land_cover_by_year: dict, hydro_by_year: dict) -> dict:
    """Per-class Pearson + Spearman between land-cover % share and the
    station's annual hydrology mean, paired by year, pairwise-complete (a
    year missing on either side -- including a class with zero mapped
    pixels that year -- is dropped for that class only, never zero-filled).
    p-values are from a paired permutation test; q-values are
    Benjamini-Hochberg FDR-adjusted across the 5 classes tested per river
    unit, separately for the Pearson and Spearman families. All floats are
    full precision here -- rounding happens only in the CSV/markdown
    writers."""
    common_years = sorted(set(land_cover_by_year) & set(hydro_by_year))
    result = {"years_used": common_years, "n": len(common_years), "per_class": {}}
    if len(common_years) < 3:
        result["note"] = "Fewer than 3 overlapping years -- correlation not computed."
        return result

    per_class: dict[str, dict] = {}
    for class_name in CLASS_NAMES.values():
        pairs = [
            (land_cover_by_year[y][class_name], hydro_by_year[y]["mean"])
            for y in common_years
            if land_cover_by_year[y].get(class_name) is not None
        ]
        if len(pairs) < 3:
            per_class[class_name] = {"note": "fewer than 3 paired years with data for this class"}
            continue
        lc_vals, hydro_vals = zip(*pairs)
        if len(set(lc_vals)) < 2 or len(set(hydro_vals)) < 2:
            per_class[class_name] = {"note": "constant series, correlation undefined"}
            continue
        pr, _ = stats.pearsonr(lc_vals, hydro_vals)
        sr, _ = stats.spearmanr(lc_vals, hydro_vals)
        per_class[class_name] = {
            "pearson_r": float(pr),
            "pearson_p": permutation_p_value(lc_vals, hydro_vals, "pearson"),
            "spearman_r": float(sr),
            "spearman_p": permutation_p_value(lc_vals, hydro_vals, "spearman"),
        }

    valid = [c for c, s in per_class.items() if "note" not in s]
    if valid:
        pearson_q = benjamini_hochberg([per_class[c]["pearson_p"] for c in valid])
        spearman_q = benjamini_hochberg([per_class[c]["spearman_p"] for c in valid])
        for c, pq, sq in zip(valid, pearson_q, spearman_q):
            per_class[c]["pearson_q"] = pq
            per_class[c]["spearman_q"] = sq

    result["per_class"] = per_class
    return result


# ── Main ─────────────────────────────────────────────────────────────────


def write_rivers_geojson(picks: list[dict]) -> None:
    """GeoJSON of the merged river-unit lines actually used (reprojected to
    WGS84), for the dashboard's hydrology map mode -- separate from the
    correlation JSON since Leaflet wants a plain FeatureCollection."""
    lines_3346 = [p["_line_geom_3346"] for p in picks if "_line_geom_3346" in p]
    props = [p for p in picks if "_line_geom_3346" in p]
    gdf = gpd.GeoDataFrame(props, geometry=lines_3346, crs="EPSG:3346").to_crs("EPSG:4326")
    features = []
    for _, row in gdf.iterrows():
        features.append({
            "type": "Feature",
            "geometry": row.geometry.__geo_interface__,
            "properties": {
                "basin": row["basin"],
                "basin_index": int(row["basin_index"]),
                "river": row["river"],
                "station_code": row.get("station_code"),
                "station_name": row.get("station_name"),
            },
        })
    fc = {"type": "FeatureCollection", "features": features}
    with open(OUT / "basin_hydrology_rivers.geojson", "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)


def main() -> None:
    print("Loading rivers, basins, stations...")
    rivers, basin_by_name, basin_index_by_name, stations_gdf, sea_geom = load_geodata()

    print("Picking most-downstream in-basin station per river unit...")
    picks = pick_downstream_stations(rivers, basin_by_name, stations_gdf, sea_geom)
    for p in picks:
        # basin_index ties this back to the dashboard's own basin-filter checkboxes
        # (lt_subbasins.json feature order), which display a possibly-renamed
        # label -- matching on this index instead of the "basin" name string is
        # what lets the dashboard reliably detect "exactly one basin selected"
        # regardless of any display-name sanitizing on the JS side.
        p["basin_index"] = int(basin_index_by_name[p["basin"]])
    for p in picks:
        if "error" in p:
            print(f"  [!] {p['basin']} / {p['river']}: {p['error']}")
        else:
            print(f"  {p['basin']:28s} / {p['river']:12s} -> {p['station_name']} ({p['station_code']})")

    OUT.mkdir(parents=True, exist_ok=True)
    write_rivers_geojson(picks)
    print(f"Wrote {OUT / 'basin_hydrology_rivers.geojson'}")
    write_basin_stations_geojson(basin_by_name, stations_gdf)
    print(f"Wrote {OUT / 'basin_hydrology_stations.json'}")

    print("\nLoading Esri land-cover shares per basin/year...")
    esri_shares = load_esri_shares(basin_index_by_name)

    print("\nFetching hydrology (this hits api.meteo.lt many times; cached under analysis/_cache/)...")
    station_cache: dict[str, tuple[str, dict]] = {}
    basin_results = []
    for p in picks:
        if "error" in p:
            basin_results.append(p)
            continue
        code = p["station_code"]
        if code not in station_cache:
            print(f"  fetching {code} ({p['basin']} / {p['river']})...")
            df = fetch_station_series(code)
            metric, annual = choose_metric_and_annualize(df)
            station_cache[code] = (metric, annual)
        metric, annual = station_cache[code]

        if metric is None:
            basin_results.append({**p, "error": "no observations returned"})
            continue

        lc_by_year = esri_shares.get(p["basin"], {})
        corr = correlate(lc_by_year, annual)

        basin_results.append({
            **p,
            "hydro_metric": metric,
            "hydro_annual": annual,
            "land_cover_annual_pct": lc_by_year,
            "correlation": corr,
        })

    basin_results = [{k: v for k, v in r.items() if k != "_line_geom_3346"} for r in basin_results]
    with open(OUT / "basin_hydrology_correlation.json", "w", encoding="utf-8") as f:
        json.dump(basin_results, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT / 'basin_hydrology_correlation.json'}")

    # Flat CSV -- rounded for human consumption (the JSON keeps full precision)
    csv_rows = []
    for r in basin_results:
        if "error" in r:
            continue
        for class_name, stats_d in r["correlation"].get("per_class", {}).items():
            row = {
                "basin": r["basin"],
                "river": r["river"],
                "station_code": r["station_code"],
                "station_name": r["station_name"],
                "hydro_metric": r["hydro_metric"],
                "class": class_name,
                "n_years": r["correlation"]["n"],
                "years_used": ";".join(str(y) for y in r["correlation"]["years_used"]),
            }
            if "note" in stats_d:
                row["note"] = stats_d["note"]
            else:
                row["pearson_r"] = round(stats_d["pearson_r"], 3)
                row["pearson_p"] = round(stats_d["pearson_p"], 4)
                row["pearson_q"] = round(stats_d["pearson_q"], 4)
                row["spearman_r"] = round(stats_d["spearman_r"], 3)
                row["spearman_p"] = round(stats_d["spearman_p"], 4)
                row["spearman_q"] = round(stats_d["spearman_q"], 4)
            csv_rows.append(row)
    csv_df = pd.DataFrame(csv_rows)
    csv_df.to_csv(OUT / "basin_hydrology_correlation.csv", index=False, encoding="utf-8")
    print(f"Wrote {OUT / 'basin_hydrology_correlation.csv'}")

    write_report(basin_results)
    print(f"Wrote {OUT / 'basin_hydrology_correlation_report.md'}")


def write_report(basin_results: list[dict]) -> None:
    lines = [
        "# Basin-by-basin land cover / hydrology correlation report",
        "",
        "Land cover: Esri 10m Annual LULC, 2017-2025. Hydrology: api.meteo.lt "
        "historical archive, most-downstream in-basin station per basin's main "
        "river -- the gauge closest to the basin's estimated outlet, since that "
        "integrates the whole basin's catchment (method + caveats: see the "
        "docstring of basin_hydrology_correlation.py). Annual hydrology values "
        "are an unweighted average of monthly means (each month needs >=20 valid "
        "days, each year needs >=11 valid months), which avoids overweighting "
        "whichever season happened to report more complete data. Correlations "
        "are Pearson (linear) and Spearman (monotonic/rank), computed per "
        "land-cover class against the station's annual discharge or water-level "
        "mean, paired by year. p-values are from a paired permutation test "
        "(exact for n<=8, Monte Carlo otherwise); q-values are Benjamini-Hochberg "
        "FDR-adjusted across the 5 land-cover classes tested per river unit. "
        "Sample sizes are small (Esri only spans 9 years, and station coverage "
        "trims that further) -- treat every result here as indicative, not "
        "statistically conclusive. Several gauges sit on rivers whose real "
        "catchment extends well beyond Lithuania's borders (see 'Caveat' notes "
        "below); for those, basin land cover explains only part of the flow by "
        "physical necessity.",
        "",
    ]
    for r in basin_results:
        lines.append(f"## {r['basin']} — {r['river']}")
        if "error" in r:
            lines.append(f"*Skipped: {r['error']}*")
            lines.append("")
            continue
        if r.get("geometry_note"):
            lines.append(f"*Note: {r['geometry_note']}.*")
        if r.get("catchment_caveat"):
            lines.append(f"*Caveat: {r['catchment_caveat']}*")
        lines.append(
            f"- Station: **{r['station_name']}** (`{r['station_code']}`), "
            f"{r['dist_from_outlet_km']} km from the basin's estimated outlet "
            f"along a {r['river_length_in_basin_km']} km mapped reach."
        )
        lines.append(f"- Hydrology metric used: **{r['hydro_metric']}** ({len(r['hydro_annual'])} usable years out of 9).")
        corr = r["correlation"]
        if corr["n"] < 3:
            lines.append(f"- {corr.get('note', 'Not enough overlapping years to correlate.')}")
            lines.append("")
            continue
        lines.append(f"- Years used: {', '.join(str(y) for y in corr['years_used'])} (n={corr['n']})")
        lines.append("")
        lines.append("| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |")
        lines.append("|---|---|---|---|---|---|---|")
        for class_name, s in corr["per_class"].items():
            if "note" in s:
                lines.append(f"| {class_name} | — | — | — | — | — | — ({s['note']}) |")
            else:
                lines.append(
                    f"| {class_name} | {s['pearson_r']:.3f} | {s['pearson_p']:.4f} | {s['pearson_q']:.4f} "
                    f"| {s['spearman_r']:.3f} | {s['spearman_p']:.4f} | {s['spearman_q']:.4f} |"
                )
        lines.append("")
    with open(OUT / "basin_hydrology_correlation_report.md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
