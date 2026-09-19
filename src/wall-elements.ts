export type Point2 = [number, number];
export type BoundaryKind = "linear" | "object" | "opening";

export type WallSourceEntity = {
  id: string;
  source: { handle: string };
  anchor: { local: number[] | null };
  geometry: { local: Record<string, any> | null };
};

export type WallSemanticDecision = {
  source_id: string;
  semantic_type: string;
  confidence: number | null;
  model?: string;
  request_id?: string;
};

export type WallElement = {
  id: string;
  status: "provisional" | "jev-grouped";
  source_entities: string[];
  source_segment_index: number;
  member_element_ids?: string[];
  parent_element_id?: string;
  start: Point2;
  end: Point2;
  length: number;
  semantic_confidence: number | null;
  semantic_model: string | null;
  semantic_request_id: string | null;
  semantic_type?: string;
  boundary_kind?: Exclude<BoundaryKind, "opening">;
};

export type ProvisionalWallElement = WallElement;

function project(point: Point2, start: Point2, end: Point2) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator;
  const projected: Point2 = [start[0] + t * dx, start[1] + t * dy];
  return { t, distance: distance(point, projected) };
}

function intersectionParameter(a: WallElement, b: WallElement): number | null {
  const ax = a.end[0] - a.start[0];
  const ay = a.end[1] - a.start[1];
  const bx = b.end[0] - b.start[0];
  const by = b.end[1] - b.start[1];
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-9) return null;
  const dx = b.start[0] - a.start[0];
  const dy = b.start[1] - a.start[1];
  const t = (dx * by - dy * bx) / denominator;
  const u = (dx * ay - dy * ax) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

export function splitWallElementsAtJunctions(elements: WallElement[], tolerance = 250, minimumLength = 50): WallElement[] {
  const result: WallElement[] = [];
  for (const element of elements) {
    const cuts = [0, 1];
    for (const other of elements) {
      if (other.id === element.id) continue;
      const intersection = intersectionParameter(element, other);
      if (intersection !== null) cuts.push(intersection);
      for (const endpoint of [other.start, other.end]) {
        const candidate = project(endpoint, element.start, element.end);
        if (candidate.t > 0 && candidate.t < 1 && candidate.distance <= tolerance) cuts.push(candidate.t);
      }
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const unique: number[] = [];
    const minimumT = Math.min(0.25, minimumLength / Math.max(element.length, minimumLength));
    for (const value of sorted) {
      if (unique.length === 0 || value - unique.at(-1)! >= minimumT) unique.push(value);
    }
    if (1 - unique.at(-1)! > 1e-9) unique.push(1);
    for (let index = 1; index < unique.length; index += 1) {
      const from = unique[index - 1]!;
      const to = unique[index]!;
      const start: Point2 = [
        element.start[0] + (element.end[0] - element.start[0]) * from,
        element.start[1] + (element.end[1] - element.start[1]) * from,
      ];
      const end: Point2 = [
        element.start[0] + (element.end[0] - element.start[0]) * to,
        element.start[1] + (element.end[1] - element.start[1]) * to,
      ];
      const segmentLength = distance(start, end);
      if (segmentLength < minimumLength) continue;
      result.push({
        ...element,
        id: `${element.id}:boundary:${index - 1}`,
        parent_element_id: element.parent_element_id ?? element.id,
        start,
        end,
        length: segmentLength,
      });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function point(value: unknown): Point2 | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function segments(entity: WallSourceEntity): Array<[Point2, Point2]> {
  const geometry = entity.geometry.local;
  if (!geometry) return [];
  if (geometry.kind === "line") {
    const start = point(geometry.start);
    const end = point(geometry.end);
    return start && end ? [[start, end]] : [];
  }
  if (geometry.kind === "polyline" && Array.isArray(geometry.vertices)) {
    const vertices = geometry.vertices.map(point).filter((value): value is Point2 => value !== null);
    const result: Array<[Point2, Point2]> = [];
    for (let index = 1; index < vertices.length; index += 1) {
      result.push([vertices[index - 1]!, vertices[index]!]);
    }
    if (geometry.closed && vertices.length > 2) result.push([vertices.at(-1)!, vertices[0]!]);
    return result;
  }
  if (geometry.kind === "solid" && Array.isArray(geometry.vertices)) {
    const raw = geometry.vertices.map(point).filter((value): value is Point2 => value !== null);
    const vertices = raw.length === 4 ? [raw[0]!, raw[1]!, raw[3]!, raw[2]!] : raw;
    return vertices.map((start, index) => [start, vertices[(index + 1) % vertices.length]!] as [Point2, Point2]);
  }
  return [];
}

function columnSegments(entity: WallSourceEntity): Array<[Point2, Point2]> {
  const geometry = entity.geometry.local;
  if (!geometry || geometry.kind !== "block_reference") return [];
  const insert = point(geometry.insert ?? entity.anchor.local);
  const scale = Array.isArray(geometry.scale) ? geometry.scale : [];
  const width = Math.abs(Number(scale[0]));
  const height = Math.abs(Number(scale[1]));
  if (!insert || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const angle = Number(geometry.rotation ?? 0) * Math.PI / 180;
  const rotate = ([x, y]: Point2): Point2 => [
    insert[0] + x * Math.cos(angle) - y * Math.sin(angle),
    insert[1] + x * Math.sin(angle) + y * Math.cos(angle),
  ];
  const corners = [
    rotate([-width / 2, -height / 2]),
    rotate([width / 2, -height / 2]),
    rotate([width / 2, height / 2]),
    rotate([-width / 2, height / 2]),
  ];
  return corners.map((start, index) => [start, corners[(index + 1) % corners.length]!] as [Point2, Point2]);
}

export function buildProvisionalBoundaryElements(
  entities: WallSourceEntity[],
  decisions: WallSemanticDecision[],
  seed: Point2,
  radius: number,
  semanticTypes: string[] = ["wall", "window", "column"],
): ProvisionalWallElement[] {
  const allowedTypes = new Set(semanticTypes);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const result: ProvisionalWallElement[] = [];
  for (const decision of decisions) {
    if (!allowedTypes.has(decision.semantic_type)) continue;
    const entity = entityById.get(decision.source_id);
    if (!entity) continue;
    const anchor = point(entity.anchor.local);
    if (!anchor || distance(anchor, seed) > radius) continue;
    const sourceSegments = decision.semantic_type === "column" ? [...segments(entity), ...columnSegments(entity)] : segments(entity);
    const boundaryKind = decision.semantic_type === "window"
      || decision.semantic_type === "column"
      || geometryFormsClosedOutline(entity.geometry.local)
      ? "object"
      : "linear";
    sourceSegments.forEach(([start, end], index) => {
      const length = distance(start, end);
      if (length <= 0) return;
      result.push({
        id: `boundary:${decision.semantic_type}:${entity.source.handle}:segment:${index}`,
        parent_element_id: `boundary:${decision.semantic_type}:${entity.source.handle}`,
        status: "provisional",
        source_entities: [entity.id],
        source_segment_index: index,
        start,
        end,
        length,
        semantic_confidence: decision.confidence,
        semantic_model: decision.model ?? null,
        semantic_request_id: decision.request_id ?? null,
        semantic_type: decision.semantic_type,
        boundary_kind: boundaryKind,
      });
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function geometryFormsClosedOutline(geometry: Record<string, any> | null): boolean {
  if (!geometry) return false;
  return geometry.kind === "solid"
    || geometry.kind === "block_reference"
    || (geometry.kind === "polyline" && geometry.closed === true);
}

export function buildProvisionalWallElements(
  entities: WallSourceEntity[],
  decisions: WallSemanticDecision[],
  seed: Point2,
  radius: number,
): ProvisionalWallElement[] {
  return buildProvisionalBoundaryElements(entities, decisions, seed, radius, ["wall"])
    .map((element) => ({ ...element, id: element.id.replace(/^boundary:wall:/, "wall:") }));
}
