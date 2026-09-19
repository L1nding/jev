import { expect, test } from "bun:test";
import { structuralBoundaryHypotheses } from "./room-boundary-hypotheses";
import type { SpatialObject, SpatialRole } from "./room-spatial-geometry";
import type { Point2 } from "./wall-elements";

const object = (id: string, points: Point2[], semantic_type = "wall"): SpatialObject => ({
  source_id: id, semantic_type, layer: "", distance: 1, warnings: [],
  paths: [{ id, points, closed: true, source_type: "POLYLINE", layer: "" }],
});
const square = object("square", [[0, 0], [10, 0], [10, 10], [0, 10]]);
const input = {
  objects: [square], roles: new Map<string, SpatialRole>(), seed: [2, 2] as Point2,
  radius: 20, maximumObjects: 10, maximumSegments: 100, maximumCandidates: 5,
};

test("small structural pools propose unreviewed intervals without approving their objects", () => {
  const result = structuralBoundaryHypotheses(input);
  expect(result.candidates).toHaveLength(1);
  expect(result.evidence[0]!.sources[0]!.prior_relation).toBeNull();
  expect(result.candidates[0]!.branch.orderedEdges.every((e) => e.kind === "wall" && e.membership === "repair")).toBe(true);
  expect(input.roles.size).toBe(0);
});

test("known interior obstacles remain holes in structural candidates", () => {
  const column = object("column", [[4, 4], [6, 4], [6, 6], [4, 6]], "column");
  const roles = new Map<string, SpatialRole>([["column", "obstacle"], ["square", "irrelevant"]]);
  const result = structuralBoundaryHypotheses({ ...input, objects: [square, column], roles });
  expect(result.candidates[0]!.defects).toEqual([]);
  expect(result.candidates[0]!.holes).toHaveLength(1);
  expect(result.candidates[0]!.net_area).toBe(96);
  expect(result.evidence[0]!.sources[0]!.prior_relation).toBe("irrelevant");
  expect(roles.get("square")).toBe("irrelevant");
});

test("door leaves, stair lines and opening-boundary objects cannot close a structural proposal", () => {
  for (const semantic of ["door", "stair", "furniture"]) {
    expect(structuralBoundaryHypotheses({ ...input, objects: [{ ...square, semantic_type: semantic }] }).candidates).toEqual([]);
  }
  expect(structuralBoundaryHypotheses({ ...input, roles: new Map([["square", "opening_boundary"]]) }).candidates).toEqual([]);
});

test("segment budget never truncates an object into a partial outline", () => {
  const result = structuralBoundaryHypotheses({ ...input, maximumSegments: 3 });
  expect(result.candidates).toEqual([]);
  expect(result.coverage.segments).toBe(0);
  expect(result.coverage.objects_truncated).toBe(true);
});

test("bounded retrieval is deterministic under object order and ignores out-of-radius padding", () => {
  const other = { ...square, source_id: "other", distance: 50 };
  const a = structuralBoundaryHypotheses({ ...input, objects: [square, other] });
  const b = structuralBoundaryHypotheses({ ...input, objects: [other, square] });
  expect(a).toEqual(b);
  expect(a).toEqual(structuralBoundaryHypotheses(input));
});
