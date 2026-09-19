import { createHash } from "node:crypto";
import type { Point2, ProvisionalWallElement } from "./wall-elements";

export type RoomLayerChoice = "include" | "uncertain" | "exclude";

export type RoomLayerDecision = {
  layer: string;
  choice: RoomLayerChoice;
  confidence: number | null;
  probabilities?: Record<string, number>;
  request_id?: string | null;
  model?: string | null;
  raw_choice?: RoomLayerChoice;
  policy_reasons?: string[];
};

export function effectiveRoomLayerDecisions(
  decisions: RoomLayerDecision[],
  protectedLayers: Iterable<string>,
  minimumExcludeConfidence = 0.65,
): RoomLayerDecision[] {
  const protectedSet = new Set(protectedLayers);
  return decisions.map((decision) => {
    if (decision.choice !== "exclude") return decision;
    const reasons: string[] = [];
    if (protectedSet.has(decision.layer)) reasons.push("direct_room_membership_evidence");
    if ((decision.confidence ?? 0) < minimumExcludeConfidence) reasons.push("low_exclude_confidence");
    if (reasons.length === 0) return decision;
    return { ...decision, raw_choice: decision.choice, choice: "uncertain", policy_reasons: reasons };
  });
}

export type RoomLayerDecisionDocument = {
  schema_version: "room-layer-decisions-v1";
  decisions: RoomLayerDecision[];
};

export type RoomLayerProfile = {
  key: string;
  layer: string;
  entity_count: number;
  boundary_element_count: number;
  accepted_boundary_element_count: number;
  selected_face_element_count: number;
  semantic_type_counts: Record<string, number>;
  entity_type_counts: Record<string, number>;
  minimum_distance_to_seed: number;
  examples: Array<{
    source_id: string;
    handle: string;
    entity_type: string;
    semantic_type: string;
    distance_to_seed: number;
    anchor_local: number[] | null;
    bbox_local: number[] | null;
    geometry: Record<string, unknown> | null;
  }>;
};

type CadEntity = {
  id: string;
  source: { handle: string; entity_type: string; layer: string };
  anchor: { local: number[] | null };
  bbox: { local: number[] | null };
  geometry: { local: Record<string, any> | null };
};

type SemanticDecision = { source_id: string; semantic_type: string };

function distanceToSeed(entity: CadEntity, seed: Point2): number {
  const anchor = entity.anchor.local;
  if (!anchor) return Number.POSITIVE_INFINITY;
  return Math.hypot(Number(anchor[0]) - seed[0], Number(anchor[1]) - seed[1]);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function compactGeometry(geometry: Record<string, any> | null): Record<string, unknown> | null {
  if (!geometry) return null;
  if (geometry.kind === "line") return { kind: "line", start: geometry.start, end: geometry.end };
  if (geometry.kind === "polyline") {
    const vertices = Array.isArray(geometry.vertices) ? geometry.vertices : [];
    return {
      kind: "polyline",
      closed: geometry.closed === true,
      vertex_count: vertices.length,
      sample_vertices: vertices.length <= 8 ? vertices : [...vertices.slice(0, 4), ...vertices.slice(-4)],
    };
  }
  if (geometry.kind === "block_reference") {
    return { kind: "block_reference", insert: geometry.insert, rotation: geometry.rotation, scale: geometry.scale };
  }
  if (geometry.kind === "solid") return { kind: "solid", vertices: geometry.vertices };
  return { kind: geometry.kind ?? "unknown" };
}

export function layerKey(layer: string): string {
  return `layer_${createHash("sha1").update(layer).digest("hex").slice(0, 12)}`;
}

export function buildRoomLayerProfiles(input: {
  entities: CadEntity[];
  semanticDecisions: SemanticDecision[];
  boundaryElements: ProvisionalWallElement[];
  roomRoles: Record<string, string>;
  seed: Point2;
  radius: number;
  selectedFaceParentIds?: Iterable<string>;
}): RoomLayerProfile[] {
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const structural = new Set(["wall", "window", "door", "column"]);
  const selectedFaceParents = new Set(input.selectedFaceParentIds ?? []);
  const elementLayers = new Map<string, string[]>();
  for (const element of input.boundaryElements) {
    elementLayers.set(element.id, [...new Set(element.source_entities
      .map((sourceId) => entityById.get(sourceId)?.source.layer)
      .filter((layer): layer is string => Boolean(layer)))].sort());
  }

  const candidates = input.semanticDecisions
    .filter((decision) => structural.has(decision.semantic_type))
    .map((decision) => ({ decision, entity: entityById.get(decision.source_id) }))
    .filter((item): item is { decision: SemanticDecision; entity: CadEntity } => Boolean(item.entity))
    .map((item) => ({ ...item, distance: distanceToSeed(item.entity, input.seed) }))
    .filter((item) => item.distance <= input.radius);

  const grouped = Map.groupBy(candidates, (item) => item.entity.source.layer);
  return [...grouped.entries()].map(([layer, items]) => {
    const nearbySourceIds = new Set(items.map((item) => item.entity.id));
    const layerElements = input.boundaryElements.filter((element) => elementLayers.get(element.id)?.includes(layer)
      && element.source_entities.some((sourceId) => nearbySourceIds.has(sourceId)));
    const acceptedElements = layerElements.filter((element) => element.source_entities.some((sourceId) => input.roomRoles[sourceId] === "boundary"));
    const selectedElements = layerElements.filter((element) => selectedFaceParents.has(element.parent_element_id ?? element.id));
    const examples = items
      .sort((a, b) => a.distance - b.distance || a.entity.id.localeCompare(b.entity.id))
      .slice(0, 6)
      .map(({ entity, decision, distance }) => ({
        source_id: entity.id,
        handle: entity.source.handle,
        entity_type: entity.source.entity_type,
        semantic_type: decision.semantic_type,
        distance_to_seed: Number(distance.toFixed(3)),
        anchor_local: entity.anchor.local,
        bbox_local: entity.bbox.local,
        geometry: compactGeometry(entity.geometry.local),
      }));
    return {
      key: layerKey(layer),
      layer,
      entity_count: items.length,
      boundary_element_count: layerElements.length,
      accepted_boundary_element_count: acceptedElements.length,
      selected_face_element_count: selectedElements.length,
      semantic_type_counts: countBy(items.map((item) => item.decision.semantic_type)),
      entity_type_counts: countBy(items.map((item) => item.entity.source.entity_type)),
      minimum_distance_to_seed: Math.min(...items.map((item) => item.distance)),
      examples,
    };
  }).sort((a, b) => b.boundary_element_count - a.boundary_element_count
    || b.entity_count - a.entity_count
    || a.layer.localeCompare(b.layer));
}

function elementChoice(
  element: Pick<ProvisionalWallElement, "source_entities">,
  entityById: Map<string, CadEntity>,
  decisionByLayer: Map<string, RoomLayerChoice>,
): RoomLayerChoice {
  const choices = [...new Set(element.source_entities
    .map((sourceId) => entityById.get(sourceId)?.source.layer)
    .filter((layer): layer is string => Boolean(layer))
    .map((layer) => decisionByLayer.get(layer) ?? "uncertain"))];
  if (choices.length === 0 || choices.includes("exclude")) return "exclude";
  if (choices.every((choice) => choice === "include")) return "include";
  return "uncertain";
}

export function partitionBoundaryElementsByLayer(
  elements: ProvisionalWallElement[],
  entities: CadEntity[],
  decisions: RoomLayerDecision[],
): { primary: ProvisionalWallElement[]; repair: ProvisionalWallElement[]; excluded: ProvisionalWallElement[]; counts: Record<RoomLayerChoice, number> } {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const decisionByLayer = new Map(decisions.map((decision) => [decision.layer, decision.choice]));
  const primary: ProvisionalWallElement[] = [];
  const repair: ProvisionalWallElement[] = [];
  const excluded: ProvisionalWallElement[] = [];
  const counts = { include: 0, uncertain: 0, exclude: 0 };
  for (const element of elements) {
    const choice = elementChoice(element, entityById, decisionByLayer);
    counts[choice] += 1;
    if (choice === "include") {
      primary.push(element);
      repair.push(element);
    } else if (choice === "uncertain") {
      repair.push(element);
    } else {
      excluded.push(element);
    }
  }
  return { primary, repair, excluded, counts };
}
