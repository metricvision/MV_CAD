"""MetricCAD browser app and shared local CAD service. Run: python app.py."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener
import webbrowser

import cadquery as cq
from backend.geometry import engine
from backend.cad_service import CADService, CommandError, atomic_write, json_bytes

ROOT = Path(__file__).resolve().parent


class Handler(BaseHTTPRequestHandler):
    def reply(self, data, kind="application/json", status=200, filename=None):
        self.send_response(status)
        self.send_header("Content-Type",kind)
        self.send_header("Content-Length",str(len(data)))
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Cache-Control","no-store")
        if filename: self.send_header("Content-Disposition",'attachment; filename="'+filename+'"')
        self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass

    def json_reply(self, value, status=200):
        self.reply(json_bytes(value),status=status)

    def check_origin(self):
        port=self.server.server_port
        if self.headers.get("Host") not in (f"127.0.0.1:{port}",f"localhost:{port}"):
            raise CommandError("invalid_host","Host nicht erlaubt")
        origin=self.headers.get("Origin")
        if origin and origin not in (f"http://127.0.0.1:{port}",f"http://localhost:{port}"):
            raise CommandError("invalid_origin","Origin nicht erlaubt")

    def error_reply(self, exc):
        if not isinstance(exc,CommandError):exc=CommandError("cad_error",str(exc))
        status=409 if exc.code=="revision_conflict" else 403 if exc.code in ("invalid_host","invalid_origin","unauthorized") else 404 if exc.code in ("not_found","project_not_found") else 400
        self.json_reply({"error":str(exc),"details":exc.payload()},status)

    def do_GET(self):
        try:
            self.check_origin();path=urlsplit(self.path).path
            if path=="/session":
                return self.json_reply({"token":self.server.token,"default_project":"default","version":"0.23-mcp"})
            if path=="/health":return self.json_reply({"ok":True,"application":"MetricCAD","version":"0.23-mcp"})
            if path=="/mcp/status":return self.json_reply(self.server.mcp_status())
            routes={"/":"frontend/index.html","/index.html":"frontend/index.html","/assembly":"frontend/assembly.html","/assembly.html":"frontend/assembly.html",
                    "/assembly.js":"frontend/js/assembly.js","/assembly.css":"frontend/css/assembly.css","/project_sync.js":"frontend/js/project_sync.js","/project_sync.css":"frontend/css/project_sync.css",
                    "/part_studio.js":"frontend/js/part_studio.js","/part_studio.css":"frontend/css/part_studio.css"}
            if path in routes:
                name=routes[path];kind={"html":"text/html; charset=utf-8","js":"application/javascript; charset=utf-8","css":"text/css; charset=utf-8"}[name.rsplit(".",1)[1]]
                return self.reply((ROOT/name).read_bytes(),kind)
            if path.startswith("/exports/"):
                name=path[len("/exports/"):]
                if not re.fullmatch(r"[A-Za-z0-9_-]+_r[0-9]+\.(json|step|stl)",name):raise CommandError("not_found","Export fehlt")
                file=self.server.service.exports_dir/name
                if not file.is_file():raise CommandError("not_found","Export fehlt")
                kind={"json":"application/json","step":"application/step","stl":"model/stl"}[name.rsplit(".",1)[1]]
                return self.reply(file.read_bytes(),kind,filename=name)
            raise CommandError("not_found","Not found")
        except Exception as exc:self.error_reply(exc)

    def do_POST(self):
        try:
            self.check_origin();path=urlsplit(self.path).path
            size=int(self.headers.get("Content-Length","0"))
            if not 0<size<=4_000_000:raise CommandError("invalid_size","Anfrage muss zwischen 1 Byte und 4 MB groß sein")
            if path in ("/api","/mcp/start","/mcp/stop"):
                if not secrets.compare_digest(self.headers.get("X-MetricCAD-Token",""),self.server.token):
                    raise CommandError("unauthorized","CAD-Verbindung nicht authentifiziert. Verbindung neu laden.")
            payload=json.loads(self.rfile.read(size),parse_constant=lambda v: (_ for _ in ()).throw(ValueError("Nicht endliche JSON-Zahl: "+v)))
            if path in ("/mcp/start","/mcp/stop"):
                if payload!={}:raise CommandError("invalid_request","MCP-Steuerung erwartet ein leeres Objekt")
                return self.json_reply(self.server.mcp_start() if path=="/mcp/start" else self.server.mcp_stop())
            if path=="/api":
                if not isinstance(payload,dict) or set(payload)-{"action","arguments"}:raise CommandError("invalid_request","Ungültige CAD-Anfrage")
                return self.json_reply(self.server.service.execute(payload.get("action"),payload.get("arguments")))
            # The legacy endpoints compute previews; persistent writes use /api.
            # All geometry, including assemblies, shares the same execution lock.
            with self.server.service.lock:
                if path.startswith("/assembly/"):
                    from backend.assembly import assembly
                    if path=="/assembly/step":
                        with tempfile.TemporaryDirectory() as directory:
                            target=Path(directory)/"assembly.step";assembly.export_step(payload,target)
                            return self.reply(target.read_bytes(),"application/step")
                    if path not in ("/assembly/build","/assembly/solve"):raise CommandError("unknown_command","Unbekannter Befehl")
                    return self.json_reply(assembly.prepare(payload,include_mesh=path=="/assembly/build"))
                handlers={"/validate":engine.validate,"/build":engine.preview,"/sketch-solve":engine.solve_sketch,"/sketch-drag":engine.drag_sketch}
                if path in handlers:return self.json_reply(handlers[path](payload))
                if path not in ("/step","/stl"):raise CommandError("unknown_command","Unbekannter Befehl")
                body,_=engine.build(payload)
                with tempfile.TemporaryDirectory() as directory:
                    target=Path(directory)/("model.stl" if path=="/stl" else "model.step")
                    if path=="/stl":
                        if not body.val().copy(mesh=False).exportStl(str(target),tolerance=.02,angularTolerance=.1,ascii=False,relative=False):
                            raise ValueError("STL-Vernetzung fehlgeschlagen")
                    else:cq.exporters.export(body,str(target))
                    return self.reply(target.read_bytes(),"model/stl" if path=="/stl" else "application/step")
        except Exception as exc:self.error_reply(exc)

    def log_message(self,*args):pass


@contextmanager
def directory_lock(directory):
    """Prevent two app processes from maintaining divergent histories on disk."""
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    stream=(directory/"server.lock").open("a+b")
    try:
        if os.name=="nt":
            import msvcrt
            stream.seek(0);stream.write(b"0");stream.flush();stream.seek(0)
            msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        stream.close()
        raise SystemExit("Für diesen Datenordner läuft bereits ein MetricCAD-Server.")
    try:yield
    finally:stream.close()


class CADServer(ThreadingHTTPServer):
    daemon_threads=True

    def __init__(self,directory,port,mcp_port):
        self.service=CADService(directory)
        self.mcp_port=mcp_port
        self.mcp_process=None
        self.mcp_error=""
        self.mcp_lock=threading.RLock()
        self.closed=False
        self.connection=None
        super().__init__(("127.0.0.1",port),Handler)
        self.token=secrets.token_urlsafe(32)
        self.service.base_url=f"http://127.0.0.1:{self.server_port}"
        self.connection=self.service.directory/"connection.json"
        try:
            atomic_write(self.connection,json_bytes({"url":self.service.base_url,"token":self.token,"pid":os.getpid(),"version":"0.23-mcp"}))
            try:self.connection.chmod(0o600)
            except OSError:pass
        except Exception:
            super().server_close()
            raise

    def mcp_status(self):
        with self.mcp_lock:
            if self.mcp_process and self.mcp_process.poll() is not None:
                self.mcp_error="MCP wurde unerwartet beendet. Details: .metriccad/mcp.log bzw. im eigenen Datenordner."
                self.mcp_process=None
            return {"running":self.mcp_process is not None,"url":f"http://127.0.0.1:{self.mcp_port}/mcp","error":self.mcp_error}

    def mcp_start(self):
        with self.mcp_lock:
            if self.closed:raise CommandError("mcp_closed","CAD-Server wird beendet")
            if self.mcp_status()["running"]:return self.mcp_status()
            self.mcp_error=""
            # Report occupied ports before launch; never attach to someone else's server.
            try:
                with socket.socket() as probe:
                    if os.name=="nt":probe.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
                    else:probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                    probe.bind(("127.0.0.1",self.mcp_port))
                    self.mcp_port=probe.getsockname()[1]
            except OSError as exc:
                self.mcp_error=f"MCP-Port {self.mcp_port} ist belegt oder nicht verfügbar."
                raise CommandError("mcp_start_failed",self.mcp_error) from exc
            try:
                instance=secrets.token_hex(16)
                with (self.service.directory/"mcp.log").open("w",encoding="utf-8") as log:
                    log.write(f"MCP-Start auf 127.0.0.1:{self.mcp_port}\n");log.flush()
                    self.mcp_process=subprocess.Popen(
                        [sys.executable,"-u",str(ROOT/"mcp_server.py"),"--connection-file",str(self.connection),"--port",str(self.mcp_port)],
                        cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,
                        env={**os.environ,"METRICCAD_MCP_INSTANCE":instance},
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0,
                        start_new_session=os.name!="nt")
                opener=build_opener(ProxyHandler({}))
                deadline=time.monotonic()+20
                last_check="Noch keine Antwort."
                while self.mcp_process.poll() is None and time.monotonic()<deadline:
                    try:
                        with opener.open(f"http://127.0.0.1:{self.mcp_port}/health",timeout=.3) as response:
                            if json.load(response).get("instance")==instance:
                                return self.mcp_status()
                            last_check="Antwort gehört nicht zu diesem MCP-Start."
                    except (OSError,ValueError) as exc:last_check=str(exc)
                    time.sleep(.1)
                code=self.mcp_process.poll()
                reason=f"MCP-Prozess beendet (Code {code})." if code is not None else f"Keine MCP-Startbestätigung nach 20 Sekunden: {last_check}"
                raise RuntimeError(reason)
            except Exception as exc:
                self.mcp_stop()
                self.mcp_error=str(exc)
                with (self.service.directory/"mcp.log").open("a",encoding="utf-8") as log:
                    log.write("Startfehler: "+self.mcp_error+"\n")
                raise CommandError("mcp_start_failed",self.mcp_error) from exc

    def mcp_stop(self):
        with self.mcp_lock:
            if self.mcp_process:
                if self.mcp_process.poll() is None:
                    self.mcp_process.terminate()
                    try:self.mcp_process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.mcp_process.kill();self.mcp_process.wait()
                self.mcp_process=None
            self.mcp_error=""
            return self.mcp_status()

    def server_close(self):
        with self.mcp_lock:
            self.closed=True
            self.mcp_stop()
            if self.connection:self.connection.unlink(missing_ok=True)
        super().server_close()


def create_server(directory,port=8765,mcp_port=8766):
    return CADServer(directory,port,mcp_port)


def main():
    parser=argparse.ArgumentParser(description="MetricCAD mit gemeinsamer Projektverwaltung und MCP-Anbindung")
    parser.add_argument("--port",type=int,default=8765,help="HTTP-Port; 0 wählt einen freien Port")
    parser.add_argument("--mcp-port",type=int,default=8766,help="Lokaler MCP-Port (Standard: 8766)")
    parser.add_argument("--data-dir",type=Path,default=Path(os.environ.get("METRICCAD_DATA_DIR",ROOT/".metriccad")))
    parser.add_argument("--no-browser",action="store_true")
    args=parser.parse_args()
    with directory_lock(args.data_dir):
        server=create_server(args.data_dir,args.port,args.mcp_port)
        def stop(signum,frame):raise KeyboardInterrupt
        signal.signal(signal.SIGTERM,stop)
        print("MetricCAD läuft: "+server.service.base_url+"  |  Beenden: Strg+C",flush=True)
        if not args.no_browser:threading.Timer(.5,lambda:webbrowser.open(server.service.base_url)).start()
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            server.server_close()


if __name__=="__main__":main()
