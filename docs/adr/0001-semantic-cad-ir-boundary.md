# Keep Semantic CAD IR independent from Blender

The pipeline will represent walls, openings, rooms, columns, stairs, furniture, provenance, and confidence in a renderer-independent Semantic CAD IR. Blender-specific operations are produced later as a Scene Plan because binding semantic interpretation directly to `bpy` would make corrections, evaluation, alternative renderers, and future BIM export costly to add.

