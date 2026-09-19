import { expect, test } from "bun:test";
import { gapChoices, objectSegments, spatialCandidates, validateSpatialBranch, type SpatialObject } from "./room-spatial-geometry";
import type { Point2 } from "./wall-elements";
import { resolveRoomBoundary, type RoomBoundaryProblem } from "./room-boundary-resolver";
import { evidenceHash, replayDecisionAdapter, type DecisionAdapter, type DecisionRecord } from "./jev-boundary-decisions";

function object(id: string, points: Point2[]): SpatialObject {
  return { source_id: id, semantic_type: "wall", layer: "arbitrary", distance: 0, warnings: [],
    paths: [{ id, points, closed: true, source_type: "POLYLINE", layer: "arbitrary" }] };
}
const square = object("square", [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);

test("concave enclosure works without a seed-side heuristic or parent-ID prohibition", () => {
  const concave = object("one-parent", [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]]);
  const result = spatialCandidates(objectSegments(concave), [], [2, 8]);
  expect(result).toHaveLength(1);
  expect(result[0]!.defects).toEqual([]);
  expect(result[0]!.gross_area).toBe(64);
});
test("interior column becomes a hole; boundary column can participate in the outer ring", () => {
  const column = object("column", [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]);
  const result = spatialCandidates(objectSegments(square), [column], [2, 2]);
  expect(result[0]!.holes).toHaveLength(1);
  expect(result[0]!.net_area).toBe(96);
  expect(result[0]!.defects).toEqual([]);
  const edges = objectSegments(square);
  edges[1] = { ...edges[1]!, parent_element_id: "column", semantic_type: "column" };
  expect(spatialCandidates(edges, [], [2, 2])[0]!.defects).toEqual([]);
});
test("removing an approved same-space dividing line merges faces", () => {
  const divider = { ...square, source_id: "divider", paths: [{ ...square.paths[0]!, id: "divider", closed: false, points: [[5, 0], [5, 10]] as Point2[] }] };
  expect(spatialCandidates([...objectSegments(square), ...objectSegments(divider)], [], [2, 2])[0]!.gross_area).toBe(50);
  expect(spatialCandidates(objectSegments(square), [], [2, 2])[0]!.gross_area).toBe(100);
});
test("translation, rotation and input order preserve area and validity", () => {
  const transformed = object("square", square.paths[0]!.points.map(([x, y]) => [-y + 1000, x - 500]));
  const result = spatialCandidates(objectSegments(transformed).reverse(), [], [998, -498]);
  expect(result[0]!.gross_area).toBe(100);
  expect(result[0]!.defects).toEqual([]);
});
test("duplicate closing junction and disconnected edge are invalid", () => {
  const candidate = spatialCandidates(objectSegments(square), [], [2, 2])[0]!;
  const last = candidate.branch.orderedEdges.at(-1)!;
  const doubled = { ...candidate.branch, orderedEdges: [...candidate.branch.orderedEdges, last] };
  expect(validateSpatialBranch(doubled, [2, 2])).toContain("disconnected_segments");
});
test("an existing virtual closing edge is emitted exactly once", () => {
  const edges = objectSegments(square);
  edges[3] = { ...edges[3]!, semantic_type: "junction-gap" };
  const candidate = spatialCandidates(edges, [], [2, 2])[0]!;
  expect(candidate.defects).toEqual([]);
  expect(candidate.branch.orderedEdges.filter((edge) => edge.kind === "junction")).toHaveLength(1);
});
test("opening portals are retrieved even when both wall outlines are closed", () => {
  const left = object("left", [[0, 0], [1, 0], [1, 4], [0, 4], [0, 0]]);
  const right = object("right", [[3, 0], [4, 0], [4, 4], [3, 4], [3, 0]]);
  const opening = object("door", [[1, 0], [3, 0]]);
  const options = gapChoices([...objectSegments(left), ...objectSegments(right)], [2, 2], 3, 20, [opening]);
  expect(options.dangling).toHaveLength(0);
  expect(options.candidates.some((g) => g.semantic_type === "opening-gap:door")).toBe(true);
});
test("a drafting gap can terminate on the interior of a long existing wall", () => {
  const vertical = object("vertical", [[5, 0], [5, 9]]);
  const top = object("top", [[0, 10], [10, 10]]);
  const result = gapChoices([...objectSegments(vertical), ...objectSegments(top)], [4, 5], 2, 12);
  expect(result.candidates.some((edge) => edge.start[0] === 5 && edge.start[1] === 9 && edge.end[0] === 5 && edge.end[1] === 10)).toBe(true);
});

const problem: RoomBoundaryProblem = {
  model: "test", seed: { source_id: "seed", text: "test", point: [2, 2] }, annotations: [], objects: [square],
  policy: { initialRadius: 20, maximumRadius: 40, initialObjects: 10, maximumObjects: 20, batchSize: 8, maximumRequests: 10, maximumRounds: 2, gapReach: 2, maximumGaps: 10 },
};
const fake: DecisionAdapter = async (request) => ({ request, request_hash: evidenceHash(request), status: "ok",
  response: { model: "test", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, {
    choice: key === "space" ? "closed_room" : key === "area" ? "none" : key === "decision" ? "candidate_0" : "boundary",
  }])) },
});
test("resolver performs intent, relationship and final decisions and exactly replays", async () => {
  const result = await resolveRoomBoundary(problem, fake);
  expect(result.outcome).toBe("accepted");
  expect(result.request_count).toBe(3);
  expect(result.accepted_candidate?.gross_area).toBe(100);
  expect(await resolveRoomBoundary(problem, replayDecisionAdapter(result.decision_records))).toEqual(result);
});
test("open zone stops without inventing a closed room", async () => {
  const result = await resolveRoomBoundary(problem, async (request) => {
    const record = await fake(request);
    record.response!.answers!.space!.choice = "open_zone";
    return record;
  });
  expect(result.outcome_reason).toBe("open_zone_extent_unresolved");
  expect(result.candidates).toEqual([]);
});
test("model refusal is preserved and triggers bounded context review", async () => {
  const result = await resolveRoomBoundary(problem, async (request) => {
    const record = await fake(request);
    if (request.questions.decision) record.response!.answers!.decision!.choice = "reject_all";
    return record;
  });
  expect(result.outcome_reason).toBe("jev_rejected_all");
  expect(result.accepted_attempt_id).toBeNull();
  expect(result.traces.filter((t) => t.stage === "context")).toHaveLength(2);
  expect(result.traces.some((t) => t.stage === "joint_repair_plans" && t.round === 1)).toBe(true);
});

test("joint repair connections require explicit acceptance of the complete candidate", async () => {
  const broken = object("broken", [[0, 1], [0, 10], [10, 10], [10, 9]]);
  broken.paths[0]!.closed = false;
  broken.paths.push({ id: "bottom", points: [[0, 0], [10, 0], [10, 8]], closed: false, source_type: "POLYLINE", layer: "arbitrary" });
  for (const accept of [false, true]) {
    let sawRepair = false;
    const result = await resolveRoomBoundary({ ...problem, objects: [broken], policy: { ...problem.policy, maximumRounds: 1 } }, async (request) => {
      const record = await fake(request);
      if (request.questions.decision) {
        const plans = (request.state.additional_evidence as { repair_plans: Array<{ unapproved_virtual_connections: unknown[] }> }).repair_plans;
        sawRepair = plans.some((p) => p.unapproved_virtual_connections.length === 2);
        record.response!.answers!.decision!.choice = accept ? "candidate_0" : "reject_all";
      }
      return record;
    });
    expect(sawRepair).toBe(true);
    expect(result.approved_gaps).toHaveLength(accept ? 2 : 0);
    expect(result.outcome).toBe(accept ? "accepted" : "uncertain");
  }
});

test("a rejected closed candidate triggers surface review with the rejected geometry as evidence", async () => {
  const mixed = object("mixed-parent", [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  mixed.paths.push({ id: "false-divider", points: [[5, 0], [5, 10]], closed: false, source_type: "LINE", layer: "arbitrary" });
  let surfaceQuestions = 0;
  const result = await resolveRoomBoundary({ ...problem, objects: [mixed], policy: { ...problem.policy, maximumRequests: 30 } }, async (request) => {
    const record = await fake(request);
    if (request.state.stage === "surface_review") {
      surfaceQuestions += Object.keys(request.questions).length;
      const candidates = request.state.candidates as Record<string, { path: Point2[] }>;
      expect(request.state.previous_candidates).toBeDefined();
      for (const [key, candidate] of Object.entries(candidates)) {
        // Coordinates are seed-relative: the divider x=5 is x=3 here.
        record.response!.answers![key]!.choice = candidate.path.every((p) => p[0] === 3) ? "non_boundary" : "boundary";
      }
    }
    if (request.questions.decision) {
      const candidates = request.state.candidates as Array<{ area: number }>;
      record.response!.answers!.decision!.choice = candidates[0]!.area === 100 ? "candidate_0" : "reject_all";
    }
    return record;
  });
  expect(surfaceQuestions).toBeGreaterThan(0);
  expect(result.outcome).toBe("accepted");
  expect(result.accepted_candidate?.gross_area).toBe(100);
});

test("an obstacle conflict is sent back to Jev rather than frozen during expansion", async () => {
  const obstacle = object("source:column", [[9, 4], [11, 4], [11, 6], [9, 6], [9, 4]]);
  let conflictReviewed = false;
  const result = await resolveRoomBoundary({ ...problem, objects: [square, obstacle], policy: { ...problem.policy, maximumRequests: 30 } }, async (request) => {
    const record = await fake(request);
    if (request.state.stage === "surface_review") {
      for (const [key, value] of Object.entries(request.state.candidates as Record<string, { source_ids: string[] }>)) {
        record.response!.answers![key]!.choice = value.source_ids.includes("source:column") ? "non_boundary" : "boundary";
      }
    } else if (request.state.candidates && !request.questions.decision && !request.state.boundary_paths) {
      for (const [key, value] of Object.entries(request.state.candidates as Record<string, { source_id: string; conflicts_with_candidate?: boolean }>)) {
        if (value.source_id === "source:column") {
          conflictReviewed ||= value.conflicts_with_candidate === true;
          record.response!.answers![key]!.choice = value.conflicts_with_candidate ? "irrelevant" : "obstacle";
        }
      }
    } else if (request.state.boundary_paths) {
      for (const key of Object.keys(request.questions)) record.response!.answers![key]!.choice = "none";
    }
    return record;
  });
  expect(conflictReviewed).toBe(true);
  expect(result.outcome).toBe("accepted");
});

test("expanded relationship requests carry retrieved frontier and neighboring segment evidence", async () => {
  const bottom = object("bottom", [[0, 0], [10, 0]]);
  const rest = object("rest", [[10, 0], [10, 10], [0, 10], [0, 0]]);
  bottom.paths[0]!.closed = false; rest.paths[0]!.closed = false;
  rest.distance = 5;
  let sawAdjacent = false;
  const result = await resolveRoomBoundary({ ...problem, objects: [bottom, rest], policy: { ...problem.policy, initialObjects: 1, maximumObjects: 2, maximumRequests: 20 } }, async (request) => {
    const record = await fake(request);
    for (const [key, question] of Object.entries(request.questions)) {
      if ("none" in question.criteria && key !== "area") record.response!.answers![key]!.choice = "none";
    }
    const candidates = request.state.candidates as Record<string, { source_id?: string; adjacent_boundary_segments?: Array<{ source_id: string; segments: Point2[][] }> }> | undefined;
    for (const candidate of Object.values(candidates ?? {})) {
      if (candidate.source_id === "rest") sawAdjacent = candidate.adjacent_boundary_segments?.some((n) => n.source_id === "bottom" && n.segments.length > 0) ?? false;
    }
    return record;
  });
  expect(sawAdjacent).toBe(true);
  expect(result.traces.some((t) => t.stage === "frontier_retrieval")).toBe(true);
  expect(result.outcome).toBe("accepted");
  expect(await resolveRoomBoundary({ ...problem, objects: [bottom, rest], policy: { ...problem.policy, initialObjects: 1, maximumObjects: 2, maximumRequests: 20 } }, replayDecisionAdapter(result.decision_records))).toEqual(result);
});

test("structural hypotheses cannot erase a known obstacle when unrelated objects are added", async () => {
  const obstacle = object("source:column", [[9, 4], [11, 4], [11, 6], [9, 6], [9, 4]]);
  const padding = Array.from({ length: 100 }, (_, i) => ({
    ...object(`padding:${i}`, [[100, 100], [101, 100]]), distance: 100,
  }));
  const input = { ...problem, objects: [square, obstacle, ...padding] };
  const result = await resolveRoomBoundary(input, async (request) => {
    const record = await fake(request);
    if (request.state.stage === "surface_review") {
      for (const [key, value] of Object.entries(request.state.candidates as Record<string, { source_ids: string[] }>)) {
        record.response!.answers![key]!.choice = value.source_ids.includes("source:column") ? "non_boundary" : "boundary";
      }
    } else if (request.state.boundary_paths) {
      for (const key of Object.keys(request.questions)) record.response!.answers![key]!.choice = "none";
    } else if (request.state.candidates && !request.questions.decision) {
      for (const [key, value] of Object.entries(request.state.candidates as Record<string, { source_id: string }>)) {
        record.response!.answers![key]!.choice = value.source_id === "source:column" ? "obstacle" : "boundary";
      }
    }
    return record;
  });
  expect(result.outcome).not.toBe("accepted");
  expect(result.candidates.some((c) => c.defects.includes("obstacle_touches_boundary:source:column"))).toBe(true);
});

test("unreviewed structural recall requires explicit final approval and exactly replays", async () => {
  const broken = object("broken", [[0, 0], [10, 0]]);
  broken.paths[0]!.closed = false;
  const unreviewed = { ...square, distance: 5 };
  const input = { ...problem, objects: [broken, unreviewed],
    policy: { ...problem.policy, initialObjects: 1, maximumObjects: 1, maximumRequests: 20 } };
  for (const accept of [false, true]) {
    let sawEvidence = false;
    const result = await resolveRoomBoundary(input, async (request) => {
      const record = await fake(request);
      if (request.state.boundary_paths) {
        for (const key of Object.keys(request.questions)) record.response!.answers![key]!.choice = "none";
      }
      if (request.questions.decision) {
        const evidence = request.state.additional_evidence as {
          boundary_hypotheses: Array<{ candidate_id: string; sources: Array<{ source_id: string; prior_relation: string | null }> }>;
        };
        sawEvidence = evidence.boundary_hypotheses.some((h) => h.sources.some((s) => s.source_id === "square" && s.prior_relation === null));
        record.response!.answers!.decision!.choice = accept ? "candidate_0" : "reject_all";
      }
      return record;
    });
    expect(sawEvidence).toBe(true);
    expect(result.outcome).toBe(accept ? "accepted" : "uncertain");
    expect(result.object_relations.square).toBeUndefined();
    expect(result.selected_object_ids).not.toContain("square");
    expect(result.boundary_hypotheses.some((h) => h.sources.some((s) => s.source_id === "square"))).toBe(true);
    expect(await resolveRoomBoundary(input, replayDecisionAdapter(result.decision_records))).toEqual(result);
  }
});
