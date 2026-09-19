# Implementation plan

## Product slice

The first useful slice is:

```text
one selected drawing region
  → wall / door / window / column / unknown candidates
  → reviewable Semantic CAD IR
  → simple wall-only Scene Plan
  → Blender preview
```

This slice tests every boundary without requiring complete support for the 193 MB source drawing.

## Stage 0: repeatable DXF inventory

**Status: implemented.** Run with `bun run inventory`.

Deliver a Bun-invoked profiling command backed by Python and `ezdxf`.

Outputs:

- file metadata and units;
- model-space and layout counts;
- layer and entity distributions;
- block definition and reference statistics;
- coordinate density and candidate Drawing Regions;
- representative text and block names;
- warnings for extreme extents, unusual Z values, unsupported entities, and corrupt geometry.

Acceptance criteria:

- The current sample can be profiled without loading expanded block geometry into one huge JSON document.
- A second run produces stable region identifiers and counts.
- Profiling output is saved as compact JSON and a readable Markdown summary.

Current sample result:

- 50,433 model-space entities scanned and audited in about 19–20 seconds;
- peak resident memory is about 1.7 GiB because `ezdxf` loads the 193 MB document model in memory;
- 49,616 entities assigned lightweight spatial anchors;
- 25 candidate Drawing Regions using 50,000 mm cells, a 20-entity density threshold, and a one-cell halo;
- repeated scans produce identical region identifiers, bounds, counts, and ordering;
- reports are written under `reports/inventory/`.

The current density-grid regions are discovery candidates. Stage 1 must confirm and refine them using drawing titles, frames, spatial gaps, and region-level geometry.

## Stage 1: region selection and CAD IR

**Status: implemented.** Run `bun run export-region --region <region-id>` after Stage 0.

Build spatial segmentation and export one selected Drawing Region.

Key choices:

- region detection from entity bounding boxes and spatial density;
- local coordinate origin per region while preserving source coordinates;
- block references remain references unless selectively expanded;
- dimensions, hatches, axes, and annotations remain available but can be excluded from primary geometry candidate generation;
- original handles become stable Source Entity identifiers.

Acceptance criteria:

- A user can list regions with bounding boxes, titles, probable scale, and entity counts.
- A user can export one region to CAD IR.
- Every exported item maps back to a DXF handle and source block path.

Current implementation exports `cad-ir-v1` JSON plus a Markdown summary. It keeps block references as opaque source items and records source/local coordinates, geometry, layers, scalar DXF attributes, and provenance. The export uses the Stage 0 assigned cells by default, so sparse entities inside the outer rectangle from another drawing are not accidentally included.

The semantic-layer fixture `region-c665ea89ba4f` exports 8,688 entities, including 2,648 `WALL` lines, 856 `WINDOW` lines, 280 `PL-DOOR` block references, and 152 `COLUMN` block references. `region-a8ec9a559249` remains a smaller 1,199-entity fixture for testing annotations and sparse detail plans.

## Stage 1.5: spatial index and analysis windows

**Status: implemented.** Run `bun run windows <cad-ir.json>`.

Subdivide the selected Drawing Region into temporary work units before candidate extraction.

Initial implementation:

- build a spatial index over entity and block-reference bounding boxes;
- create fixed-size core windows with a configurable context halo;
- include an entity in every window whose core or halo intersects its bounding box;
- assign each entity and candidate one deterministic owner window;
- retain global Source Entity IDs and region-local coordinates;
- merge boundary candidates after local extraction.

Starting parameters should be measured from the selected region rather than treated as final constants. A reasonable first trial is a core containing roughly 2,000–5,000 source primitives with a 2,000 mm halo. The halo must be at least as large as the maximum neighborhood distance used by wall, door, and window candidate builders.

Acceptance criteria:

- Candidate counts and geometry are stable when the window origin shifts.
- No duplicate semantic elements survive reconciliation.
- A wall, door, or window crossing a window boundary is reconstructed as one candidate.
- Reprocessing one window does not require reparsing the entire DXF.

Current implementation emits `analysis-windows-v1`. Ownership uses the entity anchor's core cell, while membership uses bounding-box intersection with the halo. Window manifests contain entity references and roles (`owner` or `context`) instead of duplicating CAD IR geometry.

## Stage 2: optional deterministic diagnostics

**Status: implemented as an optional diagnostic.** Run `bun run baseline <cad-ir.json>`.

Summarize obvious signals for debugging and evaluation. These outputs do not decide the main Semantic CAD IR.

Initial signals:

- semantic layer vocabulary;
- block reference layer and block name;
- inherited effective layer for entities inside blocks;
- basic geometry signatures;
- annotation exclusion rules.

Candidate builders:

- parallel line or polyline pairs for walls;
- door block references and line-plus-arc swing patterns;
- window line groups embedded in wall candidates;
- closed or block-based column shapes.

Each result includes decision method, evidence codes, confidence, and unresolved alternatives.

Acceptance criteria:

- Produce candidates rather than one label per primitive entity.
- Keep ambiguous candidates as `unknown`.
- Generate a review bundle that can be manually checked against a rendered region.

Current implementation emits `semantic-baseline-v1` primitive candidates. It uses layer and block-name tokens as evidence, classifies drafting entities as possible annotations, and carries Analysis Window ownership into each candidate. Its labels are diagnostic comparisons only.

### Stage 2.1: optional geometric diagnostics

**Status: implemented.** Run `bun run enrich <semantic-baseline.json>`.

The enrichment output keeps primitive candidates in the baseline report and adds `wall_pair` groups plus `opening_on_wall` relations for diagnostics. These rules are outside the main target path; Jev should make semantic and relationship decisions from the supplied evidence.

## Stage 3: Jev decisions

**Status: implemented as a batch runner.** Run `bun run jev <cad-ir.json>` for a 32-entity trial, or add `--all` after checking the request and cost.

The runner sends batches of typed `choice` questions to OpenRouter's Decisions API. Each question receives the source handle, entity type, layer, block name, text, local geometry, local anchor, and local bounding box. The output records Jev's choice, confidence, probabilities, model, provider, usage, and request ID. No deterministic semantic label is used as an answer override.

### Evaluation and follow-up

The first runner classifies source entities directly. Relationship questions can be added later using the same evidence-first contract; deterministic wall pairs remain comparison data rather than authoritative input.

Suggested first question:

```json
{
  "type": "choice",
  "instructions": "Classify the architectural meaning of this candidate from the supplied CAD evidence.",
  "criteria": {
    "wall": "A wall or wall pair that bounds architectural space.",
    "door": "A door or door opening, including its swing representation.",
    "window": "A window or glazed opening embedded in a wall.",
    "column": "A structural column or pier.",
    "annotation": "Drafting information rather than building geometry.",
    "unknown": "The evidence does not support one of the other meanings."
  }
}
```

The state should include compact numerical features, raw and effective layers, block names, nearby text, and topology facts. Raw DXF text should be truncated and normalized. Deterministic labels are not required and must not override the response.

Evaluation set:

- stratified samples from obvious semantic layers;
- ambiguous layer-0 and anonymous-block samples;
- hard negatives such as dimensions, grids, furniture, hatches, and repeated symbols;
- manually reviewed labels stored separately from inference output.

Metrics:

- precision and recall per semantic type;
- unknown rate;
- calibration by confidence band;
- cost and latency per candidate;
- disagreement between rules, Jev, and human labels.

Acceptance criteria:

- Jev improves at least one defined ambiguity set over the deterministic baseline.
- All requests and responses are reproducible from versioned candidate fixtures.
- Low-confidence and rule/model disagreement cases enter the review queue.

Current window fixture:

- `window-0f28c192908f` contains 1,415 owned Source Entities;
- the full-window run completed in 45 batches with zero missing answers;
- Jev returned 554 wall, 151 window, 131 door, 28 column, 297 furniture, 172 annotation, 81 unknown, and 1 stair decisions.

## Stage 3.5: Jev object and room relationship probes

**Status: initial probe implemented.** Run `bun run jev-object` with a Source Entity seed.

Element mode asks Jev whether nearby entities with an existing Jev Semantic Type belong to the same physical element as the seed. Room mode uses a room-name annotation as a Room Seed and asks Jev whether nearby entities are boundary, opening, interior, unrelated, or uncertain.

Spatial radius and Analysis Windows only retrieve bounded context. They are not evidence that entities belong to the same object. Deterministic code may validate closure after Jev has selected room boundary members, but it cannot repair membership or overwrite relationship decisions.

Current probes:

- wall seed `source:3DFDDA`: after clarifying that opposite faces, duplicate lines, caps, and continuous fragments may belong to one Wall Element, Jev accepted one connected wall fragment and rejected 31 nearby wall entities;
- room seed `source:3DFB32` (`冷链室`): after adding nearby room-name/area context and prioritizing structural candidates, Jev selected 15 boundary and 4 opening entities while rejecting 45 nearby structural entities;
- the selected room boundary is still not closed: 16 supported line segments form 9 components with 20 odd-degree endpoints, so it remains a reviewable Room Candidate rather than an accepted room;
- the comparison viewer can focus on a Room Candidate and separately color boundary, opening, interior, and open-endpoint evidence. The current result shows that independent per-entity role questions improve filtering but do not impose one coherent ordered enclosure. The next room experiment should ask Jev to traverse or adjudicate an ordered boundary over accepted wall elements rather than treating raw wall faces as an unordered set.

## Stage 3.6: ordered room-boundary traversal and repair

**Status: initial traversal implemented.** See [Jev ordered room-boundary traversal](./jev-room-boundary-traversal.md) and [ADR 0003](./adr/0003-jev-guides-room-boundary-repair.md).

The `RoomBoundaryResolver` deep module will:

- select a starting Wall Element through Jev;
- ask Jev to choose each next Wall Element, Opening Element, Virtual Boundary Edge, or cycle closure;
- keep a small beam of high-probability traversal branches instead of committing greedily to one path;
- enumerate typed repair options for open endpoints, disconnected components, false edges, and drafting gaps;
- let Jev choose repair actions while geometry applies and validates them;
- ask Jev to adjudicate complete closed cycles against room-name and area evidence;
- emit an Ordered Room Boundary only after closure and containment checks pass.

Initial acceptance criteria:

- `冷链室` produces at least one ordered traversal attempt with every step linked to a Jev request and probability;
- door gaps are represented by Virtual Boundary Edges and do not become walls;
- incomplete traversals report exact Boundary Defects and remain visualizable;
- no repair may introduce arbitrary coordinates or silently change semantic membership.

Current `冷链室` result:

- 55 Jev wall Source Entities produced 77 provisional line segments;
- Jev evaluated 5 batches of possible wall-assembly pairs and reduced them to 48 Wall Elements, including 18 multi-member groups and 36 accepted `same_wall_assembly` relations;
- geometric junction segmentation produced 134 Wall Boundary Segments while preserving their parent Wall Element IDs;
- Jev traversal now records ordered wall edges, Virtual Boundary Edges, probabilities, start/termination points, and alternative beam branches;
- Room Seed containment and the nearby `10.3m²` annotation prevent small wall-thickness loops from being accepted as rooms;
- the current beam still ends `uncertain` without a valid closed path. Visualization shows that high-probability branches continue along one parent wall past a room junction, so the next refinement is explicit junction-level turn adjudication rather than increasing the raw step count.

## Stage 3.7: candidate-first room-boundary graph

**Status: planned.** See [Room Boundary Resolver v3](./room-boundary-v3-design.md) and [ADR 0004](./adr/0004-candidate-first-room-boundary-graph.md).

The experiments after Stage 3.6 established that adding relationship retries, segment review, gap combinations, frontier retrieval, and structural fallbacks to separate candidate paths does not produce a coherent enclosure. Seven fixed-input evaluations remained at zero accepted rooms because correct Candidate Boundaries generally did not reach final adjudication.

The v3 slice will:

- introduce Boundary Surface and Reference Room Boundary fixtures;
- consolidate snapping, junction splitting, opening portals, face enumeration, and candidate deduplication into one Candidate Boundary Graph;
- use room-area evidence to bound and rank retrieval without granting semantic acceptance;
- compare complete Candidate Boundaries through Jev instead of committing to whole-object room roles first;
- report Boundary Surface recall, Candidate Recall, validation, adjudication, and replay separately;
- preserve v2 reports as a frozen baseline until held-out evaluation is complete.

Acceptance criteria:

- Every one of the six development Reference Room Boundaries has an equivalent candidate in the bounded candidate set.
- Invalid geometry and unresolved obstacle conflicts cannot be accepted.
- Complete-candidate choices preserve source and Virtual Boundary Edge provenance.
- All development reports replay exactly with zero new model requests.
- At least one held-out Drawing Region is evaluated before v3 replaces the baseline entry point.

## Stage 4: Semantic CAD IR and corrections

Finalize renderer-independent schemas for walls, doors, windows, and columns.

Add a correction log containing:

- target semantic or candidate ID;
- replacement type or geometry;
- author and timestamp;
- reason;
- source fingerprint and pipeline version.

Acceptance criteria:

- Re-running the pipeline reapplies compatible corrections.
- Source, derived features, model decisions, and corrections remain distinguishable.

## Stage 5: wall-only Scene Plan and Blender preview

Convert accepted wall elements to `create_wall` operations and execute them through Blender MCP or a local `bpy` runner.

The first preview should use explicit modeling defaults:

- unit conversion from millimeters to Blender units;
- wall height policy;
- centerline and thickness convention;
- joint treatment at intersections;
- stable object names containing Semantic CAD IR IDs.

Acceptance criteria:

- One selected Drawing Region produces a recognizable wall layout.
- A Blender object can be traced back to Semantic CAD IR and DXF Source Entities.
- Re-running the same Scene Plan is idempotent or replaces a known generated collection.

## Later stages

- door and window openings;
- room-boundary extraction;
- stairs, columns, furniture, and vertical relationships;
- topology repair and wall merging;
- multiple regions and floors;
- IFC, GLB, Three.js, Unity, and NavMesh adapters.

## Decisions to resolve during design discussion

1. **First target region**: choose a specific plan within the source drawing, rather than treating the full file as the first fixture.
2. **Success definition**: decide whether the first milestone prioritizes semantic classification quality or a visible Blender wall preview.
3. **Review workflow**: choose between a generated HTML/SVG overlay, a desktop viewer, or reviewed JSON plus rendered PNGs.
4. **Coordinate policy**: decide how region-local coordinates, survey-like source coordinates, Z flattening, and floor levels are represented.
5. **Label policy**: decide which layer and block names are accepted as weak labels and which require manual verification.
6. **Runtime boundary**: decide whether Bun orchestrates a Python `ezdxf` worker or the parser runs as a separate service/process.
