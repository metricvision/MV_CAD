"""Studio and room surfaces, in units of one assembly diagonal above the floor."""
from math import cos, pi, sin


def surface(anchor="floor"):
    return dict(anchor=anchor, vertices=[], colors=[], faces=[])


def quad(mesh, points, colors):
    start = len(mesh["vertices"])
    mesh["vertices"].extend(points)
    mesh["colors"].extend(colors)
    mesh["faces"].append([start + i for i in range(4)])


def studio():
    sweep = surface("studio")
    # An open sweep faces the camera. All four corners share each cross-section's colour.
    sections = [(-32, 0, 0), (1.55, 0, 0)]
    for i in range(1, 33):
        t = i / 32
        angle = t * pi / 2
        sections.append((1.55 + .85*sin(angle), .85*(1-cos(angle)), t*t*(3-2*t)))
    sections.append((2.4, 32, 1))
    def shade(t):
        return [round(a+(b-a)*t) for a,b in zip((48,85,119),(108,129,147))]
    for (y,z,t),(yy,zz,tt) in zip(sections,sections[1:]):
        quad(sweep, [(-32,y,z),(32,y,z),(32,yy,zz),(-32,yy,zz)],
             [shade(t),shade(t),shade(tt),shade(tt)])
    # The grid stays aligned with the CAD axes while the backdrop follows the view.
    grid = surface()
    steps = 24
    for swap in (False, True):
        for i in range(-steps, steps+1):
            for j in range(-steps, steps):
                def point(x,y):
                    return (y,x,.000015) if swap else (x,y,.000015)
                def tint(v):
                    radius = (i*i + v*v)**.5 / steps
                    t = min(1, max(0, (radius - .48) / .52))
                    fade = 1 - t*t*(3-2*t)
                    return [round(a+fade*b) for a,b in zip((48,85,119),(40,44,40))]
                if i*i + min(j*j,(j+1)**2) >= steps*steps:
                    continue
                x=i/16
                pts=[point(x-.00065,j/16),point(x+.00065,j/16),
                     point(x+.00065,(j+1)/16),point(x-.00065,(j+1)/16)]
                colors=[tint(j),tint(j),tint(j+1),tint(j+1)]
                quad(grid,pts[::-1] if swap else pts,colors[::-1] if swap else colors)
    return [sweep,grid]


def room():
    floor = surface("oak")
    quad(floor,[(-32,-32,0),(32,-32,0),(32,32,0),(-32,32,0)],[[197,166,126]]*4)
    back=surface("back")
    quad(back,[(-32,0,0),(32,0,0),(32,0,32),(-32,0,32)],[[184,178,168]]*4)
    side=surface("left")
    quad(side,[(0,-.85,0),(0,0,0),(0,0,1.65),(0,-.85,1.65)],[[197,190,180]]*4)
    # A 70 mm painted skirting with a bevel on a wardrobe-sized assembly.
    height, depth, bevel = .024, .0045, .0011
    profile = [(depth,0), (depth,height-bevel), (depth-bevel,height), (0,height)]
    paint = [[222,215,201]] * 4
    for wall in (back,side):
        is_back = wall is back
        start,end = (-32,32) if is_back else (-.85,-depth)
        def point(along, cross):
            offset,z = cross
            return (along,-offset,z) if is_back else (offset,along,z)
        for bottom,top in zip(profile,profile[1:]):
            quad(wall,[point(start,bottom),point(end,bottom),point(end,top),point(start,top)],paint)
        if not is_back:
            # Close the exposed end of the short wall's skirting.
            quad(wall,[point(start,p) for p in [(0,0),profile[0],profile[1],(0,height-bevel)]],paint)
            quad(wall,[point(start,p) for p in [(0,height-bevel),profile[1],profile[2],profile[3]]],paint)
    return [floor,back,side]


def environment_surfaces(mode):
    return {"studio":studio, "room":room, "none":list}[mode]()


def environments():
    return {mode: environment_surfaces(mode) for mode in ("studio", "room", "none")}
