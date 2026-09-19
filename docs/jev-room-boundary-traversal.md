# Jev ordered room-boundary traversal

## Objective

Resolve one Room Seed into an ordered, reviewable room boundary. Jev owns every relationship choice. Geometry code retrieves bounded options, applies the selected option, and validates the resulting topology; it does not silently choose which wall belongs to the room.

The first target is:

```text
Room Seed
  → select starting Wall Element
  → Jev chooses the next boundary element
  → repeat with accumulated traversal state
  → close the cycle
  → validate geometry
  → Jev accepts or rejects the complete enclosure
  → Ordered Room Boundary
```

## Prerequisite

Traversal operates on Wall Elements and Opening Elements, not directly on unordered DXF lines. A Wall Element may retain several source faces or fragments, but it exposes one traversal geometry with two logical ends. A door or window may contribute a Virtual Boundary Edge that closes room topology without becoming a physical wall in the Scene Plan.

The current raw-entity room probe remains useful as evidence, but it is not the traversal input.

## Deep module

`RoomBoundaryResolver` is the external seam. Callers provide one bounded problem and receive one outcome:

```ts
type RoomBoundaryResolver = (
  problem: RoomBoundaryProblem,
  decisions: JevBoundaryDecisionAdapter,
) => Promise<RoomBoundaryOutcome>;
```

The interface hides start selection, local option retrieval, probabilistic branching, traversal, repair, validation, and final adjudication.

```ts
type RoomBoundaryProblem = {
  roomSeed: RoomSeed;
  wallElements: WallElement[];
  openingElements: OpeningElement[];
  nearbyAnnotations: AnnotationEvidence[];
};

type RoomBoundaryOutcome =
  | { status: "accepted"; boundary: OrderedRoomBoundary; provenance: BoundaryDecisionTrace }
  | { status: "incomplete"; bestAttempts: BoundaryAttempt[]; defects: BoundaryDefect[] }
  | { status: "uncertain"; reason: string; reviewItems: string[] };
```

## Traversal state

Each active branch carries:

```ts
type BoundaryTraversalState = {
  startElementId: string;
  currentElementId: string;
  currentExitId: string;
  orderedEdges: BoundaryEdge[];
  visitedElementIds: string[];
  cumulativeProbability: number;
  defects: BoundaryDefect[];
};
```

The state sent to Jev also includes the Room Seed, normalized local coordinates, nearby room names and area labels, the current partial path, and the small set of available next options.

## Typed boundary edges

```ts
type BoundaryEdge =
  | { kind: "wall"; wallElementId: string; direction: "forward" | "reverse" }
  | { kind: "opening"; openingElementId: string; virtualEdgeId: string }
  | { kind: "junction"; fromExitId: string; toEntryId: string; virtualEdgeId: string };
```

An `opening` edge represents room continuity across a door or window. A `junction` edge represents a topological corner or small drafting gap selected by Jev. Neither edge creates a physical wall.

## Jev decisions

### 1. Starting wall

Geometry retrieves the nearest Wall Elements around the Room Seed. Jev chooses one option:

```text
start:<wall-id>:forward
start:<wall-id>:reverse
uncertain
```

### 2. Next edge

At the current exit, geometry enumerates only reachable options:

```text
wall:<wall-id>:forward
wall:<wall-id>:reverse
opening:<opening-id>
junction:<from-exit>:<to-entry>
close_cycle
dead_end
uncertain
```

Each option includes its source provenance, relative geometry, predicted new endpoint, nearby labels, and whether it revisits an existing element. Distance or intersection only makes an option available; Jev chooses the relationship.

### 3. Defect repair

If validation reports a Boundary Defect, geometry enumerates explicit repair options:

```text
add_existing_element:<element-id>
remove_false_edge:<edge-index>
bridge_opening:<opening-id>
join_endpoints:<exit-a>:<entry-b>
reverse_subpath:<from-index>:<to-index>
keep_unresolved
```

Jev cannot emit arbitrary coordinates. It chooses a typed option whose geometric consequence has already been calculated and can be validated.

### 4. Final enclosure

Once one or more closed paths exist, Jev makes a global choice using the complete paths:

```text
accept:<attempt-id>
reject_all
uncertain
```

The criteria include: contains the Room Seed, matches nearby room name and area evidence, does not absorb neighboring labeled rooms, and uses plausible wall/opening relationships.

## Probabilistic traversal

A single greedy choice can make an early mistake irreversible. The resolver therefore keeps a small beam, initially three branches:

1. Ask Jev for probabilities over available next edges.
2. Expand the highest-probability alternatives.
3. Prune branches that are geometrically impossible, repeat an edge illegally, leave the Analysis Window, or exceed the step limit.
4. Merge identical traversal states.
5. Continue until closed paths are produced or all branches terminate.

The beam width and maximum steps are resolver policy, not part of Semantic CAD IR.

## Geometry invariants

Geometry validation may reject an impossible operation, but it may not replace Jev's semantic choice with another option.

An accepted Ordered Room Boundary must:

- contain the Room Seed;
- form exactly one closed cycle;
- have no dangling ends;
- have no illegal self-intersection;
- use every non-virtual wall edge once;
- distinguish Virtual Boundary Edges from physical walls;
- preserve source and Jev decision provenance for every edge.

## Output

```json
{
  "id": "room:冷链室:01",
  "type": "room",
  "seed_source_id": "source:3DFB32",
  "ordered_boundary": [
    { "order": 0, "kind": "wall", "element_id": "wall:12", "direction": "forward" },
    { "order": 1, "kind": "opening", "element_id": "door:4", "virtual": true },
    { "order": 2, "kind": "wall", "element_id": "wall:18", "direction": "reverse" }
  ],
  "closed": true,
  "decision": {
    "authority": "jev",
    "confidence": 0.91,
    "trace_id": "boundary-trace:abc123"
  }
}
```

## Failure behavior

- `incomplete`: traversal found promising paths but none passed closure validation;
- `uncertain`: Jev repeatedly chose `uncertain`, probabilities were too diffuse, or several closed paths remained indistinguishable;
- no physical geometry is fabricated when repair fails;
- every incomplete attempt remains visualizable and reviewable.

## Initial implementation slice

1. Convert the Jev-selected walls around `冷链室` into provisional Wall Elements.
2. Implement start selection and `next edge` decisions with a beam width of three.
3. Support wall edges and door-opening Virtual Boundary Edges first.
4. Stop on the first validated closed path, then add final Jev adjudication.
5. Render traversal order, rejected branches, repairs, and remaining defects in the comparison viewer.
