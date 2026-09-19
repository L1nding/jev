import { expect, test } from "bun:test";
import { adjudicateRoom, type RoomAdjudicationProblem } from "./room-adjudication";
import { cachedDecisionAdapter, evidenceHash, liveDecisionAdapter, replayDecisionAdapter, type DecisionAdapter } from "./jev-boundary-decisions";
import type { TraversalBranch } from "./room-traversal";

const branch: TraversalBranch = {
  id: "single-face", startEntry: [0, 0], currentExit: [0, 0], closed: true, termination: "face_walk",
  visitedElementIds: [], visitedObjectIds: [], repairParentElementIds: [], interiorSide: 1, cumulativeProbability: 1,
  orderedEdges: [
    { kind: "junction", from: [0, 0], to: [10, 0] },
    { kind: "junction", from: [10, 0], to: [10, 10] },
    { kind: "junction", from: [10, 10], to: [0, 10] },
    { kind: "junction", from: [0, 10], to: [0, 0] },
  ],
};
const problem: RoomAdjudicationProblem = {
  model: "test", seed: { point: [5, 5] }, branches: [branch], minimumArea: 1, maximumArea: 1000,
  annotations: [], areaEvidence: null,
};
const answer = (choice: string): DecisionAdapter => async (request) => ({
  request_hash: evidenceHash(request), request, status: "ok",
  response: { answers: { decision: { choice, probabilities: { candidate_0: 0.99, reject_all: 0.01 } } } },
});

test("a unique closed face still requires Jev and respects rejection over probabilities", async () => {
  const result = await adjudicateRoom(problem, answer("reject_all"));
  expect(result.reason).toBe("jev_rejected_all");
  expect(result.accepted_attempt_id).toBeNull();
  expect(result.decision?.request.state.candidates).toHaveLength(1);
});
test("acceptance, insufficient evidence and malformed choice remain distinct", async () => {
  expect((await adjudicateRoom(problem, answer("candidate_0"))).accepted_attempt_id).toBe("single-face");
  expect((await adjudicateRoom(problem, answer("insufficient_evidence"))).reason).toBe("insufficient_evidence");
  expect((await adjudicateRoom(problem, answer("candidate_99"))).reason).toBe("invalid_response");
});
test("no closed seed-containing candidate cannot be accepted even by a permissive adapter", async () => {
  let called = false;
  const result = await adjudicateRoom({ ...problem, seed: { point: [30, 30] } }, async (request) => {
    called = true; return answer("candidate_0")(request);
  });
  expect(called).toBe(false);
  expect(result.reason).toBe("no_valid_candidates");
});
test("an exact decision can be replayed offline, changed geometry cannot", async () => {
  const live = await adjudicateRoom(problem, answer("candidate_0"));
  const replay = await adjudicateRoom(problem, replayDecisionAdapter([live.decision!]));
  expect(replay).toEqual(live);
  const changed = await adjudicateRoom({ ...problem, seed: { point: [4, 4] } }, replayDecisionAdapter([live.decision!]));
  expect(changed.reason).toBe("replay_mismatch");
});
test("cache only reuses identical evidence and sends changed evidence back to Jev", async () => {
  const original = await adjudicateRoom(problem, answer("candidate_0"));
  let calls = 0;
  const adapter = cachedDecisionAdapter([original.decision!], async (request) => { calls++; return answer("reject_all")(request); });
  expect((await adjudicateRoom(problem, adapter)).outcome).toBe("accepted");
  expect(calls).toBe(0);
  expect((await adjudicateRoom({ ...problem, seed: { point: [3, 3] } }, adapter)).reason).toBe("jev_rejected_all");
  expect(calls).toBe(1);
});
test("HTTP/model failure, non-JSON and missing choice never accept", async () => {
  for (const [body, status, reason] of [
    ['{"error":{"message":"max_tokens_exceeded"}}', 400, "model_error"],
    ["upstream error", 502, "model_error"],
    ['{"answers":{"decision":{"probabilities":{"candidate_0":1}}}}', 200, "invalid_response"],
  ] as const) {
    const adapter = liveDecisionAdapter({ endpoint: "https://unused.invalid", apiKey: "test-only", fetcher: async () => new Response(body, { status }) });
    const result = await adjudicateRoom(problem, adapter);
    expect(result.reason).toBe(reason);
    expect(result.accepted_attempt_id).toBeNull();
    expect(result.decision?.raw_response).toBe(body);
  }
});
