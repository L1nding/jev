import { validateTraversal, type TraversalBranch } from "./room-traversal";
import type { Point2 } from "./wall-elements";
import type { DecisionAdapter, DecisionRecord } from "./jev-boundary-decisions";

export type RoomAdjudicationProblem = {
  model: string;
  seed: { point: Point2; [key: string]: unknown };
  annotations: Array<{ source_id: string; text: string; point: Point2 }>;
  areaEvidence: unknown;
  branches: TraversalBranch[];
  minimumArea: number;
  maximumArea: number;
  context?: Record<string, unknown>;
};

export type RoomAdjudication = {
  outcome: "accepted" | "incomplete" | "uncertain";
  reason: "jev_accepted" | "jev_rejected_all" | "insufficient_evidence" | "no_valid_candidates" | "model_error" | "invalid_response" | "replay_mismatch";
  accepted_attempt_id: string | null;
  decision: DecisionRecord | null;
};

export async function adjudicateRoom(problem: RoomAdjudicationProblem, decide: DecisionAdapter): Promise<RoomAdjudication> {
  const candidates = problem.branches.map((branch) => ({ branch, validation: validateTraversal(branch, problem.seed.point) }))
    .filter(({ validation: v }) => v.closed && v.contains_seed && Number.isFinite(v.area)
      && v.area >= problem.minimumArea && v.area <= problem.maximumArea);
  if (candidates.length === 0) {
    return { outcome: "incomplete", reason: "no_valid_candidates", accepted_attempt_id: null, decision: null };
  }
  // Translate without rounding or dropping vertices. All geometry remains in CAD units.
  const relative = (p: Point2): Point2 => [p[0] - problem.seed.point[0], p[1] - problem.seed.point[1]];
  const criteria: Record<string, string> = Object.fromEntries(candidates.map(({ branch }, index) => [
    `candidate_${index}`, `接受候选 ${index} (${branch.id}) 为目标房间。`,
  ]));
  criteria.reject_all = "现有候选均不能表达目标房间，需要重新构建候选。";
  criteria.insufficient_evidence = "证据不足，无法接受或明确否定这些候选。";
  const decision = await decide({
    model: problem.model,
    questions: { decision: { type: "choice", criteria,
      instructions: "判断完整候选是否表达目标 Room Seed 的房间。闭合、包含 seed、面积接近均不等于语义正确；检查邻室、对象关系、绕行细线和每一条虚拟连接。候选生成和 membership 标记来自旧算法，repair 不代表经过模型批准。面积文字由最近距离取回，归属尚未确认。只有证据支持完整空间范围才接受；都不成立选 reject_all；无法判断选 insufficient_evidence。即使只有一个候选，也必须独立审查。",
    } },
    state: {
      coordinate_system: { origin: problem.seed.point, coordinates: "relative_to_seed", units: "CAD source units; areas in squared source units" },
      room_seed: { ...problem.seed, point: [0, 0] },
      nearby_annotations: problem.annotations.map((a) => ({ source_id: a.source_id, text: a.text, point: relative(a.point) })),
      unverified_area_evidence: problem.areaEvidence,
      geometry_validation_scope: problem.context?.geometry_validation_scope ?? "legacy closure, seed containment and area only; internal holes and full segment continuity are not yet validated",
      additional_evidence: problem.context ?? null,
      candidates: candidates.map(({ branch, validation }, index) => ({
        key: `candidate_${index}`,
        id: branch.id,
        area: validation.area,
        ordered_edges: branch.orderedEdges.map((edge) => edge.kind === "wall" ? {
          kind: edge.kind, source_ids: edge.source_entities, parent_id: edge.parent_element_id ?? edge.element_id,
          semantic_type: edge.semantic_type, membership: edge.membership,
          path: (edge.path ?? [edge.entry, edge.exit]).map(relative),
        } : {
          kind: edge.kind, opening_id: edge.opening_element_id ?? null,
          path: [relative(edge.from), relative(edge.to)],
        }),
      })),
    },
  });
  if (decision.status !== "ok") {
    return { outcome: "uncertain", reason: decision.status, accepted_attempt_id: null, decision };
  }
  const choice = decision.response?.answers?.decision?.choice;
  if (choice === "reject_all" || choice === "insufficient_evidence") {
    return { outcome: "uncertain", reason: choice === "reject_all" ? "jev_rejected_all" : choice, accepted_attempt_id: null, decision };
  }
  const selected = candidates.find((_, index) => choice === `candidate_${index}`);
  if (!selected) return { outcome: "uncertain", reason: "invalid_response", accepted_attempt_id: null, decision };
  // Typed choice is authoritative. Never replace it with the highest probability.
  return { outcome: "accepted", reason: "jev_accepted", accepted_attempt_id: selected.branch.id, decision };
}
