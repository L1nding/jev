import type { BoundaryKind, Point2, ProvisionalWallElement } from "./wall-elements";

export type OpeningElement = {
  id: string;
  source_entity_id: string;
  semantic_type: "door" | "window" | "opening";
  anchor: Point2;
  path?: Point2[];
  boundary_kind: "opening";
};

export type TraversalWallEdge = {
  kind: "wall";
  element_id: string;
  direction: "forward" | "reverse";
  entry: Point2;
  exit: Point2;
  source_entities: string[];
  parent_element_id?: string;
  membership: "accepted" | "repair";
  semantic_type: string;
  boundary_kind: BoundaryKind;
  path?: Point2[];
  member_element_ids?: string[];
  semantic_confidence?: number | null;
};

export type TraversalVirtualEdge = {
  kind: "junction" | "opening";
  from: Point2;
  to: Point2;
  opening_element_id?: string;
};

export type TraversalEdge = TraversalWallEdge | TraversalVirtualEdge;

export type TraversalBranch = {
  id: string;
  startEntry: Point2;
  currentExit: Point2;
  orderedEdges: TraversalEdge[];
  visitedElementIds: string[];
  visitedObjectIds: string[];
  cumulativeProbability: number;
  interiorSide: -1 | 0 | 1;
  repairParentElementIds: string[];
  closed: boolean;
  termination?: string;
};

export type TraversalOption = {
  id: string;
  kind: "wall" | "opening" | "close" | "uncertain";
  description: string;
  wall?: TraversalWallEdge;
  virtual?: TraversalVirtualEdge;
  distance: number;
  parent_element_id?: string;
  same_parent?: boolean;
  side_consistent?: boolean;
  turn_degrees?: number | null;
  repair_parent_element_id?: string;
  exit_connection_parent_ids?: string[];
};

export type RankedTraversalOption = {
  option: TraversalOption;
  score: number;
  reasons: string[];
};

export type RejectedTraversalOption = {
  option: TraversalOption;
  reasons: string[];
};

export type BoundaryPortal = {
  id: string;
  parent_element_id: string;
  point: Point2;
  connections: Array<{
    element_id: string;
    parent_element_id: string;
    distance: number;
  }>;
};

export function filterWallElementsByRole(
  elements: ProvisionalWallElement[],
  roles: Record<string, unknown>,
  role: string,
): ProvisionalWallElement[] {
  const acceptedSourceIds = new Set(
    Object.entries(roles)
      .filter(([, assignedRole]) => assignedRole === role)
      .map(([sourceId]) => sourceId),
  );
  if (acceptedSourceIds.size === 0) return elements;
  const filtered = elements.filter((element) => element.source_entities.some((sourceId) => acceptedSourceIds.has(sourceId)));
  return filtered.length >= 3 ? filtered : elements;
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function distanceToSegment(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator));
  return distance(point, [start[0] + t * dx, start[1] + t * dy]);
}

function wallEdge(element: ProvisionalWallElement, direction: "forward" | "reverse", membership: "accepted" | "repair" = "accepted"): TraversalWallEdge {
  const entry = direction === "forward" ? element.start : element.end;
  const exit = direction === "forward" ? element.end : element.start;
  return {
    kind: "wall",
    element_id: element.id,
    direction,
    entry,
    exit,
    source_entities: element.source_entities,
    parent_element_id: element.parent_element_id ?? element.id,
    membership,
    semantic_type: element.semantic_type ?? "wall",
    boundary_kind: element.boundary_kind ?? "linear",
    path: [entry, exit],
    member_element_ids: [element.id],
    semantic_confidence: element.semantic_confidence,
  };
}

function pointKey(point: Point2, tolerance = 0.1): string {
  return `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
}

function edgePoints(edge: TraversalWallEdge): Point2[] {
  return edge.path && edge.path.length >= 2 ? edge.path : [edge.entry, edge.exit];
}

export function buildBoundaryObjectPortals(
  objectElements: ProvisionalWallElement[],
  otherElements: ProvisionalWallElement[],
  tolerance = 50,
): BoundaryPortal[] {
  const parentId = objectElements[0]?.parent_element_id ?? objectElements[0]?.id;
  if (!parentId || objectElements.some((element) => (element.parent_element_id ?? element.id) !== parentId)) return [];
  const points = new Map<string, Point2>();
  for (const element of objectElements) {
    if (element.boundary_kind !== "object") continue;
    points.set(pointKey(element.start), element.start);
    points.set(pointKey(element.end), element.end);
  }
  const portals: BoundaryPortal[] = [];
  for (const [key, candidate] of points) {
    const connections = otherElements
      .filter((element) => (element.parent_element_id ?? element.id) !== parentId)
      .map((element) => ({
        element_id: element.id,
        parent_element_id: element.parent_element_id ?? element.id,
        distance: distanceToSegment(candidate, element.start, element.end),
      }))
      .filter((connection) => connection.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance);
    if (connections.length === 0) continue;
    portals.push({
      id: `${parentId}:portal:${key}`,
      parent_element_id: parentId,
      point: candidate,
      connections,
    });
  }
  return portals.sort((a, b) => a.id.localeCompare(b.id));
}

function outlineTraversalOptions(
  branch: TraversalBranch,
  elements: ProvisionalWallElement[],
  options: Parameters<typeof nextOptions>[3],
): TraversalOption[] {
  const groups = new Map<string, ProvisionalWallElement[]>();
  for (const element of elements) {
    if (element.boundary_kind !== "object") continue;
    const parentId = element.parent_element_id ?? element.id;
    const group = groups.get(parentId) ?? [];
    group.push(element);
    groups.set(parentId, group);
  }
  const visitedOutlineParents = new Set(branch.visitedObjectIds ?? []);
  const result: TraversalOption[] = [];
  for (const [parentId, group] of groups) {
    if (visitedOutlineParents.has(parentId)) continue;
    const nodes = new Map<string, Point2>();
    const adjacency = new Map<string, Array<{ to: string; element: ProvisionalWallElement }>>();
    const add = (from: Point2, to: Point2, element: ProvisionalWallElement) => {
      const fromKey = pointKey(from);
      const toKey = pointKey(to);
      nodes.set(fromKey, from);
      nodes.set(toKey, to);
      const neighbors = adjacency.get(fromKey) ?? [];
      neighbors.push({ to: toKey, element });
      adjacency.set(fromKey, neighbors);
    };
    for (const element of group) {
      if (distance(element.start, element.end) <= 0.01) continue;
      add(element.start, element.end, element);
      add(element.end, element.start, element);
    }
    const portalTolerance = Math.min(options.junctionTolerance, 50);
    const portals = buildBoundaryObjectPortals(group, elements, portalTolerance);
    const portalByKey = new Map(portals.map((portal) => [pointKey(portal.point), portal]));
    const entryKeys = portals
      .map((portal) => ({ key: pointKey(portal.point), gap: distance(branch.currentExit, portal.point) }))
      .filter(({ gap }) => gap <= options.junctionTolerance)
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 3);
    if (entryKeys.length === 0) continue;
    const portalExitGaps = new Map<string, number>();
    for (const [key, portal] of portalByKey) {
      const exitGap = Math.min(
        ...portal.connections
          .filter((connection) => !branch.visitedElementIds.includes(connection.element_id))
          .map((connection) => connection.distance),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(exitGap)) portalExitGaps.set(key, exitGap);
    }
    const portalKeys = new Set(portalExitGaps.keys());
    if (portalKeys.size === 0) continue;
    const seenTransitions = new Set<string>();
    for (const entry of entryKeys) {
      const stack: Array<{ key: string; points: Point2[]; elementIds: string[]; used: Set<string> }> = [{
        key: entry.key,
        points: [nodes.get(entry.key)!],
        elementIds: [],
        used: new Set(),
      }];
      while (stack.length > 0) {
        const state = stack.pop()!;
        if (state.elementIds.length > group.length) continue;
        if (state.key !== entry.key && portalKeys.has(state.key)) {
          const transitionKey = `${entry.key}->${state.key}:${state.elementIds.join(",")}`;
          if (!seenTransitions.has(transitionKey)) {
            seenTransitions.add(transitionKey);
            const entryPoint = state.points[0]!;
            const exitPoint = state.points.at(-1)!;
            const memberElements = state.elementIds.map((id) => group.find((element) => element.id === id)!).filter(Boolean);
            const semanticType = memberElements[0]?.semantic_type ?? group[0]?.semantic_type ?? "wall";
            const sourceEntities = [...new Set(memberElements.flatMap((element) => element.source_entities))];
            const wall: TraversalWallEdge = {
              kind: "wall",
              element_id: `${parentId}:transition:${entry.key}:${state.key}`,
              direction: "forward",
              entry: entryPoint,
              exit: exitPoint,
              source_entities: sourceEntities,
              parent_element_id: parentId,
              membership: "accepted",
              semantic_type: semanticType,
              boundary_kind: "object",
              path: state.points,
              member_element_ids: state.elementIds,
              semantic_confidence: memberElements.length > 0
                ? memberElements.reduce((sum, element) => sum + Number(element.semantic_confidence ?? 0), 0) / memberElements.length
                : null,
            };
            const previousWall = [...branch.orderedEdges].reverse().find((edge): edge is TraversalWallEdge => edge.kind === "wall");
            const candidateSide = options.roomSeed ? sideOfPath(state.points, options.roomSeed) : 0;
            const sideConsistent = branch.interiorSide === 0 || candidateSide === 0 || candidateSide === branch.interiorSide;
            const exitGap = portalExitGaps.get(state.key) ?? 0;
            const pathLength = state.points.slice(1).reduce((sum, point, index) => sum + distance(state.points[index]!, point), 0);
            result.push({
              id: `outline:${parentId}:${entry.key}:${state.key}`,
              kind: "wall",
              description: `通过原子边界对象 ${parentId}，类型 ${semanticType}；内部 ${state.elementIds.length} 条绘图边合并为一次 transition；对象路径 ${(pathLength / 1000).toFixed(2)}m；入口/出口接缝 ${(entry.gap / 1000).toFixed(2)}m + ${(exitGap / 1000).toFixed(2)}m；Room Seed 侧向一致=${sideConsistent}`,
              wall,
              virtual: entry.gap > 0.01 ? { kind: "junction", from: branch.currentExit, to: entryPoint } : undefined,
              distance: entry.gap + exitGap,
              parent_element_id: parentId,
              same_parent: previousWall?.parent_element_id === parentId,
              side_consistent: sideConsistent,
              turn_degrees: signedTurn(previousWall, wall),
              exit_connection_parent_ids: [...new Set(
                (portalByKey.get(state.key)?.connections ?? [])
                  .filter((connection) => !branch.visitedElementIds.includes(connection.element_id))
                  .map((connection) => connection.parent_element_id),
              )],
            });
          }
          continue;
        }
        for (const neighbor of adjacency.get(state.key) ?? []) {
          if (state.used.has(neighbor.element.id)) continue;
          const used = new Set(state.used);
          used.add(neighbor.element.id);
          stack.push({
            key: neighbor.to,
            points: [...state.points, nodes.get(neighbor.to)!],
            elementIds: [...state.elementIds, neighbor.element.id],
            used,
          });
        }
      }
    }
  }
  return result;
}

function pathSegments(branch: TraversalBranch): Array<[Point2, Point2]> {
  const result: Array<[Point2, Point2]> = [];
  for (const edge of branch.orderedEdges) {
    const points = edge.kind === "wall" ? edgePoints(edge) : [edge.from, edge.to];
    for (let index = 1; index < points.length; index += 1) result.push([points[index - 1]!, points[index]!]);
  }
  return result;
}

function orientation(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function samePoint(a: Point2, b: Point2, tolerance = 0.01): boolean {
  return distance(a, b) <= tolerance;
}

function properlyIntersects(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return false;
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function optionWouldSelfIntersect(branch: TraversalBranch, option: TraversalOption): boolean {
  if (!option.wall) return false;
  const existing = pathSegments(branch);
  const candidatePoints = [
    ...(option.virtual ? [option.virtual.from, option.virtual.to] : []),
    ...edgePoints(option.wall),
  ];
  for (let index = 1; index < candidatePoints.length; index += 1) {
    const from = candidatePoints[index - 1]!;
    const to = candidatePoints[index]!;
    if (samePoint(from, to)) continue;
    if (existing.some(([a, b]) => properlyIntersects(a, b, from, to))) return true;
  }
  return false;
}

export function rankTraversalOptions(
  branch: TraversalBranch,
  candidates: TraversalOption[],
  policy: {
    acceptedParentIds?: Iterable<string>;
    roomSeed?: Point2;
    targetArea?: number | null;
    maximumRoomArea?: number;
  } = {},
): { accepted: RankedTraversalOption[]; rejected: RejectedTraversalOption[] } {
  const acceptedParents = new Set(policy.acceptedParentIds ?? []);
  const accepted: RankedTraversalOption[] = [];
  const rejected: RejectedTraversalOption[] = [];
  for (const option of candidates) {
    const rejectionReasons: string[] = [];
    if (option.kind === "uncertain") {
      accepted.push({ option, score: -100, reasons: ["uncertain-fallback"] });
      continue;
    }
    if (option.side_consistent === false) rejectionReasons.push("seed-side-inconsistent");
    if (option.same_parent === false && Math.abs(Number(option.turn_degrees ?? 0)) >= 160) rejectionReasons.push("cross-parent-u-turn");
    if (optionWouldSelfIntersect(branch, option)) rejectionReasons.push("path-self-intersection");
    if (rejectionReasons.length > 0) {
      rejected.push({ option, reasons: rejectionReasons });
      continue;
    }
    let score = 50;
    const reasons: string[] = [];
    if (option.kind === "close") {
      score += 100;
      reasons.push("valid-close-cycle");
    }
    if (option.side_consistent === true) {
      score += 30;
      reasons.push("seed-side-consistent");
    }
    const turn = Math.abs(Number(option.turn_degrees ?? 0));
    if (turn >= 45 && turn <= 135) {
      score += 20;
      reasons.push("reasonable-turn");
    } else if (turn < 25) {
      score += 10;
      reasons.push("continuous-direction");
    } else if (turn > 135) {
      score -= 15;
      reasons.push("sharp-reversal");
    }
    const parentId = option.wall?.parent_element_id ?? option.parent_element_id;
    if (parentId && acceptedParents.has(parentId)) {
      score += 15;
      reasons.push("accepted-boundary-parent");
    }
    const acceptedExit = (option.exit_connection_parent_ids ?? []).some((id) => acceptedParents.has(id));
    if (acceptedExit) {
      score += 15;
      reasons.push("exit-connects-to-accepted-boundary");
    } else if ((option.exit_connection_parent_ids?.length ?? 0) > 0) {
      score += 5;
      reasons.push("exit-connects-to-boundary");
    }
    if (option.wall?.membership === "repair") {
      score -= 8;
      reasons.push("repair-boundary-parent");
    }
    const confidence = option.wall?.semantic_confidence;
    if (confidence !== null && confidence !== undefined) {
      score += Math.max(0, Math.min(10, confidence * 10));
      reasons.push("semantic-confidence");
    }
    score -= Math.min(20, option.distance / 50);
    reasons.push("junction-distance");
    if (policy.roomSeed && policy.maximumRoomArea && option.wall) {
      const partialArea = validateTraversal(applyOption(branch, option, 1, "rank"), policy.roomSeed).area;
      if (partialArea > policy.maximumRoomArea) {
        score -= 30;
        reasons.push("partial-area-above-maximum");
      } else if (policy.targetArea && partialArea <= policy.targetArea) {
        score += 2;
        reasons.push("partial-area-within-target");
      }
    }
    accepted.push({ option, score, reasons });
  }
  accepted.sort((a, b) => b.score - a.score || a.option.distance - b.option.distance);
  return { accepted, rejected };
}

export function hasDeterministicLead(ranked: RankedTraversalOption[], margin = 20): boolean {
  const actionable = ranked.filter((item) => item.option.kind !== "uncertain");
  if (actionable.length === 0) return false;
  if (actionable.length === 1) return actionable[0]!.score >= 60;
  return actionable[0]!.score >= 60 && actionable[0]!.score - actionable[1]!.score >= margin;
}

export function boundaryRepairOptions(
  branch: TraversalBranch,
  acceptedElements: ProvisionalWallElement[],
  allElements: ProvisionalWallElement[],
  openings: OpeningElement[],
  options: Parameters<typeof nextOptions>[3],
): TraversalOption[] {
  const allowedParentIds = new Set([
    ...acceptedElements.map((element) => element.parent_element_id ?? element.id),
    ...branch.repairParentElementIds,
  ]);
  const rawCandidates: TraversalOption[] = nextOptions(branch, allElements, openings, {
    ...options,
    limit: Math.max(options.limit * 8, 64),
  })
    .filter((option) => option.wall && !allowedParentIds.has(option.wall.parent_element_id ?? option.wall.element_id))
    .map((option) => {
      const parentId = option.wall!.parent_element_id ?? option.wall!.element_id;
      return {
        ...option,
        id: `repair:${option.id}`,
        description: `边界成员修复：批准此前未接受的父墙 ${parentId} 后，${option.description}`,
        wall: { ...option.wall!, membership: "repair" as const },
        repair_parent_element_id: parentId,
      };
    });
  const candidates: TraversalOption[] = [];
  const perParent = new Map<string, number>();
  for (const candidate of rawCandidates) {
    const parentId = candidate.wall?.parent_element_id ?? candidate.wall?.element_id ?? candidate.id;
    const count = perParent.get(parentId) ?? 0;
    if (count >= 2) continue;
    candidates.push(candidate);
    perParent.set(parentId, count + 1);
    if (candidates.length >= options.limit) break;
  }
  candidates.push({
    id: "uncertain",
    kind: "uncertain",
    description: "附近未接受墙元素仍不足以证明缺失的房间边界。",
    distance: Number.POSITIVE_INFINITY,
  });
  return candidates;
}

function sideOfLine(start: Point2, end: Point2, point: Point2): -1 | 0 | 1 {
  const cross = (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
  return cross > 1e-6 ? 1 : cross < -1e-6 ? -1 : 0;
}

function signedTurn(previous: TraversalWallEdge | undefined, next: TraversalWallEdge): number | null {
  if (!previous) return null;
  const previousPoints = edgePoints(previous);
  const nextPoints = edgePoints(next);
  const previousFrom = previousPoints.at(-2) ?? previous.entry;
  const previousTo = previousPoints.at(-1) ?? previous.exit;
  const nextFrom = nextPoints[0] ?? next.entry;
  const nextTo = nextPoints[1] ?? next.exit;
  const ax = previousTo[0] - previousFrom[0];
  const ay = previousTo[1] - previousFrom[1];
  const bx = nextTo[0] - nextFrom[0];
  const by = nextTo[1] - nextFrom[1];
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180 / Math.PI;
}

function sideOfPath(path: Point2[], point: Point2): -1 | 0 | 1 {
  let side: -1 | 0 | 1 = 0;
  for (let index = 1; index < path.length; index += 1) {
    const candidate = sideOfLine(path[index - 1]!, path[index]!, point);
    if (candidate === 0) continue;
    if (side !== 0 && side !== candidate) return 0;
    side = candidate;
  }
  return side;
}

export function startOptions(elements: ProvisionalWallElement[], seed: Point2, limit = 8): TraversalOption[] {
  return elements
    .map((element) => ({ element, distance: distanceToSegment(seed, element.start, element.end) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .flatMap(({ element, distance: wallDistance }) => (["forward", "reverse"] as const).map((direction) => {
      const wall = wallEdge(element, direction);
      return {
        id: `start:${element.id}:${direction}`,
        kind: "wall" as const,
        description: `从 ${element.id} 的 ${direction} 方向开始；父墙 ${wall.parent_element_id}；墙段距 Room Seed ${(wallDistance/1000).toFixed(2)}m；Room Seed 位于有向边的 ${sideOfLine(wall.entry, wall.exit, seed) > 0 ? "左侧" : "右侧"}；相对入口 [${((wall.entry[0]-seed[0])/1000).toFixed(2)},${((wall.entry[1]-seed[1])/1000).toFixed(2)}]m，相对出口 [${((wall.exit[0]-seed[0])/1000).toFixed(2)},${((wall.exit[1]-seed[1])/1000).toFixed(2)}]m`,
        wall,
        distance: wallDistance,
      };
    }));
}

export function nextOptions(
  branch: TraversalBranch,
  elements: ProvisionalWallElement[],
  openings: OpeningElement[],
  options: { junctionTolerance: number; openingReach: number; limit: number; roomSeed?: Point2; minimumRoomArea?: number; maximumRoomArea?: number },
): TraversalOption[] {
  const result: TraversalOption[] = [];
  if (branch.visitedElementIds.length >= 3 && distance(branch.currentExit, branch.startEntry) <= options.junctionTolerance) {
    const closeOption: TraversalOption = {
      id: "close_cycle",
      kind: "close",
      description: `闭合到起点，端点距离 ${distance(branch.currentExit, branch.startEntry).toFixed(1)}`,
      distance: distance(branch.currentExit, branch.startEntry),
    };
    const probe = applyOption(branch, closeOption, 1, "probe");
    const validation = validateTraversal(probe, options.roomSeed ?? branch.startEntry);
    const areaAllowed = validation.area >= (options.minimumRoomArea ?? 0)
      && validation.area <= (options.maximumRoomArea ?? Number.POSITIVE_INFINITY);
    if ((!options.roomSeed || validation.contains_seed) && areaAllowed) {
      closeOption.description += `；闭合面积 ${validation.area.toFixed(1)}；包含 Room Seed=${validation.contains_seed}`;
      result.push(closeOption);
    }
  }

  for (const element of elements) {
    if (element.boundary_kind === "object") continue;
    if (branch.visitedElementIds.includes(element.id)) continue;
    for (const direction of ["forward", "reverse"] as const) {
      const wall = wallEdge(element, direction);
      const gap = distance(branch.currentExit, wall.entry);
      if (gap > options.junctionTolerance) continue;
      const previousWall = [...branch.orderedEdges].reverse().find((edge): edge is TraversalWallEdge => edge.kind === "wall");
      const candidateSide = options.roomSeed ? sideOfLine(wall.entry, wall.exit, options.roomSeed) : 0;
      const sideConsistent = branch.interiorSide === 0 || candidateSide === 0 || candidateSide === branch.interiorSide;
      const turn = signedTurn(previousWall, wall);
      const sameParent = previousWall?.parent_element_id === wall.parent_element_id;
      if (!sameParent && turn !== null && Math.abs(turn) >= 160) continue;
      const relativeExit = options.roomSeed ? [
        (wall.exit[0] - options.roomSeed[0]) / 1000,
        (wall.exit[1] - options.roomSeed[1]) / 1000,
      ] : null;
      const exitDistance = options.roomSeed ? distance(wall.exit, options.roomSeed) / 1000 : null;
      result.push({
        id: `wall:${element.id}:${direction}`,
        kind: "wall",
        description: `连接边界段 ${element.id} (${direction})，类型 ${wall.semantic_type}，父元素 ${wall.parent_element_id}；接缝 ${(gap/1000).toFixed(2)}m；转角 ${turn === null ? "未知" : `${turn.toFixed(1)}°`}；与上一段同父元素=${sameParent}；Room Seed 侧向一致=${sideConsistent}；新出口相对 Room Seed ${relativeExit ? `[${relativeExit[0]!.toFixed(2)},${relativeExit[1]!.toFixed(2)}]m` : "未知"}，距 Room Seed ${exitDistance === null ? "未知" : `${exitDistance.toFixed(2)}m`}`,
        wall,
        virtual: gap > 0.01 ? { kind: "junction", from: branch.currentExit, to: wall.entry } : undefined,
        distance: gap,
        parent_element_id: wall.parent_element_id,
        same_parent: sameParent,
        side_consistent: sideConsistent,
        turn_degrees: turn,
      });
    }
  }

  result.push(...outlineTraversalOptions(branch, elements, options));

  for (const opening of openings) {
    if (distance(branch.currentExit, opening.anchor) > options.openingReach) continue;
    for (const element of elements) {
      if (branch.visitedElementIds.includes(element.id)) continue;
      for (const direction of ["forward", "reverse"] as const) {
        const wall = wallEdge(element, direction);
        const exitToOpening = distance(branch.currentExit, opening.anchor);
        const openingToEntry = distance(opening.anchor, wall.entry);
        if (openingToEntry > options.openingReach) continue;
        result.push({
          id: `opening:${opening.id}:${element.id}:${direction}`,
          kind: "opening",
          description: `经 ${opening.semantic_type} ${opening.id} 虚拟跨越到墙 ${element.id} (${direction})；两段距离 ${exitToOpening.toFixed(1)} + ${openingToEntry.toFixed(1)}`,
          wall,
          virtual: { kind: "opening", from: branch.currentExit, to: wall.entry, opening_element_id: opening.id },
          distance: exitToOpening + openingToEntry,
          parent_element_id: wall.parent_element_id,
          same_parent: false,
          side_consistent: options.roomSeed ? sideOfLine(wall.entry, wall.exit, options.roomSeed) === branch.interiorSide : undefined,
          turn_degrees: signedTurn([...branch.orderedEdges].reverse().find((edge): edge is TraversalWallEdge => edge.kind === "wall"), wall),
        });
      }
    }
  }

  const ranked = result
    .sort((a, b) => {
      if (a.kind === "close" && b.kind !== "close") return -1;
      if (b.kind === "close" && a.kind !== "close") return 1;
      return a.distance - b.distance;
    })
    .slice(0, options.limit);
  ranked.push({ id: "uncertain", kind: "uncertain", description: "现有可达选项不足以可靠继续边界。", distance: Number.POSITIVE_INFINITY });
  return ranked;
}

export function startBranch(option: TraversalOption, probability: number, index: number, roomSeed?: Point2): TraversalBranch | null {
  if (!option.wall) return null;
  return {
    id: `branch-${index}`,
    startEntry: option.wall.entry,
    currentExit: option.wall.exit,
    orderedEdges: [option.wall],
    visitedElementIds: [...(option.wall.member_element_ids ?? [option.wall.element_id])],
    visitedObjectIds: option.wall.boundary_kind === "object"
      ? [option.wall.parent_element_id ?? option.wall.element_id]
      : [],
    cumulativeProbability: probability,
    interiorSide: roomSeed ? sideOfLine(option.wall.entry, option.wall.exit, roomSeed) : 0,
    repairParentElementIds: [],
    closed: false,
  };
}

export function applyOption(branch: TraversalBranch, option: TraversalOption, probability: number, suffix: string): TraversalBranch {
  const next: TraversalBranch = {
    ...branch,
    id: `${branch.id}.${suffix}`,
    orderedEdges: [...branch.orderedEdges],
    visitedElementIds: [...branch.visitedElementIds],
    visitedObjectIds: [...(branch.visitedObjectIds ?? [])],
    repairParentElementIds: [...branch.repairParentElementIds],
    cumulativeProbability: branch.cumulativeProbability * probability,
  };
  if (option.kind === "close") {
    const gap = distance(next.currentExit, next.startEntry);
    if (gap > 0.01) next.orderedEdges.push({ kind: "junction", from: next.currentExit, to: next.startEntry });
    next.currentExit = next.startEntry;
    next.closed = true;
    next.termination = "close_cycle";
    return next;
  }
  if (option.kind === "uncertain" || !option.wall) {
    next.termination = option.kind;
    return next;
  }
  if (option.virtual) next.orderedEdges.push(option.virtual);
  next.orderedEdges.push(option.wall);
  for (const elementId of option.wall.member_element_ids ?? [option.wall.element_id]) {
    if (!next.visitedElementIds.includes(elementId)) next.visitedElementIds.push(elementId);
  }
  if (option.wall.boundary_kind === "object") {
    const objectId = option.wall.parent_element_id ?? option.wall.element_id;
    if (!next.visitedObjectIds.includes(objectId)) next.visitedObjectIds.push(objectId);
  }
  if (option.repair_parent_element_id && !next.repairParentElementIds.includes(option.repair_parent_element_id)) {
    next.repairParentElementIds.push(option.repair_parent_element_id);
  }
  next.currentExit = option.wall.exit;
  return next;
}

function polygonPoints(branch: TraversalBranch): Point2[] {
  const points: Point2[] = [];
  for (const edge of branch.orderedEdges) {
    if (points.length === 0) points.push(edge.kind === "wall" ? edge.entry : edge.from);
    if (edge.kind === "wall") points.push(...edgePoints(edge).slice(1));
    else points.push(edge.to);
  }
  return points;
}

function signedArea(points: Point2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    if (!next) continue;
    area += points[index]![0] * next[1] - next[0] * points[index]![1];
  }
  return area / 2;
}

function contains(points: Point2[], target: Point2): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    const intersects = (a[1] > target[1]) !== (b[1] > target[1])
      && target[0] < ((b[0] - a[0]) * (target[1] - a[1])) / ((b[1] - a[1]) || Number.EPSILON) + a[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

export function validateTraversal(branch: TraversalBranch, seed: Point2) {
  const points = polygonPoints(branch);
  const area = Math.abs(signedArea(points));
  return {
    closed: branch.closed && distance(points[0] ?? seed, points.at(-1) ?? seed) <= 0.01,
    contains_seed: branch.closed && points.length >= 4 && contains(points, seed),
    area,
    point_count: points.length,
    wall_edge_count: branch.orderedEdges.filter((edge) => edge.kind === "wall").length,
    virtual_edge_count: branch.orderedEdges.filter((edge) => edge.kind !== "wall").length,
    points,
  };
}
