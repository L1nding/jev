import { describe, expect, test } from "bun:test";
import { buildRoomLayerProfiles, effectiveRoomLayerDecisions, partitionBoundaryElementsByLayer } from "./room-layer-filter";
import type { ProvisionalWallElement } from "./wall-elements";

const entity = (id: string, layer: string, x: number) => ({
  id: `source:${id}`,
  source: { handle: id, entity_type: "LWPOLYLINE", layer },
  anchor: { local: [x, 0] },
  bbox: { local: [x, 0, x + 1, 1] },
  geometry: { local: { kind: "line", start: [x, 0], end: [x + 1, 0] } },
});

const edge = (id: string): ProvisionalWallElement => ({
  id, status: "provisional", source_entities: [`source:${id}`], source_segment_index: 0,
  start: [0, 0], end: [1, 0], length: 1, semantic_confidence: 1,
  semantic_model: null, semantic_request_id: null, semantic_type: "wall", boundary_kind: "linear",
});

describe("room layer filtering", () => {
  test("profiles structural evidence per nearby CAD layer", () => {
    const profiles = buildRoomLayerProfiles({
      entities: [entity("wall", "WALL", 2), entity("desk", "PL-家具", 3), entity("far", "WALL", 100)],
      semanticDecisions: [
        { source_id: "source:wall", semantic_type: "wall" },
        { source_id: "source:desk", semantic_type: "wall" },
        { source_id: "source:far", semantic_type: "wall" },
      ],
      boundaryElements: [edge("wall"), edge("desk"), edge("far")],
      roomRoles: { "source:wall": "boundary", "source:desk": "interior" },
      seed: [0, 0], radius: 10, selectedFaceParentIds: ["wall"],
    });
    expect(profiles.map((profile) => profile.layer).sort()).toEqual(["PL-家具", "WALL"].sort());
    expect(profiles.find((profile) => profile.layer === "WALL")).toEqual(expect.objectContaining({
      entity_count: 1,
      boundary_element_count: 1,
      accepted_boundary_element_count: 1,
      selected_face_element_count: 1,
    }));
  });

  test("uses include for topology, uncertain only for repair, and removes excluded layers", () => {
    const entities = [entity("wall", "WALL", 2), entity("shaft", "管井", 3), entity("desk", "PL-家具", 4)];
    const result = partitionBoundaryElementsByLayer([edge("wall"), edge("shaft"), edge("desk")], entities, [
      { layer: "WALL", choice: "include", confidence: 1 },
      { layer: "管井", choice: "uncertain", confidence: 0.7 },
      { layer: "PL-家具", choice: "exclude", confidence: 0.99 },
    ]);
    expect(result.primary.map((item) => item.id)).toEqual(["wall"]);
    expect(result.repair.map((item) => item.id)).toEqual(["wall", "shaft"]);
    expect(result.excluded.map((item) => item.id)).toEqual(["desk"]);
    expect(result.counts).toEqual({ include: 1, uncertain: 1, exclude: 1 });
  });

  test("downgrades conflicting or low-confidence excludes to repair-only evidence", () => {
    const effective = effectiveRoomLayerDecisions([
      { layer: "WINDOW", choice: "exclude", confidence: 0.9 },
      { layer: "COLUMN", choice: "exclude", confidence: 0.52 },
      { layer: "PL-家具", choice: "exclude", confidence: 0.9 },
    ], ["WINDOW"]);
    expect(effective).toEqual([
      expect.objectContaining({ layer: "WINDOW", raw_choice: "exclude", choice: "uncertain", policy_reasons: ["direct_room_membership_evidence"] }),
      expect.objectContaining({ layer: "COLUMN", raw_choice: "exclude", choice: "uncertain", policy_reasons: ["low_exclude_confidence"] }),
      expect.objectContaining({ layer: "PL-家具", choice: "exclude" }),
    ]);
  });
});
