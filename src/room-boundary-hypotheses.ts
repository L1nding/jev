import { evidenceHash } from "./jev-boundary-decisions";
import { objectSegments, spatialCandidates, type SpatialObject, type SpatialRole } from "./room-spatial-geometry";
import type { Point2, ProvisionalWallElement } from "./wall-elements";

export type BoundaryHypothesisEvidence = {
  candidate_id: string;
  sources: Array<{ source_id: string; semantic_type: string; prior_relation: SpatialRole | null; warnings: string[] }>;
};

/** Retrieve structural geometry as proposals, preserving every known obstacle.
 * Door leaves and stair drafting lines are not enclosing walls. Their geometry
 * must go through the opening/relationship path instead of this fallback.
 */
export function structuralBoundaryHypotheses(input: {
  objects: SpatialObject[];
  roles: ReadonlyMap<string, SpatialRole>;
  seed: Point2;
  radius: number;
  maximumObjects: number;
  maximumSegments: number;
  maximumCandidates: number;
}) {
  const eligible = input.objects.filter((o) => o.distance <= input.radius
    && ["wall", "window", "column"].includes(o.semantic_type)
    && !["obstacle", "opening_boundary"].includes(input.roles.get(o.source_id) ?? ""))
    .sort((a, b) => a.distance - b.distance || a.source_id.localeCompare(b.source_id));
  const selected: SpatialObject[] = [];
  const elements: ProvisionalWallElement[] = [];
  for (const object of eligible) {
    if (selected.length >= input.maximumObjects) break;
    const segments = objectSegments(object, object.semantic_type);
    // Never take only the first part of an object and invent a partial outline.
    if (!segments.length || elements.length + segments.length > input.maximumSegments) continue;
    selected.push(object);
    elements.push(...segments);
  }
  const obstacles = input.objects.filter((o) => input.roles.get(o.source_id) === "obstacle");
  const faces = spatialCandidates(elements, obstacles, input.seed);
  const candidates = faces.slice(0, input.maximumCandidates).map((candidate) => ({
    ...candidate,
    branch: { ...candidate.branch,
      id: `hypothesis:structural:${evidenceHash(candidate.branch.orderedEdges).slice(0, 20)}`,
      // Even a previous whole-object boundary choice does not approve every
      // interval in this reconstructed graph; surface decisions may disagree.
      orderedEdges: candidate.branch.orderedEdges.map((edge) => edge.kind === "wall"
        ? { ...edge, membership: "repair" as const } : edge),
    },
  }));
  const byId = new Map(selected.map((o) => [o.source_id, o]));
  const evidence: BoundaryHypothesisEvidence[] = candidates.map((c) => ({
    candidate_id: c.branch.id,
    sources: [...new Set(c.branch.orderedEdges.flatMap((e) => e.kind === "wall" ? e.source_entities : []))].sort().map((id) => ({
      source_id: id, semantic_type: byId.get(id)!.semantic_type,
      prior_relation: input.roles.get(id) ?? null, warnings: byId.get(id)!.warnings,
    })),
  }));
  return { candidates, evidence, coverage: {
    eligible_objects: eligible.length, selected_object_ids: selected.map((o) => o.source_id),
    segments: elements.length, obstacle_count: obstacles.length,
    objects_truncated: selected.length < eligible.length,
    candidates_truncated: faces.length > candidates.length,
  } };
}
