import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evidenceHash } from "../src/jev-boundary-decisions";
import { entityDistance, objectSegments, spatialCandidates, type MeasuredEntity, type SpatialObject } from "../src/room-spatial-geometry";
import type { SurfaceDecision } from "../src/room-surface-review";

// Diagnostic counterfactuals only: never modifies decisions or accepts a room.
const directory = resolve(Bun.argv[2] ?? "reports/room-v2/multi-gap-evaluation");
const geometry = await Bun.file(resolve(Bun.argv[3] ?? "reports/room-v2/source-geometry.json")).json();
const rows = [];
for (const file of (await readdir(directory)).filter((f) => /^source-.*\.json$/.test(f) && !f.includes("journal")).sort()) {
  const report = await Bun.file(resolve(directory, file)).json();
  if (evidenceHash(geometry) !== report.run_manifest.input_hashes.geometry) throw new Error("Geometry hash mismatch");
  const seed = report.room_seed.point;
  const local = (geometry.entities as MeasuredEntity[]).filter((o) => entityDistance(o, seed) <= report.policy.maximumRadius);
  const selected = local.filter((o) => report.selected_object_ids.includes(o.source_id));
  const objects: SpatialObject[] = selected.map((o) => ({ ...o, distance: entityDistance(o, seed), layer: "", semantic_type: "wall" }));
  const boundary = objects.filter((o) => report.object_relations[o.source_id] === "boundary").flatMap((o) => objectSegments(o));
  const obstacles = objects.filter((o) => report.object_relations[o.source_id] === "obstacle");
  const pool = objects.filter((o) => !["obstacle", "opening_boundary"].includes(report.object_relations[o.source_id])).flatMap((o) => objectSegments(o));
  const decisions = new Map<string, SurfaceDecision>((report.surface_decisions as SurfaceDecision[]).map((d) => [d.surface_id, d]));
  const id = (e: typeof pool[number]) => `surface:${evidenceHash({ sources: [...e.source_entities].sort(), start: e.start, end: e.end }).slice(0, 20)}`;
  const existing = new Set(boundary.map((e) => e.id));
  const after = pool.filter((e) => decisions.get(id(e))?.choice === "boundary" || (existing.has(e.id) && decisions.get(id(e))?.choice !== "non_boundary"));
  const faces = (elements: typeof pool, includeObstacles: boolean) => spatialCandidates(elements, includeObstacles ? obstacles : [], seed)
    .map((c) => ({ area_m2: c.gross_area / 1e6, defects: c.defects }));
  rows.push({ seed: report.room_seed.source_id, room: report.room_seed.text,
    local_objects: local.length, selected_objects: objects.length, review_pool_segments: pool.length,
    before_segments: boundary.length, after_segments: after.length, reviewed_segments: decisions.size,
    unreviewed_retained_segments: after.filter((e) => !decisions.has(id(e))).length,
    restored_segments: after.filter((e) => !existing.has(e.id)).length,
    removed_segments: boundary.filter((e) => decisions.get(id(e))?.choice === "non_boundary").length,
    before_faces_without_obstacles: faces(boundary, false), after_faces_without_obstacles: faces(after, false),
    after_faces_with_obstacles: faces(after, true),
    largest_sources: objects.map((o) => ({ source_id: o.source_id, role: report.object_relations[o.source_id], segments: objectSegments(o).length,
      reviewed: [...decisions.values()].filter((d) => d.source_ids.includes(o.source_id)).length,
    })).sort((a, b) => b.segments - a.segments).slice(0, 8),
  });
}
const audit = { kind: "surface_recall_diagnostic", limitations: ["No human reference boundary: coverage is not true boundary recall", "Final-round relations reconstructed; counterfactual faces are not accepted rooms", "Virtual repairs excluded to isolate surface selection"], rows };
await writeFile(resolve(directory, "surface-recall-audit.json"), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit, null, 2));
