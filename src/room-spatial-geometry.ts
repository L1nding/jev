import { splitWallElementsAtJunctions, type Point2, type ProvisionalWallElement } from "./wall-elements";
import { distance, distanceToSegment, validateTraversal, type TraversalBranch } from "./room-traversal";
import { faceToTraversalBranch, walkBoundaryFaces } from "./boundary-faces";

export type MeasuredPath = { id: string; points: Point2[]; closed: boolean; source_type: string; layer: string };
export type MeasuredEntity = { source_id: string; paths: MeasuredPath[]; warnings: string[] };
export type SpatialObject = MeasuredEntity & { semantic_type: string; layer: string; distance: number; prior_role?: string; prior_layer_choice?: string };
export type SpatialRole = "boundary" | "opening_boundary" | "obstacle" | "same_space" | "irrelevant" | "uncertain";

export function entityDistance(entity: MeasuredEntity, seed: Point2): number {
  return Math.min(Infinity, ...entity.paths.flatMap((path) => path.points.slice(1).map((p, i) => distanceToSegment(seed, path.points[i]!, p))));
}

export function objectSegments(object: MeasuredEntity, semanticType = "wall"): ProvisionalWallElement[] {
  return object.paths.flatMap((path) => {
    const points = [...path.points];
    if (path.closed && points.length > 2 && distance(points[0]!, points.at(-1)!) > 0.01) points.push(points[0]!);
    return points.slice(1).flatMap((end, index) => {
      const start = points[index]!;
      const length = distance(start, end);
      return length <= 0.01 ? [] : [{
        id: `${path.id}:segment:${index}`, parent_element_id: object.source_id, status: "provisional" as const,
        source_entities: [object.source_id], source_segment_index: index, start, end, length,
        semantic_confidence: null, semantic_model: null, semantic_request_id: null,
        semantic_type: semanticType, boundary_kind: "linear" as const,
      }];
    });
  });
}

export function planarize(elements: ProvisionalWallElement[]): ProvisionalWallElement[] {
  const unique = new Map<string, ProvisionalWallElement>();
  for (const element of splitWallElementsAtJunctions(elements, 0.01, 0.01)) {
    const key = [element.start, element.end].map((p) => p.map((v) => Math.round(v * 1000)).join(",")).sort().join("|");
    const previous = unique.get(key);
    if (previous) previous.source_entities = [...new Set([...previous.source_entities, ...element.source_entities])].sort();
    else unique.set(key, { ...element });
  }
  return [...unique.values()];
}

export function pointInside(points: Point2[], p: Point2): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function intersects(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (p: Point2, q: Point2, r: Point2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
  return [a, b].some((p) => distanceToSegment(p, c, d) < 0.005) || [c, d].some((p) => distanceToSegment(p, a, b) < 0.005);
}

export function validateSpatialBranch(branch: TraversalBranch, seed: Point2): string[] {
  const defects: string[] = [];
  const segments: Array<[Point2, Point2]> = [];
  let previous: Point2 | null = null;
  let first: Point2 | null = null;
  for (const edge of branch.orderedEdges) {
    const path = edge.kind === "wall" ? edge.path ?? [edge.entry, edge.exit] : [edge.from, edge.to];
    if (!path.every((p) => p.every(Number.isFinite))) defects.push("non_finite_geometry");
    if (previous && distance(previous, path[0]!) > 0.01) defects.push("disconnected_segments");
    first ??= path[0]!;
    for (let i = 1; i < path.length; i++) if (distance(path[i - 1]!, path[i]!) > 0.01) segments.push([path[i - 1]!, path[i]!]);
    previous = path.at(-1)!;
  }
  if (!first || !previous || distance(first, previous) > 0.01) defects.push("unclosed_ring");
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const [a, b] = segments[i]!, [c, d] = segments[j]!;
    if (j === i + 1 || (i === 0 && j === segments.length - 1)) {
      if ((distance(a, d) < 0.01 && distance(b, c) < 0.01) || (distance(a, c) < 0.01 && distance(b, d) < 0.01)) defects.push("reused_segment");
    } else if (intersects(a, b, c, d)) defects.push("self_intersection_or_reused_segment");
  }
  const validation = validateTraversal(branch, seed);
  if (!validation.closed || !validation.contains_seed || validation.area <= 0) defects.push("invalid_seed_enclosure");
  return [...new Set(defects)];
}

export function spatialCandidates(elements: ProvisionalWallElement[], obstacles: SpatialObject[], seed: Point2) {
  const graph = planarize(elements);
  const faces = walkBoundaryFaces(graph, seed, 0.01).filter((face) => face.contains_seed);
  return faces.map((face) => {
    const branch = faceToTraversalBranch(face, graph.map((e) => e.parent_element_id ?? e.id));
    const defects = validateSpatialBranch(branch, seed);
    const holes: Array<{ source_id: string; points: Point2[]; area: number }> = [];
    for (const obstacle of obstacles) {
      const obstacleFaces = walkBoundaryFaces(planarize(objectSegments(obstacle)), seed, 0.01);
      if (!obstacleFaces.length && entityDistance(obstacle, seed) < Math.sqrt(face.area) * 2) defects.push(`unresolved_obstacle:${obstacle.source_id}`);
      // A nested drafting outline is not an additional physical hole.
      const outermost = obstacleFaces.filter((f) => !obstacleFaces.some((other) => other !== f && other.area > f.area && f.points.every((p) => pointInside(other.points, p))));
      for (const hole of outermost) {
        const inside = hole.points.map((p) => pointInside(face.points, p));
        const crossing = hole.points.some((p, i) => face.points.some((q, j) => intersects(p, hole.points[(i + 1) % hole.points.length]!, q, face.points[(j + 1) % face.points.length]!)));
        if (crossing || (inside.some(Boolean) && !inside.every(Boolean))) defects.push(`obstacle_touches_boundary:${obstacle.source_id}`);
        else if (inside.every(Boolean)) {
          if (pointInside(hole.points, seed)) defects.push("seed_inside_obstacle");
          holes.push({ source_id: obstacle.source_id, points: hole.points, area: hole.area });
        }
      }
    }
    for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
      const a = holes[i]!, b = holes[j]!;
      if (a.points.some((p) => pointInside(b.points, p)) || b.points.some((p) => pointInside(a.points, p))
        || a.points.some((p, k) => b.points.some((q, l) => intersects(p, a.points[(k + 1) % a.points.length]!, q, b.points[(l + 1) % b.points.length]!)))) defects.push("overlapping_obstacles");
    }
    return { branch, defects: [...new Set(defects)], holes, gross_area: face.area, net_area: face.area - holes.reduce((sum, h) => sum + h.area, 0) };
  });
}

export function gapChoices(elements: ProvisionalWallElement[], seed: Point2, reach: number, limit: number, openings: SpatialObject[] = []) {
  const graph = planarize(elements);
  const endpoints = graph.flatMap((e) => [e.start, e.end]);
  const dangling = endpoints.filter((p) => endpoints.filter((q) => distance(p, q) < 0.01).length === 1);
  const unique = new Map<string, ProvisionalWallElement>();
  for (const from of dangling.sort((a, b) => distance(a, seed) - distance(b, seed))) {
    const projections = graph.map((edge): Point2 => {
      const dx = edge.end[0] - edge.start[0], dy = edge.end[1] - edge.start[1];
      const t = Math.max(0, Math.min(1, ((from[0] - edge.start[0]) * dx + (from[1] - edge.start[1]) * dy) / (dx * dx + dy * dy)));
      return [edge.start[0] + t * dx, edge.start[1] + t * dy];
    });
    const targets = [...new Map([...endpoints, ...projections].map((p) => [p.map((v) => v.toFixed(6)).join(","), p])).values()]
      .filter((to) => distance(from, to) > 0.01 && distance(from, to) <= reach)
      .sort((a, b) => distance(from, a) - distance(from, b)).slice(0, 4);
    for (const to of targets) {
      if (graph.some((edge) => distanceToSegment(from, edge.start, edge.end) > 0.01
        && distanceToSegment(to, edge.start, edge.end) > 0.01 && intersects(from, to, edge.start, edge.end))) continue;
      const key = [from.join(","), to.join(",")].sort().join("|");
      if (unique.has(key)) continue;
      unique.set(key, {
        id: `gap:${key}`, parent_element_id: `gap:${key}`, status: "provisional", source_entities: [], source_segment_index: 0,
        start: from, end: to, length: distance(from, to), semantic_type: "junction-gap", boundary_kind: "linear",
        semantic_confidence: null, semantic_model: null, semantic_request_id: null,
      });
    }
  }
  // Closed wall outlines have no dangling endpoint. Opening portals therefore
  // query nearby boundary vertices independently of graph degree.
  const openingGroups: ProvisionalWallElement[][] = [];
  for (const opening of openings) {
    const near = endpoints.filter((p) => entityDistance(opening, p) <= reach / 2);
    const options = new Map<string, ProvisionalWallElement>();
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      const a = near[i]!, b = near[j]!, length = distance(a, b);
      if (length <= 0.01 || length > reach) continue;
      const middle: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (entityDistance(opening, middle) > reach / 4) continue;
      if (graph.some((edge) => distanceToSegment(middle, edge.start, edge.end) < 0.01)) continue;
      if (graph.some((edge) => distanceToSegment(a, edge.start, edge.end) > 0.01 && distanceToSegment(b, edge.start, edge.end) > 0.01 && intersects(a, b, edge.start, edge.end))) continue;
      const key = [a.join(","), b.join(",")].sort().join("|");
      options.set(key, {
        id: `opening-portal:${opening.source_id}:${key}`, parent_element_id: `opening-portal:${opening.source_id}`,
        status: "provisional", source_entities: [opening.source_id], source_segment_index: 0,
        start: a, end: b, length, semantic_type: `opening-gap:${opening.source_id}`, boundary_kind: "linear",
        semantic_confidence: null, semantic_model: null, semantic_request_id: null,
      });
    }
    openingGroups.push([...options.values()].sort((a, b) => a.length - b.length || a.id.localeCompare(b.id)).slice(0, 4));
  }
  const candidates: ProvisionalWallElement[] = [];
  // Round-robin retrieval retains alternatives across openings instead of one large block monopolising the list.
  for (let rank = 0; rank < 4; rank++) for (const group of openingGroups) if (group[rank]) candidates.push(group[rank]!);
  const openingLimit = Math.floor(limit / 2);
  const selected = [...candidates.slice(0, openingLimit), ...[...unique.values()].slice(0, limit - Math.min(openingLimit, candidates.length))];
  return { dangling, candidates: selected, truncated: unique.size + candidates.length > selected.length };
}
