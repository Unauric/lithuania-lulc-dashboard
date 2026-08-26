# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Aggregate GRPK (Georeferencinio pagrindo kadastras) PLOTAI plot areas into the dashboard’s
five land-cover shares (Water, Wetland, Urban, Agriculture, Forest).

Reads PLOTAI_1, PLOTAI_2, PLOTAI_3 shapefiles (uses DBF + SHAPE_Area from attributes), maps
GKODAS using analysis/grpk_gkodas_mapping.json, and writes outputs/grpk_reference_shares.json.

This is a **single snapshot** reference (not time series). Validation vs products compares each
product year’s national share vector to this fixed vector.

Requires: pyshp  (pip install pyshp)

Run from repo root:
  python analysis/build_grpk_reference.py

Optional env:
  GRPK_SHP_DIR  — folder containing PLOTAI_*.shp (default: <repo>/GRPK_Open_SHP)
"""

from __future__ import annotations

import json
from pathlib import Path

try:
    BASE = Path(__file__).resolve().parent.parent
except NameError:
    BASE = Path.cwd()

OUT_JSON = BASE / "outputs" / "grpk_reference_shares.json"
MAPPING_PATH = BASE / "analysis" / "grpk_gkodas_mapping.json"
CLASS_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"]


def load_mapping() -> tuple[list[tuple[str, str]], str]:
    with open(MAPPING_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    rules = [(a[0].lower(), a[1]) for a in cfg["prefix_rules"]]
    rules.sort(key=lambda x: len(x[0]), reverse=True)
    default = cfg.get("default_class", "Agriculture")
    return rules, default


def gkodas_to_class(code: str, rules: list[tuple[str, str]], default: str) -> str:
    c = (code or "").strip().lower()
    if not c:
        return default
    for prefix, cls in rules:
        if c.startswith(prefix):
            return cls
    return default


def main() -> None:
    import shapefile as shp

    grpk_dir = Path(__import__("os").environ.get("GRPK_SHP_DIR", str(BASE / "GRPK_Open_SHP")))
    rules, default = load_mapping()

    totals = {k: 0.0 for k in CLASS_ORDER}
    unknown_by_code: dict[str, float] = {}
    plotai_names = ["PLOTAI_1", "PLOTAI_2", "PLOTAI_3"]

    for name in plotai_names:
        shp_path = grpk_dir / f"{name}.shp"
        if not shp_path.is_file():
            raise FileNotFoundError(f"Missing {shp_path}")
        r = shp.Reader(str(shp_path))
        fn = [f[0] for f in r.fields[1:]]
        if "GKODAS" not in fn or "SHAPE_Area" not in fn:
            raise ValueError(f"{name}: expected GKODAS and SHAPE_Area in DBF")
        ig, ia = fn.index("GKODAS"), fn.index("SHAPE_Area")

        for rec in r.iterRecords():
            area = float(rec[ia] or 0.0)
            if area <= 0:
                continue
            g = rec[ig]
            cls = gkodas_to_class(str(g), rules, default)
            if cls not in totals:
                cls = default
            totals[cls] += area

    tot_area = sum(totals.values())
    if tot_area <= 0:
        raise RuntimeError("Total area is zero — check GRPK path and fields.")

    shares = [totals[c] / tot_area for c in CLASS_ORDER]

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "reference": "grpk",
        "source": "GRPK PLOTAI (PLOTAI_1 + PLOTAI_2 + PLOTAI_3)",
        "grpk_dir": str(grpk_dir.resolve()),
        "mapping_file": str(MAPPING_PATH.resolve()),
        "class_order": CLASS_ORDER,
        "area_totals_m2": {k: float(totals[k]) for k in CLASS_ORDER},
        "shares": shares,
        "notes": (
            "Area-weighted shares from plot polygons. GKODAS mapped by prefix rules in "
            "analysis/grpk_gkodas_mapping.json — adjust for your interpretation of official classes."
        ),
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("Wrote", OUT_JSON)
    print("Shares:", dict(zip(CLASS_ORDER, [round(s * 100, 3) for s in shares])))


if __name__ == "__main__":
    main()
