# /// script
# requires-python = ">=3.12"
# ///

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Partition CAD IR into overlapping analysis windows.")
    parser.add_argument("input", type=Path, help="CAD IR JSON exported by Stage 1")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("reports/windows"),
        help="Directory for window manifest JSON and Markdown",
    )
    parser.add_argument(
        "--core-size-mm",
        type=float,
        default=25_000.0,
        help="Core window width and height in drawing units (default: 25000)",
    )
    parser.add_argument(
        "--halo-mm",
        type=float,
        default=2_000.0,
        help="Context halo around every core window (default: 2000)",
    )
    return parser.parse_args()


def stable_id(region_id: str, row: int, column: int, core_size: float, halo: float) -> str:
    payload = json.dumps(
        {"region": region_id, "row": row, "column": column, "core_size": core_size, "halo": halo},
        separators=(",", ":"),
    ).encode()
    return f"window-{hashlib.sha1(payload).hexdigest()[:12]}"


def interval_intersects(a_min: float, a_max: float, b_min: float, b_max: float) -> bool:
    return a_max >= b_min and a_min <= b_max


def bbox_for_entity(entity: dict[str, Any]) -> tuple[float, float, float, float] | None:
    value = entity.get("bbox", {}).get("local")
    if not isinstance(value, list) or len(value) != 4:
        anchor = entity.get("anchor", {}).get("local")
        if isinstance(anchor, list) and len(anchor) >= 2:
            x, y = float(anchor[0]), float(anchor[1])
            return x, y, x, y
        return None
    try:
        x1, y1, x2, y2 = (float(item) for item in value)
    except (TypeError, ValueError):
        return None
    return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)


def anchor_for_entity(entity: dict[str, Any]) -> tuple[float, float] | None:
    value = entity.get("anchor", {}).get("local")
    if not isinstance(value, list) or len(value) < 2:
        return None
    try:
        return float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None


def owner_index(value: float, minimum: float, core_size: float, count: int) -> int:
    index = math.floor((value - minimum) / core_size)
    return max(0, min(count - 1, index))


def markdown_report(manifest: dict[str, Any]) -> str:
    summary = manifest["summary"]
    parameters = manifest["parameters"]
    lines = [
        "# Analysis windows",
        "",
        f"Generated: {manifest['generated_at']}",
        "",
        "## Input",
        "",
        f"- CAD IR: `{manifest['input']['path']}`",
        f"- Region: `{manifest['input']['region_id']}`",
        f"- CAD IR SHA-256: `{manifest['input']['sha256']}`",
        "",
        "## Parameters",
        "",
        f"- Core size: `{parameters['core_size_units']}` drawing units",
        f"- Halo: `{parameters['halo_units']}` drawing units",
        f"- Grid: `{parameters['rows']}` rows × `{parameters['columns']}` columns",
        "",
        "## Summary",
        "",
        f"- Windows: {summary['window_count']}",
        f"- Source entities: {summary['source_entity_count']:,}",
        f"- Owned references: {summary['owned_reference_count']:,}",
        f"- Context references: {summary['context_reference_count']:,}",
        f"- Cross-window entities: {summary['cross_window_entity_count']:,}",
        "",
        "| Window | Core | Halo | Owned | Context |",
        "| --- | --- | --- | ---: | ---: |",
    ]
    for window in manifest["windows"]:
        lines.append(
            f"| `{window['id']}` | `{window['core']['min']} → {window['core']['max']}` | "
            f"`{window['halo']['min']} → {window['halo']['max']}` | "
            f"{window['owned_entity_count']:,} | {window['context_entity_count']:,} |"
        )
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {warning}" for warning in manifest["warnings"] or ["None"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"CAD IR file does not exist: {input_path}", file=sys.stderr)
        return 2
    if args.core_size_mm <= 0 or args.halo_mm < 0:
        print("--core-size-mm must be positive and --halo-mm must be non-negative.", file=sys.stderr)
        return 2

    cad_ir = json.loads(input_path.read_text(encoding="utf-8"))
    if cad_ir.get("schema_version") != "cad-ir-v1":
        print("Input must have schema_version cad-ir-v1.", file=sys.stderr)
        return 2
    entities = cad_ir.get("entities", [])
    if not isinstance(entities, list):
        print("CAD IR entities must be an array.", file=sys.stderr)
        return 2

    selection = cad_ir.get("selection", {})
    region_id = str(selection.get("region_id", "unknown"))
    bounds = selection.get("bounds", {})
    raw_min = bounds.get("min", [0.0, 0.0])
    raw_max = bounds.get("max", [0.0, 0.0])
    minimum = (float(raw_min[0]), float(raw_min[1]))
    maximum = (float(raw_max[0]), float(raw_max[1]))
    width = max(0.0, maximum[0] - minimum[0])
    height = max(0.0, maximum[1] - minimum[1])
    columns = max(1, math.ceil(width / args.core_size_mm))
    rows = max(1, math.ceil(height / args.core_size_mm))

    windows: list[dict[str, Any]] = []
    by_cell: dict[tuple[int, int], dict[str, Any]] = {}
    for row in range(rows):
        for column in range(columns):
            core_min = [column * args.core_size_mm, row * args.core_size_mm]
            core_max = [
                min(width, (column + 1) * args.core_size_mm),
                min(height, (row + 1) * args.core_size_mm),
            ]
            window = {
                "id": stable_id(region_id, row, column, args.core_size_mm, args.halo_mm),
                "row": row,
                "column": column,
                "core": {"min": core_min, "max": core_max},
                "halo": {
                    "min": [max(0.0, core_min[0] - args.halo_mm), max(0.0, core_min[1] - args.halo_mm)],
                    "max": [
                        min(width, core_max[0] + args.halo_mm),
                        min(height, core_max[1] + args.halo_mm),
                    ],
                },
                "owned_entity_ids": [],
                "context_entity_ids": [],
            }
            windows.append(window)
            by_cell[(row, column)] = window

    owner_by_entity: dict[str, str] = {}
    memberships: dict[str, list[dict[str, str]]] = {}
    skipped_without_bbox = 0
    for entity in entities:
        entity_id = str(entity.get("id", ""))
        if not entity_id:
            continue
        item_bbox = bbox_for_entity(entity)
        anchor = anchor_for_entity(entity)
        if item_bbox is None:
            skipped_without_bbox += 1
            continue
        if anchor is None:
            anchor = ((item_bbox[0] + item_bbox[2]) / 2, (item_bbox[1] + item_bbox[3]) / 2)
        owner_column = owner_index(anchor[0], 0.0, args.core_size_mm, columns)
        owner_row = owner_index(anchor[1], 0.0, args.core_size_mm, rows)
        owner = by_cell[(owner_row, owner_column)]
        owner_by_entity[entity_id] = owner["id"]
        memberships[entity_id] = []
        for window in windows:
            halo_min = window["halo"]["min"]
            halo_max = window["halo"]["max"]
            if (
                interval_intersects(item_bbox[0], item_bbox[2], halo_min[0], halo_max[0])
                and interval_intersects(item_bbox[1], item_bbox[3], halo_min[1], halo_max[1])
            ):
                role = "owner" if window["id"] == owner["id"] else "context"
                memberships[entity_id].append({"window_id": window["id"], "role": role})
                if role == "owner":
                    window["owned_entity_ids"].append(entity_id)
                else:
                    window["context_entity_ids"].append(entity_id)

    cross_window = sum(1 for refs in memberships.values() if len(refs) > 1)
    for window in windows:
        window["owned_entity_ids"].sort()
        window["context_entity_ids"].sort()
        window["owned_entity_count"] = len(window["owned_entity_ids"])
        window["context_entity_count"] = len(window["context_entity_ids"])

    warnings: list[str] = []
    if skipped_without_bbox:
        warnings.append(f"{skipped_without_bbox:,} entities had no usable local bbox and were omitted from windows.")
    if not entities:
        warnings.append("CAD IR contains no entities.")

    manifest = {
        "schema_version": "analysis-windows-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input": {
            "path": str(input_path),
            "sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
            "region_id": region_id,
            "cad_ir_schema": cad_ir["schema_version"],
        },
        "parameters": {
            "core_size_units": args.core_size_mm,
            "halo_units": args.halo_mm,
            "region_source_bounds": {
                "min": [minimum[0], minimum[1]],
                "max": [maximum[0], maximum[1]],
            },
            "region_local_bounds": {"min": [0.0, 0.0], "max": [width, height]},
            "rows": rows,
            "columns": columns,
            "ownership": "anchor-cell-clamped-to-core",
            "membership": "bbox-intersects-halo",
        },
        "summary": {
            "window_count": len(windows),
            "source_entity_count": len(entities),
            "owned_reference_count": sum(len(window["owned_entity_ids"]) for window in windows),
            "context_reference_count": sum(len(window["context_entity_ids"]) for window in windows),
            "cross_window_entity_count": cross_window,
            "owned_entity_owner_count": len(owner_by_entity),
        },
        "owner_by_entity": owner_by_entity,
        "memberships": memberships,
        "windows": windows,
        "warnings": warnings,
    }

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = input_path.name.removesuffix(".cad-ir.json")
    json_path = output_dir / f"{stem}.analysis-windows.json"
    markdown_path = output_dir / f"{stem}.analysis-windows.md"
    json_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(manifest), encoding="utf-8")
    print(
        json.dumps(
            {
                "region": region_id,
                "json": str(json_path),
                "markdown": str(markdown_path),
                "windows": len(windows),
                "source_entities": len(entities),
                "cross_window_entities": cross_window,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
