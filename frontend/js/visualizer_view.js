// Camera width is the horizontal extent of the 16:9 render frame, in millimetres.
function sceneViewport(canvas, current, select, changeCamera, environments) {
    const gl = canvas.getContext('webgl', {antialias:true});
    if (!gl) throw Error('Für die Vorschau wird WebGL benötigt.');
    const program = gl.createProgram();
    function shader(type, source) {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
        gl.attachShader(program, s);
        gl.deleteShader(s);
    }
    shader(gl.VERTEX_SHADER, `
        attribute vec3 pos, normal, tint;
        uniform bool environmentPass;
        uniform vec3 origin, basis;
        varying vec3 surfaceColor;
        varying vec2 localXY;
        uniform vec3 center, right, up, eye, scale;
        varying vec3 point, n;
        void main() {
            vec3 world=pos;
            n=normal;
            if(environmentPass){
                mat2 rotation=mat2(basis.x,basis.y,-basis.y,basis.x);
                world=origin+basis.z*vec3(rotation*pos.xy,pos.z);
                n.xy=rotation*normal.xy;
            }
            localXY=pos.xy;surfaceColor=tint;
            vec3 p = world-center;
            gl_Position=vec4(vec3(dot(p,right),dot(p,up),-dot(p,eye))*scale,1.);
            point=world*.001;
        }`);
    shader(gl.FRAGMENT_SHADER, `
        precision highp float;
        varying vec3 point,n;
        uniform vec3 base, eye, lightPos[8], lightDir[8], lightRgb[8];
        uniform float roughness, metal, opacity, lightSize[8];
        varying vec3 surfaceColor;
        varying vec2 localXY;
        uniform bool environmentPass, oak, roomFill;
        uniform int count;
        uniform bool picking;
        void main(){
            if(picking){gl_FragColor=vec4(base,1.);return;}
            vec3 N=faceforward(normalize(n),-eye,normalize(n));
            vec3 albedo=environmentPass?surfaceColor:base;
            if(oak){
                vec2 board=localXY*vec2(2.,16.);
                board.x+=.5*mod(floor(board.y),2.);
                vec2 joint=min(fract(board),1.-fract(board));
                float grain=sin(750.*localXY.y+3.*sin(localXY.x*22.));
                albedo*=.96+.04*grain;
                if(joint.x<.002||joint.y<.012)albedo*=.82;
            }
            vec3 paint=albedo*.18;
            if(roomFill)
                paint+=albedo*(.06+.17*max(dot(N,normalize(vec3(.8,-1.35,.9))),0.));
            for(int i=0;i<8;i++){
                if(i>=count)break;
                vec3 delta=lightPos[i]-point;
                vec3 L=delta/max(length(delta),.00001);
                float diffuse=max(dot(N,L),0.);
                float spec=pow(max(dot(N,normalize(L+eye)),0.),mix(96.,4.,roughness));
                float emit=lightSize[i]<0.?1.:max(dot(-L,lightDir[i]),0.);
                paint+=lightRgb[i]*emit/(dot(delta,delta)+lightSize[i]*lightSize[i]+.000001)
                      *(albedo*diffuse*(1.-metal)+mix(vec3(.05),base,metal)*spec);
            }
            gl_FragColor=vec4(pow(paint/(vec3(1.)+paint),vec3(.4545)),opacity);
        }`);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    for (const [index,name] of ['pos','normal'].entries()) {
        const loc=gl.getAttribLocation(program,name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc,3,gl.FLOAT,false,24,index*12);
    }
    const u={};
    for(const name of ['center','right','up','eye','scale','base','roughness','metal','opacity','basis','origin','environmentPass','oak','roomFill','count','picking','lightPos','lightDir','lightRgb','lightSize'])
        u[name]=gl.getUniformLocation(program,name.startsWith('light')?name+'[0]':name);
    const rgb=color=>[1,3,5].map(k=>parseInt(color.slice(k,k+2),16)/255);
    const sub=(a,b)=>a.map((v,i)=>v-b[i]);
    const unit=a=>a.map(v=>v/(Math.hypot(...a)||1));
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const envBuffer=gl.createBuffer(), envVertices=[], surfaces={};
    for(const [mode,meshes] of Object.entries(environments)){
        surfaces[mode]=meshes.map(mesh=>{
            const start=envVertices.length/9;
            for(const [a,b,c,d] of mesh.faces){
                const n=unit(cross(sub(mesh.vertices[b],mesh.vertices[a]),sub(mesh.vertices[c],mesh.vertices[a])));
                for(const i of [a,b,c,a,c,d])
                    envVertices.push(...mesh.vertices[i],...n,...mesh.colors[i].map(v=>(v/255)**2.2));
            }
            return {anchor:mesh.anchor,start,count:envVertices.length/9-start};
        });
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,envBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(envVertices),gl.STATIC_DRAW);
    const attrs=['pos','normal','tint'].map(k=>gl.getAttribLocation(program,k));
    function bindEnvironment(on){
        gl.bindBuffer(gl.ARRAY_BUFFER,on?envBuffer:buffer);
        const stride=on?36:24;
        gl.vertexAttribPointer(attrs[0],3,gl.FLOAT,false,stride,0);
        gl.vertexAttribPointer(attrs[1],3,gl.FLOAT,false,stride,12);
        if(on){
            gl.enableVertexAttribArray(attrs[2]);
            gl.vertexAttribPointer(attrs[2],3,gl.FLOAT,false,stride,24);
        }else gl.disableVertexAttribArray(attrs[2]);
        gl.uniform1i(u.environmentPass,on);
    }
    let ranges=[],center=[0,0,0],diameter=100,lowCorner=[0,0,0],backY=0,drag=null;
    function load(model,data) {
        const vertices=[], next=[], low=[Infinity,Infinity,Infinity], high=low.map(()=>-Infinity);
        for(const item of model?.instances||[]) {
            const mesh=data.parts[item.part].mesh, m=data.transforms[item.id];
            const points=mesh.vertices.map(p=>m.slice(0,3).map(r=>r[3]+r[0]*p[0]+r[1]*p[1]+r[2]*p[2]));
            const start=vertices.length/6;
            for(const triangle of mesh.triangles){
                const [a,b,c]=triangle.map(i=>points[i]);
                const n=unit(cross(sub(b,a),sub(c,a)));
                for(const p of [a,b,c]){
                    vertices.push(...p,...n);
                    p.forEach((v,i)=>{low[i]=Math.min(low[i],v);high[i]=Math.max(high[i],v);});
                }
            }
            const midpoint=[0,0,0];
            for(const p of points)p.forEach((v,i)=>midpoint[i]+=v/points.length);
            next.push({item,start,count:vertices.length/6-start,midpoint});
        }
        if(model && !vertices.length) throw Error('Baugruppe enthält keine darstellbaren Flächen.');
        center=model?low.map((v,i)=>(v+high[i])/2):[0,0,0];
        diameter=model?Math.max(.1,Math.hypot(...sub(high,low))):100;
        lowCorner=low;backY=high[1];
        gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        ranges=next;
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);
        return {center:[...center],diameter,height:model?high[2]-low[2]:0};
    }
    function axes(c){
        const {sin,cos}=Math, y=c.yaw,p=c.pitch;
        const eye=[cos(y)*cos(p),sin(y)*cos(p),sin(p)],right=[-sin(y),cos(y),0];
        return {eye,right,up:cross(eye,right)};
    }
    function draw(picking=false){
        const {camera,lights,material,environment}=current();
        const ratio=Math.min(devicePixelRatio||1,2);
        const w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));
        if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
        gl.viewport(0,0,w,h);
        gl.clearColor(picking?0:.065,picking?0:.095,picking?0:.13,1);
        gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        if(!camera)return;
        gl.enable(gl.DEPTH_TEST);gl.disable(gl.DITHER);
        const scale=[2/camera.width,2*w/(h*camera.width),.9/(diameter*(environment==='none'?1:55)+Math.hypot(...sub(camera.center,center)))];
        for(const [name,value] of Object.entries({...axes(camera),center:camera.center,scale}))gl.uniform3fv(u[name],value);
        gl.uniform1i(u.roomFill,environment==='room');
        gl.uniform1i(u.picking,picking);gl.uniform1i(u.count,lights.length);
        if(lights.length){
            gl.uniform3fv(u.lightPos,lights.flatMap(l=>l.position.map(v=>v*.001)));
            gl.uniform3fv(u.lightDir,lights.flatMap(l=>l.type==='point'?[0,0,0]:unit(sub(l.target,l.position))));
            gl.uniform3fv(u.lightRgb,lights.flatMap(l=>rgb(l.color).map(v=>v**2.2*l.power*.003)));
            gl.uniform1fv(u.lightSize,lights.map(l=>l.type==='point'?-l.size*.001:l.size*.0005));
        }
        gl.uniform1f(u.opacity,1);
        if(environment!=='none'){
            bindEnvironment(true);
            gl.uniform3fv(u.base,[0,0,0]);
            gl.uniform1f(u.roughness,.95);gl.uniform1f(u.metal,0);
            for(const surface of surfaces[environment]){
                const key=surface.anchor;
                if((key==='back'&&Math.sin(camera.yaw)>0)||(key==='left'&&Math.cos(camera.yaw)<0))continue;
                const angle=key==='studio'?camera.yaw+Math.PI/2:0;
                const x=key==='left'?lowCorner[0]-.14*diameter:center[0];
                const y=(key==='back'||key==='left')?backY+.09*diameter:center[1];
                gl.uniform3fv(u.origin,[x,y,lowCorner[2]-.00002*diameter]);
                gl.uniform3fv(u.basis,[Math.cos(angle),Math.sin(angle),diameter]);
                gl.uniform1i(u.oak,key==='oak');
                if(key==='floor'){gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1,-1);}
                gl.drawArrays(gl.TRIANGLES,surface.start,surface.count);
                gl.disable(gl.POLYGON_OFFSET_FILL);
            }
        }
        bindEnvironment(false);gl.uniform1i(u.oak,false);
        const eye=axes(camera).eye, transparent=[];
        function paint(range,m,i){
            gl.uniform3fv(u.base,picking?[(i+1)/255,0,0]:rgb(m.color).map(v=>v**2.2));
            gl.uniform1f(u.roughness,m.roughness);gl.uniform1f(u.metal,m.metallic);
            gl.uniform1f(u.opacity,picking?1:1-.80*(m.transmission??0));
            gl.drawArrays(gl.TRIANGLES,range.start,range.count);
        }
        ranges.forEach((range,i)=>{
            const m=material(range.item);
            if(!picking&&m.transmission>0){
                const depth=range.midpoint.reduce((sum,v,k)=>sum+v*eye[k],0);
                transparent.push({range,i,m,depth});
            }else paint(range,m,i);
        });
        if(transparent.length){
            gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            transparent.sort((a,b)=>a.depth-b.depth).forEach(({range,m,i})=>paint(range,m,i));
            gl.depthMask(true);gl.disable(gl.BLEND);
        }
    }
    canvas.onpointerdown=e=>{
        if(![0,1].includes(e.button)||!ranges.length||drag)return;
        e.preventDefault();canvas.setPointerCapture(e.pointerId);
        drag={id:e.pointerId,x:e.clientX,y:e.clientY,pan:e.button===1||e.shiftKey,moved:false};
    };
    canvas.onpointermove=e=>{
        if(drag?.id!==e.pointerId)return;
        const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
        if(!drag.moved&&Math.hypot(dx,dy)<3)return;
        drag.moved=true;drag.x=e.clientX;drag.y=e.clientY;
        const c=current().camera;
        if(drag.pan){
            const {right,up}=axes(c);
            c.center=c.center.map((v,i)=>v+(-dx*right[i]+dy*up[i])*c.width/canvas.clientWidth);
        }else{
            c.yaw=(c.yaw-dx*.009)%(2*Math.PI);
            c.pitch=Math.max(-1.56,Math.min(1.56,c.pitch+dy*.009));
        }
        draw();changeCamera();
    };
    canvas.onpointerup=e=>{
        if(drag?.id!==e.pointerId)return;
        const pick=!drag.pan&&!drag.moved;drag=null;
        if(!pick)return;
        draw(true);
        const rect=canvas.getBoundingClientRect(),pixel=new Uint8Array(4);
        gl.readPixels(Math.floor((e.clientX-rect.left)*canvas.width/rect.width),
            canvas.height-1-Math.floor((e.clientY-rect.top)*canvas.height/rect.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        draw();if(ranges[pixel[0]-1])select(ranges[pixel[0]-1].item);
    };
    canvas.onpointercancel=canvas.onlostpointercapture=()=>{drag=null;};
    canvas.onwheel=e=>{
        const c=current().camera;if(!c)return;
        e.preventDefault();c.width=Math.max(.01,Math.min(1e9,c.width*Math.exp(e.deltaY*.001)));
        draw();changeCamera();
    };
    new ResizeObserver(()=>draw()).observe(canvas);
    return {load,draw};
}
