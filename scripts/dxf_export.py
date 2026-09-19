# /// script
# requires-python = ">=3.12"
# dependencies = ["ezdxf==1.4.4"]
# ///

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import resource
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import ezdxf
from ezdxf import bbox


UNIT_NAMES = {
    0: "unitless",
    1: "inches",
    2: "feet",
    3: "miles",
    4: "millimeters",
    5: "centimeters",
    6: "meters",
    7: "kilometers",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export one Stage 0 Drawing Region as CAD IR.")
    parser.add_argument("input", type=Path, help="DXF file to export")
    parser.add_argument("--region", required=True, help="Drawing Region ID from the inventory report")
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Stage 0 inventory JSON; defaults to the newest report for the input file",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("reports/cad-ir"),
        help="Directory for CAD IR JSON and Markdown outputs",
    )
    parser.add_argument(
        "--expand-mm",
        type=float,
        default=0.0,
        help="Expand the selected region bounds by this many drawing units",
    )
    parser.add_argument(
        "--include-unanchored",
        action="store_true",
        help="Include unanchored entities whose computed bounding box intersects the selected region",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def finite_xyz(value: Any) -> tuple[float, float, float] | None:
    try:
        x = float(value[0])
        y = float(value[1])
        z = float(value[2]) if len(value) > 2 else 0.0
    except (TypeError, ValueError, IndexError, AttributeError):
        try:
            x = float(value.x)
            y = float(value.y)
            z = float(getattr(value, "z", 0.0))
        except (TypeError, ValueError, AttributeError):
            return None
    if not all(math.isfinite(item) for item in (x, y, z)):
        return None
    return x, y, z


def mean_points(points: Iterable[Any]) -> tuple[float, float, float] | None:
    values = [point for raw in points if (point := finite_xyz(raw)) is not None]
    if not values:
        return None
    return (
        sum(point[0] for point in values) / len(values),
        sum(point[1] for point in values) / len(values),
        sum(point[2] for point in values) / len(values),
    )


def entity_anchor(entity: Any) -> tuple[float, float, float] | None:
    entity_type = entity.dxftype()
    try:
        if entity_type == "LINE":
            return mean_points((entity.dxf.start, entity.dxf.end))
        if entity_type == "LWPOLYLINE":
            return mean_points(entity.get_points("xyz"))
        if entity_type == "POLYLINE":
            return mean_points(vertex.dxf.location for vertex in entity.vertices)
        if entity_type == "SPLINE":
            return mean_points(entity.control_points)
        if entity_type == "SOLID":
            return mean_points(
                entity.dxf.get(name)
                for name in ("vtx0", "vtx1", "vtx2", "vtx3")
                if entity.dxf.hasattr(name)
            )
        attributes = {
            "TEXT": "insert",
            "MTEXT": "insert",
            "ATTRIB": "insert",
            "ATTDEF": "insert",
            "INSERT": "insert",
            "CIRCLE": "center",
            "ARC": "center",
            "ELLIPSE": "center",
            "POINT": "location",
            "DIMENSION": "defpoint",
        }
        attribute = attributes.get(entity_type)
        if attribute and entity.dxf.hasattr(attribute):
            return finite_xyz(entity.dxf.get(attribute))
    except (AttributeError, TypeError, ValueError, ZeroDivisionError):
        return None
    return None


def plain_text(entity: Any) -> str | None:
    try:
        value = entity.plain_text() if entity.dxftype() == "MTEXT" else entity.dxf.text
    except (AttributeError, TypeError, ValueError):
        return None
    normalized = " ".join(str(value).split())
    return normalized[:1000] if normalized else None


def json_value(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    point = finite_xyz(value)
    if point is not None:
        return list(point)
    if isinstance(value, dict):
        return {str(key): json_value(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item, depth + 1) for item in value]
    return str(value)


def scalar_attributes(entity: Any) -> dict[str, Any]:
    attributes: dict[str, Any] = {}
    try:
        raw = entity.dxfattribs()
    except (AttributeError, TypeError, ValueError):
        return attributes
    for name, value in raw.items():
        converted = json_value(value)
        encoded = json.dumps(converted, ensure_ascii=False)
        if len(encoded) <= 4000:
            attributes[name] = converted
    return attributes


def geometry(entity: Any) -> dict[str, Any] | None:
    entity_type = entity.dxftype()
    try:
        if entity_type == "LINE":
            return {"kind": "line", "start": json_value(entity.dxf.start), "end": json_value(entity.dxf.end)}
        if entity_type == "LWPOLYLINE":
            return {
                "kind": "polyline",
                "vertices": [list(point[:3]) for point in entity.get_points("xyz")],
                "closed": bool(entity.closed),
            }
        if entity_type == "POLYLINE":
            return {
                "kind": "polyline",
                "vertices": [json_value(vertex.dxf.location) for vertex in entity.vertices],
                "closed": bool(entity.is_closed),
            }
        if entity_type in {"CIRCLE", "ARC"}:
            return {
                "kind": entity_type.lower(),
                "center": json_value(entity.dxf.center),
                "radius": float(entity.dxf.radius),
                **(
                    {
                        "start_angle": float(entity.dxf.start_angle),
                        "end_angle": float(entity.dxf.end_angle),
                    }
                    if entity_type == "ARC"
                    else {}
                ),
            }
        if entity_type == "ELLIPSE":
            return {
                "kind": "ellipse",
                "center": json_value(entity.dxf.center),
                "major_axis": json_value(entity.dxf.major_axis),
                "ratio": float(entity.dxf.ratio),
                "start_param": float(entity.dxf.start_param),
                "end_param": float(entity.dxf.end_param),
            }
        if entity_type == "SPLINE":
            return {
                "kind": "spline",
                "control_points": [json_value(point) for point in entity.control_points],
                "fit_points": [json_value(point) for point in entity.fit_points],
            }
        if entity_type == "SOLID":
            return {
                "kind": "solid",
                "vertices": [
                    json_value(entity.dxf.get(name))
                    for name in ("vtx0", "vtx1", "vtx2", "vtx3")
                    if entity.dxf.hasattr(name)
                ],
            }
        if entity_type == "POINT":
            return {"kind": "point", "location": json_value(entity.dxf.location)}
        if entity_type in {"TEXT", "MTEXT", "ATTRIB", "ATTDEF"}:
            result = {"kind": "text", "insert": json_value(entity.dxf.insert), "text": plain_text(entity)}
            for name in ("height", "rotation", "style", "width", "attachment_point"):
                if entity.dxf.hasattr(name):
                    result[name] = json_value(entity.dxf.get(name))
            return result
        if entity_type == "INSERT":
            return {
                "kind": "block_reference",
                "insert": json_value(entity.dxf.insert),
                "rotation": float(entity.dxf.rotation),
                "scale": [float(entity.dxf.xscale), float(entity.dxf.yscale), float(entity.dxf.zscale)],
                "block_name": str(entity.dxf.name),
            }
        if entity_type == "DIMENSION":
            result = {"kind": "dimension"}
            for name in ("defpoint", "text_midpoint", "insert", "text", "dimtype"):
                if entity.dxf.hasattr(name):
                    result[name] = json_value(entity.dxf.get(name))
            return result
    except (AttributeError, TypeError, ValueError, ZeroDivisionError):
        return None
    return None


def geometry_points(value: Any, key: str | None = None) -> Iterable[tuple[float, float, float]]:
    if isinstance(value, dict):
        for name, item in value.items():
            yield from geometry_points(item, name)
    elif key in VECTOR_KEYS:
        point = finite_xyz(value)
        if point is not None:
            yield point
    elif key in POINT_LIST_KEYS and isinstance(value, list):
        for item in value:
            point = finite_xyz(item)
            if point is not None:
                yield point


VECTOR_KEYS = {
    "start",
    "end",
    "center",
    "insert",
    "location",
    "defpoint",
    "text_midpoint",
    "major_axis",
}
POINT_LIST_KEYS = {"vertices", "control_points", "fit_points"}


def translate_vector(value: Any, origin: tuple[float, float, float]) -> Any:
    point = finite_xyz(value)
    if point is None:
        return value
    return [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]]


def translate_geometry(value: Any, origin: tuple[float, float, float], key: str | None = None) -> Any:
    if key in VECTOR_KEYS:
        return translate_vector(value, origin)
    if key in POINT_LIST_KEYS and isinstance(value, list):
        return [translate_vector(item, origin) for item in value]
    if isinstance(value, dict):
        return {name: translate_geometry(item, origin, name) for name, item in value.items()}
    if isinstance(value, list):
        return [translate_geometry(item, origin) for item in value]
    return value


def entity_bbox(entity: Any, anchor: tuple[float, float, float] | None) -> tuple[float, float, float, float] | None:
    if anchor is not None:
        points = list(geometry_points(geometry(entity) or {}))
        if points:
            return (
                min(point[0] for point in points),
                min(point[1] for point in points),
                max(point[0] for point in points),
                max(point[1] for point in points),
            )
        return anchor[0], anchor[1], anchor[0], anchor[1]
    try:
        box = bbox.extents(entity)
        if box.has_data:
            return float(box.extmin.x), float(box.extmin.y), float(box.extmax.x), float(box.extmax.y)
    except (AttributeError, TypeError, ValueError, ezdxf.DXFError):
        pass
    return None


def intersects_region(bounds: dict[str, list[float]], item_bbox: tuple[float, float, float, float] | None, expand: float) -> bool:
    if item_bbox is None:
        return False
    minimum = bounds["min"]
    maximum = bounds["max"]
    return not (
        item_bbox[2] < minimum[0] - expand
        or item_bbox[0] > maximum[0] + expand
        or item_bbox[3] < minimum[1] - expand
        or item_bbox[1] > maximum[1] + expand
    )


def find_report(input_path: Path, explicit: Path | None) -> Path:
    if explicit:
        return explicit.expanduser().resolve()
    candidates = sorted(
        Path("reports/inventory").glob(f"{input_path.stem}.inventory.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError("找不到 Stage 0 inventory 报告，请先运行 bun run inventory，或传入 --report。")
    return candidates[0].resolve()


def markdown_report(ir: dict[str, Any]) -> str:
    source = ir["source"]
    selection = ir["selection"]
    counts = ir["summary"]["entity_counts"]
    lines = [
        "# CAD IR export",
        "",
        f"Generated: {ir['generated_at']}",
        "",
        "## Selection",
        "",
        "| Property | Value |",
        "| --- | --- |",
        f"| Region | `{selection['region_id']}` |",
        f"| Source | `{source['path']}` |",
        f"| Source SHA-256 | `{source['sha256']}` |",
        f"| Region origin | `{selection['local_origin']}` |",
        f"| Bounds | `{selection['bounds']}` |",
        f"| Expand | {selection['expand_units']} drawing units |",
        "",
        "## Summary",
        "",
        f"- Selected entities: {ir['summary']['selected_entity_count']:,}",
        f"- Entities with geometry payloads: {ir['summary']['geometry_entity_count']:,}",
        f"- Unanchored entities skipped: {ir['summary']['unanchored_skipped_count']:,}",
        f"- Block references retained: {ir['summary']['block_reference_count']:,}",
        "",
        "| Entity type | Count |",
        "| --- | ---: |",
    ]
    lines.extend(f"| {name} | {count:,} |" for name, count in counts)
    lines.extend(["", "## Layers", "", "| Layer | Count |", "| --- | ---: |"])
    lines.extend(f"| `{name}` | {count:,} |" for name, count in ir["summary"]["layer_counts"])
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {warning}" for warning in ir["warnings"] or ["None"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"DXF file does not exist: {input_path}", file=sys.stderr)
        return 2
    if args.expand_mm < 0:
        print("--expand-mm must be non-negative.", file=sys.stderr)
        return 2

    report_path = find_report(input_path, args.report)
    inventory = json.loads(report_path.read_text(encoding="utf-8"))
    regions = {region["id"]: region for region in inventory.get("regions", [])}
    region = regions.get(args.region)
    if region is None:
        print(f"Unknown region {args.region}. Available regions:", file=sys.stderr)
        for item in inventory.get("regions", []):
            print(f"  {item['id']} ({item['entity_count']:,} entities)", file=sys.stderr)
        return 2

    started = time.perf_counter()
    document = ezdxf.readfile(input_path)
    modelspace = document.modelspace()
    raw_bounds = region["anchor_bounds"]
    bounds = {
        "min": [float(raw_bounds["min"][0]), float(raw_bounds["min"][1])],
        "max": [float(raw_bounds["max"][0]), float(raw_bounds["max"][1])],
    }
    region_cells = {tuple(cell) for cell in region.get("assigned_cells", [])}
    cell_size = float(inventory.get("region_detection", {}).get("cell_size", 0.0))
    origin = (bounds["min"][0], bounds["min"][1], 0.0)
    observed_layers = {layer for layer, _count in region.get("top_layers", [])}
    entities: list[dict[str, Any]] = []
    entity_counts: Counter[str] = Counter()
    layer_counts: Counter[str] = Counter()
    block_counts: Counter[str] = Counter()
    geometry_count = 0
    unanchored_skipped = 0
    selection_warnings: list[str] = []

    for entity in modelspace:
        anchor = entity_anchor(entity)
        payload_geometry = geometry(entity)
        item_bbox = entity_bbox(entity, anchor)
        anchor_cell = (
            (math.floor(anchor[0] / cell_size), math.floor(anchor[1] / cell_size))
            if anchor is not None and cell_size > 0
            else None
        )
        selected = (
            anchor_cell in region_cells
            if region_cells and args.expand_mm == 0
            else intersects_region(bounds, item_bbox, args.expand_mm)
        )
        if not selected and args.include_unanchored and anchor is None:
            selected = intersects_region(bounds, item_bbox, args.expand_mm)
            if not selected:
                layer = str(entity.dxf.get("layer", "<none>"))
                selected = layer in observed_layers and args.expand_mm > 0
        if not selected:
            if anchor is None:
                unanchored_skipped += 1
            continue

        entity_type = entity.dxftype()
        layer = str(entity.dxf.get("layer", "<none>"))
        handle = str(entity.dxf.get("handle", ""))
        if not handle:
            selection_warnings.append(f"Entity {entity_type} has no DXF handle.")
            handle = f"synthetic:{len(entities):08d}"
        source = {
            "handle": handle,
            "entity_type": entity_type,
            "layer": layer,
            "layout": "Model",
            "path": [f"modelspace:{handle}"],
            "attributes": scalar_attributes(entity),
        }
        if entity_type == "INSERT":
            block_name = str(entity.dxf.name)
            source["block"] = {"name": block_name, "expanded": False}
            block_counts[block_name] += 1

        item: dict[str, Any] = {
            "id": f"source:{handle}",
            "source": source,
            "anchor": {
                "source": list(anchor) if anchor else None,
                "local": translate_vector(list(anchor), origin) if anchor else None,
            },
            "bbox": {
                "source": list(item_bbox) if item_bbox else None,
                "local": [
                    item_bbox[0] - origin[0],
                    item_bbox[1] - origin[1],
                    item_bbox[2] - origin[0],
                    item_bbox[3] - origin[1],
                ]
                if item_bbox
                else None,
            },
            "geometry": {
                "source": payload_geometry,
                "local": translate_geometry(payload_geometry, origin) if payload_geometry else None,
            },
        }
        text = plain_text(entity)
        if text:
            item["text"] = text
        entities.append(item)
        entity_counts[entity_type] += 1
        layer_counts[layer] += 1
        if payload_geometry is not None:
            geometry_count += 1

    entities.sort(key=lambda item: item["source"]["handle"])
    if unanchored_skipped:
        selection_warnings.append(
            f"{unanchored_skipped:,} unanchored entities were skipped; use --include-unanchored to include ones with intersecting bounds."
        )
    if args.expand_mm:
        selection_warnings.append("Selection bounds were expanded; review boundary entities before semantic grouping.")

    unit_code = int(document.header.get("$INSUNITS", 0))
    ir = {
        "schema_version": "cad-ir-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": {
            "name": "dxf_export",
            "ezdxf_version": ezdxf.__version__,
            "duration_seconds": round(time.perf_counter() - started, 3),
            "peak_rss_bytes": int(
                resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                if platform.system() == "Darwin"
                else resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
            ),
        },
        "source": {
            "path": str(input_path),
            "name": input_path.name,
            "sha256": sha256_file(input_path),
            "dxf_version": document.dxfversion,
            "units": {"code": unit_code, "name": UNIT_NAMES.get(unit_code, "unknown")},
            "inventory_report": str(report_path),
        },
        "selection": {
            "region_id": args.region,
            "bounds": bounds,
            "expand_units": args.expand_mm,
            "selection_mode": "assigned-cells" if region_cells and args.expand_mm == 0 else "bounds-intersection",
            "assigned_cell_count": len(region_cells),
            "local_origin": list(origin),
            "region_metadata": region,
        },
        "summary": {
            "selected_entity_count": len(entities),
            "geometry_entity_count": geometry_count,
            "unanchored_skipped_count": unanchored_skipped,
            "block_reference_count": sum(block_counts.values()),
            "entity_counts": entity_counts.most_common(),
            "layer_counts": layer_counts.most_common(),
            "block_reference_counts": block_counts.most_common(100),
        },
        "entities": entities,
        "warnings": selection_warnings,
    }

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    safe_region = args.region.replace("/", "_")
    json_path = output_dir / f"{input_path.stem}.{safe_region}.cad-ir.json"
    markdown_path = output_dir / f"{input_path.stem}.{safe_region}.cad-ir.md"
    json_path.write_text(json.dumps(ir, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(ir), encoding="utf-8")

    print(
        json.dumps(
            {
                "region": args.region,
                "json": str(json_path),
                "markdown": str(markdown_path),
                "selected_entities": len(entities),
                "duration_seconds": ir["generator"]["duration_seconds"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
