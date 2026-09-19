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
import re
import resource
import sys
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import ezdxf


UNIT_NAMES = {
    0: "unitless",
    1: "inches",
    2: "feet",
    3: "miles",
    4: "millimeters",
    5: "centimeters",
    6: "meters",
    7: "kilometers",
    8: "microinches",
    9: "mils",
    10: "yards",
    11: "angstroms",
    12: "nanometers",
    13: "microns",
    14: "decimeters",
    15: "decameters",
    16: "hectometers",
    17: "gigameters",
    18: "astronomical units",
    19: "light years",
    20: "parsecs",
    21: "US survey feet",
    22: "US survey inches",
    23: "US survey yards",
    24: "US survey miles",
}


@dataclass
class CellStats:
    count: int = 0
    min_x: float = math.inf
    min_y: float = math.inf
    max_x: float = -math.inf
    max_y: float = -math.inf
    entity_types: Counter[str] = field(default_factory=Counter)
    layers: Counter[str] = field(default_factory=Counter)
    texts: list[str] = field(default_factory=list)

    def add(self, x: float, y: float, entity_type: str, layer: str) -> None:
        self.count += 1
        self.min_x = min(self.min_x, x)
        self.min_y = min(self.min_y, y)
        self.max_x = max(self.max_x, x)
        self.max_y = max(self.max_y, y)
        self.entity_types[entity_type] += 1
        self.layers[layer] += 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Profile a DXF and discover candidate drawing regions.")
    parser.add_argument("input", type=Path, help="DXF file to scan")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("reports/inventory"),
        help="Directory for JSON and Markdown reports",
    )
    parser.add_argument(
        "--cell-size-mm",
        type=float,
        default=50_000.0,
        help="Density grid cell size in drawing units (default: 50000 mm)",
    )
    parser.add_argument(
        "--min-cell-entities",
        type=int,
        default=20,
        help="Minimum anchor count for a core density cell",
    )
    parser.add_argument(
        "--halo-cells",
        type=int,
        default=1,
        help="Number of grid cells used to assign sparse neighbors to a region",
    )
    parser.add_argument(
        "--max-text-samples",
        type=int,
        default=50,
        help="Maximum number of global representative text samples",
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
    return normalized[:240] if normalized else None


def connected_components(cells: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    remaining = set(cells)
    components: list[set[tuple[int, int]]] = []
    neighbors = [
        (dx, dy)
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        if not (dx == 0 and dy == 0)
    ]
    while remaining:
        start = min(remaining)
        remaining.remove(start)
        component = {start}
        queue = deque([start])
        while queue:
            x, y = queue.popleft()
            for dx, dy in neighbors:
                candidate = (x + dx, y + dy)
                if candidate in remaining:
                    remaining.remove(candidate)
                    component.add(candidate)
                    queue.append(candidate)
        components.append(component)
    return components


def cell_distance(cell: tuple[int, int], component: set[tuple[int, int]]) -> int:
    x, y = cell
    return min(max(abs(x - core_x), abs(y - core_y)) for core_x, core_y in component)


def region_identifier(
    core_cells: set[tuple[int, int]], cell_size: float, min_cell_entities: int
) -> str:
    payload = json.dumps(
        {
            "cell_size": cell_size,
            "min_cell_entities": min_cell_entities,
            "core_cells": sorted(core_cells),
        },
        separators=(",", ":"),
    ).encode()
    return f"region-{hashlib.sha1(payload).hexdigest()[:12]}"


def discover_regions(
    cells: dict[tuple[int, int], CellStats],
    cell_size: float,
    min_cell_entities: int,
    halo_cells: int,
) -> tuple[list[dict[str, Any]], int]:
    core_cells = {cell for cell, stats in cells.items() if stats.count >= min_cell_entities}
    if not core_cells and cells:
        core_cells = {max(cells, key=lambda item: cells[item].count)}

    components = connected_components(core_cells)
    assigned: dict[int, set[tuple[int, int]]] = {index: set(component) for index, component in enumerate(components)}
    unassigned = 0

    for cell in sorted(set(cells) - core_cells):
        distances = [(cell_distance(cell, component), index) for index, component in enumerate(components)]
        distance, owner = min(distances, default=(halo_cells + 1, -1))
        if distance <= halo_cells:
            assigned[owner].add(cell)
        else:
            unassigned += cells[cell].count

    regions: list[dict[str, Any]] = []
    scale_pattern = re.compile(r"(?:^|\s)1\s*[:：]\s*\d+(?:\s|$)")
    for index, component in enumerate(components):
        member_cells = assigned[index]
        stats = [cells[cell] for cell in member_cells]
        entity_types: Counter[str] = Counter()
        layers: Counter[str] = Counter()
        texts: list[str] = []
        for item in stats:
            entity_types.update(item.entity_types)
            layers.update(item.layers)
            texts.extend(item.texts)

        unique_texts = list(dict.fromkeys(texts))
        scales = [text for text in unique_texts if scale_pattern.search(text)][:5]
        labels = [
            text
            for text in unique_texts
            if text not in scales and len(text) >= 2 and not text.replace(".", "").replace("-", "").isdigit()
        ][:10]
        regions.append(
            {
                "id": region_identifier(component, cell_size, min_cell_entities),
                "core_cell_count": len(component),
                "assigned_cell_count": len(member_cells),
                "assigned_cells": [list(cell) for cell in sorted(member_cells)],
                "entity_count": sum(item.count for item in stats),
                "anchor_bounds": {
                    "min": [min(item.min_x for item in stats), min(item.min_y for item in stats)],
                    "max": [max(item.max_x for item in stats), max(item.max_y for item in stats)],
                },
                "core_cells": [list(cell) for cell in sorted(component)],
                "top_entity_types": entity_types.most_common(12),
                "top_layers": layers.most_common(12),
                "probable_scales": scales,
                "representative_text": labels,
            }
        )

    regions.sort(key=lambda region: (-region["entity_count"], region["id"]))
    return regions, unassigned


def json_vector(value: Any) -> list[float] | None:
    point = finite_xyz(value)
    return list(point) if point is not None else None


def markdown_report(report: dict[str, Any]) -> str:
    file_info = report["file"]
    drawing = report["drawing"]
    scan = report["scan"]
    regions = report["regions"]

    lines = [
        "# DXF inventory",
        "",
        f"Generated: {report['generated_at']}",
        "",
        "## File",
        "",
        "| Property | Value |",
        "| --- | --- |",
        f"| Path | `{file_info['path']}` |",
        f"| Size | {file_info['size_bytes']:,} bytes |",
        f"| SHA-256 | `{file_info['sha256']}` |",
        f"| DXF version | {drawing['dxf_version']} |",
        f"| Units | {drawing['units']['name']} (`{drawing['units']['code']}`) |",
        f"| Model-space entities | {scan['modelspace_entity_count']:,} |",
        f"| Anchored entities | {scan['anchored_entity_count']:,} |",
        f"| Scan duration | {scan['duration_seconds']:.3f} seconds |",
        f"| Peak RSS | {scan['peak_rss_bytes'] / 1024 / 1024:.1f} MiB |",
        f"| DXF audit | {scan['audit']['errors']} error(s), {scan['audit']['fixes']} fix(es) |",
        f"| Layers | {drawing['layer_count']:,} |",
        f"| Block definitions | {drawing['block_definition_count']:,} |",
        "",
        "## Entity distribution",
        "",
        "| Entity | Count |",
        "| --- | ---: |",
    ]
    lines.extend(f"| {name} | {count:,} |" for name, count in scan["entity_counts"])
    lines.extend(["", "## Top layers", "", "| Layer | Count |", "| --- | ---: |"]) 
    lines.extend(f"| {name} | {count:,} |" for name, count in scan["top_layers"])

    lines.extend(
        [
            "",
            "## Candidate drawing regions",
            "",
            f"Parameters: cell size `{report['region_detection']['cell_size']}`; minimum cell entities `{report['region_detection']['min_cell_entities']}`; halo `{report['region_detection']['halo_cells']}` cell(s).",
            "",
            "| Region | Entities | Core cells | Bounds | Probable scale | Representative text |",
            "| --- | ---: | ---: | --- | --- | --- |",
        ]
    )
    for region in regions:
        minimum = region["anchor_bounds"]["min"]
        maximum = region["anchor_bounds"]["max"]
        bounds = f"({minimum[0]:.1f}, {minimum[1]:.1f}) → ({maximum[0]:.1f}, {maximum[1]:.1f})"
        scale = ", ".join(region["probable_scales"]) or "—"
        labels = ", ".join(region["representative_text"][:3]) or "—"
        lines.append(
            f"| `{region['id']}` | {region['entity_count']:,} | {region['core_cell_count']} | {bounds} | {scale} | {labels} |"
        )

    lines.extend(["", "## Warnings", ""])
    if report["warnings"]:
        lines.extend(f"- {warning}" for warning in report["warnings"])
    else:
        lines.append("- None")

    lines.extend(["", "## Representative text", ""])
    for item in scan["text_samples"]:
        lines.append(f"- `{item['layer']}` / `{item['type']}`: {item['text']}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"DXF file does not exist: {input_path}", file=sys.stderr)
        return 2
    if args.cell_size_mm <= 0 or args.min_cell_entities <= 0 or args.halo_cells < 0:
        print("Region detection parameters must be positive (halo may be zero).", file=sys.stderr)
        return 2

    started = time.perf_counter()
    document = ezdxf.readfile(input_path)
    auditor = document.audit()
    modelspace = document.modelspace()

    entity_counts: Counter[str] = Counter()
    layer_counts: Counter[str] = Counter()
    block_references: Counter[str] = Counter()
    anchor_failures: Counter[str] = Counter()
    z_values: Counter[float] = Counter()
    cells: dict[tuple[int, int], CellStats] = {}
    text_samples: list[dict[str, str]] = []

    for entity in modelspace:
        entity_type = entity.dxftype()
        layer = str(entity.dxf.get("layer", "<none>"))
        entity_counts[entity_type] += 1
        layer_counts[layer] += 1
        if entity_type == "INSERT":
            block_references[str(entity.dxf.name)] += 1

        anchor = entity_anchor(entity)
        if anchor is None:
            anchor_failures[entity_type] += 1
            continue
        x, y, z = anchor
        z_values[round(z, 3)] += 1
        cell = (math.floor(x / args.cell_size_mm), math.floor(y / args.cell_size_mm))
        stats = cells.setdefault(cell, CellStats())
        stats.add(x, y, entity_type, layer)

        if entity_type in {"TEXT", "MTEXT"}:
            text = plain_text(entity)
            if text:
                if len(stats.texts) < 30:
                    stats.texts.append(text)
                if len(text_samples) < args.max_text_samples:
                    text_samples.append({"type": entity_type, "layer": layer, "text": text})

    regions, unassigned_entities = discover_regions(
        cells,
        args.cell_size_mm,
        args.min_cell_entities,
        args.halo_cells,
    )

    referenced_blocks: list[dict[str, Any]] = []
    for name, references in block_references.most_common(50):
        try:
            block = document.blocks.get(name)
        except ezdxf.DXFKeyError:
            continue
        types = Counter(entity.dxftype() for entity in block)
        layers = Counter(str(entity.dxf.get("layer", "<none>")) for entity in block)
        referenced_blocks.append(
            {
                "name": name,
                "reference_count": references,
                "definition_entity_count": sum(types.values()),
                "entity_types": types.most_common(10),
                "layers": layers.most_common(10),
            }
        )

    layouts = []
    for layout in document.layouts:
        counts = Counter(entity.dxftype() for entity in layout)
        layouts.append(
            {
                "name": layout.name,
                "entity_count": sum(counts.values()),
                "entity_types": counts.most_common(15),
            }
        )

    extmin = json_vector(document.header.get("$EXTMIN"))
    extmax = json_vector(document.header.get("$EXTMAX"))
    warnings: list[str] = []
    if extmin and extmax and (extmax[0] - extmin[0] > 1_000_000 or extmax[1] - extmin[1] > 1_000_000):
        warnings.append("Drawing extents exceed 1,000,000 units; multiple distant drawing regions are likely.")
    failed_count = sum(anchor_failures.values())
    if failed_count:
        warnings.append(f"{failed_count:,} entities have no lightweight spatial anchor and were excluded from region detection.")
    if unassigned_entities:
        warnings.append(f"{unassigned_entities:,} anchored entities are outside the configured halo of every dense region.")
    unusual_z = sum(count for z, count in z_values.items() if abs(z) > 0.01)
    if unusual_z:
        warnings.append(f"{unusual_z:,} anchored entities have |Z| > 0.01 drawing units.")
    large_blocks = [item for item in referenced_blocks if item["definition_entity_count"] > 10_000]
    if large_blocks:
        warnings.append(
            f"{len(large_blocks)} frequently referenced block definition(s) contain more than 10,000 entities; avoid blind recursive expansion."
        )
    if auditor.errors or auditor.fixes:
        warnings.append(
            f"DXF audit reported {len(auditor.errors)} error(s) and {len(auditor.fixes)} automatic fix(es)."
        )

    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_rss_bytes = int(peak_rss if platform.system() == "Darwin" else peak_rss * 1024)

    unit_code = int(document.header.get("$INSUNITS", 0))
    report = {
        "schema_version": "stage0-inventory-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": {"name": "dxf_inventory", "ezdxf_version": ezdxf.__version__},
        "file": {
            "path": str(input_path),
            "name": input_path.name,
            "size_bytes": input_path.stat().st_size,
            "sha256": sha256_file(input_path),
        },
        "drawing": {
            "dxf_version": document.dxfversion,
            "units": {"code": unit_code, "name": UNIT_NAMES.get(unit_code, "unknown")},
            "header_extents": {"min": extmin, "max": extmax},
            "layer_count": len(document.layers),
            "block_definition_count": len(document.blocks),
            "layouts": layouts,
        },
        "scan": {
            "duration_seconds": round(time.perf_counter() - started, 3),
            "peak_rss_bytes": peak_rss_bytes,
            "audit": {
                "errors": len(auditor.errors),
                "fixes": len(auditor.fixes),
                "error_samples": [issue.message for issue in list(auditor.errors)[:20]],
                "fix_samples": [issue.message for issue in list(auditor.fixes)[:20]],
            },
            "modelspace_entity_count": sum(entity_counts.values()),
            "anchored_entity_count": sum(stats.count for stats in cells.values()),
            "entity_counts": entity_counts.most_common(),
            "top_layers": layer_counts.most_common(100),
            "top_block_references": referenced_blocks,
            "anchor_failures": anchor_failures.most_common(),
            "z_values": z_values.most_common(100),
            "text_samples": text_samples,
        },
        "region_detection": {
            "algorithm": "dense-grid-connected-components-v1",
            "cell_size": args.cell_size_mm,
            "min_cell_entities": args.min_cell_entities,
            "halo_cells": args.halo_cells,
            "occupied_cell_count": len(cells),
            "candidate_region_count": len(regions),
            "unassigned_entity_count": unassigned_entities,
        },
        "regions": regions,
        "warnings": warnings,
    }

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = input_path.stem
    json_path = output_dir / f"{stem}.inventory.json"
    markdown_path = output_dir / f"{stem}.inventory.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(report), encoding="utf-8")

    print(
        json.dumps(
            {
                "input": str(input_path),
                "json_report": str(json_path),
                "markdown_report": str(markdown_path),
                "entities": report["scan"]["modelspace_entity_count"],
                "candidate_regions": len(regions),
                "duration_seconds": report["scan"]["duration_seconds"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
