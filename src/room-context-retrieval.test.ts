import { expect, test } from "bun:test";
import { retrieveBoundaryContext } from "./room-context-retrieval";
import type { SpatialObject } from "./room-spatial-geometry";

const line = (id: string, x: number, y: number): SpatialObject => ({ source_id: id, semantic_type: "unknown", distance: Math.hypot(x, y), layer: "", warnings: [], paths: [{ id, points: [[x, y], [x + 1, y]], closed: false, source_type: "LINE", layer: "" }] });

test("dense geometry at one frontier cannot starve another boundary chain", () => {
  const clutter = Array.from({ length: 20 }, (_, i) => line(`clutter-${i}`, 0, i * 0.001));
  const continuation = line("continuation", 100, 0.1);
  const result = retrieveBoundaryContext([...clutter, continuation], [], [[0, 0], [100, 0]], 2, 1);
  expect(result.objects.map((o) => o.source_id)).toContain("continuation");
  expect(result.objects).toHaveLength(2);
  expect(retrieveBoundaryContext([continuation, ...clutter].reverse(), [], [[100, 0], [0, 0]], 2, 1).objects).toEqual(result.objects);
});

test("retained decisions survive expansion; empty frontier falls back to seed distance", () => {
  const retained = line("retained", 100, 0);
  const near = line("near", 1, 0), far = line("far", 20, 0);
  expect(retrieveBoundaryContext([far, retained, near], [retained], [], 2, 1).objects).toEqual([retained, near]);
});

test("adjacent evidence includes contact with a segment interior without changing objects", async () => {
  const { adjacentBoundaryEvidence } = await import("./room-context-retrieval");
  const target = line("target", 5, 0);
  const wall = line("wall", 0, 0);
  wall.paths[0]!.points = [[0, 0], [10, 0]];
  const before = JSON.stringify([target, wall]);
  expect(adjacentBoundaryEvidence(target, [wall], 0.01)[0]?.distance_mm).toBe(0);
  expect(adjacentBoundaryEvidence(target, [wall], 0.01)[0]?.segments).toEqual([[[0, 0], [10, 0]]]);
  expect(JSON.stringify([target, wall])).toBe(before);
});
