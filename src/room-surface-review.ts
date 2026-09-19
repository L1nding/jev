import { evidenceHash, type DecisionAdapter } from "./jev-boundary-decisions";
import { distanceToSegment } from "./room-traversal";
import type { Point2, ProvisionalWallElement } from "./wall-elements";

export type SurfaceDecision = {
  surface_id: string;
  source_ids: string[];
  path: Point2[];
  choice: "boundary" | "non_boundary" | "uncertain";
  request_hash: string;
};

/** Review source intervals, never infer a whole parent's role from one interval. */
export async function reviewBoundarySurfaces(input: {
  elements: ProvisionalWallElement[];
  alternatives?: ProvisionalWallElement[];
  seed: Point2;
  model: string;
  context: Record<string, unknown>;
  focus: Point2[];
  maximumSurfaces: number;
  batchSize: number;
}, decide: DecisionAdapter) {
  const relative = (p: Point2): Point2 => [Number((p[0] - input.seed[0]).toFixed(3)), Number((p[1] - input.seed[1]).toFixed(3))];
  const existingIds = new Set(input.elements.map((e) => e.id));
  const pool = [...input.elements, ...(input.alternatives ?? []).filter((e) => !existingIds.has(e.id))];
  const surfaces = pool.map((element) => ({
    element,
    id: `surface:${evidenceHash({ sources: [...element.source_entities].sort(), start: element.start, end: element.end }).slice(0, 20)}`,
    distance: distanceToSegment(input.seed, element.start, element.end),
    focusDistance: input.focus.length ? Math.min(...input.focus.map((p) => distanceToSegment(p, element.start, element.end))) : Infinity,
  }));
  // Alternate seed-local and defect-local retrieval so a remote defect cannot monopolise the budget.
  const bySeed = [...surfaces].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const byDefect = [...surfaces].sort((a, b) => a.focusDistance - b.focusDistance || a.distance - b.distance || a.id.localeCompare(b.id));
  const ranked = new Map<string, typeof surfaces[number]>();
  const buckets = new Map<number, typeof surfaces>();
  for (const surface of bySeed) {
    const e = surface.element;
    const angle = Math.atan2((e.start[1] + e.end[1]) / 2 - input.seed[1], (e.start[0] + e.end[0]) / 2 - input.seed[0]);
    const key = Math.min(15, Math.floor((angle + Math.PI) / (2 * Math.PI) * 16));
    buckets.set(key, [...buckets.get(key) ?? [], surface]);
  }
  const diverse: typeof surfaces = [];
  for (let rank = 0; diverse.length < surfaces.length; rank++) {
    for (const key of [...buckets.keys()].sort((a, b) => a - b)) if (buckets.get(key)?.[rank]) diverse.push(buckets.get(key)![rank]!);
  }
  for (let i = 0; i < surfaces.length; i++) {
    for (const candidate of [bySeed[i], byDefect[i], diverse[i]]) if (candidate && !ranked.has(candidate.id)) ranked.set(candidate.id, candidate);
  }
  // Geometry retrieval priority is not semantic authority. Allocate two slots
  // to the current graph for each restoration slot, then redistribute leftovers.
  // Round-robin by source prevents tessellated curves consuming the whole budget.
  const sourceDiverse = (items: typeof surfaces) => {
    const groups = new Map<string, typeof surfaces>();
    for (const item of items) {
      const key = JSON.stringify([...item.element.source_entities].sort());
      groups.set(key, [...groups.get(key) ?? [], item]);
    }
    const result: typeof surfaces = [];
    for (let rank = 0; result.length < items.length; rank++) {
      for (const group of groups.values()) if (group[rank]) result.push(group[rank]!);
    }
    return result;
  };
  const current = sourceDiverse([...ranked.values()].filter((s) => existingIds.has(s.element.id)));
  const omitted = sourceDiverse([...ranked.values()].filter((s) => !existingIds.has(s.element.id)));
  const selected = new Map<string, typeof surfaces[number]>();
  let currentIndex = 0, omittedIndex = 0;
  while (selected.size < input.maximumSurfaces && (currentIndex < current.length || omittedIndex < omitted.length)) {
    for (const kind of ["current", "current", "omitted"]) {
      if (selected.size >= input.maximumSurfaces) break;
      const candidate = kind === "current" ? current[currentIndex++] : omitted[omittedIndex++];
      if (candidate) selected.set(candidate.id, candidate);
    }
  }
  const pending = [...selected.values()];
  const overview = [...pending, ...[...ranked.values()].filter((s) => !selected.has(s.id))].slice(0, input.maximumSurfaces * 2);
  const decisions: SurfaceDecision[] = [];
  const excluded = new Set<string>();
  const added = new Map<string, ProvisionalWallElement>();
  for (let offset = 0; offset < pending.length; offset += input.batchSize) {
    const batch = pending.slice(offset, offset + input.batchSize);
    const response = await decide({
      model: input.model,
      state: {
        ...input.context, stage: "surface_review",
        review_selection_policy: "two_current_graph_slots_per_restoration_slot; source_round_robin; unused_slots_redistributed; not_a_semantic_filter",
        all_surface_overview: overview.map((s) => [s.id, s.element.source_entities, relative(s.element.start), relative(s.element.end)]),
        overview_truncated: surfaces.length > input.maximumSurfaces * 2,
        candidates: Object.fromEntries(batch.map((s, i) => [`q${i}`, {
          surface_id: s.id, source_ids: s.element.source_entities, semantic_type: s.element.semantic_type,
          currently_in_boundary_graph: existingIds.has(s.element.id),
          path: [relative(s.element.start), relative(s.element.end)],
          connections: surfaces.filter((other) => other !== s && [s.element.start, s.element.end].some((p) => distanceToSegment(p, other.element.start, other.element.end) <= 0.01))
            .slice(0, 12).map((other) => ({ id: other.id, path: [relative(other.element.start), relative(other.element.end)] })),
        }])),
      },
      questions: Object.fromEntries(batch.map((_, i) => [`q${i}`, {
        type: "choice" as const,
          instructions: `复核 candidates.q${i} 这一个具体表面区段与目标空间的关系。previous_candidates 是此前失败的完整轮廓及校验缺陷。候选既含已选线，也含此前未选线；选择 boundary 可补回遗漏，选择 non_boundary 只排除此区段。一个 CAD 父对象可跨多个空间。利用连接、邻室标注、房间范围及失败证据判断；不能按 seed 侧向或面积接近机械决定。`,
        criteria: {
          boundary: "该区段实际参与目标房间分隔，应保留。",
          non_boundary: "该区段是内部表达、重复表面或属于其他空间，不应分割目标房间；只排除此区段。",
          uncertain: "当前上下文不足以改判，保留未决证据。",
        },
      }])),
    });
    if (response.status !== "ok") return { elements: input.elements, decisions, error: response.status, truncated: surfaces.length > pending.length };
    for (const [index, surface] of batch.entries()) {
      const choice = response.response?.answers?.[`q${index}`]?.choice;
      if (choice !== "boundary" && choice !== "non_boundary" && choice !== "uncertain") return { elements: input.elements, decisions, error: "invalid_response", truncated: surfaces.length > pending.length };
      decisions.push({ surface_id: surface.id, source_ids: surface.element.source_entities, path: [surface.element.start, surface.element.end], choice, request_hash: response.answer_request_hashes?.[`q${index}`] ?? response.request_hash });
      if (choice === "non_boundary") excluded.add(surface.element.id);
      if (choice === "boundary" && !existingIds.has(surface.element.id)) added.set(surface.element.id, surface.element);
    }
  }
  return { elements: [...input.elements.filter((element) => !excluded.has(element.id)), ...added.values()], decisions, error: null, truncated: surfaces.length > pending.length,
    coverage: { pool_segments: surfaces.length, current_graph_segments: input.elements.length,
      reviewed_current_segments: pending.filter((s) => existingIds.has(s.element.id)).length,
      reviewed_restoration_segments: pending.filter((s) => !existingIds.has(s.element.id)).length,
      reviewed_source_groups: new Set(pending.map((s) => JSON.stringify([...s.element.source_entities].sort()))).size,
      removed_from_graph: input.elements.filter((e) => excluded.has(e.id)).length, restored_to_graph: added.size },
  };
}
