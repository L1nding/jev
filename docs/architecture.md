# DXF to semantic 3D architecture

## Goal

Turn a DXF drawing into a traceable, correctable semantic building model, then generate an executable 3D Scene Plan. The first target is architectural plan data and Blender, while the semantic representation must remain usable by other renderers and BIM pipelines.

```text
DXF
  ↓
DXF parser and drawing-region segmentation
  ↓
CAD IR
  ↓
Spatial index and overlapping analysis windows
  ↓
Geometry and topology extraction
  ↓
Jev decisions
  ↓
Semantic CAD IR
  ↓
Coding agent / planner
  ↓
Scene Plan
  ↓
Blender MCP / bpy
```

## Responsibility boundaries

### DXF parser

- Reads the DXF with `ezdxf`.
- Preserves handles, layers, layouts, block definitions, block references, transforms, text, dimensions, and source coordinates.
- Normalizes supported geometry without discarding provenance.
- Does not assign architectural meaning.

### Drawing-region segmentation

- Finds spatially coherent plans or details inside model space.
- Separates large coordinate clusters before semantic analysis.
- Associates nearby titles, scale text, level text, and dimensions with each region.

### Analysis windows

- Subdivide one Drawing Region for bounded geometry and topology work.
- Each window has a non-overlapping owned core plus a context halo that overlaps neighboring windows.
- Source Entities keep global identifiers and may appear as context in more than one window.
- Only the window owning a candidate anchor emits that candidate; neighboring copies provide context only.
- Candidates crossing window boundaries are reconciled after local analysis using source identifiers, geometry overlap, and topology continuity.
- Window boundaries are computational details and never become walls, rooms, or other semantic boundaries.

A fixed grid is acceptable for the first implementation when combined with a halo and deterministic ownership. Later versions can use density-aware or connected-component partitioning without changing CAD IR or Semantic CAD IR.

### Geometry and topology analysis

- Computes lengths, directions, bounding boxes, parallel distances, intersections, connectivity, containment, and closed boundaries.
- Forms Semantic Candidates from related Source Entities.
- Produces facts and candidate groups; it does not create Blender geometry.

### Optional deterministic diagnostics

- `semantic_baseline` and `semantic_enrichment` summarize layer, block, geometry, and topology signals for debugging and evaluation.
- They do not decide the production Semantic Type, wall relationship, or opening relationship.
- Their labels must not overwrite Jev decisions.

### Jev

- Owns semantic and relationship decisions in the main path.
- Receives source facts, geometry features, and local context as state.
- Classifies or scores bounded semantic questions.
- Returns typed answers, probabilities, and confidence.
- Does not generate scripts, plan workflows, call tools, or construct meshes.

### Room boundary resolution

- Operates on Wall Elements and Opening Elements rather than unordered DXF lines.
- Maintains an ordered traversal state beginning at a Room Seed.
- Geometry retrieves reachable next edges and reports Boundary Defects; it does not choose semantic membership.
- Jev chooses the starting wall, each next edge, typed repair actions, and the final enclosure.
- A small probabilistic beam preserves alternative paths when Jev probabilities are close.
- Door, window, corner, and accepted drafting-gap continuity is represented by Virtual Boundary Edges, not physical walls.
- Only a validated closed cycle can become an Ordered Room Boundary in Semantic CAD IR.

See [Jev ordered room-boundary traversal](./jev-room-boundary-traversal.md).

Current OpenRouter integration:

```text
Endpoint: https://openrouter.ai/api/alpha/decisions
Model:    typesafe/jev-1.13
```

The OpenRouter page alias `~typesafe/jev-latest` is not currently accepted as the Decisions API model value. The implementation therefore defaults to the concrete version and exposes `OPENROUTER_MODEL` for upgrades.

### Coding agent / planner

- Converts validated Semantic CAD IR into a Scene Plan.
- Applies modeling policies such as default wall height and opening behavior.
- Selects and calls execution tools.

### Blender MCP / bpy

- Executes the Scene Plan.
- Creates and modifies Blender objects and meshes.
- Reports execution results using stable Semantic CAD IR identifiers.

## Data contracts

### CAD IR source entity

```json
{
  "id": "source:2F1A",
  "source_handle": "2F1A",
  "entity_type": "LINE",
  "layer": "WALL",
  "region_id": "region:ground-floor",
  "geometry": {
    "start": [0, 0, 0],
    "end": [5000, 0, 0]
  }
}
```

### Evidence bundle presented to Jev

```json
{
  "source_entity": "source:2F1A",
  "evidence": {
    "layer": "WALL",
    "entity_type": "LINE",
    "geometry": {
      "start": [0, 0],
      "end": [5000, 0]
    },
    "nearby_text": []
  }
}
```

Jev receives source facts and derived geometry as evidence. It decides whether the entity is a `wall`, `door`, `window`, `column`, `stair`, `furniture`, `annotation`, or `unknown`; relationship questions use the same evidence-first contract.

### Semantic CAD IR

```json
{
  "id": "semantic:wall:12",
  "type": "wall",
  "source_entities": ["source:2F1A", "source:2F1B"],
  "geometry": {
    "centerline": [[0, 120], [5000, 120]],
    "thickness_mm": 240,
    "height_mm": 2800
  },
  "decision": {
    "method": "jev",
    "model": "typesafe/jev-1.13-20260917",
    "confidence": 0.98,
    "evidence_codes": ["source-layer", "line-geometry"]
  }
}
```

### Scene Plan

```json
{
  "operations": [
    {
      "operation": "create_wall",
      "semantic_id": "semantic:wall:12",
      "start_mm": [0, 120],
      "end_mm": [5000, 120],
      "thickness_mm": 240,
      "height_mm": 2800
    }
  ]
}
```

## Required properties

- Every semantic element points back to its Source Entities.
- Source coordinates and normalized local coordinates are both recoverable.
- Unknown and ambiguous candidates are valid outputs.
- Rules and model decisions record their evidence and version.
- Corrections are stored separately and replayed, rather than mutating the source DXF.
- Blender-specific object names and mesh details do not enter Semantic CAD IR.
- Analysis-window boundaries do not appear in Semantic CAD IR.
- Geometry and topology are evidence for decisions; local geometry rules are not the authority for semantic meaning.
