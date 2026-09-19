import type { Point2, ProvisionalWallElement } from "./wall-elements";
import { splitWallElementsAtJunctions } from "./wall-elements";
import type { TraversalBranch, TraversalEdge, TraversalWallEdge } from "./room-traversal";

type GraphNode = { id: number; point: Point2; outgoing: number[] };
type GraphEdge = { id: string; element: ProvisionalWallElement; a: number; b: number };
type HalfEdge = { id: number; edge: number; from: number; to: number; twin: number; angle: number };

export type BoundaryFace = {
  id: string;
  points: Point2[];
  element_ids: string[];
  parent_element_ids: string[];
  area: number;
  contains_seed: boolean;
  half_edges: Array<{ element: ProvisionalWallElement; reverse: boolean }>;
};

export type BoundaryOpening = {
  id: string;
  anchor: Point2;
  path?: Point2[];
};

export type RoomFaceWalkResult = {
  faces: BoundaryFace[];
  virtual_edges: ProvisionalWallElement[];
};

type Endpoint = {
  point: Point2;
  element: ProvisionalWallElement;
  other: Point2;
};

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function distanceToSegment(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator));
  return distance(point, [start[0] + t * dx, start[1] + t * dy]);
}

function unit(from: Point2, to: Point2): Point2 {
  const length = distance(from, to) || 1;
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

function continuationAlignment(endpoint: Endpoint, target: Point2): number {
  const existing = unit(endpoint.point, endpoint.other);
  const gap = unit(endpoint.point, target);
  return -(existing[0] * gap[0] + existing[1] * gap[1]);
}

function properIntersection(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (p: Point2, q: Point2, r: Point2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < -1e-6 && cdA * cdB < -1e-6;
}

function deduplicateSegments(elements: ProvisionalWallElement[], precision = 1): ProvisionalWallElement[] {
  const keyFor = (point: Point2) => `${Math.round(point[0] / precision)},${Math.round(point[1] / precision)}`;
  const unique = new Map<string, ProvisionalWallElement>();
  for (const element of elements) {
    const start = keyFor(element.start);
    const end = keyFor(element.end);
    const key = start < end ? `${start}|${end}` : `${end}|${start}`;
    const previous = unique.get(key);
    if (!previous || (previous.boundary_kind === "object" && element.boundary_kind !== "object")) unique.set(key, element);
  }
  return [...unique.values()];
}

function openingForGap(a: Point2, b: Point2, openings: BoundaryOpening[], tolerance: number): { id: string; distance: number } | null {
  const matches = openings.map((opening) => ({
    id: opening.id,
    distance: Math.min(
      distanceToSegment(opening.anchor, a, b),
      ...(opening.path ?? []).map((point) => distanceToSegment(point, a, b)),
    ),
  })).filter((match) => match.distance <= tolerance).sort((left, right) => left.distance - right.distance);
  return matches[0] ?? null;
}

function constrainedGapEdges(
  elements: ProvisionalWallElement[],
  openings: BoundaryOpening[],
  seed: Point2,
  snapTolerance: number,
  maximumGap: number,
): ProvisionalWallElement[] {
  const endpoints: Endpoint[] = elements.flatMap((element) => [
    { point: element.start, other: element.end, element },
    { point: element.end, other: element.start, element },
  ]);
  const parent = endpoints.map((_, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const join = (a: number, b: number) => {
    const aRoot = root(a);
    const bRoot = root(b);
    if (aRoot !== bRoot) parent[bRoot] = aRoot;
  };
  for (let index = 0; index < elements.length; index += 1) join(index * 2, index * 2 + 1);
  for (let aIndex = 0; aIndex < endpoints.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < endpoints.length; bIndex += 1) {
      if (distance(endpoints[aIndex]!.point, endpoints[bIndex]!.point) <= snapTolerance) join(aIndex, bIndex);
    }
  }
  const candidates: Array<{ edge: ProvisionalWallElement; score: number; openingId: string | null }> = [];
  for (let aIndex = 0; aIndex < endpoints.length; aIndex += 1) {
    const a = endpoints[aIndex]!;
    if (distance(a.point, seed) > 5000) continue;
    for (let bIndex = aIndex + 1; bIndex < endpoints.length; bIndex += 1) {
      const b = endpoints[bIndex]!;
      if (a.element.id === b.element.id) continue;
      if (a.element.boundary_kind === "object" && b.element.boundary_kind === "object") continue;
      const gapLength = distance(a.point, b.point);
      if (gapLength <= snapTolerance || gapLength > maximumGap) continue;
      const aAlignment = continuationAlignment(a, b.point);
      const bAlignment = continuationAlignment(b, a.point);
      const opening = openingForGap(a.point, b.point, openings, 300);
      const aligned = aAlignment >= 0.94 && bAlignment >= 0.94;
      const shortCorner = gapLength <= 600
        && ((aAlignment >= 0.94 && Math.abs(bAlignment) <= 0.15)
          || (bAlignment >= 0.94 && Math.abs(aAlignment) <= 0.15));
      if (opening && (a.element.boundary_kind === "object" || b.element.boundary_kind === "object")) continue;
      if (!aligned && !shortCorner) continue;
      if (!opening && gapLength > 600) continue;
      if (!shortCorner && elements.some((element) => properIntersection(a.point, b.point, element.start, element.end))) continue;
      const id = `virtual-gap:${a.element.id}:${b.element.id}`;
      candidates.push({
        score: gapLength + (opening ? opening.distance * 2 : 250) - (aAlignment + bAlignment) * 50,
        openingId: opening?.id ?? null,
        edge: {
          id,
          parent_element_id: id,
          status: "provisional",
          source_entities: [],
          source_segment_index: 0,
          start: a.point,
          end: b.point,
          length: gapLength,
          semantic_confidence: 1,
          semantic_model: null,
          semantic_request_id: null,
          semantic_type: opening ? `opening-gap:${opening.id}` : "junction-gap",
          boundary_kind: "linear",
        },
      });
    }
  }
  const unique = new Map<string, { edge: ProvisionalWallElement; score: number; openingId: string | null }>();
  for (const candidate of candidates.sort((a, b) => a.score - b.score)) {
    const a = candidate.edge.start;
    const b = candidate.edge.end;
    const key = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])
      ? `${a.join(",")}|${b.join(",")}`
      : `${b.join(",")}|${a.join(",")}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const shortCandidates = [...unique.values()].filter((candidate) => candidate.openingId === null);
  const trustedShort = shortCandidates.filter((candidate) => candidate.edge.length <= 250).slice(0, 40);
  const speculativeBuckets = new Map<number, Array<{ edge: ProvisionalWallElement; score: number; openingId: string | null }>>();
  for (const candidate of shortCandidates.filter((item) => item.edge.length > 250)) {
    const midpoint: Point2 = [
      (candidate.edge.start[0] + candidate.edge.end[0]) / 2,
      (candidate.edge.start[1] + candidate.edge.end[1]) / 2,
    ];
    const angle = Math.atan2(midpoint[1] - seed[1], midpoint[0] - seed[0]);
    const bucket = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 16) % 16;
    const list = speculativeBuckets.get(bucket) ?? [];
    list.push(candidate);
    speculativeBuckets.set(bucket, list);
  }
  const diversifiedShort: Array<{ edge: ProvisionalWallElement; score: number; openingId: string | null }> = [];
  for (let rank = 0; rank < 4; rank += 1) {
    for (let bucket = 0; bucket < 16; bucket += 1) {
      const candidate = speculativeBuckets.get(bucket)?.[rank];
      if (candidate) diversifiedShort.push(candidate);
    }
  }
  const perOpening = new Map<string, Array<{ edge: ProvisionalWallElement; score: number; openingId: string | null }>>();
  for (const candidate of unique.values()) {
    if (!candidate.openingId) continue;
    const list = perOpening.get(candidate.openingId) ?? [];
    list.push(candidate);
    perOpening.set(candidate.openingId, list);
  }
  return [
    ...trustedShort,
    ...diversifiedShort,
    ...[...perOpening.values()].flatMap((candidatesForOpening) => candidatesForOpening.slice(0, 16)),
  ].map((candidate) => candidate.edge);
}

function faceSignature(face: BoundaryFace): string {
  return face.points
    .map((point) => `${Math.round(point[0])},${Math.round(point[1])}`)
    .sort()
    .join("|");
}

function signedArea(points: Point2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function decomposeRepeatedNodeCycle(cycle: HalfEdge[]): HalfEdge[][] {
  const positions = new Map<number, number>();
  for (let index = 0; index < cycle.length; index += 1) {
    const node = cycle[index]!.from;
    const previous = positions.get(node);
    if (previous === undefined) {
      positions.set(node, index);
      continue;
    }
    const inner = cycle.slice(previous, index);
    const outer = [...cycle.slice(index), ...cycle.slice(0, previous)];
    return [inner, outer]
      .filter((part) => part.length >= 3)
      .flatMap(decomposeRepeatedNodeCycle);
  }
  return [cycle];
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

export function walkBoundaryFaces(elements: ProvisionalWallElement[], seed: Point2, snapTolerance = 50): BoundaryFace[] {
  const nodes: GraphNode[] = [];
  const nodeFor = (point: Point2) => {
    const existing = nodes.find((node) => distance(node.point, point) <= snapTolerance);
    if (existing) return existing.id;
    const id = nodes.length;
    nodes.push({ id, point, outgoing: [] });
    return id;
  };
  const edges: GraphEdge[] = [];
  for (const element of elements) {
    if (element.length <= 0.01 || distance(element.start, element.end) <= 0.01) continue;
    const a = nodeFor(element.start);
    const b = nodeFor(element.end);
    if (a === b) continue;
    edges.push({ id: element.id, element, a, b });
  }
  const halfEdges: HalfEdge[] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex]!;
    const forward = halfEdges.length;
    const reverse = forward + 1;
    const a = nodes[edge.a]!.point;
    const b = nodes[edge.b]!.point;
    halfEdges.push({ id: forward, edge: edgeIndex, from: edge.a, to: edge.b, twin: reverse, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) });
    halfEdges.push({ id: reverse, edge: edgeIndex, from: edge.b, to: edge.a, twin: forward, angle: Math.atan2(a[1] - b[1], a[0] - b[0]) });
    nodes[edge.a]!.outgoing.push(forward);
    nodes[edge.b]!.outgoing.push(reverse);
  }
  for (const node of nodes) node.outgoing.sort((a, b) => halfEdges[a]!.angle - halfEdges[b]!.angle);
  const nextHalfEdge = (halfEdge: HalfEdge) => {
    const outgoing = nodes[halfEdge.to]!.outgoing;
    const twinIndex = outgoing.indexOf(halfEdge.twin);
    return outgoing[(twinIndex - 1 + outgoing.length) % outgoing.length]!;
  };
  const visited = new Set<number>();
  const faces: BoundaryFace[] = [];
  for (const start of halfEdges) {
    if (visited.has(start.id)) continue;
    const cycle: HalfEdge[] = [];
    let current = start;
    const local = new Set<number>();
    while (!local.has(current.id) && cycle.length <= halfEdges.length) {
      local.add(current.id);
      visited.add(current.id);
      cycle.push(current);
      current = halfEdges[nextHalfEdge(current)]!;
    }
    if (current.id !== start.id || cycle.length < 3) continue;
    for (const simpleCycle of decomposeRepeatedNodeCycle(cycle)) {
      if (new Set(simpleCycle.map((halfEdge) => halfEdge.edge)).size !== simpleCycle.length) continue;
      const points = simpleCycle.map((halfEdge) => nodes[halfEdge.from]!.point);
      const area = signedArea(points);
      if (area <= 0.01) continue;
      const faceEdges = simpleCycle.map((halfEdge) => ({
        element: edges[halfEdge.edge]!.element,
        reverse: halfEdge.from === edges[halfEdge.edge]!.b,
      }));
      faces.push({
        id: `face:${faces.length}`,
        points,
        element_ids: faceEdges.map(({ element }) => element.id),
        parent_element_ids: [...new Set(faceEdges.map(({ element }) => element.parent_element_id ?? element.id))],
        area,
        contains_seed: contains(points, seed),
        half_edges: faceEdges,
      });
    }
  }
  return faces.sort((a, b) => a.area - b.area);
}

export function walkRoomBoundaryFaces(
  elements: ProvisionalWallElement[],
  openings: BoundaryOpening[],
  seed: Point2,
  options: { snapTolerance?: number; maximumGap?: number; targetArea?: number | null } = {},
): RoomFaceWalkResult {
  const snapTolerance = options.snapTolerance ?? 50;
  const searchRadius = options.targetArea ? Math.sqrt(options.targetArea) * 1.6 : Number.POSITIVE_INFINITY;
  const localElements = elements.filter((element) => distanceToSegment(seed, element.start, element.end) <= searchRadius);
  const planarized = deduplicateSegments(splitWallElementsAtJunctions(localElements, Math.min(10, snapTolerance), 10));
  const virtualEdges = constrainedGapEdges(planarized, openings, seed, snapTolerance, options.maximumGap ?? 1200);
  const junctionEdges = virtualEdges.filter((edge) => edge.semantic_type === "junction-gap");
  const trustedJunctionEdges = junctionEdges.filter((edge) => edge.length <= 250);
  const speculativeJunctionEdges = junctionEdges.filter((edge) => edge.length > 250);
  const openingEdges = virtualEdges.filter((edge) => String(edge.semantic_type).startsWith("opening-gap:"));
  const openingGroups = new Map<string, ProvisionalWallElement[]>();
  for (const edge of openingEdges) {
    const openingId = String(edge.semantic_type).slice("opening-gap:".length);
    const group = openingGroups.get(openingId) ?? [];
    group.push(edge);
    openingGroups.set(openingId, group);
  }
  const variants = [
    trustedJunctionEdges,
    ...openingEdges.map((edge) => [...trustedJunctionEdges, edge]),
    ...speculativeJunctionEdges.map((edge) => [...trustedJunctionEdges, edge]),
  ];
  for (const openingEdge of openingEdges) {
    for (const junctionEdge of speculativeJunctionEdges.slice(0, 16)) {
      variants.push([...trustedJunctionEdges, openingEdge, junctionEdge]);
    }
  }
  const groups = [...openingGroups.values()];
  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
      for (const left of groups[leftIndex]!.slice(0, 8)) {
        for (const right of groups[rightIndex]!.slice(0, 8)) variants.push([...trustedJunctionEdges, left, right]);
      }
    }
  }
  const uniqueFaces = new Map<string, BoundaryFace>();
  for (const variant of variants) {
    const faces = walkBoundaryFaces(deduplicateSegments([...planarized, ...variant]), seed, snapTolerance);
    for (const face of faces) {
      const key = faceSignature(face);
      const previous = uniqueFaces.get(key);
      if (!previous || (options.targetArea && Math.abs(face.area - options.targetArea) < Math.abs(previous.area - options.targetArea))) {
        uniqueFaces.set(key, face);
      }
    }
  }
  const sortedFaces = [...uniqueFaces.values()].sort((a, b) => {
      if (a.contains_seed !== b.contains_seed) return a.contains_seed ? -1 : 1;
      if (options.targetArea) return Math.abs(a.area - options.targetArea) - Math.abs(b.area - options.targetArea);
      return a.area - b.area;
    }).map((face, index) => ({ ...face, id: `room-face:${index}` }));
  return {
    faces: sortedFaces,
    virtual_edges: virtualEdges,
  };
}

function orientedPath(element: ProvisionalWallElement, reverse: boolean): Point2[] {
  return reverse ? [element.end, element.start] : [element.start, element.end];
}

export function faceToTraversalBranch(
  face: BoundaryFace,
  acceptedParentIds: Iterable<string>,
  probability = 1,
): TraversalBranch {
  const accepted = new Set(acceptedParentIds);
  const orderedEdges: TraversalEdge[] = [];
  const visitedElementIds: string[] = [];
  const visitedObjectIds: string[] = [];
  const repairParentElementIds: string[] = [];
  for (let index = 0; index < face.half_edges.length;) {
    const item = face.half_edges[index]!;
    if (String(item.element.semantic_type).startsWith("opening-gap:") || item.element.semantic_type === "junction-gap") {
      const path = orientedPath(item.element, item.reverse);
      orderedEdges.push({
        kind: String(item.element.semantic_type).startsWith("opening-gap:") ? "opening" : "junction",
        from: path[0]!,
        to: path.at(-1)!,
        ...(String(item.element.semantic_type).startsWith("opening-gap:")
          ? { opening_element_id: String(item.element.semantic_type).slice("opening-gap:".length) }
          : {}),
      });
      index += 1;
      continue;
    }
    const parentId = item.element.parent_element_id ?? item.element.id;
    const isObject = item.element.boundary_kind === "object";
    const members = [item];
    let nextIndex = index + 1;
    while (isObject && nextIndex < face.half_edges.length) {
      const next = face.half_edges[nextIndex]!;
      if ((next.element.parent_element_id ?? next.element.id) !== parentId) break;
      members.push(next);
      nextIndex += 1;
    }
    const path = members.flatMap((member, memberIndex) => {
      const points = orientedPath(member.element, member.reverse);
      return memberIndex === 0 ? points : points.slice(1);
    });
    const membership = accepted.has(parentId) ? "accepted" as const : "repair" as const;
    const edge: TraversalWallEdge = {
      kind: "wall",
      element_id: isObject ? `${parentId}:face-transition:${index}` : item.element.id,
      direction: item.reverse ? "reverse" : "forward",
      entry: path[0]!,
      exit: path.at(-1)!,
      source_entities: [...new Set(members.flatMap((member) => member.element.source_entities))],
      parent_element_id: parentId,
      membership,
      semantic_type: item.element.semantic_type ?? "wall",
      boundary_kind: item.element.boundary_kind ?? "linear",
      path,
      member_element_ids: members.map((member) => member.element.id),
      semantic_confidence: members.reduce((sum, member) => sum + Number(member.element.semantic_confidence ?? 0), 0) / members.length,
    };
    const previous = orderedEdges.at(-1);
    const previousExit = previous ? (previous.kind === "wall" ? previous.exit : previous.to) : null;
    if (previousExit && distance(previousExit, edge.entry) > 0.01) orderedEdges.push({ kind: "junction", from: previousExit, to: edge.entry });
    orderedEdges.push(edge);
    visitedElementIds.push(...edge.member_element_ids!);
    if (isObject && !visitedObjectIds.includes(parentId)) visitedObjectIds.push(parentId);
    if (membership === "repair" && !repairParentElementIds.includes(parentId)) repairParentElementIds.push(parentId);
    index = nextIndex;
  }
  const first = orderedEdges[0]!;
  const last = orderedEdges.at(-1)!;
  const startEntry = first.kind === "wall" ? first.entry : first.from;
  const lastExit = last.kind === "wall" ? last.exit : last.to;
  if (distance(lastExit, startEntry) > 0.01) orderedEdges.push({ kind: "junction", from: lastExit, to: startEntry });
  return {
    id: `face-branch:${face.id}`,
    startEntry,
    currentExit: startEntry,
    orderedEdges,
    visitedElementIds,
    visitedObjectIds,
    cumulativeProbability: probability,
    interiorSide: 1,
    repairParentElementIds,
    closed: true,
    termination: "face_walk",
  };
}

export function selectRoomFaces(
  faces: BoundaryFace[],
  targetArea: number | null,
  minimumArea: number,
  maximumArea: number,
): BoundaryFace[] {
  return faces
    .filter((face) => face.contains_seed && face.area >= minimumArea && face.area <= maximumArea)
    .sort((a, b) => {
      if (targetArea) return Math.abs(a.area - targetArea) - Math.abs(b.area - targetArea);
      return a.area - b.area;
    });
}
