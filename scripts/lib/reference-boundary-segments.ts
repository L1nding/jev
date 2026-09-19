export type Point2 = [number, number];

export type PickSegment = {
  id: string;
  source_id: string;
  handle: string;
  segment_index: number;
  layer: string;
  entity_type: string;
  start: Point2;
  end: Point2;
  origin: "cad" | "wall";
  wall_element_id?: string;
};

export type AnnotatorDefaults = {
  drawing_region_id: string;
  analysis_window_id?: string;
  room_seed: { source_id: string; text: string; point: Point2 };
  area_evidence?: { source_id: string; text: string; point: Point2 };
  cad_ir_path: string;
  focus_bounds: [number, number, number, number];
};

const num = (value: unknown) => Number(value);

const bboxIntersects = (bbox: number[], focus: [number, number, number, number]) =>
  bbox.length >= 4
  && num(bbox[0]) <= focus[2]
  && num(bbox[2]) >= focus[0]
  && num(bbox[1]) <= focus[3]
  && num(bbox[3]) >= focus[1];

const pointInFocus = (point: Point2, focus: [number, number, number, number]) =>
  point[0] >= focus[0] && point[0] <= focus[2] && point[1] >= focus[1] && point[1] <= focus[3];

export function focusBoundsFromSeed(seed: Point2, radius = 4500): [number, number, number, number] {
  return [seed[0] - radius, seed[1] - radius, seed[0] + radius, seed[1] + radius];
}

export function expandBounds(
  bounds: [number, number, number, number],
  pad: number,
): [number, number, number, number] {
  return [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad];
}

function segmentsFromPolyline(
  sourceId: string,
  handle: string,
  layer: string,
  entityType: string,
  vertices: number[][],
  closed: boolean,
): PickSegment[] {
  const points = vertices.map((point) => [num(point[0]), num(point[1])] as Point2);
  if (points.length < 2) return [];
  const segments: PickSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push({
      id: `${sourceId}:seg:${index}`,
      source_id: sourceId,
      handle,
      segment_index: index,
      layer,
      entity_type: entityType,
      start: points[index]!,
      end: points[index + 1]!,
      origin: "cad",
    });
  }
  if (closed && points.length > 2) {
    segments.push({
      id: `${sourceId}:seg:${points.length - 1}`,
      source_id: sourceId,
      handle,
      segment_index: points.length - 1,
      layer,
      entity_type: entityType,
      start: points.at(-1)!,
      end: points[0]!,
      origin: "cad",
    });
  }
  return segments;
}

export function segmentsFromCadEntity(entity: any): PickSegment[] {
  const geometry = entity.geometry?.local;
  if (!geometry) return [];
  const sourceId = String(entity.id);
  const handle = String(entity.source?.handle ?? sourceId.replace(/^source:/, ""));
  const layer = String(entity.source?.layer ?? "");
  const entityType = String(entity.source?.entity_type ?? "");

  if (geometry.kind === "line" && geometry.start && geometry.end) {
    return [{
      id: `${sourceId}:seg:0`,
      source_id: sourceId,
      handle,
      segment_index: 0,
      layer,
      entity_type: entityType,
      start: [num(geometry.start[0]), num(geometry.start[1])],
      end: [num(geometry.end[0]), num(geometry.end[1])],
      origin: "cad",
    }];
  }

  if (geometry.kind === "polyline" && Array.isArray(geometry.vertices)) {
    return segmentsFromPolyline(sourceId, handle, layer, entityType, geometry.vertices, Boolean(geometry.closed));
  }

  if (geometry.kind === "solid" && Array.isArray(geometry.vertices) && geometry.vertices.length >= 3) {
    const vertices = geometry.vertices.length === 4
      ? [geometry.vertices[0], geometry.vertices[1], geometry.vertices[3], geometry.vertices[2]]
      : geometry.vertices;
    return segmentsFromPolyline(sourceId, handle, layer, entityType, vertices, true);
  }

  if (entityType === "INSERT" && entity.anchor?.local) {
    const center: Point2 = [num(entity.anchor.local[0]), num(entity.anchor.local[1])];
    const scaleX = Math.abs(num(geometry.scale?.[0] ?? 500));
    const scaleY = Math.abs(num(geometry.scale?.[1] ?? 500));
    const halfW = scaleX > 20 ? scaleX / 2 : 250;
    const halfH = scaleY > 20 ? scaleY / 2 : 250;
    const corners: Point2[] = [
      [center[0] - halfW, center[1] - halfH],
      [center[0] + halfW, center[1] - halfH],
      [center[0] + halfW, center[1] + halfH],
      [center[0] - halfW, center[1] + halfH],
    ];
    return segmentsFromPolyline(sourceId, handle, layer, entityType, corners, true);
  }

  return [];
}

export function segmentsFromWallElements(document: any): PickSegment[] {
  const elements = document.elements ?? [];
  return elements.map((element: any, index: number) => {
    const sourceId = String(element.source_entities?.[0] ?? `wall:${index}`);
    const handle = sourceId.replace(/^source:/, "");
    return {
      id: String(element.id),
      source_id: sourceId,
      handle,
      segment_index: Number(element.source_segment_index ?? 0),
      layer: "wall-element",
      entity_type: "WALL_ELEMENT",
      start: [num(element.start[0]), num(element.start[1])],
      end: [num(element.end[0]), num(element.end[1])],
      origin: "wall" as const,
      wall_element_id: String(element.id),
    };
  });
}

export function buildPickSegments(options: {
  cad: any;
  wallElements?: any;
  focus: [number, number, number, number];
  preferWallSegments?: boolean;
}): PickSegment[] {
  const { cad, wallElements, focus, preferWallSegments = true } = options;
  if (preferWallSegments && wallElements) {
    return segmentsFromWallElements(wallElements).filter((segment) =>
      pointInFocus(segment.start, focus) || pointInFocus(segment.end, focus));
  }

  const segments: PickSegment[] = [];
  for (const entity of cad.entities ?? []) {
    const bbox = entity.bbox?.local;
    if (Array.isArray(bbox) && !bboxIntersects(bbox.map(num), focus)) continue;
    segments.push(...segmentsFromCadEntity(entity));
  }
  return segments.filter((segment) => pointInFocus(segment.start, focus) || pointInFocus(segment.end, focus));
}

export function defaultsFromRoomObject(cadPath: string, cad: any, roomObject: any, windowId?: string): AnnotatorDefaults {
  const seedSourceId = String(roomObject.object?.seed_source_id ?? roomObject.room_seed?.source_id ?? "");
  const seedEntity = (cad.entities as any[]).find((entity) => entity.id === seedSourceId);
  const seedPoint: Point2 = seedEntity?.anchor?.local
    ? [num(seedEntity.anchor.local[0]), num(seedEntity.anchor.local[1])]
    : [num(roomObject.query?.seed_point?.[0] ?? 0), num(roomObject.query?.seed_point?.[1] ?? 0)];

  const entityText = (entity: any) => String(
    entity.geometry?.local?.text
    ?? entity.geometry?.source?.text
    ?? entity.source?.attributes?.text
    ?? entity.text?.content
    ?? "",
  );

  const areaCandidates = (cad.entities as any[])
    .map((entity) => {
      if (!/m²|m2|㎡/.test(entityText(entity))) return null;
      const distance = Math.hypot(
        num(entity.anchor?.local?.[0]) - seedPoint[0],
        num(entity.anchor?.local?.[1]) - seedPoint[1],
      );
      return distance < 8000 ? { entity, distance } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a!.distance - b!.distance);
  const areaSource = areaCandidates[0]?.entity ?? null;

  let focus = focusBoundsFromSeed(seedPoint, 4500);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sourceId of roomObject.object?.source_entities ?? []) {
    const entity = (cad.entities as any[]).find((item) => item.id === sourceId);
    const bbox = entity?.bbox?.local;
    if (!bbox || bbox.length < 4) continue;
    xs.push(num(bbox[0]), num(bbox[2]));
    ys.push(num(bbox[1]), num(bbox[3]));
  }
  if (xs.length > 0) {
    focus = expandBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 800);
  }

  return {
    drawing_region_id: String(cad.selection?.region_id ?? "unknown-region"),
    analysis_window_id: windowId,
    room_seed: {
      source_id: seedSourceId,
      text: String(roomObject.query?.seed_text ?? roomObject.object?.label ?? ""),
      point: seedPoint,
    },
    area_evidence: areaSource ? {
      source_id: String(areaSource.id),
      text: entityText(areaSource),
      point: [num(areaSource.anchor.local[0]), num(areaSource.anchor.local[1])],
    } : undefined,
    cad_ir_path: cadPath,
    focus_bounds: focus,
  };
}
