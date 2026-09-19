import { describe, expect, test } from "bun:test";
import { buildProvisionalBoundaryElements, buildProvisionalWallElements, splitWallElementsAtJunctions } from "./wall-elements";

describe("buildProvisionalWallElements", () => {
  test("keeps one wall line as a traceable provisional element", () => {
    const result = buildProvisionalWallElements([
      { id: "source:A", source: { handle: "A" }, anchor: { local: [5, 0] }, geometry: { local: { kind: "line", start: [0, 0], end: [10, 0] } } },
    ], [
      { source_id: "source:A", semantic_type: "wall", confidence: 0.9, model: "jev", request_id: "r1" },
    ], [0, 0], 100);
    expect(result).toEqual([expect.objectContaining({ id: "wall:A:segment:0", source_entities: ["source:A"], start: [0, 0], end: [10, 0], length: 10 })]);
  });

  test("does not merge duplicate wall lines without a Jev membership decision", () => {
    const result = buildProvisionalWallElements([
      { id: "source:A", source: { handle: "A" }, anchor: { local: [5, 0] }, geometry: { local: { kind: "line", start: [0, 0], end: [10, 0] } } },
      { id: "source:B", source: { handle: "B" }, anchor: { local: [5, 0] }, geometry: { local: { kind: "line", start: [0, 0], end: [10, 0] } } },
    ], [
      { source_id: "source:A", semantic_type: "wall", confidence: 1 },
      { source_id: "source:B", semantic_type: "wall", confidence: 1 },
    ], [0, 0], 100);
    expect(result).toHaveLength(2);
  });
});

describe("buildProvisionalBoundaryElements", () => {
  test("expands a column block reference into a traversable perimeter", () => {
    const result = buildProvisionalBoundaryElements([
      { id: "source:C", source: { handle: "C" }, anchor: { local: [100, 100] }, geometry: { local: { kind: "block_reference", insert: [100, 100], scale: [60, 40], rotation: 0 } } },
    ], [
      { source_id: "source:C", semantic_type: "column", confidence: 1 },
    ], [100, 100], 100, ["column"]);
    expect(result).toHaveLength(4);
    expect(result.map((edge) => [edge.start, edge.end])).toContainEqual([[70, 80], [130, 80]]);
    expect(result.every((edge) => edge.semantic_type === "column")).toBe(true);
    expect(result.every((edge) => edge.boundary_kind === "object")).toBe(true);
    expect(new Set(result.map((edge) => edge.parent_element_id))).toEqual(new Set(["boundary:column:C"]));
  });

  test("marks windows and closed wall polylines as atomic outlines", () => {
    const result = buildProvisionalBoundaryElements([
      { id: "source:W", source: { handle: "W" }, anchor: { local: [5, 5] }, geometry: { local: { kind: "polyline", vertices: [[0, 0], [10, 0], [10, 10]], closed: false } } },
      { id: "source:P", source: { handle: "P" }, anchor: { local: [5, 5] }, geometry: { local: { kind: "polyline", vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true } } },
    ], [
      { source_id: "source:W", semantic_type: "window", confidence: 1 },
      { source_id: "source:P", semantic_type: "wall", confidence: 1 },
    ], [5, 5], 100);
    expect(result.filter((edge) => edge.source_entities.includes("source:W")).every((edge) => edge.boundary_kind === "object")).toBe(true);
    expect(result.filter((edge) => edge.source_entities.includes("source:P")).every((edge) => edge.boundary_kind === "object")).toBe(true);
  });
});

describe("splitWallElementsAtJunctions", () => {
  test("splits a long wall where another wall terminates", () => {
    const base = {
      status: "jev-grouped" as const,
      source_entities: ["source:A"],
      source_segment_index: -1,
      semantic_confidence: 1,
      semantic_model: "jev",
      semantic_request_id: null,
    };
    const result = splitWallElementsAtJunctions([
      { ...base, id: "vertical", start: [0, 0], end: [0, 20], length: 20 },
      { ...base, id: "horizontal", start: [-10, 10], end: [0, 10], length: 10 },
    ], 0.1, 1);
    expect(result.filter((element) => element.parent_element_id === "vertical")).toHaveLength(2);
  });
});
