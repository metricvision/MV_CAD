"""Headless, geometry-derived PNG feedback for MCP. No browser is required."""
from __future__ import annotations

import io
import math
import numpy as np
from PIL import Image, ImageDraw
import dimension_layout as layout

BACKGROUND = (14, 23, 34)
TEXT = (224, 234, 244)
MUTED = (142, 168, 187)
GOLD = (244, 203, 131)


def png(image):
    stream = io.BytesIO(); image.save(stream, format="PNG")
    return stream.getvalue()


def header(draw, title, subtitle, width, height):
    draw.rectangle((0,0,width,55),fill=(24,39,54))
    draw.text((22,14),title,fill=TEXT,font=layout.font(20))
    draw.rectangle((0,height-32,width,height),fill=(24,39,54))
    draw.text((18,height-24),subtitle,fill=MUTED,font=layout.font(12))


def arrow(draw, a, toward, color):
    a,b=np.array(a,dtype=float),np.array(toward,dtype=float);v=b-a
    length=float(np.linalg.norm(v))
    if length<1e-8:return
    u=v/length;n=np.array([-u[1],u[0]])
    draw.polygon([tuple(a),tuple(a+u*8+n*3),tuple(a+u*8-n*3)],fill=color)


def render_sketch(f, support, width=1100, height=760):
    segments=layout.profile_segments(f)
    dimensions=[(d,layout.dimension_geometry(d,f,support)) for d in f.get("dimensions",[])]
    points=[p for a,b,_ in segments for p in (a,b)]
    outlines=[(np.array(a),np.array(b)) for edge in support.get("edges",[]) for a,b in zip(edge,edge[1:])]
    points += [p for a,b in outlines for p in (a,b)]
    for _,g in dimensions:
        points.extend([g["label"]]+[p for a,b in g["segments"] for p in (a,b)])
    if not points:points=[np.array([-20,-20]),np.array([20,20])]
    pts=np.array(points);lo=pts.min(axis=0);hi=pts.max(axis=0);center=(lo+hi)/2
    scale=min((width-180)/max(10.,hi[0]-lo[0]),(height-210)/max(10.,hi[1]-lo[1]))
    def xy(p):return (width/2+(float(p[0])-center[0])*scale,(height+20)/2-(float(p[1])-center[1])*scale)
    image=Image.new("RGB",(width,height),BACKGROUND);draw=ImageDraw.Draw(image)
    raw=max(1e-3,max(hi-lo)/12);power=10**math.floor(math.log10(raw));step=next(x*power for x in (1,2,5,10) if x*power>=raw)
    for axis in (0,1):
        for value in np.arange(math.floor((lo[axis]-step)/step)*step,hi[axis]+2*step,step):
            a,b=lo.copy()-step,hi.copy()+step;a[axis]=b[axis]=value
            draw.line((xy(a),xy(b)),fill=(27,41,55),width=1)
    # The origin remains a visible reference even in a fully dimensioned sketch.
    for a,b in (([lo[0]-step,0],[hi[0]+step,0]),([0,lo[1]-step],[0,hi[1]+step])):
        draw.line((xy(a),xy(b)),fill=(71,88,104),width=1)
    for a,b in outlines:draw.line((xy(a),xy(b)),fill=(81,116,130),width=1)
    fixed=support.get("constraints",{}).get("fully",False)
    for a,b,construction in segments:
        draw.line((xy(a),xy(b)),fill=(104,143,180) if construction else (105,224,148) if fixed else (158,185,205),width=1 if construction else 2)
    for d,g in dimensions:
        for a,b in g["segments"]:draw.line((xy(a),xy(b)),fill=GOLD,width=1)
        for a,b in g["arrows"]:arrow(draw,xy(a),xy(b),GOLD)
    # Labels are drawn last, so no later extension line crosses a label.
    for d,g in dimensions:
        text=layout.label_text(d);x,y=xy(g["label"]);box=layout.font().getbbox(text)
        w=box[2]-box[0]+16;h=24
        draw.rounded_rectangle((x-w/2,y-h/2,x+w/2,y+h/2),radius=3,fill=(17,34,49),outline=GOLD)
        draw.text((x,y),text,anchor="mm",fill=GOLD,font=layout.font())
    dof=support.get("constraints",{}).get("dof","?")
    header(draw,f'MetricCAD · {f.get("name","Skizze")}',f'{dof} Freiheitsgrade · {len(f.get("dimensions",[]))} Maße · Einheit mm',width,height)
    return png(image)


def render_model(preview, width=1100, height=760, view="3d"):
    image=Image.new("RGB",(width,height),BACKGROUND)
    vertices=np.asarray(preview.get("vertices",[]),dtype=float)
    paths=[l for l in preview.get("layouts",[]) if l.get("helix")]
    if view=="top":right,up,depth=[1,0,0],[0,1,0],[0,0,1]
    elif view=="front":right,up,depth=[1,0,0],[0,0,1],[0,-1,0]
    elif view=="right":right,up,depth=[0,1,0],[0,0,1],[1,0,0]
    else:
        yaw,pitch=-.7,.65;cy,sy,cp,sp=math.cos(yaw),math.sin(yaw),math.cos(pitch),math.sin(pitch)
        right,up,depth=[cy,-sy,0],[-sy*sp,-cy*sp,cp],[sy*cp,cy*cp,sp]
    matrix=np.array([right,up,depth]).T
    bound_points=[*vertices]+[p for l in paths for p in l["points"]]
    if not bound_points:
        draw=ImageDraw.Draw(image);draw.text((width/2,height/2),"Noch kein Volumenkörper",anchor="mm",fill=MUTED,font=layout.font(20))
        header(draw,"MetricCAD · Modell","Skizze erstellen und aufpolstern · Einheit mm",width,height)
        return png(image)
    bounds=np.asarray(bound_points)@matrix;center=(bounds.max(axis=0)+bounds.min(axis=0))/2
    span=np.maximum(bounds.max(axis=0)-bounds.min(axis=0),1)
    scale=min((width-180)/span[0],(height-200)/span[1])
    def project(points):
        p=np.asarray(points)@matrix-center
        return np.column_stack((width/2+p[:,0]*scale,(height+20)/2-p[:,1]*scale,p[:,2]))
    pixels=np.full((height,width,3),BACKGROUND,dtype=np.uint8)
    zbuffer=np.full((height,width),-np.inf,dtype=np.float32)
    projected=project(vertices) if len(vertices) else np.empty((0,3))
    sun=np.array([.3,-.4,1.]);sun/=np.linalg.norm(sun)
    for tri in preview.get("triangles",[]):
        a,b,c=projected[tri];normal=np.cross(vertices[tri[1]]-vertices[tri[0]],vertices[tri[2]]-vertices[tri[0]])
        normal/=max(np.linalg.norm(normal),1e-15)
        shade=.45+.55*abs(float(normal@sun));color=np.array([66,177,157])*shade
        x0=max(0,int(math.floor(min(a[0],b[0],c[0]))));x1=min(width-1,int(math.ceil(max(a[0],b[0],c[0]))))
        y0=max(56,int(math.floor(min(a[1],b[1],c[1]))));y1=min(height-34,int(math.ceil(max(a[1],b[1],c[1]))))
        if x1<x0 or y1<y0:continue
        den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(den)<1e-12:continue
        yy,xx=np.mgrid[y0:y1+1,x0:x1+1]
        u=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/den
        v=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/den;w=1-u-v
        zz=u*a[2]+v*b[2]+w*c[2];region=zbuffer[y0:y1+1,x0:x1+1]
        mask=(u>=-1e-8)&(v>=-1e-8)&(w>=-1e-8)&(zz>=region)
        region[mask]=zz[mask];pixels[y0:y1+1,x0:x1+1][mask]=color.astype(np.uint8)
    # Depth-tested real BRep edges, rather than visible triangulation diagonals.
    for edge in preview.get("edges",[]):
        points=project(edge["points"])
        for a,b in zip(points,points[1:]):
            count=max(2,int(np.linalg.norm(b[:2]-a[:2]))+1)
            p=np.linspace(a,b,count);xs=np.round(p[:,0]).astype(int);ys=np.round(p[:,1]).astype(int)
            valid=(xs>=0)&(xs<width)&(ys>=56)&(ys<height-33)
            xs,ys,z=xs[valid],ys[valid],p[valid,2]
            visible=z>=zbuffer[ys,xs]-max(.03,2/scale)
            pixels[ys[visible],xs[visible]]=(24,64,70)
    image=Image.fromarray(pixels);draw=ImageDraw.Draw(image)
    for helix in paths:
        draw.line([tuple(p[:2]) for p in project(helix["points"])],fill=(240,191,107),width=2)
    count=preview.get("solidCount",0);volume=preview.get("volume",0)
    header(draw,"MetricCAD · "+{"3d":"Isometrie","top":"Oben","front":"Vorne","right":"Rechts"}[view],
           f'{count} Volumenkörper · {volume:.2f} mm³ · {len(preview["document"]["features"])} Bearbeitungen',width,height)
    return png(image)
