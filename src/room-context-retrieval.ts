import { entityDistance, objectSegments, type SpatialObject } from "./room-spatial-geometry";
import { distanceToSegment } from "./room-traversal";
import type { Point2 } from "./wall-elements";

// Ranking changes evidence retrieval only, never the object's room relation.
export function retrieveBoundaryContext(objects: SpatialObject[], retained: SpatialObject[], focus: Point2[], limit: number, reach: number) {
  const selected = retained.slice(0, limit);
  const seen = new Set(selected.map((o) => o.source_id));
  const pool = objects.filter((o) => !seen.has(o.source_id));
  const frontiers = [...new Map(focus.map((p) => [p.join(","), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const fallback = pool.map((object) => ({ object, distance: frontiers.length ? Math.min(...frontiers.map((p) => entityDistance(object, p))) : object.distance }))
    .sort((a, b) => a.distance - b.distance || a.object.distance - b.object.distance || a.object.source_id.localeCompare(b.object.source_id));
  const queues = frontiers.map((point) => pool.map((object) => ({ object, distance: entityDistance(object, point) }))
    .filter((row) => row.distance <= reach)
    .sort((a, b) => a.distance - b.distance || a.object.distance - b.object.distance || a.object.source_id.localeCompare(b.object.source_id)));
  const evidence: Array<{ source_id: string; frontier: Point2; distance_mm: number }> = [];
  let added = true;
  while (selected.length < limit && added) {
    added = false;
    for (let i = 0; i < queues.length && selected.length < limit; i++) {
      const queue = queues[i]!;
      while (queue.length && seen.has(queue[0]!.object.source_id)) queue.shift();
      const row = queue.shift();
      if (!row) continue;
      selected.push(row.object); seen.add(row.object.source_id); added = true;
      evidence.push({ source_id: row.object.source_id, frontier: frontiers[i]!, distance_mm: row.distance });
    }
  }
  for (const row of fallback) {
    if (selected.length >= limit) break;
    if (!seen.has(row.object.source_id)) { selected.push(row.object); seen.add(row.object.source_id); }
  }
  return { objects: selected, evidence, frontier_count: frontiers.length,
    covered_frontiers: queues.filter((_, i) => selected.some((o) => !retained.some((r) => r.source_id === o.source_id) && entityDistance(o, frontiers[i]!) <= reach)).length };
}

// Return actual adjacent segments, including contacts in the middle of long walls.
// These are contextual measurements, not approved connections or room members.
export function adjacentBoundaryEvidence(object: SpatialObject, neighbors: SpatialObject[], reach: number, limit = 4) {
  const own = objectSegments(object);
  return neighbors.filter((neighbor) => neighbor.source_id !== object.source_id).flatMap((neighbor) => {
    const segments = objectSegments(neighbor).map((segment) => ({ segment, distance: Math.min(Infinity, ...own.map((edge) => Math.min(
      distanceToSegment(edge.start, segment.start, segment.end), distanceToSegment(edge.end, segment.start, segment.end),
      distanceToSegment(segment.start, edge.start, edge.end), distanceToSegment(segment.end, edge.start, edge.end),
    ))) })).filter((row) => row.distance <= reach).sort((a, b) => a.distance - b.distance || a.segment.id.localeCompare(b.segment.id));
    return segments.length ? [{ source_id: neighbor.source_id, distance_mm: segments[0]!.distance, segments: segments.slice(0, 2).map((r) => [r.segment.start, r.segment.end]) }] : [];
  }).sort((a, b) => a.distance_mm - b.distance_mm || a.source_id.localeCompare(b.source_id)).slice(0, limit);
}
