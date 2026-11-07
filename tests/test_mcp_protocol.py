"""Real stdio MCP handshake/tools/resources against an actual HTTP CAD service."""
import asyncio
from datetime import timedelta
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_server
from backend.cad_service import atomic_write,json_bytes
from examples.build_plate import plate_sketch
from mcp import ClientSession,StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT=Path(__file__).resolve().parents[1]


class MCPProtocol(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.server=create_server(self.temp.name,0)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.connection=Path(self.temp.name)/"connection.json"
        atomic_write(self.connection,json_bytes({"url":self.server.service.base_url,"token":self.server.token}))

    async def asyncTearDown(self):
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close();self.thread.join(timeout=5);self.temp.cleanup()

    async def test_stdio_native_sketch_operations_and_png(self):
        params=StdioServerParameters(command=sys.executable,args=[str(ROOT/"mcp_server.py"),"--connection-file",str(self.connection)])
        async with stdio_client(params) as (read,write):
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

    async def test_http_requires_session_token_and_detects_origin(self):
        url=self.server.service.base_url+"/api"
        body=json.dumps({"action":"create_project","arguments":{"name":"Unauthorized"}}).encode()
        for headers in ({"Content-Type":"application/json"},{"Content-Type":"application/json","X-MetricCAD-Token":self.server.token,"Origin":"https://unrelated.invalid"}):
            with self.assertRaises(HTTPError) as caught:
                await asyncio.to_thread(urlopen,Request(url,data=body,headers=headers))
            self.assertEqual(caught.exception.code,403)
        self.assertEqual(len(self.server.service.execute("list_projects")["projects"]),1)


if __name__=="__main__":unittest.main()
