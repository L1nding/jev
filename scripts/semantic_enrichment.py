# /// script
# requires-python = ">=3.12"
# ///

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build deterministic semantic groups and CAD relationships.")
    parser.add_argument("input", type=Path, help="Semantic baseline JSON")
    parser.add_argument("--cad-ir", type=Path, default=None, help="CAD IR JSON; defaults to the baseline input reference")
    parser.add_argument("--output-dir", type=Path, default=Path("reports/semantic"))
    parser.add_argument("--max-wall-thickness-mm", type=float, default=600.0)
    parser.add_argument("--min-wall-thickness-mm", type=float, default=40.0)
    parser.add_argument("--min-overlap-ratio", type=float, default=0.5)
    parser.add_argument("--opening-distance-mm", type=float, default=600.0)
    return parser.parse_args()


def stable_id(kind: str, source_ids: list[str]) -> str:
    payload = f"semantic-enrichment-v1:{kind}:{'|'.join(sorted(source_ids))}"
    return f"group-{kind}-{hashlib.sha1(payload.encode()).hexdigest()[:12]}"


def point(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, list) or len(value) < 2:
        return None
    try:
        return float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def dot(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1]


def sub(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return a[0] - b[0], a[1] - b[1]


def add(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return a[0] + b[0], a[1] + b[1]


def scale(a: tuple[float, float], value: float) -> tuple[float, float]:
    return a[0] * value, a[1] * value


def cross(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[1] - a[1] * b[0]


def line_from_entity(entity: dict[str, Any]) -> tuple[tuple[float, float], tuple[float, float]] | None:
    geometry = entity.get("geometry", {}).get("local") or {}
    if geometry.get("kind") != "line":
        return None
    start = point(geometry.get("start"))
    end = point(geometry.get("end"))
    if start is None or end is None or distance(start, end) < 1e-6:
        return None
    return start, end


def candidate_source_id(candidate: dict[str, Any]) -> str | None:
    values = candidate.get("source_entities", [])
    return str(values[0]) if len(values) == 1 else None


def line_record(candidate: dict[str, Any], entity: dict[str, Any]) -> dict[str, Any] | None:
    segment = line_from_entity(entity)
    source_id = candidate_source_id(candidate)
    if segment is None or source_id is None:
        return None
    start, end = segment
    vector = sub(end, start)
    length = distance(start, end)
    unit = scale(vector, 1.0 / length)
    normal = (-unit[1], unit[0])
    return {
        "candidate": candidate,
        "source_id": source_id,
        "start": start,
        "end": end,
        "length": length,
        "unit": unit,
        "normal": normal,
        "bbox": (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1])),
    }


def orientation_difference(first: tuple[float, float], second: tuple[float, float]) -> float:
    value = abs(math.degrees(math.atan2(cross(first, second), dot(first, second))))
    return min(value, abs(180.0 - value))


def parallel_pair(first: dict[str, Any], second: dict[str, Any], min_thickness: float, max_thickness: float, min_overlap: float) -> dict[str, Any] | None:
    if orientation_difference(first["unit"], second["unit"]) > 2.5:
        return None
    unit = first["unit"] if dot(first["unit"], second["unit"]) >= 0 else scale(first["unit"], -1.0)
    normal = (-unit[1], unit[0])
    first_mid = scale(add(first["start"], first["end"]), 0.5)
    second_mid = scale(add(second["start"], second["end"]), 0.5)
    thickness = abs(dot(sub(second_mid, first_mid), normal))
    if thickness < min_thickness or thickness > max_thickness:
        return None

    first_s = [dot(value, unit) for value in (first["start"], first["end"])]
    second_s = [dot(value, unit) for value in (second["start"], second["end"])]
    overlap_min = max(min(first_s), min(second_s))
    overlap_max = min(max(first_s), max(second_s))
    overlap = max(0.0, overlap_max - overlap_min)
    overlap_ratio = overlap / min(first["length"], second["length"])
    if overlap_ratio < min_overlap:
        return None

    first_r = dot(first_mid, normal)
    second_r = dot(second_mid, normal)
    center_r = (first_r + second_r) / 2.0
    center_start = add(scale(unit, overlap_min), scale(normal, center_r))
    center_end = add(scale(unit, overlap_max), scale(normal, center_r))
    source_ids = sorted([first["source_id"], second["source_id"]])
    candidate_ids = sorted([first["candidate"]["id"], second["candidate"]["id"]])
    owner_windows = sorted({first["candidate"].get("window", {}).get("owner_window_id"), second["candidate"].get("window", {}).get("owner_window_id")} - {None})
    return {
        "id": stable_id("wall-pair", source_ids),
        "kind": "wall_pair",
        "candidate_ids": candidate_ids,
        "source_entities": source_ids,
        "window": {"owner_window_ids": owner_windows},
        "geometry": {"centerline": [list(center_start), list(center_end)], "thickness_mm": thickness, "overlap_mm": overlap, "overlap_ratio": overlap_ratio, "angle_degrees": math.degrees(math.atan2(unit[1], unit[0])) % 180},
        "evidence": ["parallel-lines", "overlap", "wall-thickness-range"],
        "decision": {"method": "deterministic-geometry-v1", "confidence": 0.94},
    }


def point_to_segment(value: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> tuple[float, float]:
    vector = sub(end, start)
    length_squared = dot(vector, vector)
    if length_squared == 0:
        return distance(value, start), 0.0
    parameter = max(0.0, min(1.0, dot(sub(value, start), vector) / length_squared))
    projection = add(start, scale(vector, parameter))
    return distance(value, projection), parameter


def opening_relation(opening: dict[str, Any], opening_entity: dict[str, Any], wall_segments: list[tuple[str, str, tuple[float, float], tuple[float, float]]], max_distance: float) -> dict[str, Any] | None:
    anchor = point(opening_entity.get("anchor", {}).get("local"))
    source_id = candidate_source_id(opening)
    if anchor is None or source_id is None:
        return None
    best: tuple[float, str, str, float] | None = None
    for wall_candidate_id, wall_source_id, start, end in wall_segments:
        current_distance, parameter = point_to_segment(anchor, start, end)
        if current_distance <= max_distance and (best is None or current_distance < best[0]):
            best = (current_distance, wall_candidate_id, wall_source_id, parameter)
    if best is None:
        return None
    current_distance, wall_candidate_id, wall_source_id, parameter = best
    return {
        "id": stable_id("opening-on-wall", [source_id, wall_source_id]),
        "kind": "opening_on_wall",
        "opening_type": opening["semantic_type"],
        "opening_candidate_id": opening["id"],
        "wall_candidate_id": wall_candidate_id,
        "source_entities": [source_id, wall_source_id],
        "geometry": {"opening_anchor": list(anchor), "distance_mm": current_distance, "wall_parameter": parameter},
        "evidence": ["nearest-wall-segment", "within-opening-distance"],
        "decision": {"method": "deterministic-topology-v1", "confidence": max(0.5, 0.92 - current_distance / max_distance * 0.2)},
    }


def markdown_report(result: dict[str, Any]) -> str:
    summary = result["summary"]
    lines = [
        "# Semantic enrichment", "", f"Generated: {result['generated_at']}", "",
        f"- Baseline: `{result['input']['baseline_path']}`",
        f"- CAD IR: `{result['input']['cad_ir_path']}`",
        f"- Region: `{result['input']['region_id']}`", "", "## Summary", "",
        f"- Primitive candidates: {summary['primitive_candidate_count']:,}",
        f"- Wall pair groups: {summary['wall_pair_count']:,}",
        f"- Opening-on-wall relations: {summary['opening_relation_count']:,}",
        f"- Door relations: {summary['opening_relation_type_counts'].get('door', 0):,}",
        f"- Window relations: {summary['opening_relation_type_counts'].get('window', 0):,}",
        f"- Wall source lines considered: {summary['wall_line_count']:,}", "",
        f"- Wall lines with more than 20 pair matches: {summary['high_degree_wall_line_count']:,}", "",
        "| Band (mm) | Wall pairs |", "| --- | ---: |",
    ]
    lines.extend(f"| `{band}` | {count:,} |" for band, count in summary["wall_pair_thickness_bands"])
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {warning}" for warning in result["warnings"] or ["None"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    baseline_path = args.input.expanduser().resolve()
    if not baseline_path.is_file():
        print(f"Semantic baseline does not exist: {baseline_path}", file=sys.stderr)
        return 2
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if baseline.get("schema_version") != "semantic-baseline-v1":
        print("Input must have schema_version semantic-baseline-v1.", file=sys.stderr)
        return 2
    cad_ir_path = (args.cad_ir or Path(baseline["input"]["cad_ir_path"])).expanduser().resolve()
    if not cad_ir_path.is_file():
        print(f"CAD IR does not exist: {cad_ir_path}", file=sys.stderr)
        return 2
    cad_ir = json.loads(cad_ir_path.read_text(encoding="utf-8"))
    entities_by_id = {entity["id"]: entity for entity in cad_ir.get("entities", [])}
    candidates = baseline.get("candidates", [])
    walls: list[dict[str, Any]] = []
    openings: list[dict[str, Any]] = []
    for candidate in candidates:
        source_id = candidate_source_id(candidate)
        if source_id is None or source_id not in entities_by_id:
            continue
        if candidate.get("semantic_type") == "wall":
            record = line_record(candidate, entities_by_id[source_id])
            if record is not None:
                walls.append(record)
        elif candidate.get("semantic_type") in {"door", "window"}:
            openings.append(candidate)

    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    bucket_size = max(args.max_wall_thickness_mm * 2.0, 1000.0)
    for index, wall in enumerate(walls):
        minimum = wall["bbox"]
        for x in range(math.floor(minimum[0] / bucket_size), math.floor(minimum[2] / bucket_size) + 1):
            for y in range(math.floor(minimum[1] / bucket_size), math.floor(minimum[3] / bucket_size) + 1):
                buckets[(x, y)].append(index)
    wall_pairs: list[dict[str, Any]] = []
    pairs_seen: set[tuple[str, str]] = set()
    for indices in buckets.values():
        for position, first_index in enumerate(indices):
            for second_index in indices[position + 1 :]:
                first = walls[first_index]
                second = walls[second_index]
                source_ids = tuple(sorted((first["source_id"], second["source_id"])))
                if source_ids in pairs_seen:
                    continue
                pairs_seen.add(source_ids)
                pair = parallel_pair(first, second, args.min_wall_thickness_mm, args.max_wall_thickness_mm, args.min_overlap_ratio)
                if pair is not None:
                    wall_pairs.append(pair)

    wall_segments = [(wall["candidate"]["id"], wall["source_id"], wall["start"], wall["end"]) for wall in walls]
    opening_relations: list[dict[str, Any]] = []
    relation_seen: set[str] = set()
    for opening in openings:
        source_id = candidate_source_id(opening)
        if source_id is None:
            continue
        relation = opening_relation(opening, entities_by_id[source_id], wall_segments, args.opening_distance_mm)
        if relation is not None and relation["id"] not in relation_seen:
            relation_seen.add(relation["id"])
            opening_relations.append(relation)

    thickness_bands = Counter()
    for pair in wall_pairs:
        thickness = pair["geometry"]["thickness_mm"]
        band = "40-99" if thickness < 100 else "100-199" if thickness < 200 else "200-299" if thickness < 300 else "300-399" if thickness < 400 else "400-600"
        thickness_bands[band] += 1
    relation_types = Counter(relation["opening_type"] for relation in opening_relations)
    pair_degree: Counter[str] = Counter()
    for pair in wall_pairs:
        for source_id in pair["source_entities"]:
            pair_degree[source_id] += 1
    pair_degree_bands = Counter(
        "1" if degree == 1 else "2-5" if degree <= 5 else "6-20" if degree <= 20 else "21+"
        for degree in pair_degree.values()
    )
    warnings: list[str] = []
    if not wall_pairs:
        warnings.append("No wall pairs matched the current geometric thresholds.")
    if not opening_relations:
        warnings.append("No door/window to wall relations matched the current distance threshold.")
    high_degree_wall_line_count = sum(1 for degree in pair_degree.values() if degree > 20)
    if high_degree_wall_line_count:
        warnings.append(
            f"{high_degree_wall_line_count:,} wall lines matched more than 20 pairs; these are proposal clusters requiring later deduplication."
        )

    result = {
        "schema_version": "semantic-enrichment-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input": {"baseline_path": str(baseline_path), "baseline_sha256": hashlib.sha256(baseline_path.read_bytes()).hexdigest(), "cad_ir_path": str(cad_ir_path), "cad_ir_sha256": hashlib.sha256(cad_ir_path.read_bytes()).hexdigest(), "region_id": baseline["input"].get("region_id")},
        "parameters": {"min_wall_thickness_mm": args.min_wall_thickness_mm, "max_wall_thickness_mm": args.max_wall_thickness_mm, "min_overlap_ratio": args.min_overlap_ratio, "opening_distance_mm": args.opening_distance_mm},
        "summary": {"primitive_candidate_count": len(candidates), "wall_line_count": len(walls), "wall_pair_count": len(wall_pairs), "opening_relation_count": len(opening_relations), "opening_relation_type_counts": dict(relation_types), "wall_pair_thickness_bands": sorted(thickness_bands.items()), "wall_pair_degree_bands": sorted(pair_degree_bands.items()), "high_degree_wall_line_count": high_degree_wall_line_count},
        "wall_pairs": wall_pairs,
        "opening_relations": opening_relations,
        "warnings": warnings,
    }
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = baseline_path.name.removesuffix(".semantic-baseline.json")
    json_path = output_dir / f"{stem}.enriched.json"
    markdown_path = output_dir / f"{stem}.enriched.md"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(result), encoding="utf-8")
    print(json.dumps({"json": str(json_path), "markdown": str(markdown_path), **result["summary"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
