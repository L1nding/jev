import { expect, test } from "bun:test";
import { enumerateRepairPlans } from "./room-repair-plans";
import type { Point2, ProvisionalWallElement } from "./wall-elements";

const edge = (id: string, a: Point2, b: Point2, virtual = false): ProvisionalWallElement => ({
  id, parent_element_id: id, source_entities: virtual ? [] : [id], start: a, end: b,
  length: Math.hypot(b[0] - a[0], b[1] - a[1]), source_segment_index: 0, status: "provisional",
  semantic_type: virtual ? "junction-gap" : "wall", boundary_kind: "linear", semantic_confidence: null, semantic_model: null, semantic_request_id: null,
});
const elements = [edge("a", [0, 0], [10, 0]), edge("b", [10, 0], [10, 9]), edge("c", [10, 10], [0, 10]), edge("d", [0, 10], [0, 1])];
const gaps = [edge("gap1", [10, 9], [10, 10], true), edge("gap2", [0, 1], [0, 0], true)];
test("enumerates a complete two-gap enclosure when neither individual repair closes it", () => {
  const result = enumerateRepairPlans({ elements, seed: [5, 5], obstacles: [], gaps, maximumVariants: 10, maximumCandidates: 5 });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.gross_area).toBe(100);
  expect(result.repairs.get(result.candidates[0]!.branch.id)).toHaveLength(2);
});
test("bounded enumeration reports truncation rather than claiming no possible solution", () => {
  const result = enumerateRepairPlans({ elements, seed: [5, 5], obstacles: [], gaps, maximumVariants: 1, maximumCandidates: 5 });
  expect(result.candidates).toEqual([]);
  expect(result.truncated).toBe(true);
});

test("three independent breaks can be proposed together without approving unrelated repairs", () => {
  const walls = [edge("bottom", [1, 0], [10, 0]), edge("right", [10, 1], [10, 10]), edge("top-left", [9, 10], [0, 10]), edge("left", [0, 10], [0, 0])];
  const repairs = [edge("g1", [0, 0], [1, 0], true), edge("g2", [10, 0], [10, 1], true), edge("g3", [10, 10], [9, 10], true), edge("unrelated", [20, 20], [21, 20], true)];
  const run = (gaps: ProvisionalWallElement[]) => enumerateRepairPlans({ elements: walls, seed: [5, 5], obstacles: [], gaps, maximumVariants: 12, maximumCandidates: 5 });
  const result = run(repairs);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.gross_area).toBe(100);
  expect(result.repairs.get(result.candidates[0]!.branch.id)?.map((g) => g.id).sort()).toEqual(["g1", "g2", "g3"]);
  expect(run([...repairs].reverse()).candidates).toEqual(result.candidates);
});

test("a connection split by an existing wall retains its approval evidence", () => {
  const walls = [edge("bottom", [0, 0], [10, 0]), edge("right", [10, 0], [10, 8]), edge("top", [10, 10], [0, 10]), edge("left", [0, 10], [0, 0]), edge("stub", [10, 9], [10, 10])];
  const gap = edge("split-gap", [10, 8], [10, 10], true);
  const result = enumerateRepairPlans({ elements: walls, seed: [5, 5], obstacles: [], gaps: [gap], maximumVariants: 10, maximumCandidates: 5 });
  expect(result.candidates).toHaveLength(1);
  expect(result.repairs.get(result.candidates[0]!.branch.id)).toEqual([gap]);
});

test("multi-break proposals never combine mutually exclusive portals of one opening", () => {
  const walls = [edge("bottom", [1, 0], [10, 0]), edge("right", [10, 1], [10, 10]), edge("top", [9, 10], [0, 10]), edge("left", [0, 10], [0, 0])];
  const repairs = [edge("g1", [0, 0], [1, 0], true), edge("g2", [10, 0], [10, 1], true), edge("g3", [10, 10], [9, 10], true)]
    .map((gap) => ({ ...gap, semantic_type: "opening-gap:same-opening" }));
  const result = enumerateRepairPlans({ elements: walls, seed: [5, 5], obstacles: [], gaps: repairs, maximumVariants: 96, maximumCandidates: 5 });
  expect(result.candidates).toEqual([]);
  expect(result.exhaustive).toBe(false);
});
