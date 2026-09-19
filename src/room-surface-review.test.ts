import { expect, test } from "bun:test";
import { reviewBoundarySurfaces } from "./room-surface-review";
import { objectSegments, type SpatialObject } from "./room-spatial-geometry";
import { evidenceHash, replayDecisionAdapter, type DecisionAdapter } from "./jev-boundary-decisions";

const object: SpatialObject = {
  source_id: "same-parent", semantic_type: "wall", layer: "mixed", distance: 0, warnings: [],
  paths: [{ id: "path", points: [[0, 0], [10, 0], [10, 10]], closed: false, source_type: "POLYLINE", layer: "mixed" }],
};
const input = { elements: objectSegments(object), seed: [2, 2] as [number, number], model: "test", context: {}, focus: [], maximumSurfaces: 10, batchSize: 8 };
test("surface removal preserves another interval of the same source and exact replay", async () => {
  const records: Awaited<ReturnType<DecisionAdapter>>[] = [];
  const result = await reviewBoundarySurfaces(input, async (request) => {
    const record: typeof records[number] = { request_hash: evidenceHash(request), request, status: "ok", response: {
      answers: { q0: { choice: "non_boundary" }, q1: { choice: "boundary" } },
    } };
    records.push(record);
    return record;
  });
  expect(result.elements).toHaveLength(1);
  expect(result.elements[0]!.source_entities).toEqual(["same-parent"]);
  expect(result.decisions).toHaveLength(2);
  expect(await reviewBoundarySurfaces(input, replayDecisionAdapter(records))).toEqual(result);
});
test("unknown choice cannot silently remove geometry", async () => {
  const result = await reviewBoundarySurfaces(input, async (request) => ({ request_hash: evidenceHash(request), request, status: "ok", response: { answers: { q0: { choice: "invented" } } } }));
  expect(result.error).toBe("invalid_response");
  expect(result.elements).toEqual(input.elements);
});
test("uncertain surface is recorded without overwriting its previous relation", async () => {
  const result = await reviewBoundarySurfaces(input, async (request) => ({ request_hash: evidenceHash(request), request, status: "ok", response: { answers: { q0: { choice: "uncertain" }, q1: { choice: "uncertain" } } } }));
  expect(result.elements).toEqual(input.elements);
  expect(result.decisions.every((d) => d.choice === "uncertain")).toBe(true);
});
test("Jev can restore a previously omitted surface instead of only deleting", async () => {
  const all = objectSegments(object);
  const result = await reviewBoundarySurfaces({ ...input, elements: [all[0]!], alternatives: all }, async (request) => ({
    request_hash: evidenceHash(request), request, status: "ok", response: { answers: { q0: { choice: "boundary" }, q1: { choice: "boundary" } } },
  }));
  expect(result.elements.map((e) => e.id).sort()).toEqual(all.map((e) => e.id).sort());
});

test("dense omitted geometry cannot starve current boundary review or monopolise source coverage", async () => {
  const existing = Array.from({ length: 4 }, (_, i) => ({ ...input.elements[0]!, id: `wall-${i}`, source_entities: [`wall-${i}`], start: [20 + i, 0] as [number, number], end: [20 + i, 10] as [number, number] }));
  const clutter = Array.from({ length: 40 }, (_, i) => ({ ...input.elements[0]!, id: `clutter-${i}`, source_entities: ["dense-object"], start: [i / 100, 0] as [number, number], end: [i / 100, 1] as [number, number] }));
  const alternative = { ...existing[0]!, id: "missed-wall", source_entities: ["missed-wall"] };
  const result = await reviewBoundarySurfaces({ ...input, elements: existing, alternatives: [...clutter, alternative], maximumSurfaces: 6 }, async (request) => ({
    request, request_hash: evidenceHash(request), status: "ok", response: { answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { choice: "uncertain" }])) },
  }));
  expect(result.decisions.filter((d) => d.source_ids[0]!.startsWith("wall-")).length).toBe(4);
  expect(result.decisions.some((d) => d.source_ids.includes("missed-wall"))).toBe(true);
  expect(result.decisions.filter((d) => d.source_ids.includes("dense-object"))).toHaveLength(1);
  expect(result.elements).toEqual(existing);
  expect(result.coverage).toMatchObject({ reviewed_current_segments: 4, reviewed_restoration_segments: 2, reviewed_source_groups: 6, removed_from_graph: 0, restored_to_graph: 0 });
});

test("unused restoration slots return to current surfaces and every queried surface appears in the overview", async () => {
  const elements = Array.from({ length: 10 }, (_, i) => ({ ...input.elements[0]!, id: `w${i}`, source_entities: [`w${i}`], start: [i, 0] as [number, number], end: [i, 10] as [number, number] }));
  const result = await reviewBoundarySurfaces({ ...input, elements, maximumSurfaces: 6, batchSize: 2 }, async (request) => {
    const ids = new Set((request.state.all_surface_overview as unknown[][]).map((row) => row[0]));
    for (const c of Object.values(request.state.candidates as Record<string, { surface_id: string }>)) expect(ids.has(c.surface_id)).toBe(true);
    return { request, request_hash: evidenceHash(request), status: "ok", response: { answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { choice: "non_boundary" }])) } };
  });
  expect(result.decisions).toHaveLength(6);
  expect(result.elements).toHaveLength(4);
  expect(result.coverage?.removed_from_graph).toBe(6);
});
