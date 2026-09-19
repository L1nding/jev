import { evidenceHash } from "./jev-boundary-decisions";
import { spatialCandidates, type SpatialObject } from "./room-spatial-geometry";
import type { Point2, ProvisionalWallElement } from "./wall-elements";
import { distance, distanceToSegment } from "./room-traversal";

function incompatible(a: ProvisionalWallElement, b: ProvisionalWallElement): boolean {
  if (a.semantic_type?.startsWith("opening-gap:") && a.semantic_type === b.semantic_type) return true;
  const cross = (p: Point2, q: Point2, r: Point2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if ([a.start, a.end].some((p) => [b.start, b.end].some((q) => distance(p, q) <= 0.01))) return true;
  return cross(a.start, a.end, b.start) * cross(a.start, a.end, b.end) < 0
    && cross(b.start, b.end, a.start) * cross(b.start, b.end, a.end) < 0;
}

/** Geometry proposes complete alternatives; nothing here approves a repair. */
export function enumerateRepairPlans(input: {
  elements: ProvisionalWallElement[];
  obstacles: SpatialObject[];
  seed: Point2;
  gaps: ProvisionalWallElement[];
  maximumVariants: number;
  maximumCandidates: number;
}) {
  const candidates: ReturnType<typeof spatialCandidates> = [];
  const repairs = new Map<string, ProvisionalWallElement[]>();
  const seen = new Set<string>();
  const evaluated = new Set<string>();
  const ordered = [...input.gaps].sort((a, b) => a.id.localeCompare(b.id));
  let examined = 0;
  let exhausted = false;
  const evaluate = (gaps: ProvisionalWallElement[]) => {
    const key = gaps.map((gap) => gap.id).sort().join("\n");
    if (evaluated.has(key)) return;
    if (examined >= input.maximumVariants || candidates.length >= input.maximumCandidates) { exhausted = true; return; }
    evaluated.add(key);
    examined++;
    for (const candidate of spatialCandidates([...input.elements, ...gaps], input.obstacles, input.seed)) {
      if (candidate.defects.length) continue;
      const virtual = candidate.branch.orderedEdges.filter((edge) => edge.kind !== "wall");
      // Only retain repairs actually consumed by this candidate; unrelated selected gaps are not approved.
      const covers = (gap: ProvisionalWallElement, edge: typeof virtual[number]) =>
        distanceToSegment(edge.from, gap.start, gap.end) < 0.01
        && distanceToSegment(edge.to, gap.start, gap.end) < 0.01;
      const used = gaps.filter((gap) => virtual.some((edge) => covers(gap, edge)));
      // Planarization may split a proposed connection. Never omit its approval
      // evidence simply because the consumed subsegment has different endpoints.
      if (virtual.some((edge) => !used.some((gap) => covers(gap, edge)))) continue;
      if (!used.length) continue;
      const signature = evidenceHash(candidate.branch.orderedEdges.map((edge) => edge.kind === "wall"
        ? [edge.source_entities, edge.path ?? [edge.entry, edge.exit]] : [edge.kind, edge.from, edge.to]));
      if (seen.has(signature)) continue;
      seen.add(signature);
      candidate.branch.id = `repair-plan:${signature.slice(0, 20)}`;
      candidates.push(candidate);
      repairs.set(candidate.branch.id, used);
      if (candidates.length >= input.maximumCandidates) break;
    }
  };
  // Reserve part of the same budget for multi-break hypotheses. Each anchor
  // produces a deterministic maximal compatible set, not a semantic approval.
  // Only consumed edges survive in repairs; unrelated speculative edges do not.
  const packBudget = Math.floor(input.maximumVariants / 2);
  for (let anchor = 0; anchor < ordered.length && examined < packBudget && !exhausted; anchor++) {
    const pack: ProvisionalWallElement[] = [ordered[anchor]!];
    for (let step = 1; step < ordered.length; step++) {
      const gap = ordered[(anchor + step) % ordered.length]!;
      if (pack.every((selected) => !incompatible(selected, gap))) pack.push(gap);
    }
    if (pack.length > 2) evaluate(pack.sort((a, b) => a.id.localeCompare(b.id)));
  }
  for (const gap of ordered) { evaluate([gap]); if (exhausted) break; }
  for (let i = 0; !exhausted && i < ordered.length; i++) {
    for (let j = i + 1; !exhausted && j < ordered.length; j++) {
      const a = ordered[i]!, b = ordered[j]!;
      if (!incompatible(a, b)) evaluate([a, b]);
    }
  }
  return { candidates, repairs, examined, truncated: exhausted || ordered.length > 2,
    search_strategy: "anchored_compatible_sets_then_singles_and_pairs", exhaustive: ordered.length <= 2 && !exhausted,
    maximum_repairs_per_plan: ordered.length };
}
