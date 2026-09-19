import { describe, expect, test } from "bun:test";
import { applyOption, boundaryRepairOptions, buildBoundaryObjectPortals, filterWallElementsByRole, hasDeterministicLead, nextOptions, rankTraversalOptions, startBranch, startOptions, validateTraversal } from "./room-traversal";

const walls = [
  { id: "w1", status: "provisional" as const, source_entities: ["s1"], source_segment_index: 0, start: [0, 0] as [number, number], end: [10, 0] as [number, number], length: 10, semantic_confidence: 1, semantic_model: null, semantic_request_id: null },
  { id: "w2", status: "provisional" as const, source_entities: ["s2"], source_segment_index: 0, start: [10, 0] as [number, number], end: [10, 10] as [number, number], length: 10, semantic_confidence: 1, semantic_model: null, semantic_request_id: null },
  { id: "w3", status: "provisional" as const, source_entities: ["s3"], source_segment_index: 0, start: [10, 10] as [number, number], end: [0, 10] as [number, number], length: 10, semantic_confidence: 1, semantic_model: null, semantic_request_id: null },
  { id: "w4", status: "provisional" as const, source_entities: ["s4"], source_segment_index: 0, start: [0, 10] as [number, number], end: [0, 0] as [number, number], length: 10, semantic_confidence: 1, semantic_model: null, semantic_request_id: null },
];

describe("ordered room traversal", () => {
  test("restricts traversal walls to Jev boundary members", () => {
    const selected = filterWallElementsByRole(walls, {
      s1: "boundary",
      s2: "boundary",
      s3: "boundary",
      s4: "unrelated",
    }, "boundary");
    expect(selected.map((wall) => wall.id)).toEqual(["w1", "w2", "w3"]);
  });

  test("reports translation-independent area for an open path", () => {
    const translated = [
      { ...walls[0]!, id: "a", start: [52_085, 15_512] as [number, number], end: [52_085, 13_286] as [number, number] },
      { ...walls[0]!, id: "b", start: [52_085, 13_286] as [number, number], end: [52_085, 12_746] as [number, number] },
    ];
    const start = startOptions(translated, [51_566, 14_590], 2).find((option) => option.id === "start:a:forward")!;
    let branch = startBranch(start, 1, 0, [51_566, 14_590])!;
    const next = nextOptions(branch, translated, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8 })
      .find((option) => option.wall?.element_id === "b")!;
    branch = applyOption(branch, next, 1, "b");
    expect(validateTraversal(branch, [51_566, 14_590]).area).toBe(0);
  });

  test("offers rejected parent walls only as explicit boundary repairs", () => {
    const start = startOptions(walls, [5, 5], 1).find((option) => option.id === "start:w1:forward")!;
    const branch = startBranch(start, 1, 0, [5, 5])!;
    const repairs = boundaryRepairOptions(branch, [walls[0]!], walls, [], {
      junctionTolerance: 0.1,
      openingReach: 2,
      limit: 8,
      roomSeed: [5, 5],
    });
    const repair = repairs.find((option) => option.wall?.element_id === "w2")!;
    expect(repair).toEqual(expect.objectContaining({
      repair_parent_element_id: "w2",
      wall: expect.objectContaining({ membership: "repair" }),
    }));
    const repairedBranch = applyOption(branch, repair, 1, "repair");
    expect(repairedBranch.repairParentElementIds).toEqual(["w2"]);
    expect(branch.repairParentElementIds).toEqual([]);
  });

  test("does not let accepted candidates crowd a nearby heterogeneous repair out of the limit", () => {
    const start = startOptions(walls, [5, 5], 2).find((option) => option.id === "start:w1:forward")!;
    const branch = startBranch(start, 1, 0, [5, 5])!;
    const accepted = Array.from({ length: 16 }, (_, index) => ({
      ...walls[1]!,
      id: `accepted-${index}`,
      parent_element_id: `accepted-parent-${index}`,
      start: [10, index / 100] as [number, number],
      end: [10 + index / 100, 10] as [number, number],
    }));
    const windowEdge = {
      ...walls[1]!,
      id: "window-edge",
      parent_element_id: "window",
      semantic_type: "window",
      start: [10, 0] as [number, number],
      end: [10, -10] as [number, number],
    };
    const repairs = boundaryRepairOptions(branch, [walls[0]!, ...accepted], [walls[0]!, ...accepted, windowEdge], [], {
      junctionTolerance: 2,
      openingReach: 2,
      limit: 4,
      roomSeed: [5, 5],
    });
    expect(repairs.some((option) => option.wall?.semantic_type === "window")).toBe(true);
  });

  test("diversifies repair candidates by boundary object", () => {
    const start = startOptions(walls, [5, 5], 2).find((option) => option.id === "start:w1:forward")!;
    const branch = startBranch(start, 1, 0, [5, 5])!;
    const windowSegments = Array.from({ length: 8 }, (_, index) => ({
      ...walls[1]!,
      id: `window-${index}`,
      parent_element_id: "window-object",
      semantic_type: "window",
      start: [10, index / 100] as [number, number],
      end: [11, 1 + index / 100] as [number, number],
    }));
    const columnEdge = {
      ...walls[1]!,
      id: "column-edge",
      parent_element_id: "column-object",
      semantic_type: "column",
      start: [10, 0] as [number, number],
      end: [10, -10] as [number, number],
    };
    const repairs = boundaryRepairOptions(branch, [walls[0]!], [walls[0]!, ...windowSegments, columnEdge], [], {
      junctionTolerance: 2,
      openingReach: 2,
      limit: 4,
      roomSeed: [5, 5],
    });
    expect(repairs.filter((option) => option.wall?.parent_element_id === "window-object")).toHaveLength(2);
    expect(repairs.some((option) => option.wall?.parent_element_id === "column-object")).toBe(true);
  });

  test("does not cross wall thickness by reversing onto a parallel parent", () => {
    const parallel = {
      ...walls[0]!,
      id: "parallel",
      start: [10, 1] as [number, number],
      end: [0, 1] as [number, number],
    };
    const start = startOptions([walls[0]!, parallel], [5, 5], 2).find((option) => option.id === "start:w1:forward")!;
    const branch = startBranch(start, 1, 0, [5, 5])!;
    const candidates = nextOptions(branch, [walls[0]!, parallel], [], { junctionTolerance: 2, openingReach: 2, limit: 8 });
    expect(candidates.some((option) => option.wall?.element_id === "parallel")).toBe(false);
  });

  test("traverses an outline object as one atomic transition", () => {
    const incoming = { ...walls[0]!, id: "incoming", start: [0, 0] as [number, number], end: [10, 0] as [number, number] };
    const outgoing = { ...walls[2]!, id: "outgoing", start: [10, 10] as [number, number], end: [0, 10] as [number, number] };
    const outline = [
      [[10, 0], [12, 0]],
      [[12, 0], [12, 10]],
      [[12, 10], [10, 10]],
      [[10, 10], [10, 0]],
    ].map(([start, end], index) => ({
      ...walls[0]!,
      id: `window:${index}`,
      parent_element_id: "boundary:window:W",
      semantic_type: "window",
      boundary_kind: "object" as const,
      start: start as [number, number],
      end: end as [number, number],
    }));
    const start = startOptions([incoming], [5, 5], 1).find((option) => option.id === "start:incoming:forward")!;
    const branch = startBranch(start, 1, 0, [5, 5])!;
    const candidates = nextOptions(branch, [incoming, ...outline, outgoing], [], {
      junctionTolerance: 0.1,
      openingReach: 2,
      limit: 8,
      roomSeed: [5, 5],
    });
    const transition = candidates.find((option) => option.wall?.parent_element_id === "boundary:window:W")!;
    expect(transition.wall).toEqual(expect.objectContaining({
      boundary_kind: "object",
      entry: [10, 0],
      exit: [10, 10],
      member_element_ids: ["window:3"],
      path: [[10, 0], [10, 10]],
    }));
    expect(candidates.some((option) => option.wall?.element_id === "window:0")).toBe(false);
    const traversed = applyOption(branch, transition, 1, "window");
    expect(traversed.orderedEdges).toHaveLength(2);
    expect(traversed.visitedElementIds).toContain("window:3");
    expect(traversed.visitedObjectIds).toEqual(["boundary:window:W"]);
    const afterObject = nextOptions(traversed, [incoming, ...outline, outgoing], [], {
      junctionTolerance: 20,
      openingReach: 20,
      limit: 8,
      roomSeed: [5, 5],
    });
    expect(afterObject.some((option) => option.wall?.parent_element_id === "boundary:window:W")).toBe(false);
  });

  test("generates explicit portals for an object where it touches neighboring boundaries", () => {
    const object = [
      [[10, 0], [12, 0]],
      [[12, 0], [12, 10]],
      [[12, 10], [10, 10]],
      [[10, 10], [10, 0]],
    ].map(([start, end], index) => ({
      ...walls[0]!, id: `column:${index}`, parent_element_id: "boundary:column:C",
      semantic_type: "column", boundary_kind: "object" as const,
      start: start as [number, number], end: end as [number, number],
    }));
    const neighbors = [
      { ...walls[0]!, id: "incoming", start: [0, 0] as [number, number], end: [10, 0] as [number, number] },
      { ...walls[2]!, id: "outgoing", start: [10, 10] as [number, number], end: [0, 10] as [number, number] },
    ];
    const portals = buildBoundaryObjectPortals(object, neighbors, 0.1);
    expect(portals.map((portal) => portal.point)).toEqual([[10, 0], [10, 10]]);
    expect(portals.map((portal) => portal.connections[0]?.element_id)).toEqual(["incoming", "outgoing"]);
  });

  test("deterministic ranking rejects the wrong seed side and cross-parent U-turn", () => {
    const start = startOptions(walls, [5, 5], 1).find((option) => option.id === "start:w1:forward")!;
    const branch = startBranch(start, 1, 0, [5, 5])!;
    const valid = nextOptions(branch, walls, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8, roomSeed: [5, 5] })
      .find((option) => option.wall?.element_id === "w2")!;
    const wrongSide = { ...valid, id: "wrong-side", side_consistent: false };
    const uTurn = { ...valid, id: "u-turn", side_consistent: true, same_parent: false, turn_degrees: 180 };
    const ranking = rankTraversalOptions(branch, [wrongSide, uTurn, valid], { acceptedParentIds: ["w2"], roomSeed: [5, 5], targetArea: 100, maximumRoomArea: 400 });
    expect(ranking.rejected.map((item) => item.option.id)).toEqual(["wrong-side", "u-turn"]);
    expect(ranking.accepted[0]?.option.id).toBe(valid.id);
    expect(hasDeterministicLead(ranking.accepted)).toBe(true);
  });

  test("collapses the real window-like outline with duplicate vertices into one step", () => {
    const incoming = { ...walls[0]!, id: "incoming", start: [0, 0] as [number, number], end: [10, 0] as [number, number] };
    const vertices = [
      [0, 0], [30, 0], [30, 75], [30, 75], [30, 120],
      [0, 120], [0, 110], [0, 110], [0, 10], [0, 10], [0, 0],
    ] as [number, number][];
    const outline = vertices.slice(1).map((end, index) => ({
      ...walls[0]!,
      id: `window-real:${index}`,
      parent_element_id: "boundary:window:3E0207",
      semantic_type: "window",
      boundary_kind: "object" as const,
      start: vertices[index]!,
      end,
      length: distanceForTest(vertices[index]!, end),
    }));
    const adjacentClosedWall = [
      [[0, 10], [-370, 10]],
      [[-370, 10], [-370, 110]],
      [[-370, 110], [0, 110]],
      [[0, 110], [0, 10]],
    ].map(([start, end], index) => ({
      ...walls[0]!,
      id: `closed-wall:${index}`,
      parent_element_id: "boundary:wall:3E01EF",
      semantic_type: "wall",
      boundary_kind: "object" as const,
      start: start as [number, number],
      end: end as [number, number],
    }));
    const start = startOptions([incoming], [5, 50], 1).find((option) => option.id === "start:incoming:forward")!;
    const branch = startBranch(start, 1, 0, [5, 50])!;
    const candidates = nextOptions(branch, [incoming, ...outline, ...adjacentClosedWall], [], {
      junctionTolerance: 15,
      openingReach: 100,
      limit: 12,
      roomSeed: [5, 50],
    });
    const windowTransitions = candidates.filter((option) => option.wall?.parent_element_id === "boundary:window:3E0207");
    expect(windowTransitions.length).toBeGreaterThan(0);
    expect(windowTransitions.every((option) => option.wall?.boundary_kind === "object")).toBe(true);
    expect(windowTransitions.every((option) => !option.wall?.element_id.includes(":segment:"))).toBe(true);
    const traversed = applyOption(branch, windowTransitions[0]!, 1, "window");
    expect(traversed.orderedEdges.filter((edge) => edge.kind === "wall" && edge.parent_element_id === "boundary:window:3E0207")).toHaveLength(1);
    expect(traversed.visitedObjectIds).toEqual(["boundary:window:3E0207"]);
    const afterWindow = nextOptions(traversed, [incoming, ...outline, ...adjacentClosedWall], [], {
      junctionTolerance: 15,
      openingReach: 100,
      limit: 12,
      roomSeed: [5, 50],
    });
    expect(afterWindow.some((option) => option.wall?.parent_element_id === "boundary:window:3E0207")).toBe(false);
  });

  test("validates area and seed containment using the full object transition path", () => {
    const branch = {
      id: "full-path",
      startEntry: [0, 0] as [number, number],
      currentExit: [0, 0] as [number, number],
      orderedEdges: [
        { kind: "wall" as const, element_id: "bottom", direction: "forward" as const, entry: [0, 0] as [number, number], exit: [10, 0] as [number, number], source_entities: [], membership: "accepted" as const, semantic_type: "wall", boundary_kind: "linear" as const, path: [[0, 0], [10, 0]] as [number, number][] },
        { kind: "wall" as const, element_id: "column-transition", direction: "forward" as const, entry: [10, 0] as [number, number], exit: [10, 10] as [number, number], source_entities: [], parent_element_id: "column", membership: "accepted" as const, semantic_type: "column", boundary_kind: "object" as const, path: [[10, 0], [12, 0], [12, 10], [10, 10]] as [number, number][] },
        { kind: "wall" as const, element_id: "top", direction: "forward" as const, entry: [10, 10] as [number, number], exit: [0, 10] as [number, number], source_entities: [], membership: "accepted" as const, semantic_type: "wall", boundary_kind: "linear" as const, path: [[10, 10], [0, 10]] as [number, number][] },
        { kind: "wall" as const, element_id: "left", direction: "forward" as const, entry: [0, 10] as [number, number], exit: [0, 0] as [number, number], source_entities: [], membership: "accepted" as const, semantic_type: "wall", boundary_kind: "linear" as const, path: [[0, 10], [0, 0]] as [number, number][] },
      ],
      visitedElementIds: ["bottom", "column-transition", "top", "left"],
      visitedObjectIds: ["column"],
      cumulativeProbability: 1,
      interiorSide: 1 as const,
      repairParentElementIds: [],
      closed: true,
    };
    const validation = validateTraversal(branch, [5, 5]);
    expect(validation).toEqual(expect.objectContaining({ closed: true, contains_seed: true, area: 120 }));
    expect(validation.points).toContainEqual([12, 0]);
    expect(validation.points).toContainEqual([12, 10]);
  });

  test("uses a column object as one side of a closed room", () => {
    const incoming = { ...walls[0]!, id: "bottom", start: [0, 0] as [number, number], end: [10, 0] as [number, number] };
    const top = { ...walls[2]!, id: "top", start: [10, 10] as [number, number], end: [0, 10] as [number, number] };
    const left = { ...walls[3]!, id: "left", start: [0, 10] as [number, number], end: [0, 0] as [number, number] };
    const column = [
      [[10, 0], [12, 0]],
      [[12, 0], [12, 10]],
      [[12, 10], [10, 10]],
      [[10, 10], [10, 0]],
    ].map(([start, end], index) => ({
      ...walls[0]!, id: `column:${index}`, parent_element_id: "boundary:column:C",
      semantic_type: "column", boundary_kind: "object" as const,
      start: start as [number, number], end: end as [number, number],
    }));
    const elements = [incoming, ...column, top, left];
    const start = startOptions([incoming], [5, 5], 1).find((option) => option.id === "start:bottom:forward")!;
    let branch = startBranch(start, 1, 0, [5, 5])!;
    const columnOption = nextOptions(branch, elements, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8, roomSeed: [5, 5] })
      .find((option) => option.wall?.parent_element_id === "boundary:column:C" && option.wall.member_element_ids?.length === 1)!;
    branch = applyOption(branch, columnOption, 1, "column");
    expect(branch.orderedEdges.filter((edge) => edge.kind === "wall" && edge.semantic_type === "column")).toHaveLength(1);
    for (const id of ["top", "left"]) {
      const option = nextOptions(branch, elements, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8, roomSeed: [5, 5] })
        .find((candidate) => candidate.wall?.element_id === id)!;
      branch = applyOption(branch, option, 1, id);
    }
    const close = nextOptions(branch, elements, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8, roomSeed: [5, 5], minimumRoomArea: 50, maximumRoomArea: 150 })
      .find((option) => option.kind === "close")!;
    branch = applyOption(branch, close, 1, "close");
    expect(validateTraversal(branch, [5, 5])).toEqual(expect.objectContaining({ closed: true, contains_seed: true, area: 100 }));
    expect(branch.visitedObjectIds).toEqual(["boundary:column:C"]);
  });

  test("builds and validates a closed ordered boundary", () => {
    const start = startOptions(walls, [5, 5], 4).find((option) => option.id === "start:w1:forward")!;
    let branch = startBranch(start, 1, 0, [5, 5])!;
    for (const wallId of ["w2", "w3", "w4"]) {
      const option = nextOptions(branch, walls, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8 }).find((candidate) => candidate.wall?.element_id === wallId)!;
      branch = applyOption(branch, option, 1, wallId);
    }
    const close = nextOptions(branch, walls, [], { junctionTolerance: 0.1, openingReach: 2, limit: 8 }).find((option) => option.kind === "close")!;
    branch = applyOption(branch, close, 1, "close");
    expect(validateTraversal(branch, [5, 5])).toEqual(expect.objectContaining({ closed: true, contains_seed: true, area: 100, wall_edge_count: 4 }));
  });
});

function distanceForTest(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
