# Room Boundary Resolver v3

Date: 2026-09-20.

## Decision

Freeze the current two-round `room-resolve` implementation as an evaluation baseline. Build the next resolver around one candidate-first Candidate Boundary Graph instead of continuing to add relationship, retrieval, repair, surface-review, and structural-fallback stages to the existing pipeline.

The objective is not to make a closed polygon at any cost. The objective is to ensure that a correct, fully evidenced Candidate Boundary reaches Jev whenever the source drawing contains enough evidence, then distinguish candidate-recall failure from final semantic rejection.

## Evidence from the current system

Seven end-to-end evaluation variants have retained the same outcome: zero of six development rooms accepted. The variants added joint gap repair, segment-level review, multi-gap combinations, balanced surface retrieval, frontier retrieval, adjacent-segment evidence, and structural hypotheses. The test suite grew to 70 passing tests, but no variant demonstrated an accepted real room.

The final fixed-input evaluation shows that candidate construction fails before final adjudication:

| Room Seed | Area evidence | Final candidate areas | Outcome |
|---|---:|---:|---|
| 资料室 | 4.7 m² | 14.799 m² | Jev rejected the candidate. |
| 登记室 | 6.5 m² | 0.135 m² twice | Jev rejected duplicate local outlines. |
| 冷链室 | 10.3 m² | None | No valid candidate reached adjudication. |
| 哺乳室 | None | 3.657 and 3.477 m² | Both retained obstacle conflicts. |
| 接种室 | 21 m² | None | No valid candidate reached adjudication. |
| 留观区 | 33.2 m² | 455.683 m² | Jev rejected a much larger surrounding space. |

This is not evidence that Jev cannot judge rooms. In the three cases where a geometrically valid candidate reached Jev, the area and context indicate that rejection was appropriate. The main failure is Candidate Recall.

## Failure model

### The production entry point uses the weaker topology path

`room-resolve` builds candidates through `spatialCandidates`, which calls the exact face walker with a 0.01 mm snap tolerance. It does not use the opening-aware `walkRoomBoundaryFaces` path.

The repository already contains a second path with junction splitting, 50 mm snapping, opening portals, bounded virtual connections, and area-guided face selection. A real cold-room regression test finds a face close to the 10.3 m² annotation through that path. Maintaining both implementations allows the tested capability and production behavior to diverge.

### Area evidence is collected but does not constrain candidate retrieval

The current resolver asks Jev to associate an area annotation, then passes `minimumArea = 0` and an unbounded maximum to candidate adjudication. Area evidence therefore neither bounds the graph nor ranks candidates before the five-candidate limit. Tiny symbols and very large surrounding spaces can consume the candidate set.

Area is evidence, not acceptance authority. It should guide context scale, face filtering, and candidate order while Jev retains the final choice.

### A Source Entity is too coarse for a room-relative role

One Source Entity may contain exterior boundary intervals, internal drafting lines, duplicate geometry, and geometry belonging to an adjacent room. Assigning one global `boundary`, `same_space`, or `irrelevant` role to the whole entity either adds too much geometry or removes useful Boundary Surfaces. Segment review after failure is a repair for the wrong abstraction.

Boundary participation must be represented per Boundary Surface and per Candidate Boundary. Whole-object semantic decisions remain evidence but cannot be a hard gate.

### Repair search cannot recover geometry removed before graph construction

Gap enumeration and repair plans operate on the selected graph. If the correct Boundary Surface was excluded by context retrieval or a whole-object role decision, increasing gap reach, gap count, or combination count cannot restore it. The repeated 96-variant search limit is therefore a symptom, not the root cause.

### Error reporting conflates different failures

`context_budget_exhausted_with_defects` is emitted when rounds end with no candidate even when the request budget is not exhausted. This hides whether the missing result came from source geometry, Boundary Surface retrieval, topology construction, opening ambiguity, deterministic validation, or Jev rejection.

### There is no Reference Room Boundary

Acceptance rate alone cannot reveal where the correct boundary disappeared. A Reference Room Boundary is required to measure Boundary Surface recall, Candidate Recall, and adjudication separately. Without it, every optimization is an indirect experiment against a zero-success end result.

## v3 architecture

```text
DXF geometry and Jev semantic evidence
  -> Boundary Surface IR
  -> one Candidate Boundary Graph
  -> seed-containing Candidate Boundaries
  -> evidence-guided ranking and deduplication
  -> Jev comparison of complete candidates
  -> deterministic validation
  -> accepted / insufficient evidence / stage-specific failure
```

### Boundary Surface IR

Create a traceable interval-level representation with:

- source entity and physical-object provenance;
- exact interval geometry and geometry warnings;
- semantic type evidence;
- candidate-relative boundary, opening, obstacle, or non-boundary role;
- any Jev request hash that supports its role.

Whole objects may group Boundary Surfaces, but do not assign one irreversible room role to every interval in the object.

### One Candidate Boundary Graph

Consolidate topology construction into one implementation:

- split at real intersections and T-junctions;
- snap drafting endpoints with an explicit measured tolerance;
- deduplicate coincident intervals without losing provenance;
- represent doors and windows as opening evidence and mutually exclusive portal choices;
- retain columns as either obstacle rings or valid exterior boundary surfaces;
- restrict graph size using room scale and connectivity rather than a fixed first-N object gate.

The exact face path, standalone repair graph, and structural fallback must use this same graph or leave the production path.

### Candidate-first enumeration

Enumerate complete seed-containing faces before asking for global object roles. If area evidence exists, derive a broad retrieval scale and area band from it. The current 0.25x to 4x band is an acceptable initial retrieval bound, but it is not an automatic acceptance rule.

Deduplicate candidates by ordered geometry and provenance. Allocate the candidate budget across distinct topology, opening choices, source groups, and area bands so equivalent tiny faces cannot crowd out a plausible room.

### Joint Jev adjudication

Present complete candidates with:

- ordered Boundary Surfaces;
- area evidence and nearby room annotations;
- every opening portal and unapproved virtual connection;
- candidate-relative object and obstacle relationships;
- conflicts with prior object or segment decisions;
- deterministic validation results.

Jev chooses a candidate, rejects all candidates, or reports insufficient evidence. Accepting a candidate approves only its displayed Boundary Surfaces and Virtual Boundary Edges; it does not relabel entire Source Entities.

### Deterministic validation

After semantic selection, verify closure, seed containment, continuity, self-intersection, reused intervals, obstacle containment, overlapping holes, and provenance for every Virtual Boundary Edge. Geometry can invalidate a selected candidate but cannot substitute another candidate or create semantic membership.

## Failure outcomes

Replace the current aggregate failure with stage-specific outcomes:

- `source_geometry_missing`
- `boundary_surface_not_retrieved`
- `topology_no_seed_face`
- `opening_connection_unresolved`
- `candidate_failed_geometry`
- `jev_rejected_candidates`
- `insufficient_evidence`
- `model_or_transport_error`

Each report must record the last successful stage, truncation limits, and whether a Reference Room Boundary was present in the source pool and candidate set.

## Evaluation contract

Create human-reviewed Reference Room Boundaries for the six development rooms and at least one held-out Drawing Region. The fixtures remain separate from inference outputs and never alter production decisions.

Report these metrics independently:

1. Source geometry coverage.
2. Reference Boundary Surface recall.
3. Candidate Recall at K.
4. Candidate validity rate.
5. Jev adjudication result when the reference-equivalent candidate is present.
6. Incorrect-candidate acceptance count.
7. Request count, cost, and strict replay status.

The v3 development milestone is complete only when all six reference-equivalent candidates appear in the bounded candidate set, invalid candidates cannot be accepted, and all reports replay exactly. Final model acceptance and held-out performance are reported separately so candidate generation cannot be hidden behind one aggregate success rate.

## Migration

Retain:

- source-geometry extraction and provenance;
- Jev decision transport, journals, hashes, cache, and replay;
- explicit Virtual Boundary Edges;
- deterministic geometry and obstacle validation;
- final Jev authority from ADR-0002.

Move out of the production path after v3 reaches parity:

- two-round 48-to-96 object orchestration;
- whole-object room roles as graph filters;
- failure-triggered surface review;
- repair enumeration on an already filtered graph;
- structural hypotheses as a final fallback;
- exact 0.01 mm face walking as the main path;
- insertion-order `slice(0, 5)` candidate selection.

Keep the v2 implementation and its reports as a reproducible baseline until the v3 reports and held-out evaluation are complete.

## Delivery slices

The implementation is tracked by [GitHub issue #1](https://github.com/L1nding/jev/issues/1):

1. [Define Reference Room Boundary fixtures and stage metrics](https://github.com/L1nding/jev/issues/2).
2. [Produce the cold-room candidate through one Candidate Boundary Graph](https://github.com/L1nding/jev/issues/3).
3. [Adjudicate complete Candidate Boundaries with deterministic validation](https://github.com/L1nding/jev/issues/4).
4. [Establish Candidate Recall for all six development rooms](https://github.com/L1nding/jev/issues/5).
5. [Switch `room-resolve` to v3 and report stage-specific failures](https://github.com/L1nding/jev/issues/6).
6. [Evaluate v3 on a held-out Drawing Region](https://github.com/L1nding/jev/issues/7).
