import { describe, expect, test } from "bun:test";
import { validateRoomBoundary } from "./room-boundary";

const line = (id: string, start: number[], end: number[]) => ({ id, geometry: { local: { kind: "line", start, end } } });

describe("validateRoomBoundary", () => {
  test("accepts one closed ring", () => {
    const result = validateRoomBoundary([
      line("a", [0, 0], [10, 0]),
      line("b", [10, 0], [10, 10]),
      line("c", [10, 10], [0, 10]),
      line("d", [0, 10], [0, 0]),
    ], 0.1);
    expect(result.closed_boundary).toBe(true);
    expect(result.odd_degree_node_count).toBe(0);
  });

  test("reports an open boundary", () => {
    const result = validateRoomBoundary([
      line("a", [0, 0], [10, 0]),
      line("b", [10, 0], [10, 10]),
      line("c", [10, 10], [0, 10]),
    ], 0.1);
    expect(result.closed_boundary).toBe(false);
    expect(result.odd_degree_node_count).toBe(2);
  });

  test("snaps endpoints within tolerance", () => {
    const result = validateRoomBoundary([
      line("a", [0, 0], [10, 0]),
      line("b", [10.05, 0], [10, 10]),
      line("c", [10, 10], [0, 10]),
      line("d", [0, 10], [0, 0.05]),
    ], 0.1);
    expect(result.closed_boundary).toBe(true);
  });
});
