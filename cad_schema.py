"""Typed public CAD inputs. Values are millimetres unless explicitly documented."""
from __future__ import annotations

from typing import Annotated, Literal, Union
from pydantic import BaseModel, ConfigDict, Field, model_validator

ID = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[^/]+$")]
Coordinate = Annotated[float, Field(ge=-10000, le=10000, allow_inf_nan=False)]
Positive = Annotated[float, Field(gt=0, le=10000, allow_inf_nan=False)]
Point2 = tuple[Coordinate, Coordinate]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Branch(Input):
    axis: Literal[0, 1, 2]
    side: Literal[-1, 1]


class EdgeReference(Input):
    faces: list[str] = Field(min_length=2, max_length=2)
    curve: str = Field(max_length=60)
    chain: Literal[True] | None = None
    branch: Branch | None = None


class Reference(Input):
    """Refer to returned stable IDs, never mesh triangle/face indices.

    point/edge: element ID and role; polyline roles are point IDs.
    rect roles: bl, br, tr, tl, center / left, right, bottom, top.
    circle/arc point role: center; axis role: horizontal or vertical.
    support-edge role: left/right/bottom/top, obtained from get_references.
    External references copy an entire returned external edge reference.
    """
    kind: Literal["point", "edge", "circle", "origin", "axis", "support-edge",
                  "support-point", "fixed-point", "geometry", "curve"]
    element: ID | None = None
    role: str | None = None
    endpoint: Literal[0, 1] | None = None
    external: EdgeReference | None = None
    vertex: list[str] | None = None
    position: Point2 | None = None


class Support(Input):
    plane: Literal["XY", "XZ", "YZ"] | None = None
    face: str | None = Field(default=None, max_length=2000)
    helix: ID | None = None

    @model_validator(mode="after")
    def one_reference(self):
        if sum(x is not None for x in (self.plane, self.face, self.helix)) != 1:
            raise ValueError("Exactly one of plane, face, helix is required")
        return self


class Point(Input):
    id: ID
    x: Coordinate
    y: Coordinate


class GeometryBase(Input):
    id: ID
    construction: bool = False


class Rectangle(GeometryBase):
    type: Literal["rect"]
    x: Coordinate
    y: Coordinate
    a: Positive = Field(description="Width, mm")
    b: Positive = Field(description="Height, mm")
    angle: Coordinate = Field(default=0, description="Rotation, radians")


class Circle(GeometryBase):
    type: Literal["circle"]
    x: Coordinate
    y: Coordinate
    a: Positive = Field(description="Diameter, NOT radius, mm")


class Arc(GeometryBase):
    type: Literal["arc"]
    x: Coordinate
    y: Coordinate
    a: Positive = Field(description="Diameter, mm")
    start: Coordinate = Field(description="Start angle, radians")
    sweep: Coordinate = Field(description="Signed angle, radians; less than a full circle")


class Ellipse(GeometryBase):
    type: Literal["ellipse"]
    x: Coordinate
    y: Coordinate
    a: Positive = Field(description="Full first axis length, mm")
    b: Positive = Field(description="Full second axis length, mm")
    angle: Coordinate = 0
    start: Coordinate = 0
    sweep: Coordinate = 6.283185307179586


class Polyline(GeometryBase):
    type: Literal["polyline"]
    points: list[Point] = Field(min_length=2, max_length=80)
    closed: bool


class Spline(GeometryBase):
    type: Literal["spline"]
    points: list[Point] = Field(min_length=4, max_length=4)
    closed: Literal[False] = False


Geometry = Annotated[Union[Rectangle, Circle, Arc, Ellipse, Polyline, Spline], Field(discriminator="type")]


class LabelLayout(Input):
    mode: Literal["auto", "manual"]
    last_position: Point2 | None = None


class Dimension(Input):
    id: ID
    kind: Literal["linear", "distance", "length", "diameter", "radius", "angle"]
    value: Annotated[float, Field(ge=0, le=10000, allow_inf_nan=False)]
    first: Reference | None = None
    second: Reference | None = None
    element: ID | None = None
    axis: Literal["x", "y"] | None = None
    sign: Literal[-1, 1] = 1
    flipFirst: Literal[-1, 1] = 1
    flipSecond: Literal[-1, 1] = 1
    position: Point2 | None = Field(default=None, description="Optional manual label position in sketch coordinates; omitted positions are laid out automatically")
    layout: LabelLayout | None = Field(default=None, description="Optional layout metadata when round-tripping an existing dimension")


class Relation(Input):
    id: ID
    kind: Literal["coincident", "perpendicular", "concentric", "horizontal", "vertical", "equal", "mirror", "rotation", "tangent"]
    first: Reference
    second: Reference | None = None
    axis: Reference | None = None
    center: Reference | None = None
    angle: Coordinate | None = Field(default=None, description="Rotation pattern angle, degrees")
    pattern: ID | None = Field(default=None, description="Native UI group ID for a rotation pattern")
    index: int | None = Field(default=None, ge=1, le=23)
    count: int | None = Field(default=None, ge=2, le=24)
    sweep: Annotated[float, Field(gt=0, le=360)] | None = Field(default=None, description="Total rotation pattern angle, degrees")
    orientation: Literal[-1, 1] = 1
    position: Point2 | None = None


class SketchInput(Input):
    id: ID | None = None
    name: str = Field(default="Skizze", min_length=1, max_length=200)
    support: Support
    geometry: list[Geometry] = Field(min_length=1, max_length=60)
    dimensions: list[Dimension] = Field(default_factory=list, max_length=120)
    relations: list[Relation] = Field(default_factory=list, max_length=120)


class SketchEdit(Input):
    """Supplied arrays replace their respective arrays. Omitted arrays are kept."""
    name: str | None = Field(default=None, min_length=1, max_length=200)
    support: Support | None = None
    geometry: list[Geometry] | None = Field(default=None, min_length=1, max_length=60)
    dimensions: list[Dimension] | None = Field(default=None, max_length=120)
    relations: list[Relation] | None = Field(default=None, max_length=120)


class Operation(Input):
    op: Literal["pad", "pocket", "revolve", "revolve-pocket", "sweep", "sweep-pocket", "fillet", "chamfer"]
    sketch_id: ID | None = None
    id: ID | None = None
    name: str | None = Field(default=None, max_length=200)
    depth: Positive | None = None
    reverse: bool = False
    symmetric: bool = False
    revolveAxis: Reference | None = None
    revolveAngle: Annotated[float, Field(gt=0, le=360)] | None = None
    path: ID | None = None
    amount: Positive | None = None
    edges: list[EdgeReference] | None = Field(default=None, min_length=1, max_length=30)


class HelixInput(Input):
    id: ID | None = None
    name: str = Field(default="Helix", max_length=200)
    axis: Literal["X", "Y", "Z"] = "Z"
    origin: tuple[Coordinate, Coordinate, Coordinate] = (0, 0, 0)
    radius: Positive
    pitch: Positive
    height: Positive
    phase: Coordinate = 0
    leftHand: bool = False
    reverse: bool = False


class FeatureParameters(Input):
    name: str | None = Field(default=None, max_length=200)
    depth: Positive | None = None
    amount: Positive | None = None
    reverse: bool | None = None
    symmetric: bool | None = None
    revolveAngle: Annotated[float, Field(gt=0, le=360)] | None = None
    radius: Positive | None = None
    pitch: Positive | None = None
    height: Positive | None = None
    phase: Coordinate | None = None
    leftHand: bool | None = None


def data(model: BaseModel) -> dict:
    return model.model_dump(mode="json", exclude_none=True)
