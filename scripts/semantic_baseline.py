# /// script
# requires-python = ">=3.12"
# ///

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SEMANTIC_TYPES = (
    "wall",
    "door",
    "window",
    "column",
    "stair",
    "furniture",
    "annotation",
    "unknown",
)


RULES: tuple[tuple[str, tuple[str, ...], float], ...] = (
    ("door", ("door", "门"), 0.98),
    ("window", ("window", "窗"), 0.98),
    ("wall", ("wall", "墙"), 0.98),
    ("column", ("column", "柱"), 0.98),
    ("stair", ("stair", "楼梯", "电梯"), 0.98),
    ("furniture", ("furniture", "家具", "fur", "护士站柜台"), 0.96),
)

ANNOTATION_LAYER_TOKENS = (
    "pub_text",
    "pub_dim",
    "p-pubtext",
    "p-pubdim",
    "axis",
    "dim",
    "dote",
    "索引",
    "标注",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a deterministic Semantic CAD baseline.")
    parser.add_argument("input", type=Path, help="CAD IR JSON exported by Stage 1")
    parser.add_argument(
        "--windows",
        type=Path,
        default=None,
        help="Analysis Window manifest; defaults to the newest matching manifest",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("reports/semantic"),
        help="Directory for Semantic CAD baseline outputs",
    )
    return parser.parse_args()


def find_windows(input_path: Path, explicit: Path | None) -> Path | None:
    if explicit:
        return explicit.expanduser().resolve()
    candidates = sorted(
        Path("reports/windows").glob(f"{input_path.name.replace('.cad-ir.json', '')}.analysis-windows.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0].resolve() if candidates else None


def normalized(value: str) -> str:
    return value.casefold().replace("_", "-").replace(" ", "")


def token_match(value: str, tokens: tuple[str, ...]) -> str | None:
    candidate = normalized(value)
    for token in tokens:
        if normalized(token) in candidate:
            return token
    return None


def numeric(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else None


def geometry_features(entity: dict[str, Any]) -> dict[str, Any]:
    geometry = entity.get("geometry", {}).get("local") or {}
    bbox = entity.get("bbox", {}).get("local")
    features: dict[str, Any] = {"kind": geometry.get("kind"), "bbox": bbox}
    if isinstance(bbox, list) and len(bbox) == 4:
        width = abs(float(bbox[2]) - float(bbox[0]))
        height = abs(float(bbox[3]) - float(bbox[1]))
        features.update({"width": width, "height": height, "area": width * height})
    if geometry.get("kind") == "line":
        start = geometry.get("start")
        end = geometry.get("end")
        if isinstance(start, list) and isinstance(end, list):
            dx = float(end[0]) - float(start[0])
            dy = float(end[1]) - float(start[1])
            features.update(
                {
                    "length": math.hypot(dx, dy),
                    "angle_degrees": math.degrees(math.atan2(dy, dx)) % 180,
                }
            )
    if geometry.get("kind") == "polyline":
        vertices = geometry.get("vertices", [])
        length = 0.0
        for first, second in zip(vertices, vertices[1:]):
            length += math.hypot(float(second[0]) - float(first[0]), float(second[1]) - float(first[1]))
        if geometry.get("closed") and len(vertices) > 1:
            length += math.hypot(float(vertices[0][0]) - float(vertices[-1][0]), float(vertices[0][1]) - float(vertices[-1][1]))
        features["length"] = length
    return features


def classify(entity: dict[str, Any]) -> tuple[str, float, list[str], list[str]]:
    source = entity.get("source", {})
    layer = str(source.get("layer", ""))
    entity_type = str(source.get("entity_type", ""))
    block = str(source.get("block", {}).get("name", ""))
    layer_norm = normalized(layer)
    block_norm = normalized(block)
    evidence: list[str] = []

    if entity_type in {"TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION"} or any(
        token in layer_norm for token in ANNOTATION_LAYER_TOKENS
    ):
        if entity_type in {"TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION"}:
            evidence.append(f"entity-type:{entity_type}")
        if any(token in layer_norm for token in ANNOTATION_LAYER_TOKENS):
            evidence.append(f"annotation-layer:{layer}")
        return "annotation", 0.97, evidence, []

    for semantic_type, tokens, confidence in RULES:
        layer_token = token_match(layer, tokens)
        if layer_token:
            return semantic_type, confidence, [f"layer:{layer}", f"layer-token:{layer_token}"], []

    for semantic_type, tokens, confidence in RULES:
        block_token = token_match(block, tokens)
        if block_token:
            return semantic_type, confidence - 0.04, [f"block:{block}", f"block-token:{block_token}"], []

    if entity_type in {"HATCH", "SOLID"}:
        return "unknown", 0.2, [f"entity-type:{entity_type}"], ["annotation", "furniture", "wall"]
    return "unknown", 0.1, [], list(SEMANTIC_TYPES[:-1])


def candidate_id(semantic_type: str, source_id: str) -> str:
    digest = hashlib.sha1(f"semantic-baseline-v1:{semantic_type}:{source_id}".encode()).hexdigest()[:12]
    return f"candidate-{semantic_type}-{digest}"


def markdown_report(result: dict[str, Any]) -> str:
    summary = result["summary"]
    lines = [
        "# Semantic baseline",
        "",
        f"Generated: {result['generated_at']}",
        "",
        f"- CAD IR: `{result['input']['cad_ir_path']}`",
        f"- Region: `{result['input']['region_id']}`",
        f"- Analysis windows: `{result['input']['windows_path'] or 'not supplied'}`",
        "",
        "## Summary",
        "",
        f"- Source entities: {summary['source_entity_count']:,}",
        f"- Candidates: {summary['candidate_count']:,}",
        f"- Resolved by rules: {summary['resolved_count']:,}",
        f"- Ambiguous / unknown: {summary['ambiguous_count']:,}",
        "",
        "| Semantic type | Candidates | Mean confidence |",
        "| --- | ---: | ---: |",
    ]
    for semantic_type in SEMANTIC_TYPES:
        count = summary["type_counts"].get(semantic_type, 0)
        confidence = summary["mean_confidence"].get(semantic_type)
        lines.append(f"| `{semantic_type}` | {count:,} | {confidence:.3f} |" if confidence is not None else f"| `{semantic_type}` | {count:,} | — |")
    lines.extend(["", "## Evidence coverage", "", "| Evidence | Candidates |", "| --- | ---: |"])
    lines.extend(f"| `{name}` | {count:,} |" for name, count in summary["evidence_counts"])
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {warning}" for warning in result["warnings"] or ["None"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"CAD IR file does not exist: {input_path}", file=sys.stderr)
        return 2

    cad_ir = json.loads(input_path.read_text(encoding="utf-8"))
    if cad_ir.get("schema_version") != "cad-ir-v1":
        print("Input must have schema_version cad-ir-v1.", file=sys.stderr)
        return 2
    windows_path = find_windows(input_path, args.windows)
    windows = json.loads(windows_path.read_text(encoding="utf-8")) if windows_path else None
    owner_by_entity = windows.get("owner_by_entity", {}) if windows else {}
    membership_by_entity = windows.get("memberships", {}) if windows else {}

    candidates: list[dict[str, Any]] = []
    type_counts: Counter[str] = Counter()
    confidence_totals: Counter[str] = Counter()
    evidence_counts: Counter[str] = Counter()
    warnings: list[str] = []
    for entity in cad_ir.get("entities", []):
        source_id = str(entity.get("id", ""))
        semantic_type, confidence, evidence_codes, alternatives = classify(entity)
        source = entity.get("source", {})
        evidence = {
            "layer": source.get("layer"),
            "entity_type": source.get("entity_type"),
            "block_name": source.get("block", {}).get("name"),
            "geometry": geometry_features(entity),
            "codes": evidence_codes,
        }
        owner_window = owner_by_entity.get(source_id)
        context_windows = [
            membership["window_id"]
            for membership in membership_by_entity.get(source_id, [])
            if membership["role"] == "context"
        ]
        candidate = {
            "id": candidate_id(semantic_type, source_id),
            "candidate_kind": "primitive-v1",
            "semantic_type": semantic_type,
            "source_entities": [source_id],
            "window": {
                "owner_window_id": owner_window,
                "context_window_ids": sorted(context_windows),
            },
            "evidence": evidence,
            "decision": {
                "method": "deterministic-rule-v1",
                "status": "resolved" if semantic_type != "unknown" else "ambiguous",
                "confidence": confidence,
                "alternatives": alternatives,
            },
        }
        candidates.append(candidate)
        type_counts[semantic_type] += 1
        confidence_totals[semantic_type] += confidence
        for code in evidence_codes:
            evidence_counts[code.split(":", 1)[0]] += 1

    if not windows_path:
        warnings.append("No Analysis Window manifest supplied; window ownership is null.")
    if not candidates:
        warnings.append("CAD IR contains no entities.")

    mean_confidence = {
        semantic_type: confidence_totals[semantic_type] / type_counts[semantic_type]
        for semantic_type in type_counts
    }
    resolved_count = sum(count for semantic_type, count in type_counts.items() if semantic_type != "unknown")
    result = {
        "schema_version": "semantic-baseline-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input": {
            "cad_ir_path": str(input_path),
            "cad_ir_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
            "region_id": cad_ir.get("selection", {}).get("region_id"),
            "windows_path": str(windows_path) if windows_path else None,
            "windows_sha256": hashlib.sha256(windows_path.read_bytes()).hexdigest() if windows_path else None,
        },
        "rules": {
            "version": "deterministic-rule-v1",
            "semantic_types": list(SEMANTIC_TYPES),
            "layer_tokens": {semantic_type: list(tokens) for semantic_type, tokens, _ in RULES},
            "annotation_layer_tokens": list(ANNOTATION_LAYER_TOKENS),
        },
        "summary": {
            "source_entity_count": len(cad_ir.get("entities", [])),
            "candidate_count": len(candidates),
            "resolved_count": resolved_count,
            "ambiguous_count": len(candidates) - resolved_count,
            "type_counts": dict(type_counts),
            "mean_confidence": mean_confidence,
            "evidence_counts": evidence_counts.most_common(),
        },
        "candidates": candidates,
        "warnings": warnings,
    }

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = input_path.name.removesuffix(".cad-ir.json")
    json_path = output_dir / f"{stem}.semantic-baseline.json"
    markdown_path = output_dir / f"{stem}.semantic-baseline.md"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(result), encoding="utf-8")
    print(json.dumps({"json": str(json_path), "markdown": str(markdown_path), **result["summary"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
