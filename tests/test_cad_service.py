"""Integration tests with the actual CadQuery/Open Cascade geometry kernel."""
import base64
import copy
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.cad_service import CADService,CommandError
from examples.build_plate import build,plate_sketch
from PIL import Image


class CADIntegration(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.service=CADService(self.temp.name)
        self.call=self.service.execute
        self.project=build(self.call)["project"]

    def tearDown(self):self.temp.cleanup()

    def current(self):return self.call("get_project",{"project_id":self.project["id"]})["project"]

    def change(self,action,**arguments):
        result=self.call(action,{"project_id":self.project["id"],"expected_revision":self.project["revision"],**arguments})
        self.project=result["project"]
        return result

    def test_plate_is_solid_and_both_sketches_fully_constrained(self):
        report=self.call("inspect_model",{"project_id":self.project["id"]})
        self.assertTrue(report["valid"])
        self.assertEqual(report["solid_count"],1)
        self.assertAlmostEqual(report["volume_mm3"],80*50*8-4*math.pi*3**2*8,places=4)
        self.assertEqual([s["dof"] for s in report["sketches"]],[0,0])
        self.assertEqual([f["op"] for f in self.project["document"]["features"]],["pad","pocket"])

    def test_width_change_preserves_hole_diameters_and_edge_distances(self):
        result=self.change("set_dimension",sketch_id="plate",dimension_id="width",value=100)
        holes=next(f for f in self.project["document"]["features"] if f["id"]=="holes")
        for g in holes["geometry"]:
            self.assertAlmostEqual(abs(g["x"]),40,places=5)
            self.assertAlmostEqual(abs(g["y"]),15,places=5)
            self.assertAlmostEqual(g["a"],6,places=5)
        self.assertAlmostEqual(result["model"]["volume_mm3"],100*50*8-4*math.pi*3**2*8,places=4)
        self.assertEqual([s["dof"] for s in result["model"]["sketches"]],[0,0])

    def test_failed_operation_and_missing_reference_are_atomic(self):
        before=self.current()
        with self.assertRaises(CommandError):
            self.change("edit_sketch",sketch_id="holes",changes={"support":{"face":"missing/end"}})
        self.assertEqual(self.current(),before)
        with self.assertRaises(CommandError):self.change("delete_feature",feature_id="plate")
        self.assertEqual(self.current(),before)

    def test_conflicting_dimensions_do_not_change_document_or_history(self):
        before=self.current();f=copy.deepcopy(before["document"]["features"][0])
        dims=[]
        for d in f["dimensions"]:
            d.pop("layout",None);dims.append(d)
        duplicate=copy.deepcopy(dims[0]);duplicate.update(id="conflicting_width",value=90)
        with self.assertRaises(CommandError):self.change("edit_sketch",sketch_id="plate",changes={"dimensions":dims+[duplicate]})
        self.assertEqual(self.current(),before)

    def test_stale_and_concurrent_writes_only_commit_once(self):
        args={"project_id":self.project["id"],"expected_revision":self.project["revision"],"sketch_id":"plate","dimension_id":"width"}
        def attempt(value):
            try:return self.call("set_dimension",{**args,"value":value})
            except CommandError as e:return e.code
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,[95,105]))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertIn("revision_conflict",results)
        self.assertEqual(self.current()["revision"],args["expected_revision"]+1)

    def test_history_and_restart_preserve_native_project(self):
        original=copy.deepcopy(self.project["document"])
        self.change("set_dimension",sketch_id="plate",dimension_id="width",value=100)
        updated=copy.deepcopy(self.project["document"])
        self.change("undo");self.assertEqual(self.project["document"],original)
        self.change("redo");self.assertEqual(self.project["document"],updated)
        restarted=CADService(self.temp.name)
        self.assertEqual(restarted.execute("get_project",{"project_id":self.project["id"]})["project"],self.current())

    def test_manual_dimension_position_is_preserved(self):
        doc=copy.deepcopy(self.project["document"])
        d=doc["features"][0]["dimensions"][0];d["position"]=[12,-45];d["layout"]={"mode":"manual"}
        self.change("replace_document",document=doc,annotation_only=True)
        self.change("set_dimension",sketch_id="plate",dimension_id="width",value=90)
        d=self.project["document"]["features"][0]["dimensions"][0]
        self.assertEqual(d["position"],[12,-45])
        result=self.change("layout_dimensions",sketch_id="plate",force=True)
        self.assertEqual(result["layout"]["plate"]["preserved_manual"],0)

    def test_editing_native_rotation_pattern_preserves_ui_metadata(self):
        native={"version":2,"features":[{
            "id":"pattern_sketch","name":"Kreismuster","shape":"multi","op":"sketch",
            "support":{"plane":"XY"},"depth":10,"reverse":False,
            "geometry":[{"id":"a","type":"circle","x":10,"y":0,"a":4},
                        {"id":"b","type":"circle","x":-10,"y":0,"a":4}],
            "dimensions":[],"relations":[{
                "id":"rot","kind":"rotation","pattern":"group","index":1,"count":2,"sweep":360,"angle":180,
                "first":{"kind":"geometry","element":"a"},
                "second":{"kind":"geometry","element":"b"},"center":{"kind":"origin"}}]}]}
        self.project=self.call("create_project",{"name":"UI pattern","document":native})["project"]
        sketch=self.call("get_sketch",{"project_id":self.project["id"],"sketch_id":"pattern_sketch"})["sketch"]
        self.change("edit_sketch",sketch_id="pattern_sketch",changes={"relations":sketch["relations"]})
        relation=self.project["document"]["features"][0]["relations"][0]
        self.assertEqual({k:relation[k] for k in ("pattern","index","count","sweep")},
                         {"pattern":"group","index":1,"count":2,"sweep":360})

    def test_json_step_stl_and_image_feedback(self):
        for format in ("json","step","stl"):
            result=self.call("export_model",{"project_id":self.project["id"],"format":format})
            path=Path(result["path"]);self.assertTrue(path.is_file());self.assertGreater(path.stat().st_size,100)
            if format=="json":self.assertEqual(json.loads(path.read_text()),self.project["document"])
            elif format=="step":self.assertIn(b"ISO-10303-21",path.read_bytes()[:100])
            else:
                raw=path.read_bytes();count=int.from_bytes(raw[80:84],"little")
                self.assertEqual(len(raw),84+50*count)
        for view,sketch_id in (("3d",None),("sketch","plate"),("sketch","holes")):
            result=self.call("get_preview",{"project_id":self.project["id"],"view":view,"sketch_id":sketch_id})
            image=Image.open(io.BytesIO(base64.b64decode(result["image_base64"])))
            self.assertEqual(image.size,(1100,760));self.assertGreater(len(image.getcolors(1100*760)),10)

    def test_pending_browser_sketch_can_be_saved_and_completed(self):
        original=copy.deepcopy(self.project["document"])
        doc=copy.deepcopy(self.project["document"]);doc["features"][0]["dimensions"][0]["value"]=90
        result=self.change("replace_document",document=doc,sketch_id="plate")
        self.assertEqual(result["project"]["pending_sketch"],"plate")
        view=self.call("get_project_view",{"project_id":self.project["id"]})
        self.assertEqual(view["preview"]["pendingSketch"],"plate")
        result=self.change("replace_document",document=self.project["document"])
        self.assertIsNone(result["project"]["pending_sketch"])
        self.assertTrue(self.call("inspect_model",{"project_id":self.project["id"]})["valid"])
        self.change("undo")
        self.assertEqual(self.project["document"],original)

    def test_edge_treatments_use_stable_handles_after_preview(self):
        refs=self.call("get_references",{"project_id":self.project["id"]})
        edge=next(e["reference"] for e in refs["edges"] if e["reference"]["curve"]=="LINE" and abs(e["center"][2]-8)<1e-5)
        old=self.call("inspect_model",{"project_id":self.project["id"]})["volume_mm3"]
        for kind in ("fillet","chamfer"):
            self.call("get_preview",{"project_id":self.project["id"]})
            result=self.change("apply_operation",operation={"op":kind,"amount":1,"edges":[edge]})
            self.assertTrue(result["model"]["valid"])
            self.assertEqual(result["model"]["solid_count"],1)
            self.assertLess(result["model"]["volume_mm3"],old)
            self.change("undo")

    def test_revolution_and_helix_sweep_commands(self):
        p=self.call("create_project",{"name":"Rotation"})["project"]
        def edit(action,**kwargs):
            nonlocal p
            result=self.call(action,{"project_id":p["id"],"expected_revision":p["revision"],**kwargs});p=result["project"]
            return result
        edit("create_sketch",sketch={"id":"profile","support":{"plane":"XY"},"geometry":[{"id":"circle","type":"circle","x":10,"y":0,"a":4}]})
        result=edit("apply_operation",operation={"op":"revolve","sketch_id":"profile","revolveAxis":{"kind":"axis","role":"vertical"},"revolveAngle":360})
        self.assertAlmostEqual(result["model"]["volume_mm3"],2*math.pi**2*10*4,places=4)
        p=self.call("create_project",{"name":"Helix"})["project"]
        edit("create_helix",helix={"id":"path","radius":5,"pitch":2,"height":6})
        edit("create_sketch",sketch={"id":"thread","support":{"helix":"path"},"geometry":[{"id":"triangle","type":"polyline","closed":True,"points":[{"id":"p0","x":-.4,"y":0},{"id":"p1","x":.4,"y":-.3},{"id":"p2","x":.4,"y":.3}]}]})
        result=edit("apply_operation",operation={"op":"sweep","sketch_id":"thread","path":"path"})
        self.assertTrue(result["model"]["valid"])
        self.assertEqual(result["model"]["solid_count"],1)
        self.assertGreater(result["model"]["volume_mm3"],1)


if __name__=="__main__":unittest.main()
