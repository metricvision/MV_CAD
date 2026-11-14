"""MCP adapter to the running MetricCAD app (one shared geometry process).

Started and stopped by app.py. Clients connect through local Streamable HTTP.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, ProxyHandler, build_opener

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import CallToolResult, ImageContent, TextContent, ToolAnnotations
from starlette.responses import JSONResponse
from backend.cad_schema import SketchInput, SketchEdit, Operation, HelixInput, FeatureParameters, data

ROOT=Path(__file__).resolve().parent
INSTRUCTIONS="""Use native MetricCAD sketches, driving dimensions and feature operations.
Read the project and its revision before edits; use returned reference IDs.
Create each sketch with geometry, constraints and dimensions together. Check
remaining DOF and inspect both sketch and 3D previews. Keep the model editable.
On a revision conflict, re-read and re-plan; never overwrite a newer project.
Read get_capabilities and metriccad://guide for units, reference conventions,
dimensioning rules and a worked example. Do not export until geometry is valid.
"""

READ=ToolAnnotations(readOnlyHint=True,destructiveHint=False,idempotentHint=True,openWorldHint=False)
WRITE=ToolAnnotations(readOnlyHint=False,destructiveHint=False,idempotentHint=False,openWorldHint=False)
EXPORT=ToolAnnotations(readOnlyHint=False,destructiveHint=False,idempotentHint=True,openWorldHint=False)


class CADClient:
    def __init__(self, connection_file, timeout=180):
        self.connection_file=Path(connection_file)
        self.timeout=timeout
        self.http=build_opener(ProxyHandler({}))

    def call(self,action,arguments=None):
        try:
            connection=json.loads(self.connection_file.read_text(encoding="utf-8"))
        except (OSError,ValueError) as exc:
            raise ToolError("MetricCAD ist nicht verbunden. Zuerst python app.py starten. Verbindungsdatei: "+str(self.connection_file)) from exc
        url=connection.get("url","");parsed=urlsplit(url)
        if parsed.scheme!="http" or parsed.hostname not in ("127.0.0.1","localhost") or parsed.username or parsed.password:
            raise ToolError("Die Verbindungsdatei muss auf den lokalen MetricCAD-Server zeigen.")
        payload=json.dumps({"action":action,"arguments":arguments or {}},allow_nan=False).encode()
        request=Request(url+"/api",data=payload,headers={"Content-Type":"application/json","X-MetricCAD-Token":connection["token"]})
        try:
            with self.http.open(request,timeout=self.timeout) as response:return json.load(response)
        except HTTPError as exc:
            try:error=json.loads(exc.read())
            except (ValueError,OSError):error={"error":str(exc)}
            raise ToolError(json.dumps(error.get("details",error),ensure_ascii=False)) from exc
        except (URLError,TimeoutError,ConnectionError) as exc:
            raise ToolError("CAD-Verbindung unterbrochen. Prüfen, ob app.py läuft. Vor dem Wiederholen einer Änderung get_project aufrufen; eine Berechnung könnte bereits übernommen worden sein.") from exc


def make_server(client,port=8766):
    mcp=FastMCP("MetricCAD",instructions=INSTRUCTIONS,host="127.0.0.1",port=port,stateless_http=True,log_level="WARNING")

    @mcp.custom_route("/health",methods=["GET"])
    async def health(request):
        return JSONResponse({"pid":os.getpid()})

    def invoke(action,arguments,keep_document=False):
        result=client.call(action,arguments)
        # Do not repeatedly put meshes or entire projects into the model context.
        result.pop("preview",None);result.pop("sketch_result",None)
        if not keep_document and "project" in result:result["project"].pop("document",None)
        return result

    @mcp.tool(annotations=READ)
    def get_capabilities() -> dict[str, Any]:
        """Read supported operations, units, limits and modeling conventions before creating a model."""
        preferences=json.loads((ROOT/"config"/"modeling_preferences.json").read_text(encoding="utf-8"))
        return {"application":"MetricCAD","version":"0.23-mcp","native_format":{"version":2,"features":[]},
                "units":{"length":"mm","geometry_angles":"radians","dimension_angles":"degrees","revolve_and_helix_phase":"degrees"},
                "geometry_types":["rect","circle","polyline","arc","ellipse","spline"],
                "operations":["pad","pocket","revolve","revolve-pocket","fillet","chamfer","helix","sweep","sweep-pocket"],
                "relations":["coincident","horizontal","vertical","perpendicular","equal","concentric","tangent","mirror","rotation"],
                "dimension_types":["linear","distance","length","diameter","radius","angle"],
                "limits":{"features":50,"geometry_per_sketch":60,"dimensions_per_sketch":120,"geometry_parameters_per_sketch":240},
                "conventions":["Circle/arc a is the DIAMETER. Rectangle/ellipse a,b are full widths.",
                  "Provide stable IDs for geometry, points, dimensions and relations.",
                  "Omit dimension.position to enable automatic layout; supplied positions are manual.",
                  "Rectangles have a rotation DOF: add horizontal on bottom or an angle dimension.",
                  "A feature and its sketch share the same ID. apply_operation changes the sketch op.",
                  "Depth is finite, in mm. There is no through-all mode. symmetric extends depth to EACH side.",
                  "For a sketch on an existing face, query get_references first; use get_sketch for external references.",
                  "A pending_sketch means a browser edit has deferred its solid rebuild. Preserve that edit and coordinate before further work.",
                  "Backend supports parts via MCP. Existing assembly UI remains available; assembly MCP tools are not included."],
                "modeling_preferences":preferences,"guide_resource":"metriccad://guide"}

    @mcp.tool(annotations=READ)
    def list_projects() -> dict[str, Any]:
        """List existing shared projects and browser URLs. Choose the requested project; do not silently replace another."""
        return invoke("list_projects",{})

    @mcp.tool(annotations=WRITE)
    def create_project(name:str="Neues Projekt",document:dict|None=None) -> dict[str, Any]:
        """Create an empty project, or import an explicitly supplied native MetricCAD document. Returns project ID, revision and browser URL."""
        return invoke("create_project",{"name":name,"document":document})

    @mcp.tool(annotations=READ)
    def get_project(project_id:str="default",include_document:bool=True) -> dict[str, Any]:
        """Read the current revision and editable native feature tree, including sketches, driving dimensions and relations."""
        return invoke("get_project",{"project_id":project_id,"include_document":include_document},True)

    @mcp.tool(annotations=READ)
    def get_sketch(project_id:str,sketch_id:str) -> dict[str, Any]:
        """Inspect a solved sketch, its coordinate frame, support/external references, DOF and per-element constraint state."""
        return invoke("get_sketch",{"project_id":project_id,"sketch_id":sketch_id})

    @mcp.tool(annotations=READ)
    def get_references(project_id:str,before_feature:str|None=None) -> dict[str, Any]:
        """Get stable face/edge handles, normals, centers and frames. For editing a sketch, use before_feature=its ID. Do not use mesh indices as references."""
        return invoke("get_references",{"project_id":project_id,"before_feature":before_feature})

    @mcp.tool(annotations=WRITE)
    def create_sketch(project_id:str,expected_revision:int,sketch:SketchInput) -> dict[str, Any]:
        """Create one native multi-element sketch atomically with its geometry, relations and dimensions. Coordinates alone do not constrain it. Omit label positions for automatic layout."""
        return invoke("create_sketch",{"project_id":project_id,"expected_revision":expected_revision,"sketch":data(sketch)})

    @mcp.tool(annotations=WRITE)
    def edit_sketch(project_id:str,expected_revision:int,sketch_id:str,changes:SketchEdit) -> dict[str, Any]:
        """Edit an existing sketch and rebuild its dependents. Supplied arrays replace whole arrays; omitted fields stay unchanged. Read the sketch first to preserve its design intent."""
        return invoke("edit_sketch",{"project_id":project_id,"expected_revision":expected_revision,"sketch_id":sketch_id,
                                      "changes":changes.model_dump(mode="json",exclude_none=True,exclude_unset=True)})

    @mcp.tool(annotations=WRITE)
    def apply_operation(project_id:str,expected_revision:int,operation:Operation) -> dict[str, Any]:
        """Apply pad/pocket/revolve/sweep to an existing sketch ID, or append a fillet/chamfer using returned edge references. Failed operations leave the project unchanged."""
        return invoke("apply_operation",{"project_id":project_id,"expected_revision":expected_revision,"operation":data(operation)})

    @mcp.tool(annotations=WRITE)
    def create_helix(project_id:str,expected_revision:int,helix:HelixInput) -> dict[str, Any]:
        """Create a parametric helix reference. Create its profile with support={helix: returned ID}, then apply sweep or sweep-pocket. Profile axial height must be below pitch."""
        return invoke("create_helix",{"project_id":project_id,"expected_revision":expected_revision,"helix":data(helix)})

    @mcp.tool(annotations=WRITE)
    def set_dimension(project_id:str,expected_revision:int,sketch_id:str,dimension_id:str,value:float) -> dict[str, Any]:
        """Change an existing driving dimension and rebuild the dependent model. Values are mm, except angle dimensions in degrees."""
        return invoke("set_dimension",{"project_id":project_id,"expected_revision":expected_revision,"sketch_id":sketch_id,"dimension_id":dimension_id,"value":value})

    @mcp.tool(annotations=WRITE)
    def set_feature_parameters(project_id:str,expected_revision:int,feature_id:str,parameters:FeatureParameters) -> dict[str, Any]:
        """Change extrusion depth, fillet/chamfer size, revolution angle, helix parameters or feature name. Change sketch sizes through set_dimension."""
        return invoke("set_feature_parameters",{"project_id":project_id,"expected_revision":expected_revision,"feature_id":feature_id,
                                                "parameters":parameters.model_dump(mode="json",exclude_none=True,exclude_unset=True)})

    @mcp.tool(annotations=WRITE)
    def delete_feature(project_id:str,expected_revision:int,feature_id:str) -> dict[str, Any]:
        """Remove one feature and its sketch. If later references break, reject the deletion atomically; do not silently delete dependent work."""
        return invoke("delete_feature",{"project_id":project_id,"expected_revision":expected_revision,"feature_id":feature_id})

    @mcp.tool(annotations=WRITE)
    def layout_dimensions(project_id:str,expected_revision:int,sketch_id:str,force:bool=False) -> dict[str, Any]:
        """Arrange dimension labels and lines without changing geometry or constraints. Preserve manual positions by default. force=True also repositions manual labels."""
        return invoke("layout_dimensions",{"project_id":project_id,"expected_revision":expected_revision,"sketch_id":sketch_id,"force":force})

    @mcp.tool(annotations=READ)
    def inspect_model(project_id:str) -> dict[str, Any]:
        """Check solid validity, volume, bounds, sketch DOF and deferred browser edits. A valid solid alone does not imply well-constrained sketches."""
        return invoke("inspect_model",{"project_id":project_id})

    @mcp.tool(annotations=READ,structured_output=False)
    def get_preview(project_id:str,view:Literal["3d","top","front","right","sketch"]="3d",sketch_id:str|None=None,width:int=1100,height:int=760) -> CallToolResult:
        """Return an actual PNG of the model or dimensioned sketch for visual review. For view=sketch supply sketch_id. No open browser tab is required."""
        result=client.call("get_preview",{"project_id":project_id,"view":view,"sketch_id":sketch_id,"width":width,"height":height});encoded=result.pop("image_base64")
        return CallToolResult(content=[TextContent(type="text",text=json.dumps(result,ensure_ascii=False)),
                                      ImageContent(type="image",data=encoded,mimeType="image/png")],structuredContent=result)

    @mcp.tool(annotations=WRITE)
    def undo(project_id:str,expected_revision:int) -> dict[str, Any]:
        """Undo one committed browser or MCP edit. Revision increases, preserving conflict protection."""
        return invoke("undo",{"project_id":project_id,"expected_revision":expected_revision})

    @mcp.tool(annotations=WRITE)
    def redo(project_id:str,expected_revision:int) -> dict[str, Any]:
        """Redo one undone edit in the shared project history."""
        return invoke("redo",{"project_id":project_id,"expected_revision":expected_revision})

    @mcp.tool(annotations=EXPORT)
    def save_project(project_id:str) -> dict[str, Any]:
        """Write a portable native JSON project with all sketches, dimensions and features. Shared project state is also saved automatically after every successful edit."""
        return invoke("save_project",{"project_id":project_id})

    @mcp.tool(annotations=EXPORT)
    def export_model(project_id:str,format:Literal["step","stl","json"]="step") -> dict[str, Any]:
        """Export the current revision and return the local path plus browser download URL. JSON preserves editability; STEP/STL export calculated geometry."""
        return invoke("export_model",{"project_id":project_id,"format":format})

    @mcp.resource("metriccad://guide")
    def guide() -> str:
        """Native modeling and dimensioning workflow, reference semantics and examples."""
        return (ROOT/"docs"/"MODELING_GUIDE.md").read_text(encoding="utf-8")

    @mcp.resource("metriccad://examples/plate")
    def plate_example() -> str:
        """Native fully dimensioned plate with four equal holes and edge-relative placement."""
        return (ROOT/"examples"/"plate_with_holes.json").read_text(encoding="utf-8")

    return mcp


def main():
    parser=argparse.ArgumentParser(description="MetricCAD MCP adapter")
    default=Path(os.environ.get("METRICCAD_DATA_DIR",ROOT/".metriccad"))/"connection.json"
    parser.add_argument("--connection-file",type=Path,default=default)
    parser.add_argument("--port",type=int,default=8766,help="Lokaler MCP-Port")
    args=parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    server=make_server(CADClient(args.connection_file),port=args.port)
    server.run(transport="streamable-http")


if __name__=="__main__":main()
