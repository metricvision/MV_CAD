# MetricCAD: native parametric modeling through MCP

Use `get_capabilities`, then `list_projects` and `get_project`. Match the user's
intended project; `default` is the initial browser project. Create a new project
when requested and return its `browser_url` so the user can open it. Existing
browser tabs stay attached to their chosen project.

## Model ownership and edits

- The running `app.py` process owns the projects. MCP and the browser use that
  same process. Do not create another geometry process to edit its files.
- Every mutation requires the current `expected_revision`; successful edits
  return the next revision. A conflict requires reading and replanning.
- Use the tools, not writes to `.metriccad/projects`. JSON exports are portable
  documents, not the authoritative live project files.
- `pending_sketch` means the browser has saved a solved sketch but deferred its
  solid and successors. Coordinate with the user's active edit before continuing.
- Changes are validated on a copy and committed atomically. A failed operation
  leaves the saved project and undo history unchanged.
- A timeout has an uncertain result: read the project before retrying.

## Units and native schema

The portable format is `{ "version": 2, "features": [...] }`. A feature contains
its sketch and operation; applying `pad` changes that sketch's `op` while keeping
its ID. The same sketch is still editable in the model tree.

Lengths and coordinates are millimetres. Geometry angles (`rect.angle`, arc
`start`/`sweep`, ellipse angles) are **radians**. Dimension angles, revolution
angles, and helix phase are **degrees**. Circle/arc `a` is the **diameter**;
rectangle and ellipse `a` and `b` are full dimensions, not half-axes.

Use `create_sketch` with all initial geometry, dimensions and relations together.
An empty sketch is not a valid persisted feature. An open polyline is valid as
an `op=sketch` reference, but an extrusion needs a closed, non-branching contour.

`edit_sketch` replaces only the supplied fields. A supplied `geometry`,
`dimensions` or `relations` array replaces that **whole array**. Read the current
sketch first and retain unrelated geometry and references.

## Stable references

Use returned semantic IDs, never mesh face indices or nearest-face guessing.

- Origin planes: `{"plane":"XY"}`, `XZ`, `YZ`.
- Body face: copy the `reference` object from `get_references`.
- Helix profile: `{"helix":"helix_id"}`.
- To edit an existing feature's support, query
  `get_references(project_id, before_feature=sketch_id)`.
- `get_sketch` returns the support `frame`, `targets`, projected `external`
  geometry and constraint state.
- A point on a rectangle: `{"kind":"point","element":"outline","role":"bl"}`.
  Other roles: `br`, `tr`, `tl`, `center`.
- A rectangle edge: `{"kind":"edge","element":"outline","role":"bottom"}`.
  Other roles: `left`, `right`, `top`.
- A circle center: `{"kind":"point","element":"hole","role":"center"}`.
- A polyline point uses its stable point ID as `role`; a segment uses its starting
  point ID. A spline is a cubic Bézier with four control points.
- Sketch axes: `{"kind":"axis","role":"horizontal"}` or `vertical`.
- Support boundary: `{"kind":"support-edge","role":"left"}` (or another
  role actually returned in `targets`). These roles are available only when the
  support boundary is uniquely identifiable.
- General external edges/vertices: copy their complete returned `external`
  reference and vertex signature. They are read-only inputs to the sketch solver.

If references disappear or become ambiguous, stop and choose a verified
replacement. Never silently attach a sketch to an arbitrary remaining face.

## Driving dimensions and geometric intent

Coordinates are initial values, **not constraints**. A rectangle has five
parameters including rotation. To fully define a centered rectangle, use:

1. A coincident relation between its center and the origin.
2. A horizontal relation on its bottom edge.
3. Width and height dimensions between corresponding corners.

For a circle, use a diameter or radius dimension and two independent position
constraints. Prefer equality/mirror/concentric relations when they express the
design, instead of separately specifying every related size. Do not add redundant
dimensions merely to create more labels.

Linear dimensions use `axis: "x" | "y"` and `sign: 1 | -1`:
`second[axis] - first[axis] = sign * value`. `value` itself is non-negative.
Right/top-edge-to-interior dimensions usually have sign -1; left/bottom use +1.
`length` measures a single straight edge; `distance` measures point/point or
perpendicular point/line/parallel-line spacing. `diameter`/`radius` use `element`.
Angles use two straight references, optional `flipFirst`/`flipSecond` and sign.

Omit `position` on new dimensions for automatic layout. Providing a position
marks it manual. `layout_dimensions(force=false)` retains manual placement;
`force=true` explicitly repositions all labels of that sketch. Layout alters
presentation only, not dimension values or geometry. Inspect the sketch PNG;
the layout report can still flag overlaps in very dense drawings. Positions are
stored in sketch units; very small browser viewports may require adjustment.

Read the project's `modeling_preferences.json` via `get_capabilities` and respect
the user's more specific instructions. A consistent convention is not a substitute
for the requested design intent.

## Example workflow: 80 × 50 × 8 plate with four Ø6 holes

The `metriccad://examples/plate` resource contains the fully editable finished
document. `examples/build_plate.py` executes the same workflow through the CAD
service and is also the test fixture.

1. Create the centered, horizontal 80 × 50 rectangle with driving width/height.
2. Apply `pad`, depth 8.
3. Query references and select the unique top plane by its normal and location.
4. Create four circles. Drive the lower-left circle by Ø6 and 10 mm from the left
   and bottom support boundaries. Mirror it about the sketch axes for the other
   three holes; those relations preserve both position symmetry and equal diameter.
5. Apply `pocket`, depth 8, from the top face.
6. Inspect the solid and both sketches (each should have 0 DOF), then request 3D
   and sketch previews.
7. A later width change to 100 moves the hole centers to x = ±40 while retaining
   y = ±15, Ø6, and 10 mm edge distances. Use `set_dimension` for this change.

Useful tool argument fragment for a width dimension:

```json
{
  "id": "width",
  "kind": "linear",
  "axis": "x",
  "first": {"kind": "point", "element": "outline", "role": "bl"},
  "second": {"kind": "point", "element": "outline", "role": "br"},
  "value": 80,
  "sign": 1
}
```

## Operations and completion

- `pad`/`pocket` require `sketch_id` and a positive `depth`. Depth is finite; there
  is no through-all mode. `symmetric=true` extends the given depth to **each side**.
- `revolve`/`revolve-pocket` require a sketch axis or straight construction line
  (`revolveAxis`) and `revolveAngle` up to 360 degrees.
- Fillet/chamfer append a feature with returned `edges` and positive `amount`.
  The kernel may reject excessive radii or unsupported contour propagation.
- Helix paths are independent reference features. A sweep uses one closed profile
  on that helix, with axial profile height below pitch and no crossing of the axis.
- Existing backend limits apply: 50 features, 60 geometry elements/240 parameters
  per sketch, 120 dimensions and 120 relations per multi-element sketch.
- `inspect_model` reports valid solids and sketch DOF. A valid solid does not by
  itself prove a fully constrained or semantically correct design.
- `get_preview` returns headless PNG views derived from the same geometry. It
  does not require an open browser and does not mutate the model.
- `save_project` exports native JSON with edit history structure (features,
  sketches, dimensions, relations). Session undo snapshots live separately in the
  project store. STEP/STL exports contain geometry, not the parametric feature tree.
- Assembly editing remains available in the existing UI. This MCP release
  controls Part Studio projects; it does not expose assembly/joint tools.
