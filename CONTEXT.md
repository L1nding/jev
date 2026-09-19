# CAD Semantic Modeling

This context describes the language used to turn CAD drawings into renderer-independent semantic building data.

## Source drawing

**Source Drawing**:
The original CAD document supplied for analysis. It may contain several spatially separated plans, annotations, reusable blocks, and unrelated drafting content.
_Avoid_: Floor Plan, when the file has not yet been segmented

**Drawing Region**:
A spatially coherent portion of a Source Drawing that can be analyzed as one plan, detail, or sheet-like unit.
_Avoid_: Page, Sheet

**Analysis Window**:
A temporary, bounded view into a Drawing Region containing an owned core and an overlapping context halo. It limits computation without becoming a permanent semantic boundary.
_Avoid_: Drawing Region, Tile, Final Partition

**Owner Window**:
The one Analysis Window responsible for emitting a Source Entity or Semantic Candidate. Ownership is deterministic and does not prevent neighboring windows from seeing the entity as context.
_Avoid_: Primary Window

**Context Membership**:
The appearance of a Source Entity in a neighboring Analysis Window because its bounding box intersects that window's halo.
_Avoid_: Duplicate Entity

**Source Entity**:
One addressable CAD element from the Source Drawing, such as a line, polyline, arc, text item, hatch, dimension, or block reference.
_Avoid_: Object, Shape

**Block Definition**:
A reusable group of CAD entities whose geometry is instantiated by one or more Block References.
_Avoid_: Component

**Block Reference**:
A placed instance of a Block Definition with its own transform and attributes.
_Avoid_: Block, Insert

## Interpretation

**Geometry Feature**:
A measured fact derived from Source Entities, such as length, angle, parallel distance, intersection, closure, adjacency, or bounding box.
_Avoid_: Semantic Feature

**Topology Relation**:
A relation between Source Entities or candidates, such as connected-to, intersects, contains, bounds, or opens-into.
_Avoid_: Geometry

**Semantic Candidate**:
A group of Source Entities proposed as one meaningful building element before its type is resolved.
_Avoid_: Entity, Object

**Object Membership Decision**:
An authoritative decision about whether a Source Entity or Semantic Candidate belongs to the same physical building element as a designated seed. Jev owns this decision; spatial proximity only selects context for consideration.
_Avoid_: Geometry Group, Nearby Match

**Semantic Element**:
One accepted physical or spatial building object, such as a particular wall, window, door, column, or room, composed of one or more Source Entities and backed by Jev decisions.
_Avoid_: Source Entity, Semantic Type

**Room Seed**:
An addressable point or room-name annotation used to identify which spatial enclosure a room-membership question refers to. A Room Seed identifies the query target but is not itself a room boundary.
_Avoid_: Room, Room Polygon

**Boundary Validation**:
A deterministic check of whether the Source Entities selected by Jev form a geometrically coherent closed boundary. It can report defects but cannot add, remove, or relabel semantic members.
_Avoid_: Room Detection, Semantic Decision

**Boundary Defect**:
A specific topological problem preventing a proposed room boundary from being accepted, such as an open endpoint, disconnected component, dangling branch, duplicate face, or illegal self-intersection.
_Avoid_: Semantic Error, Bad Room

**Virtual Boundary Edge**:
A non-physical edge that preserves room enclosure topology across an opening, corner tolerance, or explicitly accepted drafting gap. It never becomes a wall in a Scene Plan.
_Avoid_: Generated Wall, Fake Wall

**Ordered Room Boundary**:
A single directed cycle of Wall Elements and Virtual Boundary Edges that encloses one Room Seed and records the Jev decisions used to traverse it.
_Avoid_: Unordered Boundary Set, Room Candidate

**Boundary Surface**:
One traceable interval of source geometry that may participate in a candidate room boundary. Its role is relative to a Candidate Boundary, so one Source Entity may contribute several Boundary Surfaces with different roles.
_Avoid_: Whole-Object Boundary Role, Wall Entity

**Candidate Boundary Graph**:
A bounded planar graph of Boundary Surfaces and candidate Virtual Boundary Edges from which complete room enclosures are enumerated for a Room Seed.
_Avoid_: Selected Object Set, Repair Graph

**Candidate Boundary**:
A complete, geometrically validated enclosure proposed for a Room Seed before final semantic acceptance. It records every physical and Virtual Boundary Edge and the evidence for including it.
_Avoid_: Room, Accepted Boundary

**Reference Room Boundary**:
A human-reviewed ordered boundary used only to evaluate Boundary Surface recall, candidate recall, and final adjudication. It never overrides a production decision.
_Avoid_: Automatic Correction, Ground-Truth Rule

**Candidate Recall**:
Whether a Candidate Boundary equivalent to a Reference Room Boundary appears in the bounded candidate set presented for adjudication.
_Avoid_: Acceptance Rate, Geometry Closure Rate

**Boundary Repair Decision**:
A Jev decision selecting one typed action for a Boundary Defect from geometrically enumerated options.
_Avoid_: Automatic Fix, Geometry Rule

**Semantic Type**:
The canonical meaning assigned to a Semantic Candidate, such as wall, door, window, column, stair, room, furniture, annotation, or unknown.
_Avoid_: Entity Type, CAD Type

**Evidence**:
The source facts supporting a semantic decision, including layers, block names, text, geometry, topology, and model outputs.
_Avoid_: Reasoning

**Decision Authority**:
The component whose typed output is authoritative for a semantic or relationship decision. In the main path, this is Jev; deterministic rules provide evidence or diagnostics.
_Avoid_: Rule Winner, Baseline Label

**Confidence**:
A normalized estimate of how strongly the available Evidence supports a semantic decision.
_Avoid_: Accuracy, Certainty

## Intermediate representations

**CAD IR**:
A normalized, loss-aware representation of Source Entities, transforms, layers, text, blocks, and derived Geometry Features.
_Avoid_: Parsed DXF, Raw JSON

**Semantic CAD IR**:
Renderer-independent building elements produced by enriching CAD IR with Semantic Types, geometry, provenance, Evidence, and Confidence.
_Avoid_: Scene, Blender Model

**Scene Plan**:
An ordered set of renderer-facing construction operations derived from Semantic CAD IR.
_Avoid_: Semantic IR, Blender Script

**Correction**:
A human-provided replacement or confirmation of a semantic decision that can be replayed on later runs.
_Avoid_: Override, Label
