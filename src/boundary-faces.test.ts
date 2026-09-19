import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { faceToTraversalBranch, selectRoomFaces, walkBoundaryFaces, walkRoomBoundaryFaces } from "./boundary-faces";
import { filterWallElementsByRole, validateTraversal } from "./room-traversal";
import { buildProvisionalBoundaryElements, type Point2, type ProvisionalWallElement } from "./wall-elements";
import { effectiveRoomLayerDecisions, partitionBoundaryElementsByLayer } from "./room-layer-filter";

const edge = (id: string, start: [number, number], end: [number, number], extra: Partial<ProvisionalWallElement> = {}): ProvisionalWallElement => ({
  id, status: "provisional" as const, source_entities: [`source:${id}`], source_segment_index: 0,
  start, end, length: Math.hypot(end[0] - start[0], end[1] - start[1]),
  semantic_confidence: 1, semantic_model: null, semantic_request_id: null,
  semantic_type: "wall", boundary_kind: "linear" as const, ...extra,
});

describe("boundary face walking", () => {
  test("finds the bounded face containing the room seed", () => {
    const elements = [
      edge("bottom", [0, 0], [10, 0]), edge("right", [10, 0], [10, 10]),
      edge("top", [10, 10], [0, 10]), edge("left", [0, 10], [0, 0]),
    ];
    const faces = selectRoomFaces(walkBoundaryFaces(elements, [5, 5], 0.1), 100, 50, 150);
    expect(faces).toHaveLength(1);
    expect(faces[0]).toEqual(expect.objectContaining({ area: 100, contains_seed: true }));
    const branch = faceToTraversalBranch(faces[0]!, elements.map((element) => element.id));
    expect(validateTraversal(branch, [5, 5])).toEqual(expect.objectContaining({ closed: true, contains_seed: true, area: 100 }));
  });

  test("compresses consecutive column perimeter edges in a face", () => {
    const elements = [
      edge("bottom", [0, 0], [10, 0]),
      edge("column-left", [10, 0], [10, 10], { parent_element_id: "column:C", semantic_type: "column", boundary_kind: "object" as const }),
      edge("top", [10, 10], [0, 10]), edge("left", [0, 10], [0, 0]),
    ];
    const face = selectRoomFaces(walkBoundaryFaces(elements, [5, 5], 0.1), 100, 50, 150)[0]!;
    const branch = faceToTraversalBranch(face, elements.map((element) => element.parent_element_id ?? element.id));
    expect(branch.orderedEdges.filter((item) => item.kind === "wall" && item.parent_element_id === "column:C")).toHaveLength(1);
    expect(branch.visitedObjectIds).toEqual(["column:C"]);
  });

  test("completes constrained gaps around real 3DFB32 room seed", async () => {
    const root = resolve(import.meta.dir, "..");
    const [cad, decisions, walls, room] = await Promise.all([
      readFile(resolve(root, "reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/jev/window-0f28c192908f/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.jev-decisions.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/wall-elements/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.3DFB32.segmented-wall-elements.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/objects/window-0f28c192908f/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.room.3DFB32.jev-object.json"), "utf8").then(JSON.parse),
    ]);
    const seed = walls.room_seed.point as Point2;
    const base = walls.elements as ProvisionalWallElement[];
    const radius = Math.max(
      Number(walls.selection?.radius ?? 3000),
      ...base.flatMap((element) => [element.start, element.end])
        .map((value) => Math.hypot(value[0] - seed[0], value[1] - seed[1])),
    );
    const baseSourceIds = new Set(base.flatMap((element) => element.source_entities));
    const supplemental = buildProvisionalBoundaryElements(cad.entities, decisions.decisions, seed, radius, ["wall", "window", "column"])
      .filter((element) => !element.source_entities.some((sourceId) => baseSourceIds.has(sourceId)));
    const allElements = [...base, ...supplemental];
    const accepted = filterWallElementsByRole(allElements, room.object.roles, "boundary");
    const entityById = new Map<string, any>(cad.entities.map((entity: any) => [entity.id, entity]));
    const openings = Object.entries(room.object.roles)
      .filter(([, role]) => role === "opening")
      .map(([sourceId]) => {
        const entity = entityById.get(sourceId)!;
        const geometry = entity.geometry?.local;
        const path = geometry?.kind === "line"
          ? [geometry.start, geometry.end]
          : geometry?.kind === "polyline" ? geometry.vertices : undefined;
        return {
          id: `opening:${entity.source.handle}`,
          anchor: [Number(entity.anchor.local[0]), Number(entity.anchor.local[1])] as Point2,
          path: path?.map((point: number[]) => [Number(point[0]), Number(point[1])] as Point2),
        };
      });
    const result = walkRoomBoundaryFaces(allElements, openings, seed, { snapTolerance: 50, targetArea: 10_300_000 });
    const roomFaces = selectRoomFaces(result.faces, 10_300_000, 2_575_000, 41_200_000);
    expect(accepted.length).toBeGreaterThan(0);
    expect(roomFaces.length).toBeGreaterThan(0);
    expect(Math.abs(roomFaces[0]!.area - 10_300_000) / 10_300_000).toBeLessThan(0.25);
    const branch = faceToTraversalBranch(roomFaces[0]!, accepted.map((element) => element.parent_element_id ?? element.id));
    expect(validateTraversal(branch, seed)).toEqual(expect.objectContaining({ closed: true, contains_seed: true }));
    expect(branch.orderedEdges.some((item) => item.kind === "junction")).toBe(true);
    expect(branch.visitedObjectIds).toContain("boundary:column:3E0433");
  });

  test("removes Jev-excluded layers from the real 3DFB32 face graph", async () => {
    const root = resolve(import.meta.dir, "..");
    const [cad, decisions, walls, room, layers] = await Promise.all([
      readFile(resolve(root, "reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/jev/window-0f28c192908f/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.jev-decisions.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/wall-elements/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.3DFB32.segmented-wall-elements.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/objects/window-0f28c192908f/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.room.3DFB32.jev-object.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "reports/layers/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.3DFB32.room-layer-decisions.json"), "utf8").then(JSON.parse),
    ]);
    const seed = walls.room_seed.point as Point2;
    const base = walls.elements as ProvisionalWallElement[];
    const baseSourceIds = new Set(base.flatMap((element) => element.source_entities));
    const supplemental = buildProvisionalBoundaryElements(cad.entities, decisions.decisions, seed, 7600, ["wall", "window", "column"])
      .filter((element) => !element.source_entities.some((sourceId) => baseSourceIds.has(sourceId)));
    const entityById = new Map<string, any>(cad.entities.map((entity: any) => [entity.id, entity]));
    const protectedLayers = Object.entries(room.object.roles)
      .filter(([, role]) => role === "boundary" || role === "opening")
      .map(([sourceId]) => entityById.get(sourceId)?.source.layer)
      .filter(Boolean);
    const effective = effectiveRoomLayerDecisions(layers.decisions, protectedLayers);
    const partition = partitionBoundaryElementsByLayer([...base, ...supplemental], cad.entities, effective);
    const choiceByLayer = new Map(effective.map((decision) => [decision.layer, decision.choice]));
    const openings = Object.entries(room.object.roles)
      .filter(([, role]) => role === "opening")
      .map(([sourceId]) => {
        const entity = entityById.get(sourceId)!;
        const geometry = entity.geometry?.local;
        const path = geometry?.kind === "line"
          ? [geometry.start, geometry.end]
          : geometry?.kind === "polyline" ? geometry.vertices : undefined;
        return {
          id: `opening:${entity.source.handle}`,
          source_entity_id: sourceId,
          anchor: [Number(entity.anchor.local[0]), Number(entity.anchor.local[1])] as Point2,
          path: path?.map((value: number[]) => [Number(value[0]), Number(value[1])] as Point2),
        };
      })
      .filter((opening) => choiceByLayer.get(entityById.get(opening.source_entity_id)?.source.layer) !== "exclude");
    const result = walkRoomBoundaryFaces(partition.primary, openings, seed, { snapTolerance: 50, targetArea: 10_300_000 });
    const roomFaces = selectRoomFaces(result.faces, 10_300_000, 2_575_000, 41_200_000);
    expect(result.faces.length).toBeLessThan(100);
    expect(roomFaces.length).toBeGreaterThan(0);
    expect(Math.abs(roomFaces[0]!.area - 10_300_000) / 10_300_000).toBeLessThan(0.03);
    const virtualGapCount = roomFaces[0]!.half_edges.filter((edge) => edge.element.id.startsWith("virtual-gap:")).length;
    expect(virtualGapCount).toBeGreaterThan(0);
    expect(virtualGapCount).toBeLessThanOrEqual(2);
    const excludedLayers = new Set(effective.filter((decision) => decision.choice === "exclude").map((decision) => decision.layer));
    expect(partition.primary.every((element) => element.source_entities.every((sourceId) => !excludedLayers.has(entityById.get(sourceId)?.source.layer)))).toBe(true);
  });
});
