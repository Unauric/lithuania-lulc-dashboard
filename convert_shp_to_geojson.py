# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

"""Convert shapefile to GeoJSON (WGS84) for Leaflet.

Run from anywhere -- paths are resolved relative to this file, not the
current working directory (this used to be hardcoded to one developer's
own machine, which broke for everyone else)."""
import json
from pathlib import Path

import shapefile
from pyproj import Transformer

BASE = Path(__file__).resolve().parent
SHP_PATH = BASE / "Lithuania_Subbasins" / "UpiuPabaseiniai.shp"
OUT_PATH = BASE / "lt_subbasins.json"

# LKS 1994 Lithuania TM -> WGS84
transformer = Transformer.from_crs(
    "EPSG:2600",  # LKS 94
    "EPSG:4326",  # WGS84
    always_xy=True
)


def transform_ring(ring):
    """Transform a ring of [x, y] coords from LKS94 to WGS84."""
    return [
        list(transformer.transform(x, y))
        for x, y in ring
    ]


def shape_to_geojson_geom(shape):
    """Convert pyshp shape to GeoJSON geometry."""
    if shape.shapeType == shapefile.POLYGON:
        parts = list(shape.parts) + [len(shape.points)]
        rings = []
        for i in range(len(parts) - 1):
            ring = shape.points[parts[i]:parts[i + 1]]
            transformed = transform_ring(ring)
            rings.append(transformed)
        if len(rings) == 1:
            return {"type": "Polygon", "coordinates": rings}
        return {"type": "Polygon", "coordinates": rings}
    elif shape.shapeType == shapefile.MULTIPOLYGON:
        # MultiPatch or similar - treat as multi
        parts = list(shape.parts) + [len(shape.points)]
        polygons = []
        for i in range(len(parts) - 1):
            ring = shape.points[parts[i]:parts[i + 1]]
            transformed = transform_ring(ring)
            polygons.append([transformed])
        return {"type": "MultiPolygon", "coordinates": polygons}
    else:
        raise ValueError(f"Unsupported shape type: {shape.shapeType}")


def main():
    sf = shapefile.Reader(SHP_PATH)
    fields = sf.fields[1:]  # Skip deletion flag
    field_names = [f[0] for f in fields]

    features = []
    for i, (shape, record) in enumerate(zip(sf.shapes(), sf.records())):
        try:
            geom = shape_to_geojson_geom(shape)
            props = dict(zip(field_names, record))
            features.append({
                "type": "Feature",
                "geometry": geom,
                "properties": props
            })
        except Exception as e:
            print(f"Warning: Skipping feature {i}: {e}")

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    print(f"Converted {len(features)} features to {OUT_PATH}")


if __name__ == "__main__":
    main()
