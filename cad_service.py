"""Single owner of native MetricCAD projects, history and geometry execution.

The browser and MCP bridge use this service in the *same* app process. All OCCT
and solver calls are serialized because the existing engine caches are global.
"""
from __future__ import annotations

import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

from pydantic import ValidationError
import engine
import dimension_layout
from cad_schema import SketchInput, SketchEdit, Operation, HelixInput, FeatureParameters, data

CAD_LOCK = threading.RLock()


class CommandError(ValueError):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details

    def payload(self):
        return {"code": self.code, "message": str(self), "unchanged": True, **self.details}


def now():
    return datetime.now(timezone.utc).isoformat()


def fresh():
    return {"version": 2, "features": []}


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def feature(document, feature_id):
    result = next((f for f in document["features"] if f["id"] == feature_id), None)
    if result is None: raise CommandError("feature_not_found", "Bearbeitung/Skizze fehlt.", feature_id=feature_id)
    return result


def prepare_dimensions(items, previous=None):
    old = {d["id"]: d for d in previous or []}
    for d in items:
        if "position" not in d:
            if d["id"] in old:
                d["position"] = copy.deepcopy(old[d["id"]]["position"])
                if "layout" in old[d["id"]]: d["layout"] = copy.deepcopy(old[d["id"]]["layout"])
            else:
                d["position"] = [0., 0.]
                d["layout"] = {"mode": "auto", "last_position": [0., 0.]}
        elif "layout" not in d:
            d["layout"] = {"mode": "manual"}


class CADService:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.projects_dir = self.directory / "projects"
        self.exports_dir = self.directory / "exports"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.lock = CAD_LOCK
        self.base_url = ""
        self._records = {}
        with self.lock:
            if not self._path("default").exists():
                self._new("Unbenannt", fresh(), "default")

    def _path(self, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", project_id):
            raise CommandError("invalid_project_id", "Ungültige Projekt-ID")
        return self.projects_dir / (project_id + ".json")

    def _record(self, project_id):
        if project_id not in self._records:
            path = self._path(project_id)
            if not path.is_file(): raise CommandError("project_not_found", "Projekt fehlt.", project_id=project_id)
            try:
                self._records[project_id] = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise CommandError("project_unreadable", "Gespeichertes Projekt konnte nicht gelesen werden.", project_id=project_id) from exc
        return self._records[project_id]

    def _public(self, r, include_document=True):
        result = {k: copy.deepcopy(r.get(k)) for k in ("id", "name", "revision", "pending_sketch", "created_at", "updated_at", "last_action", "last_source")}
        result.update(can_undo=bool(r["history"]), can_redo=bool(r["future"]),
                      feature_count=len(r["document"]["features"]), browser_url=self.base_url+"/?project="+r["id"])
        if include_document: result["document"] = copy.deepcopy(r["document"])
        return result

    def _persist(self, r):
        atomic_write(self._path(r["id"]), json_bytes(r))
        self._records[r["id"]] = r

    def _new(self, name, document, project_id=None):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200:
            raise CommandError("invalid_name", "Projektname muss 1 bis 200 Zeichen enthalten.")
        preview = engine.preview(document)
        self._arrange(preview["document"], preview)
        r = {"id": project_id or uuid.uuid4().hex, "name": name.strip(), "revision": 0,
             "document": preview["document"], "history": [], "future": [], "pending_sketch": None,
             "created_at": now(), "updated_at": now(), "last_action": "Projekt erstellt", "last_source": "service"}
        self._persist(r)
        return {"project": self._public(r), "model": self._summary(preview)}

    def _expect(self, r, expected_revision):
        if type(expected_revision) is not int or expected_revision != r["revision"]:
            raise CommandError("revision_conflict", "Das Projekt wurde inzwischen geändert. Aktuellen Stand lesen und Änderung erneut planen.",
                               expected_revision=expected_revision, current_revision=r["revision"], project_id=r["id"])

    @staticmethod
    def _snapshot(r):
        return {"document": copy.deepcopy(r["document"]), "pending_sketch": r.get("pending_sketch")}

    def _commit(self, r, document, action, source="mcp", pending_sketch=None, record_history=True):
        if document == r["document"] and pending_sketch == r.get("pending_sketch"):
            return r
        next_record = copy.deepcopy(r)
        if record_history:
            next_record["history"] = (r["history"] + [self._snapshot(r)])[-60:]
        next_record["future"] = []
        next_record.update(document=document, revision=r["revision"]+1, pending_sketch=pending_sketch,
                           updated_at=now(), last_action=action, last_source=source)
        # Persist first: failed IO must not leave an acknowledged in-memory edit.
        self._persist(next_record)
        return next_record

    @staticmethod
    def _summary(preview):
        states = []
        for l in preview.get("layouts", []):
            c = l.get("constraints")
            if c is not None:
                states.append({"id": l["id"], "dof": c["dof"], "fully_constrained": c["fully"]})
        return {"valid": True, "volume_mm3": preview.get("volume", 0), "bounds_mm": preview.get("bounds"),
                "solid_count": preview.get("solidCount", 0), "sketches": states,
                "warnings": [{"code": "underconstrained_sketch", "sketch_id": s["id"], "dof": s["dof"]} for s in states if s["dof"]]}

    @staticmethod
    def _arrange(document, preview, target=None, force=False):
        layouts = {l["id"]: l for l in preview.get("layouts", [])}
        reports = {}
        for f in document["features"]:
            if f["id"] in layouts and f.get("dimensions") and (target is None or f["id"] == target):
                reports[f["id"]] = dimension_layout.arrange(f, layouts[f["id"]], force=force)
        return reports

    def _mutate(self, project_id, expected_revision, label, change, source="mcp", layout_target=None, force_layout=False):
        r = self._record(project_id); self._expect(r, expected_revision)
        candidate = copy.deepcopy(r["document"])
        details = change(candidate) or {}
        preview = engine.preview(candidate)
        reports = self._arrange(preview["document"], preview, layout_target, force_layout)
        r = self._commit(r, preview["document"], label, source)
        return {"project": self._public(r), "model": self._summary(preview), "layout": reports, **details}

    def _view(self, r):
        doc = r["document"]
        if r.get("pending_sketch"):
            result = engine.solve_sketch({"document": doc, "sketch": r["pending_sketch"]})
            index = next(i for i,f in enumerate(doc["features"]) if f["id"] == r["pending_sketch"])
            preview = engine.preview({"version": 2, "features": doc["features"][:index]})
            preview["layouts"].append(result["layout"])
            preview["document"] = copy.deepcopy(doc)
            preview["pendingSketch"] = r["pending_sketch"]
            return preview
        return engine.preview(doc)

    def execute(self, action, arguments=None):
        args = arguments or {}
        if not isinstance(args, dict): raise CommandError("invalid_arguments", "Argumente müssen ein Objekt sein.")
        with self.lock:
            try:
                method = getattr(self, "cmd_"+action, None) if isinstance(action, str) else None
                if method is None: raise CommandError("unknown_command", "Unbekannter CAD-Befehl")
                return method(**args)
            except CommandError:
                raise
            except ValidationError as exc:
                raise CommandError("invalid_arguments", "Ungültige CAD-Parameter", errors=json.loads(exc.json(include_url=False))) from exc
            except (ValueError, KeyError, TypeError, StopIteration) as exc:
                raise CommandError("cad_error", str(exc) or "Geometriereferenz fehlt.", command=action) from exc
            except Exception as exc:
                # OCCT bindings may raise kernel-specific exception types.
                raise CommandError("operation_failed", str(exc) or type(exc).__name__, command=action) from exc

    def cmd_list_projects(self):
        result, errors = [], []
        for path in sorted(self.projects_dir.glob("*.json")):
            try: result.append(self._public(self._record(path.stem), False))
            except CommandError as exc: errors.append(exc.payload())
        return {"projects": result, "errors": errors}

    def cmd_create_project(self, name="Neues Projekt", document=None):
        return self._new(name, document if document is not None else fresh())

    def cmd_get_project(self, project_id="default", include_document=True):
        return {"project": self._public(self._record(project_id), include_document)}

    def cmd_get_project_view(self, project_id="default"):
        r = self._record(project_id)
        return {"project": self._public(r), "preview": self._view(r)}

    def cmd_get_sketch(self, project_id, sketch_id):
        r = self._record(project_id)
        result = engine.solve_sketch({"document": r["document"], "sketch": sketch_id})
        layout = result["layout"]
        return {"project_id": project_id, "revision": r["revision"], "sketch": feature(result["document"],sketch_id),
                "layout": {k: layout[k] for k in ("frame","targets","external","constraints","bounds") if k in layout}}

    def cmd_get_references(self, project_id, before_feature=None):
        r = self._record(project_id); doc = copy.deepcopy(r["document"])
        if before_feature is not None:
            feature(doc, before_feature)
            doc["features"] = doc["features"][:next(i for i,f in enumerate(doc["features"]) if f["id"] == before_feature)]
        body, registry, _, _ = engine.build_state(doc)
        faces, unavailable = [], []
        for key, entry in registry.items():
            if len(entry["faces"]) != 1:
                unavailable.append({"key":key,"reason":"missing" if not entry["faces"] else "ambiguous"}); continue
            face = entry["faces"][0]
            item = {"reference":{"face":key},"label":entry["label"],"type":face.geomType(),
                    "center":list(face.Center().toTuple()),"area_mm2":face.Area(),"supports_sketch":face.geomType()=="PLANE"}
            if item["supports_sketch"]:
                info = engine.face_info(face,entry)
                item.update(frame=info["frame"],normal=info["frame"]["n"],targets=info["targets"],bounds=info["bounds"])
            faces.append(item)
        edges = []
        for item in engine.edge_catalog(body,registry) if body is not None else []:
            if item["ref"] is None: continue
            e = item["edge"]
            edges.append({"reference":item["ref"],"length_mm":e.Length(),"center":list(e.Center().toTuple()),
                          "endpoints":[list(v.Center().toTuple()) for v in e.Vertices()]})
        # A logical chain can consist of several kernel edges. Return one handle.
        unique_edges = {}
        for e in edges:
            key=json.dumps(e["reference"],sort_keys=True)
            if key not in unique_edges: unique_edges[key]=e
            else: unique_edges[key]["length_mm"] += e["length_mm"]
        return {"project_id":project_id,"revision":r["revision"],"before_feature":before_feature,
                "planes":[{"plane":p} for p in ("XY","XZ","YZ")],"faces":faces,"edges":list(unique_edges.values()),
                "unavailable_references":unavailable}

    def cmd_create_sketch(self, project_id, expected_revision, sketch):
        spec = data(SketchInput.model_validate(sketch)); spec["id"] = spec.get("id") or uuid.uuid4().hex
        prepare_dimensions(spec["dimensions"])
        f = {**spec,"shape":"multi","op":"sketch","depth":10.,"reverse":False}
        def change(doc):
            if any(x["id"] == f["id"] for x in doc["features"]): raise CommandError("duplicate_id","Skizzen-ID existiert bereits.")
            doc["features"].append(copy.deepcopy(f)); return {"sketch_id":f["id"]}
        return self._mutate(project_id,expected_revision,"Skizze erstellt",change)

    def cmd_edit_sketch(self, project_id, expected_revision, sketch_id, changes):
        changes = SketchEdit.model_validate(changes).model_dump(mode="json",exclude_none=True,exclude_unset=True)
        def change(doc):
            f = feature(doc,sketch_id)
            if f.get("shape") != "multi": raise CommandError("unsupported_sketch","Für dieses Werkzeug ist eine Mehrfachskizze erforderlich.")
            if "dimensions" in changes: prepare_dimensions(changes["dimensions"],f.get("dimensions"))
            f.update(copy.deepcopy(changes)); return {"sketch_id":sketch_id}
        return self._mutate(project_id,expected_revision,"Skizze bearbeitet",change)

    def cmd_apply_operation(self, project_id, expected_revision, operation):
        op = data(Operation.model_validate(operation))
        def change(doc):
            kind = op["op"]
            if kind in ("fillet","chamfer"):
                if not op.get("edges") or op.get("amount") is None: raise CommandError("invalid_operation","Kanten und Radius/Fasenmaß fehlen.")
                f = {"id":op.get("id") or uuid.uuid4().hex,"name":op.get("name") or ("Verrundung" if kind=="fillet" else "Fase"),"op":kind,"amount":op["amount"],"edges":op["edges"]}
                doc["features"].append(f)
            else:
                f = feature(doc,op.get("sketch_id"))
                if f.get("shape") not in ("rect","circle","multi"): raise CommandError("not_a_sketch","Operation benötigt eine Skizze.")
                f.update(op=kind,reverse=op["reverse"],symmetric=op["symmetric"])
                if op.get("name"): f["name"] = op["name"]
                if kind in ("pad","pocket"):
                    if op.get("depth") is None: raise CommandError("invalid_operation","Tiefe fehlt.")
                    f["depth"] = op["depth"]
                if kind in ("revolve","revolve-pocket"):
                    if op.get("revolveAxis") is None or op.get("revolveAngle") is None: raise CommandError("invalid_operation","Rotationsachse und Winkel fehlen.")
                    f.update(revolveAxis=op["revolveAxis"],revolveAngle=op["revolveAngle"])
                if kind in ("sweep","sweep-pocket"):
                    if not op.get("path") or f["support"] != {"helix":op["path"]}:
                        raise CommandError("invalid_operation","Sweep benötigt eine Profilskizze auf der gewählten Helix.")
                    f["path"] = op["path"]
            return {"feature_id":f["id"]}
        return self._mutate(project_id,expected_revision,"Operation "+op["op"],change)

    def cmd_create_helix(self, project_id, expected_revision, helix):
        spec = data(HelixInput.model_validate(helix)); spec["id"] = spec.get("id") or uuid.uuid4().hex; spec["op"]="helix"
        def change(doc):
            doc["features"].append(copy.deepcopy(spec)); return {"feature_id":spec["id"]}
        return self._mutate(project_id,expected_revision,"Helix erstellt",change)

    def cmd_set_dimension(self, project_id, expected_revision, sketch_id, dimension_id, value):
        value = engine.num(value,"Maßwert")
        if value < 0: raise CommandError("invalid_dimension","Maßwert darf nicht negativ sein.")
        def change(doc):
            f = feature(doc,sketch_id)
            d = next((d for d in f.get("dimensions",[]) if d["id"] == dimension_id),None)
            if d is None: raise CommandError("dimension_not_found","Maß fehlt.",dimension_id=dimension_id)
            d["value"] = value
        return self._mutate(project_id,expected_revision,"Maß geändert",change)

    def cmd_set_feature_parameters(self, project_id, expected_revision, feature_id, parameters):
        parameters = FeatureParameters.model_validate(parameters).model_dump(mode="json",exclude_none=True,exclude_unset=True)
        def change(doc):
            f = feature(doc,feature_id); op=f["op"]
            allowed = {"name"}
            if op in ("pad","pocket","sketch"): allowed |= {"depth","reverse","symmetric"}
            if op in ("fillet","chamfer"): allowed |= {"amount"}
            if op in ("revolve","revolve-pocket"): allowed |= {"revolveAngle","reverse"}
            if op == "helix": allowed |= {"radius","pitch","height","phase","leftHand","reverse"}
            if set(parameters)-allowed: raise CommandError("invalid_parameter","Parameter passt nicht zur ausgewählten Operation.",parameters=sorted(set(parameters)-allowed))
            f.update(parameters)
        return self._mutate(project_id,expected_revision,"Featureparameter geändert",change)

    def cmd_delete_feature(self, project_id, expected_revision, feature_id):
        def change(doc):
            feature(doc,feature_id)
            doc["features"]=[f for f in doc["features"] if f["id"] != feature_id]
        return self._mutate(project_id,expected_revision,"Bearbeitung gelöscht",change)

    def cmd_layout_dimensions(self, project_id, expected_revision, sketch_id, force=False):
        def change(doc):
            feature(doc,sketch_id)
        return self._mutate(project_id,expected_revision,"Maße angeordnet",change,layout_target=sketch_id,force_layout=force)

    def cmd_inspect_model(self, project_id):
        r = self._record(project_id)
        try:
            preview = engine.preview(r["document"])
            report = self._summary(preview)
        except Exception as exc:
            report = {"valid":False,"error":str(exc)}
        return {"project_id":project_id,"revision":r["revision"],"pending_sketch":r.get("pending_sketch"),**report}

    def cmd_replace_document(self, project_id, expected_revision, document, sketch_id=None, annotation_only=False):
        """Browser commit. Sketch edits may defer solid/successor rebuilds.

        This is intentionally not exposed as an unrestricted MCP write tool.
        """
        r = self._record(project_id); self._expect(r,expected_revision)
        feedback = {}
        record_history = True
        if annotation_only:
            def stripped(d):
                result=copy.deepcopy(d)
                for f in result["features"]:
                    for dim in f.get("dimensions",[]):
                        dim.pop("position",None);dim.pop("layout",None)
                return result
            if stripped(document) != stripped(r["document"]): raise CommandError("invalid_annotation_edit","Die Änderung betrifft auch Geometrie.")
            normalized = engine.validate(document)
            pending = r.get("pending_sketch")
        elif sketch_id:
            solved = engine.solve_sketch({"document":document,"sketch":sketch_id})
            normalized=solved["document"];pending=sketch_id
            feedback["sketch_result"] = solved
        else:
            preview = engine.preview(document); normalized=preview["document"];pending=None
            feedback["preview"] = preview
            if r.get("pending_sketch"):
                try:
                    # Finishing the already-saved sketch is a rebuild, not an
                    # additional user edit. Keep undo focused on the dimension
                    # or geometry edit instead of the 2D/3D navigation step.
                    old_built = engine.build_state(r["document"])[3]
                    record_history = old_built != normalized
                except (ValueError, KeyError, TypeError):
                    pass
        r = self._commit(r,normalized,"Änderung in der Oberfläche","browser",pending,record_history)
        return {"project":self._public(r),**feedback}

    def _history(self, project_id, expected_revision, redo):
        r=self._record(project_id); self._expect(r,expected_revision)
        source,target=("future","history") if redo else ("history","future")
        if not r[source]: raise CommandError("history_empty","Keine weitere Änderung vorhanden.")
        saved=r[source][-1]
        # Validate before moving history. Pending sketches remain valid editable drafts.
        if saved.get("pending_sketch"):
            engine.solve_sketch({"document":saved["document"],"sketch":saved["pending_sketch"]})
        else: engine.build_state(saved["document"])
        updated=copy.deepcopy(r);updated[source].pop();updated[target]=(updated[target]+[self._snapshot(r)])[-60:]
        updated.update(copy.deepcopy(saved));updated.update(revision=r["revision"]+1,updated_at=now(),last_source="history",last_action="Wiederherstellen" if redo else "Rückgängig")
        preview = self._view(updated)
        self._persist(updated)
        return {"project":self._public(updated),"preview":preview}

    def cmd_undo(self, project_id, expected_revision):
        return self._history(project_id,expected_revision,False)

    def cmd_redo(self, project_id, expected_revision):
        return self._history(project_id,expected_revision,True)

    def cmd_save_project(self, project_id):
        return self.cmd_export_model(project_id,"json")

    def cmd_export_model(self, project_id, format="step"):
        if format not in ("json","step","stl"): raise CommandError("invalid_format","Exportformat muss json, step oder stl sein.")
        r=self._record(project_id);filename=f'{project_id}_r{r["revision"]}.{format}';path=self.exports_dir/filename
        if format == "json":
            content=json_bytes(r["document"])
        else:
            import cadquery as cq
            body,_=engine.build(r["document"])
            with tempfile.TemporaryDirectory(dir=self.exports_dir) as temp:
                target=Path(temp)/("model."+format)
                if format == "step": cq.exporters.export(body,str(target))
                elif not body.val().copy(mesh=False).exportStl(str(target),tolerance=.02,angularTolerance=.1,ascii=False,relative=False):
                    raise CommandError("export_failed","STL-Vernetzung fehlgeschlagen")
                content=target.read_bytes()
        atomic_write(path,content)
        return {"project_id":project_id,"revision":r["revision"],"filename":filename,"path":str(path),
                "download_url":self.base_url+"/exports/"+filename,"size_bytes":len(content),"sha256":hashlib.sha256(content).hexdigest()}

    def cmd_get_preview(self, project_id, view="3d", sketch_id=None, width=1100, height=760):
        from cad_preview import render_model, render_sketch
        if type(width) is not int or type(height) is not int or not 400<=width<=1800 or not 300<=height<=1400:
            raise CommandError("invalid_preview_size","Vorschaugröße: Breite 400–1800, Höhe 300–1400 Pixel.")
        r=self._record(project_id)
        if view == "sketch":
            if not sketch_id: raise CommandError("sketch_required","Skizzen-ID für die Skizzenansicht erforderlich.")
            solved=engine.solve_sketch({"document":r["document"],"sketch":sketch_id})
            image=render_sketch(feature(solved["document"],sketch_id),solved["layout"],width,height)
        elif view in ("3d","top","front","right"):
            image=render_model(engine.preview(r["document"]),width,height,view)
        else: raise CommandError("invalid_view","Ansicht muss 3d, top, front, right oder sketch sein.")
        return {"project_id":project_id,"revision":r["revision"],"view":view,"sketch_id":sketch_id,
                "mime_type":"image/png","image_base64":base64.b64encode(image).decode("ascii")}
