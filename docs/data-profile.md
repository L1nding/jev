# DXF sample profile

Profiled on September 19, 2026.

## Source

```text
data/广州市妇女儿童医疗中心珠江新城院区总平顶视图.dxf
```

| Property | Observed value |
| --- | ---: |
| File size | 193 MB |
| DXF version | AutoCAD 2018 / AC1032 |
| Drawing units | Millimeters (`$INSUNITS = 4`) |
| Model-space entities | 50,433 |
| Layer definitions | 383 |
| Block definitions | 14,200 |
| Paper-space layouts | 2, each containing two viewports |

## Main entity distribution

| Entity | Count |
| --- | ---: |
| LINE | 21,709 |
| TEXT | 8,609 |
| DIMENSION | 6,715 |
| INSERT | 5,453 |
| LWPOLYLINE | 4,889 |
| ARC | 1,345 |
| HATCH | 817 |
| CIRCLE | 679 |
| MTEXT | 139 |

## Strong existing semantic signals

The file already contains architectural layer names. These should seed deterministic classification and evaluation labels.

| Signal | Representative content |
| --- | --- |
| Walls | `WALL`, `P-WALL1`, `RF-WALL`, `墙` |
| Doors | `PL-DOOR`, `P-DOOR`, `门`, `门线` |
| Windows | `WINDOW`, `PL-WINDOW`, `PL-窗`, `WINDOW-门洞` |
| Columns | `COLUMN`, `COLUMN-框`, `COLUMN_HATCH` |
| Vertical circulation | `STAIR`, `STAIR-楼梯`, `STAIR-电梯` |
| Furniture | `PL-家具`, named blocks such as `输液椅` and `办公电脑` |
| Annotation | `PUB_TEXT`, `PUB_DIM`, `AXIS` |

Observed model-space counts include 2,240 wall-layer lines, 800 window-layer lines, 176 door-layer block references on `PL-DOOR`, and 128 column block references on `COLUMN`.

## Structural findings

### The file contains multiple distant drawing regions

The declared extents run approximately from `(3,844,689, 5,806,687)` to `(5,976,546, 12,612,899)` millimeters. Entity density is split across many distant coordinate cells, including particularly dense clusters around `(5,900,000, 12,500,000)` and `(3,900,000, 5,600,000)`.

This indicates that the model space must be segmented before entity grouping. Treating the whole file as one floor plan would create false proximity and topology relationships.

### Blocks need selective expansion

The drawing has 14,200 block definitions and 5,453 block references. Some definitions are small reusable symbols, while at least one anonymous definition contains 24,511 entities and is referenced 17 times.

The parser should preserve block references by default and expand them only when required for geometry or semantic analysis. Blindly flattening every block would multiply data volume and destroy useful block identity.

### Layers are useful but insufficient

Architectural layer names provide strong weak labels, but layer `0` alone contains 14,393 model-space entities. Block contents also commonly live on layer `0` while the block reference carries the meaningful layer or name.

Classification therefore needs effective-layer inheritance, block context, geometry, topology, and nearby text in addition to the entity's raw layer.

### The drawing contains nonzero and inconsistent Z values

Most lines are at Z = 0, but some occur at Z = 3 and other small positive or negative values. The header minimum Z is approximately -18,700 mm.

Plan analysis needs a documented flattening policy and must retain original Z values for audit and later floor or elevation interpretation.

## Implications for the first prototype

1. Profile and segment the drawing before producing full CAD IR.
2. Select one bounded drawing region as the first evaluation fixture.
3. Use layer and block signals to create a deterministic baseline and a reviewable weak-label dataset.
4. Build candidates before calling Jev; do not ask Jev to classify 50,433 isolated entities.
5. Measure Jev against the deterministic baseline and a small manually reviewed truth set.

