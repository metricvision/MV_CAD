"""End-to-end CAD commands used both by the example and integration tests.

Run with app.py running: python examples/build_plate.py
The result is a regular editable MetricCAD project in the shared app.
"""
from __future__ import annotations

from pathlib import Path
import json
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))


def plate_sketch():
    def point(role):return {"kind":"point","element":"outline","role":role}
    return {"id":"plate","name":"Grundplatte","support":{"plane":"XY"},
            "geometry":[{"id":"outline","type":"rect","x":0,"y":0,"a":80,"b":50,"angle":0}],
            "dimensions":[
                {"id":"width","kind":"linear","axis":"x","first":point("bl"),"second":point("br"),"value":80},
                {"id":"height","kind":"linear","axis":"y","first":point("bl"),"second":point("tl"),"value":50}],
            "relations":[
                {"id":"origin","kind":"coincident","first":point("center"),"second":{"kind":"origin"}},
                {"id":"horizontal","kind":"horizontal","first":{"kind":"edge","element":"outline","role":"bottom"}}]}


def hole_sketch(support):
    def center(id):return {"kind":"point","element":id,"role":"center"}
    def mirror(id,a,b,axis):
        return {"id":id,"kind":"mirror","first":{"kind":"geometry","element":a},
                "second":{"kind":"geometry","element":b},"axis":{"kind":"axis","role":axis}}
    return {"id":"holes","name":"Vier Bohrungen","support":support,
            "geometry":[{"id":id,"type":"circle","x":x,"y":y,"a":6} for id,x,y in
                        [("h0",-30,-15),("h1",30,-15),("h2",-30,15),("h3",30,15)]],
            "dimensions":[
                {"id":"diameter","kind":"diameter","element":"h0","value":6},
                {"id":"edge_x","kind":"linear","axis":"x","first":{"kind":"support-edge","role":"left"},"second":center("h0"),"value":10},
                {"id":"edge_y","kind":"linear","axis":"y","first":{"kind":"support-edge","role":"bottom"},"second":center("h0"),"value":10}],
            "relations":[mirror("mirror_x","h0","h1","vertical"),mirror("mirror_y","h0","h2","horizontal"),mirror("mirror_xy","h1","h3","horizontal")]}


def build(call,name="Platte mit vier Bohrungen"):
    result=call("create_project",{"name":name});project=result["project"]
    def edit(action,**arguments):
        nonlocal project
        result=call(action,{"project_id":project["id"],"expected_revision":project["revision"],**arguments})
        project=result["project"];return result
    edit("create_sketch",sketch=plate_sketch())
    edit("apply_operation",operation={"op":"pad","sketch_id":"plate","depth":8})
    references=call("get_references",{"project_id":project["id"]})
    candidates=[f for f in references["faces"] if f.get("normal",[0,0,0])[2]>.999 and f["center"][2]>7.9]
    if len(candidates)!=1:raise RuntimeError("Oberseite ist nicht eindeutig")
    edit("create_sketch",sketch=hole_sketch(candidates[0]["reference"]))
    edit("apply_operation",operation={"op":"pocket","sketch_id":"holes","depth":8})
    return call("get_project",{"project_id":project["id"]})


if __name__=="__main__":
    from mcp_server import CADClient
    client=CADClient(Path(__file__).resolve().parents[1]/".metriccad"/"connection.json")
    result=build(client.call)
    print(json.dumps({"project":result["project"]["id"],"url":result["project"]["browser_url"]},indent=2))
