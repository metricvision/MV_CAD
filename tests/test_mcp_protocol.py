"""Real HTTP MCP tools, app-managed lifecycle and CAD access checks."""
import asyncio
from datetime import timedelta
import json
import socket
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import httpx
from urllib.error import HTTPError
from urllib.request import Request,urlopen

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_server
from examples.build_plate import plate_sketch
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

class MCPProtocol(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.server=create_server(self.temp.name,0,mcp_port=0)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()

    async def asyncTearDown(self):
        await asyncio.to_thread(self.server.shutdown)
        await asyncio.to_thread(self.server.server_close)
        self.thread.join(timeout=5);self.temp.cleanup()

    async def control(self,action):
        def request():
            url=self.server.service.base_url+"/mcp/"+action
            if action=="status":
                with urlopen(url,timeout=30) as response:return json.load(response)
            headers={"Content-Type":"application/json","X-MetricCAD-Token":self.server.token}
            with urlopen(Request(url,data=b"{}",headers=headers),timeout=30) as response:return json.load(response)
        return await asyncio.to_thread(request)

    async def test_http_native_sketch_operations_and_png(self):
        started=await self.control("start")
        self.assertTrue(started["running"])
        async with httpx.AsyncClient(trust_env=False,timeout=90) as http, streamable_http_client(started["url"],http_client=http) as (read,write,_):
            async with ClientSession(read,write,read_timeout_seconds=timedelta(seconds=90)) as session:
                initialized=await session.initialize()
                self.assertEqual(initialized.serverInfo.name,"MetricCAD")
                names={t.name for t in (await session.list_tools()).tools}
                self.assertTrue({"create_sketch","apply_operation","set_dimension","get_preview","undo"}<=names)
                capabilities=await session.call_tool("get_capabilities",{})
                self.assertFalse(capabilities.isError)
                guide=await session.read_resource("metriccad://guide")
                self.assertIn("Coordinates are initial values",guide.contents[0].text)
                created=await session.call_tool("create_project",{"name":"MCP protocol test"})
                self.assertFalse(created.isError)
                project=created.structuredContent["project"]
                result=await session.call_tool("create_sketch",{"project_id":project["id"],"expected_revision":project["revision"],"sketch":plate_sketch()})
                self.assertFalse(result.isError,result.content);project=result.structuredContent["project"]
                self.assertEqual(result.structuredContent["model"]["sketches"][0]["dof"],0)
                result=await session.call_tool("apply_operation",{"project_id":project["id"],"expected_revision":project["revision"],"operation":{"op":"pad","sketch_id":"plate","depth":8}})
                self.assertFalse(result.isError,result.content);project=result.structuredContent["project"]
                self.assertAlmostEqual(result.structuredContent["model"]["volume_mm3"],32000,places=4)
                result=await session.call_tool("set_dimension",{"project_id":project["id"],"expected_revision":project["revision"],"sketch_id":"plate","dimension_id":"width","value":100})
                self.assertFalse(result.isError,result.content);project=result.structuredContent["project"]
                image=await session.call_tool("get_preview",{"project_id":project["id"],"view":"sketch","sketch_id":"plate"})
                self.assertFalse(image.isError,image.content)
                self.assertTrue(any(c.type=="image" and c.mimeType=="image/png" for c in image.content))
                invalid=await session.call_tool("set_dimension",{"project_id":project["id"],"expected_revision":0,"sketch_id":"plate","dimension_id":"width","value":200})
                self.assertTrue(invalid.isError)
                self.assertIn("revision_conflict",invalid.content[0].text)
                saved=await session.call_tool("save_project",{"project_id":project["id"]})
                self.assertFalse(saved.isError,saved.content)
                self.assertTrue(Path(saved.structuredContent["path"]).is_file())
                undone=await session.call_tool("undo",{"project_id":project["id"],"expected_revision":project["revision"]})
                self.assertFalse(undone.isError,undone.content)

    async def test_lifecycle_repeated_start_stop_restart_and_close(self):
        self.assertFalse((await self.control("status"))["running"])
        first,second=await asyncio.gather(self.control("start"),self.control("start"))
        self.assertEqual(first,second)
        child=self.server.mcp_process
        self.assertIsNotNone(child)
        self.assertTrue((await self.control("status"))["running"])
        self.assertFalse((await self.control("stop"))["running"])
        self.assertIsNotNone(child.poll())
        self.assertFalse((await self.control("stop"))["running"])
        await self.control("start")
        child=self.server.mcp_process
        await asyncio.to_thread(self.server.server_close)
        self.assertIsNotNone(child.poll())
        self.assertFalse(self.server.connection.exists())
        self.assertFalse(self.server.mcp_status()["running"])
        with self.assertRaisesRegex(ValueError,"beendet"):
            self.server.mcp_start()

    async def test_occupied_port_reports_error_without_stopping_other_service(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1",0));occupied.listen()
            self.server.mcp_port=occupied.getsockname()[1]
            with self.assertRaises(HTTPError) as caught:
                await self.control("start")
            error=json.loads(caught.exception.read())
            self.assertEqual(error["details"]["code"],"mcp_start_failed")
            state=await self.control("status")
            self.assertFalse(state["running"])
            self.assertIn("belegt",state["error"])
            self.assertIsNone(self.server.mcp_process)
            with socket.create_connection(occupied.getsockname(),timeout=1):pass
        self.assertTrue((await self.control("start"))["running"])

    async def test_crash_is_visible_and_can_be_restarted(self):
        await self.control("start")
        child=self.server.mcp_process
        child.kill();await asyncio.to_thread(child.wait)
        state=await self.control("status")
        self.assertFalse(state["running"])
        self.assertIn("unerwartet",state["error"])
        self.assertTrue((await self.control("start"))["running"])

    async def test_http_requires_session_token_and_detects_origin(self):
        for path in ("/api","/mcp/start","/mcp/stop"):
            url=self.server.service.base_url+path
            body=json.dumps({"action":"create_project","arguments":{"name":"Unauthorized"}} if path=="/api" else {}).encode()
            for headers in ({"Content-Type":"application/json"},{"Content-Type":"application/json","X-MetricCAD-Token":self.server.token,"Origin":"https://unrelated.invalid"}):
                with self.assertRaises(HTTPError) as caught:
                    await asyncio.to_thread(urlopen,Request(url,data=body,headers=headers))
                self.assertEqual(caught.exception.code,403)
        self.assertFalse((await self.control("status"))["running"])
        self.assertEqual(len(self.server.service.execute("list_projects")["projects"]),1)


if __name__=="__main__":unittest.main()
