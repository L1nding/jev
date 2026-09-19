# /// script
# requires-python = ">=3.12"
# dependencies = ["ezdxf==1.4.4"]
# ///
"""Export measured geometry for room analysis without mutating the original CAD IR."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import ezdxf
from ezdxf.disassemble import recursive_decompose
from ezdxf.path import make_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cad", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--curve-error", type=float, default=1.0)
    args = parser.parse_args()
    if args.curve_error <= 0:
        parser.error("curve-error must be positive")
    cad = json.loads(args.cad.read_text())
    dxf_path = Path(cad["source"]["path"])
    digest = hashlib.file_digest(dxf_path.open("rb"), "sha256").hexdigest()
    if digest != cad["source"]["sha256"]:
        raise ValueError("Source DXF differs from CAD IR")
    document = ezdxf.readfile(dxf_path)
    origin = cad["selection"]["local_origin"]
    records = []
    for source in cad["entities"]:
        kind = source["source"]["entity_type"]
        if kind not in {"LINE", "LWPOLYLINE", "POLYLINE", "INSERT", "ARC", "CIRCLE", "ELLIPSE", "SPLINE", "SOLID"}:
            continue
        entity = document.entitydb.get(source["source"]["handle"])
        paths, warnings = [], []
        try:
            if entity is None:
                raise ValueError("missing_source_entity")
            if entity.dxftype() == "INSERT" and entity.has_extension_dict:
                warnings.append("extension_dictionary_present_review_clipping")
            for index, child in enumerate(recursive_decompose([entity])):
                if child.dxftype() in {"TEXT", "MTEXT", "ATTRIB", "ATTDEF", "POINT"}:
                    continue
                try:
                    curve = make_path(child)
                    points = [[p.x - origin[0], p.y - origin[1]] for p in curve.flattening(args.curve_error)]
                    if len(points) >= 2:
                        paths.append({"id": f"{source['id']}:path:{index}", "points": points, "closed": curve.is_closed,
                                      "source_type": child.dxftype(), "layer": child.dxf.layer})
                except (TypeError, ValueError, AttributeError, NotImplementedError) as error:
                    warnings.append(f"unsupported_child:{child.dxftype()}:{type(error).__name__}")
        except Exception as error:
            warnings.append(f"expansion_failed:{type(error).__name__}")
        records.append({"source_id": source["id"], "paths": paths, "warnings": sorted(set(warnings))})
    result = {"schema_version": "room-source-geometry-v1", "source_sha256": digest,
              "cad_sha256": hashlib.sha256(args.cad.read_bytes()).hexdigest(),
              "units": cad["source"]["units"], "curve_error": args.curve_error,
              "generator": {"ezdxf": ezdxf.__version__, "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
              "entities": records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"output": str(args.output), "entities": len(records), "paths": sum(len(r["paths"]) for r in records),
                      "warnings": sum(bool(r["warnings"]) for r in records)}))


if __name__ == "__main__":
    main()
