export type BoundaryEntity = {
  id: string;
  geometry: { local: Record<string, any> | null };
};

type Point = [number, number];
type Segment = [Point, Point];

function point(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function segmentsFor(entity: BoundaryEntity): Segment[] {
  const geometry = entity.geometry.local;
  if (!geometry) return [];
  if (geometry.kind === "line") {
    const start = point(geometry.start);
    const end = point(geometry.end);
    return start && end ? [[start, end]] : [];
  }
  if (geometry.kind === "polyline" && Array.isArray(geometry.vertices)) {
    const vertices = geometry.vertices.map(point).filter((value): value is Point => value !== null);
    const segments: Segment[] = [];
    for (let index = 1; index < vertices.length; index += 1) {
      segments.push([vertices[index - 1]!, vertices[index]!]);
    }
    if (geometry.closed && vertices.length > 2) segments.push([vertices.at(-1)!, vertices[0]!]);
    return segments;
  }
  return [];
}

export function validateRoomBoundary(entities: BoundaryEntity[], tolerance = 10) {
  const segments = entities.flatMap(segmentsFor);
  const representedIds = new Set(entities.filter((entity) => segmentsFor(entity).length > 0).map((entity) => entity.id));
  const unresolvedEntityIds = entities.filter((entity) => !representedIds.has(entity.id)).map((entity) => entity.id);
  const nodes: Array<{ point: Point; degree: number; neighbors: Set<number> }> = [];

  const nodeFor = (candidate: Point) => {
    const existing = nodes.findIndex((node) => Math.hypot(node.point[0] - candidate[0], node.point[1] - candidate[1]) <= tolerance);
    if (existing >= 0) return existing;
    nodes.push({ point: candidate, degree: 0, neighbors: new Set() });
    return nodes.length - 1;
  };

  for (const [start, end] of segments) {
    const a = nodeFor(start);
    const b = nodeFor(end);
    nodes[a]!.degree += 1;
    nodes[b]!.degree += 1;
    nodes[a]!.neighbors.add(b);
    nodes[b]!.neighbors.add(a);
  }

  let componentCount = 0;
  const visited = new Set<number>();
  for (let start = 0; start < nodes.length; start += 1) {
    if (visited.has(start)) continue;
    componentCount += 1;
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of nodes[current]!.neighbors) stack.push(neighbor);
    }
  }

  const oddDegreeNodes = nodes.filter((node) => node.degree % 2 !== 0);
  return {
    status: "checked",
    tolerance,
    segment_count: segments.length,
    node_count: nodes.length,
    component_count: componentCount,
    odd_degree_node_count: oddDegreeNodes.length,
    open_endpoints: oddDegreeNodes.slice(0, 20).map((node) => node.point),
    unresolved_boundary_entity_ids: unresolvedEntityIds,
    closed_boundary: segments.length >= 3 && componentCount === 1 && oddDegreeNodes.length === 0 && unresolvedEntityIds.length === 0,
  };
}
