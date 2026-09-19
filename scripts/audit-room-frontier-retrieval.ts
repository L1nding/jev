import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { evidenceHash } from "../src/jev-boundary-decisions";
import { retrieveBoundaryContext } from "../src/room-context-retrieval";
import { entityDistance, type MeasuredEntity, type SpatialObject } from "../src/room-spatial-geometry";
import type { Point2 } from "../src/wall-elements";

const directory = resolve(Bun.argv[2] ?? "reports/room-v2/source-balanced-evaluation");
const geometry = await Bun.file("reports/room-v2/source-geometry.json").json();
const rows = [];
for (const name of (await readdir(directory)).filter((f) => /^source-.*\.json$/.test(f) && !f.includes("journal")).sort()) {
  const report = await Bun.file(resolve(directory, name)).json();
  if (evidenceHash(geometry) !== report.run_manifest.input_hashes.geometry) throw new Error("Geometry hash mismatch");
  const objects: SpatialObject[] = geometry.entities.map((o: MeasuredEntity) => ({ ...o, layer: "", semantic_type: "unknown", distance: entityDistance(o, report.room_seed.point) }))
    .filter((o: SpatialObject) => o.distance <= report.policy.maximumRadius)
    .sort((a: SpatialObject, b: SpatialObject) => a.distance - b.distance || a.source_id.localeCompare(b.source_id));
  const retained = objects.filter((o) => o.distance <= report.policy.initialRadius).slice(0, report.policy.initialObjects);
  const ids = new Set(retained.map((o) => o.source_id));
  const focus: Point2[] = report.traces.find((t: any) => t.stage === "defects" && t.round === 0)?.dangling_endpoints ?? [];
  const old = objects.filter((o) => !ids.has(o.source_id)).sort((a, b) =>
    (focus.length ? Math.min(...focus.map((p) => entityDistance(a, p))) - Math.min(...focus.map((p) => entityDistance(b, p))) : 0)
    || a.distance - b.distance || a.source_id.localeCompare(b.source_id)).slice(0, report.policy.maximumObjects - retained.length);
  const next = retrieveBoundaryContext(objects, retained, focus, report.policy.maximumObjects, report.policy.gapReach);
  const additions = next.objects.filter((o) => !ids.has(o.source_id));
  const coverage = (items: SpatialObject[], distance: number) => focus.filter((p) => items.some((o) => entityDistance(o, p) <= distance)).length;
  rows.push({ room: report.room_seed.text, seed: report.room_seed.source_id, frontier_count: focus.length,
    old_coverage_within_reach: coverage(old, report.policy.gapReach), new_coverage_within_reach: coverage(additions, report.policy.gapReach),
    old_coverage_within_1mm: coverage(old, 1), new_coverage_within_1mm: coverage(additions, 1),
    changed_additions: additions.filter((o) => !old.some((p) => p.source_id === o.source_id)).length,
    additions: additions.map((o) => o.source_id), evidence: next.evidence,
  });
}
const output = { kind: "frontier_retrieval_counterfactual", source_directory: directory,
  limitations: ["Uses first-round model-approved graph defects", "Geometric proximity is not correct room membership", "No human reference boundary; not boundary recall or accuracy"], rows };
await Bun.write(resolve(directory, "frontier-retrieval-audit.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(rows.map(({ additions, evidence, ...summary }) => summary), null, 2));
