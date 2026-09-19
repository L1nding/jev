import { adjudicateRoom } from "./room-adjudication";
import { evidenceHash, type DecisionAdapter, type DecisionRecord } from "./jev-boundary-decisions";
import { distanceToSegment } from "./room-traversal";
import type { Point2, ProvisionalWallElement } from "./wall-elements";
import { gapChoices, objectSegments, spatialCandidates, type SpatialObject, type SpatialRole } from "./room-spatial-geometry";
import { reviewBoundarySurfaces, type SurfaceDecision } from "./room-surface-review";
import { retrieveBoundaryContext, adjacentBoundaryEvidence } from "./room-context-retrieval";
import { enumerateRepairPlans } from "./room-repair-plans";
import { structuralBoundaryHypotheses, type BoundaryHypothesisEvidence } from "./room-boundary-hypotheses";

export type RoomBoundaryProblem = {
  model: string;
  seed: { source_id: string; text: string; point: Point2 };
  annotations: Array<{ source_id: string; text: string; point: Point2 }>;
  objects: SpatialObject[];
  policy: { initialRadius: number; maximumRadius: number; initialObjects: number; maximumObjects: number; batchSize: number; maximumRequests: number; maximumRounds: number; gapReach: number; maximumGaps: number; maximumSurfaces?: number; maximumHypothesisObjects?: number; maximumHypothesisSegments?: number };
};

const roleCriteria: Record<SpatialRole, string> = {
  boundary: "该对象的实际轮廓参与分隔目标房间与外部/邻室，可作为边界候选；墙/柱/外窗均可能。",
  opening_boundary: "该对象表达房间边界上的门窗开口，需在明确两侧接点后用虚拟封口维持房间划分，不能把门扇弧线当墙。",
  obstacle: "该对象为目标房间内部实体障碍物（例如独立柱），其闭合轮廓是内环，不是房间外轮廓。",
  same_space: "该对象是同一空间内部的表达线，不分隔房间，应允许其两侧空间合并。",
  irrelevant: "该对象与目标房间围合无关，或仅为家具、符号、标注、邻室内部图元。",
  uncertain: "现有证据不足以确认该对象与目标房间的关系。",
};

function bounds(object: SpatialObject) {
  const p = object.paths.flatMap((path) => path.points);
  return p.length ? [Math.min(...p.map((v) => v[0])), Math.min(...p.map((v) => v[1])), Math.max(...p.map((v) => v[0])), Math.max(...p.map((v) => v[1]))] : null;
}

export async function resolveRoomBoundary(problem: RoomBoundaryProblem, adapter: DecisionAdapter, progress: (message: string) => void = () => {}) {
  const { policy, seed } = problem;
  const records: DecisionRecord[] = [];
  const traces: Array<Record<string, unknown>> = [];
  const roles = new Map<string, SpatialRole>();
  let stoppedByBudget = false;
  const send: DecisionAdapter = async (request) => {
    if (records.length >= policy.maximumRequests) {
      stoppedByBudget = true;
      return { request, request_hash: evidenceHash(request), status: "model_error", response: null, error: "request_budget_exhausted" };
    }
    const record = await adapter(request);
    records.push(record);
    progress(`Jev request ${records.length}/${policy.maximumRequests}: ${record.status}`);
    return record;
  };
  const decide: DecisionAdapter = async (request) => {
    // A repair question needs detailed nearby geometry and a compact global map,
    // not every vertex of every object in the expanded analysis window.
    if (Array.isArray(request.state.boundary_paths)) {
      const choices = Object.values(request.state.candidates as Record<string, Array<{ path: Point2[] }>>).flat();
      const focus = choices.flatMap((choice) => choice.path);
      const localDetails = (items: unknown) => (items as Array<{ id: string; paths: Point2[][] }>).flatMap((item) => {
        const paths = item.paths.filter((path) => path.slice(1).some((p, i) => focus.some((f) => distanceToSegment(f, path[i]!, p) <= policy.gapReach)));
        return paths.length ? [{ id: item.id, paths }] : [];
      });
      request = { ...request, state: { ...request.state,
        detail_scope: { kind: "paths_near_current_gap_options", radius_mm: policy.gapReach, full_global_object_bounds_in_common_context: true },
        boundary_paths: localDetails(request.state.boundary_paths), opening_objects: localDetails(request.state.opening_objects),
      } };
    }
    const keys = Object.keys(request.questions);
    const splittable = keys.length > 1 && keys.every((key) => /^q\d+$/.test(key));
    const oversized = JSON.stringify(request).length > 32_000;
    let result: DecisionRecord | undefined;
    if (!oversized || !splittable) result = await send(request);
    const tokenOverflow = JSON.stringify(result?.response?.error ?? "").includes("max_tokens_exceeded");
    if (splittable && (oversized || tokenOverflow)) {
      const answers: NonNullable<NonNullable<DecisionRecord["response"]>["answers"]> = {};
      const answerRequestHashes: Record<string, string> = {};
      const half = Math.ceil(keys.length / 2);
      for (const selected of [keys.slice(0, half), keys.slice(half)]) {
        const candidates = request.state.candidates as Record<string, unknown>;
        const part = await decide({ ...request,
          questions: Object.fromEntries(selected.map((key) => [key, request.questions[key]!])),
          state: { ...request.state, candidates: Object.fromEntries(selected.map((key) => [key, candidates[key]])) },
        });
        if (part.status !== "ok") return part;
        Object.assign(answers, part.response?.answers);
        for (const key of selected) answerRequestHashes[key] = part.answer_request_hashes?.[key] ?? part.request_hash;
      }
      traces.push({ stage: "split_request", question_count: keys.length, preserved_common_context: true });
      return { request, request_hash: evidenceHash(request), status: "ok", response: { answers }, answer_request_hashes: answerRequestHashes };
    }
    return result!;
  };
  // Display evidence uses 0.001 mm precision; local validation always uses original doubles.
  const relative = (p: Point2): Point2 => [Number((p[0] - seed.point[0]).toFixed(3)), Number((p[1] - seed.point[1]).toFixed(3))];
  const annotations = problem.annotations.map((a) => ({ ...a, point: relative(a.point) }));
  const overview = {
    room_seed: { ...seed, point: [0, 0] }, coordinates: "millimetres relative to room seed; evidence display rounded to 0.001 mm; all vertices retained; original geometry used for validation",
    annotations,
  };
  const intent = await decide({
    model: problem.model,
    state: { ...overview, nearby_objects: problem.objects.slice(0, 24).map((o) => ({ source_id: o.source_id, semantic_type: o.semantic_type, layer: o.layer, bounds: bounds(o)?.map((v, i) => v - seed.point[i % 2]!) })) },
    questions: {
      space: { type: "choice", instructions: "判断目标文字指代的空间类型，不能仅凭房间名称认定是开放空间。证据不足请选择 unknown。", criteria: { closed_room: "独立围合的房间", open_zone: "较大空间中的开放功能区，无独立完整围合", unknown: "证据不足" } },
      area: { type: "choice", instructions: "选择属于目标房间的面积标注。使用相对位置与邻室文字判断，不能仅选最近文字。", criteria: {
        ...Object.fromEntries(problem.annotations.filter((a) => /\d\s*m[²2]/i.test(a.text)).map((a) => [a.source_id.replace(/[^a-zA-Z0-9_]/g, "_"), `${a.source_id}: ${a.text}`])),
        none: "没有目标房间面积标注", unknown: "无法确认面积标注归属",
      } },
    },
  });
  let latest = { outcome: "incomplete", reason: "no_valid_candidates", accepted_attempt_id: null as string | null };
  let candidates: ReturnType<typeof spatialCandidates> = [];
  let approvedGaps: ProvisionalWallElement[] = [];
  let selectedObjects: SpatialObject[] = [];
  let defectPoints: Point2[] = [];
  let finalDecision: DecisionRecord | null = null;
  const surfaceDecisions: SurfaceDecision[] = [];
  const hypothesisEvidence: BoundaryHypothesisEvidence[] = [];
  let previousCandidates: Array<Record<string, unknown>> = [];
  const conflicts = new Set<string>();
  const jointRepairs = new Map<string, ProvisionalWallElement[]>();
  const spaceKind = intent.status === "ok" ? intent.response?.answers?.space?.choice : "unknown";
  const areaId = intent.response?.answers?.area?.choice;
  const areaAnnotation = problem.annotations.find((a) => a.source_id.replace(/[^a-zA-Z0-9_]/g, "_") === areaId);
  const finish = () => ({
    schema_version: "room-boundary-resolver-v2", room_seed: seed, outcome: latest.outcome,
    outcome_reason: latest.reason, accepted_attempt_id: latest.accepted_attempt_id,
    accepted_candidate: candidates.find((c) => c.branch.id === latest.accepted_attempt_id) ?? null,
    candidates, space_kind: spaceKind, area_evidence: areaAnnotation ?? null,
    object_relations: Object.fromEntries(roles), selected_object_ids: selectedObjects.map((o) => o.source_id),
    approved_gaps: approvedGaps, final_decision: finalDecision, decision_records: records,
    surface_decisions: surfaceDecisions, boundary_hypotheses: hypothesisEvidence,
    traces, request_count: records.length, budget_exhausted: stoppedByBudget,
  });
  if (intent.status !== "ok") { latest = { ...latest, outcome: "uncertain", reason: intent.status }; return finish(); }
  if (spaceKind === "open_zone") { latest = { ...latest, outcome: "uncertain", reason: "open_zone_extent_unresolved" }; return finish(); }
  for (let round = 0; round < policy.maximumRounds && !stoppedByBudget; round++) {
    const radius = round === 0 ? policy.initialRadius : policy.maximumRadius;
    const limit = round === 0 ? policy.initialObjects : policy.maximumObjects;
    const local = problem.objects.filter((o) => o.distance <= radius);
    const retained = round === 0 ? [] : selectedObjects;
    const retrieval = retrieveBoundaryContext(local, retained, defectPoints, limit, policy.gapReach);
    selectedObjects = retrieval.objects;
    if (round > 0) traces.push({ stage: "frontier_retrieval", round, frontier_count: retrieval.frontier_count,
      covered_frontiers: retrieval.covered_frontiers, evidence: retrieval.evidence });
    const pending = selectedObjects.filter((o) => !roles.has(o.source_id) || roles.get(o.source_id) === "uncertain" || conflicts.has(o.source_id));
    const shared = { columns: ["source_id", "semantic", "relative_bbox", "previous_relation"], rows: selectedObjects.map((o) => [o.source_id, o.semantic_type, bounds(o)?.map((v, i) => Number((v - seed.point[i % 2]!).toFixed(3))), roles.get(o.source_id) ?? null]) };
    traces.push({ stage: "context", round, radius, available_objects: local.length, selected_objects: selectedObjects.length, truncated: local.length > limit });
    for (let offset = 0; offset < pending.length && !stoppedByBudget; offset += policy.batchSize) {
      const batch = pending.slice(offset, offset + policy.batchSize);
      const request = {
        model: problem.model,
        state: {
          ...overview, space_kind: spaceKind, associated_area: areaAnnotation ?? null,
          common_context: shared, previous_failure: round > 0 ? latest.reason : null, previous_candidates: previousCandidates,
          candidates: Object.fromEntries(batch.map((o, i) => [`q${i}`, {
            source_id: o.source_id, semantic: o.semantic_type, layer: o.layer,
            prior_room_role: o.prior_role ?? null, prior_layer_choice: o.prior_layer_choice ?? null,
            geometry_warnings: o.warnings, prior_relation: roles.get(o.source_id) ?? null, conflicts_with_candidate: conflicts.has(o.source_id),
            paths: o.paths.map((path) => ({ closed: path.closed, points: path.points.map(relative) })),
            ...(round > 0 ? { adjacent_boundary_segments: adjacentBoundaryEvidence(o, retained.filter((neighbor) => ["boundary", "opening_boundary"].includes(roles.get(neighbor.source_id) ?? "")), policy.gapReach)
              .map((neighbor) => ({ ...neighbor, prior_relation: roles.get(neighbor.source_id), segments: neighbor.segments.map((segment) => segment.map(relative)) })) } : {}),
          }])),
        },
        questions: Object.fromEntries(batch.map((_, i) => [`q${i}`, { type: "choice" as const,
          instructions: `判断 candidates.q${i} 与目标空间的关系。结合共同上下文、完整几何、邻室文字，不按图层名称或距离直接判断。旧图层/成员判断可能互相冲突；本次应依据原始几何证据复核。凹形房间不要求 seed 在所有边同侧。`,
          criteria: roleCriteria,
        }])),
      };
      const response = await decide(request);
      if (response.status !== "ok") { latest = { ...latest, outcome: "uncertain", reason: stoppedByBudget ? "request_budget_exhausted" : response.status }; return finish(); }
      batch.forEach((object, i) => roles.set(object.source_id, response.response!.answers![`q${i}`]!.choice as SpatialRole));
    }
    const boundary = selectedObjects.filter((o) => roles.get(o.source_id) === "boundary");
    const obstacles = selectedObjects.filter((o) => roles.get(o.source_id) === "obstacle");
    let elements = boundary.flatMap((o) => objectSegments(o, o.semantic_type));
    if (round > 0) {
      const availableBatches = Math.max(0, policy.maximumRequests - records.length - 4);
      const maximumSurfaces = Math.min(policy.maximumSurfaces ?? 48, availableBatches * policy.batchSize);
      if (maximumSurfaces > 0) {
        const review = await reviewBoundarySurfaces({
          elements, alternatives: selectedObjects.filter((o) => !["obstacle", "opening_boundary"].includes(roles.get(o.source_id) ?? ""))
            .flatMap((o) => objectSegments(o, o.semantic_type)), seed: seed.point, model: problem.model, focus: defectPoints,
          maximumSurfaces, batchSize: policy.batchSize,
          context: { ...overview, common_context: shared, associated_area: areaAnnotation ?? null, previous_candidates: previousCandidates, previous_failure: latest.reason },
        }, decide);
        surfaceDecisions.push(...review.decisions);
        traces.push({ stage: "surface_review", round, reviewed: review.decisions.length, non_boundary_choices: review.decisions.filter((d) => d.choice === "non_boundary").length, coverage: review.coverage ?? null, truncated: review.truncated });
        if (review.error) { latest = { ...latest, outcome: "uncertain", reason: review.error }; return finish(); }
        elements = review.elements;
      }
    }
    approvedGaps = []; // Repairs are reconsidered against the expanded graph, never carried over blindly.
    candidates = spatialCandidates(elements, obstacles, seed.point);
    if (!candidates.some((c) => c.defects.length === 0) || latest.reason === "jev_rejected_all") {
      const openingObjects = selectedObjects.filter((o) => roles.get(o.source_id) === "opening_boundary");
      const gaps = gapChoices(elements, seed.point, policy.gapReach, policy.maximumGaps, openingObjects);
      defectPoints = gaps.dangling;
      traces.push({ stage: "defects", round, dangling_endpoints: gaps.dangling, gap_candidates: gaps.candidates.length, truncated: gaps.truncated });
      const plans = enumerateRepairPlans({ elements, obstacles, seed: seed.point, gaps: gaps.candidates, maximumVariants: 96, maximumCandidates: 5 });
      traces.push({ stage: "joint_repair_plans", round, examined: plans.examined, truncated: plans.truncated, exhaustive: plans.exhaustive, search_strategy: plans.search_strategy, maximum_repairs_per_plan: plans.maximum_repairs_per_plan, candidates: plans.candidates.map((c) => ({ id: c.branch.id, area: c.gross_area, repairs: plans.repairs.get(c.branch.id) })) });
      for (const [id, repairs] of plans.repairs) jointRepairs.set(id, repairs);
      if (plans.candidates.length) {
        candidates = [...candidates, ...plans.candidates];
      }
      if (!candidates.some((c) => c.defects.length === 0)) {
      const byOrigin = new Map<string, ProvisionalWallElement[]>();
      for (const gap of gaps.candidates) {
        const key = gap.semantic_type?.startsWith("opening-gap:") ? gap.semantic_type : gap.start.join(",");
        byOrigin.set(key, [...byOrigin.get(key) ?? [], gap]);
      }
      const groups = [...byOrigin.values()];
      const sourcePaths = new Map<string, Point2[][]>();
      for (const e of elements) {
        const source = e.source_entities.join(",");
        sourcePaths.set(source, [...sourcePaths.get(source) ?? [], [relative(e.start), relative(e.end)]]);
      }
      for (let offset = 0; offset < groups.length && !stoppedByBudget; offset += policy.batchSize) {
        const batch = groups.slice(offset, offset + policy.batchSize);
        const gapResponse = await decide({
          model: problem.model,
          state: { ...overview, common_context: shared,
            boundary_paths: [...sourcePaths].map(([id, paths]) => ({ id, paths })),
            opening_objects: selectedObjects.filter((o) => roles.get(o.source_id) === "opening_boundary").map((o) => ({ id: o.source_id, paths: o.paths.map((p) => p.points.map(relative)) })),
            approved_gaps: approvedGaps.map((g) => [relative(g.start), relative(g.end)]),
            candidates: Object.fromEntries(batch.map((group, i) => [`q${i}`, group.map((g, j) => ({ key: `bridge_${j}`, path: [relative(g.start), relative(g.end)] }))])),
          },
          questions: Object.fromEntries(batch.map((group, i) => [`q${i}`, { type: "choice" as const,
            instructions: `为断口 q${i} 选择一个有建筑证据支持的虚拟连接。只能用于门窗封口或明确绘图断线；短距离和能闭合都不是充分理由。考虑已经批准的连接，禁止相互交叉或多条互斥出口。没有合适项选 none，证据不足选 uncertain。`,
            criteria: { ...Object.fromEntries(group.map((_, j) => [`bridge_${j}`, `采用候选连接 ${j}`])), none: "这些连接均不成立", uncertain: "无法确认，保留断口" },
          }])),
        });
        if (gapResponse.status !== "ok") { latest = { ...latest, outcome: "uncertain", reason: stoppedByBudget ? "request_budget_exhausted" : gapResponse.status }; return finish(); }
        batch.forEach((group, i) => {
          const choice = gapResponse.response?.answers?.[`q${i}`]?.choice;
          const selected = group.find((_, j) => choice === `bridge_${j}`);
          if (selected) approvedGaps.push(selected);
        });
      }
      candidates = spatialCandidates([...elements, ...approvedGaps], obstacles, seed.point);
      }
    }
    // Exhaust the normal relationship/repair rounds before proposing a new
    // structural graph. A rejected closed face can also need new geometry.
    if (round + 1 === policy.maximumRounds && !stoppedByBudget
      && (!candidates.some((c) => c.defects.length === 0) || latest.reason === "jev_rejected_all")) {
      const hypotheses = structuralBoundaryHypotheses({ objects: local, roles, seed: seed.point, radius,
        maximumObjects: policy.maximumHypothesisObjects ?? 220,
        maximumSegments: policy.maximumHypothesisSegments ?? 1200, maximumCandidates: 5 });
      candidates.push(...hypotheses.candidates);
      hypothesisEvidence.push(...hypotheses.evidence);
      traces.push({ stage: "structural_local_hypotheses", round, ...hypotheses.coverage,
        candidates: hypotheses.candidates.map((c) => ({ id: c.branch.id, area: c.gross_area, defects: c.defects })) });
    }
    const valid = candidates.filter((candidate) => candidate.defects.length === 0);
    previousCandidates = candidates.map((candidate) => ({
      id: candidate.branch.id, area_m2: candidate.gross_area / 1e6, defects: candidate.defects,
      edges: candidate.branch.orderedEdges.map((edge) => edge.kind === "wall"
        ? { sources: edge.source_entities, path: (edge.path ?? [edge.entry, edge.exit]).map(relative) }
        : { virtual: edge.kind, path: [relative(edge.from), relative(edge.to)] }),
    }));
    conflicts.clear();
    for (const candidate of candidates) for (const defect of candidate.defects) {
      const match = defect.match(/(?:obstacle_touches_boundary|unresolved_obstacle):(source:.+)/);
      if (match) conflicts.add(match[1]!);
    }
    traces.push({ stage: "candidate_validation", round, candidates: candidates.map((c) => ({ id: c.branch.id, defects: c.defects, gross_area: c.gross_area, net_area: c.net_area })) });
    const result = await adjudicateRoom({
      model: problem.model, seed, annotations: problem.annotations, areaEvidence: areaAnnotation ?? null,
      branches: valid.slice(0, 5).map((c) => c.branch), minimumArea: 0, maximumArea: Number.MAX_VALUE,
      context: {
        geometry_validation_scope: "closed continuous ring, seed inclusion, self-intersection/reused-segment checks, interior obstacle containment and overlap checks",
        repair_plans: valid.slice(0, 5).map((c) => ({ candidate_id: c.branch.id, unapproved_virtual_connections: (jointRepairs.get(c.branch.id) ?? []).map((e) => ({ id: e.id, source_ids: e.source_entities, path: [relative(e.start), relative(e.end)] })) })),
        repair_authority: "Where unapproved_virtual_connections are present, accepting the complete candidate also approves EACH listed connection. Reject if any connection lacks architectural evidence, even if the full path closes.",
        ...(hypothesisEvidence.length ? { boundary_hypotheses: hypothesisEvidence.filter((h) => valid.slice(0, 5).some((c) => c.branch.id === h.candidate_id)),
        hypothesis_authority: "Structural hypotheses are unapproved proposals, including every wall interval marked repair. prior_relation=null means never reviewed. Existing whole-object and surface decisions remain evidence, not overwritten. Accepting a hypothesis explicitly approves only its displayed boundary intervals after resolving conflicts; it does not relabel entire source objects. Reject if any interval lacks architectural evidence.", } : {}),
        approved_relations: Object.fromEntries(roles), context_truncated: local.length > limit,
        surface_decisions: surfaceDecisions.map((d) => ({ ...d, path: d.path.map(relative) })),
        unresolved_objects: selectedObjects.filter((o) => roles.get(o.source_id) === "uncertain" || o.warnings.length > 0).map((o) => ({ id: o.source_id, warnings: o.warnings, paths: o.paths.map((p) => p.points.map(relative)) })),
        candidates: valid.slice(0, 5).map((c) => ({ id: c.branch.id, gross_area: c.gross_area, net_area: c.net_area, holes: c.holes.map((h) => ({ ...h, points: h.points.map(relative) })) })),
      },
    }, decide);
    latest = { outcome: result.outcome, reason: result.reason, accepted_attempt_id: result.accepted_attempt_id };
    finalDecision = result.decision;
    if (result.accepted_attempt_id && jointRepairs.has(result.accepted_attempt_id)) approvedGaps = jointRepairs.get(result.accepted_attempt_id)!;
    if (result.outcome === "accepted" || (result.decision && result.decision.status !== "ok")) return finish();
    // A global rejection is evidence that earlier relationships need review too.
    if (round + 1 < policy.maximumRounds) {
      traces.push({ stage: "expand_context", round, cause: result.reason, remaining_requests: policy.maximumRequests - records.length });
      progress(`round ${round + 1}: ${latest.reason}; expanding bounded context`);
    }
  }
  if (stoppedByBudget) latest = { ...latest, outcome: "incomplete", reason: "request_budget_exhausted" };
  else if (latest.reason === "no_valid_candidates") latest.reason = "context_budget_exhausted_with_defects";
  return finish();
}
