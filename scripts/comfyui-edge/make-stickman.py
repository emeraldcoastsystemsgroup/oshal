# Box-side PROGRAMMATIC stick-figure animator -- the RIGHT engine for stick characters.
# A stick figure is a skeleton (joints + limb angles), so animation = interpolating the angles between
# poses. No diffusion model, so it NEVER morphs and NEVER swaps identity -- it is the same figure by
# construction, with perfect pose control and buttery tweens. This is the stick-character IDE engine.
# Renders with PIL (bundled in ComfyUI's python_embeded) -> frames -> ffmpeg mp4. Out ~/oshal-stick.mp4
import os, math, glob, subprocess, time
from PIL import Image, ImageDraw

HOME = os.path.expanduser("~")
OUTDIR = os.path.join(HOME, "stickframes")
LOG = os.path.join(HOME, "stick.log")
W, H, FPS = 512, 512, 24
INK = (20, 20, 20)
BAND = (210, 40, 40)        # red headband -- the character's signature trait
BG = (250, 250, 250)
# Skeleton lengths (px)
L_UPARM, L_FOREARM, L_THIGH, L_SHIN = 46, 42, 56, 54
HEAD_R = 30


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def pt(origin, length, ang_deg):
    """Point `length` from origin at ang_deg where 0=straight down, 90=right, 180=up, 270=left."""
    r = math.radians(ang_deg)
    return (origin[0] + length * math.sin(r), origin[1] + length * math.cos(r))


# A pose = root vertical offset + 8 limb angles. shoulder/hip angles measured from straight-down.
# keys: dy, rsa(right shoulder) rea(right elbow) lsa lea rha(right hip) rka(right knee) lha lka
POSES = {
    "idle":  dict(dy=0,  rsa=18,  rea=4,   lsa=-18, lea=-4,  rha=8,  rka=4,  lha=-8, lka=4),
    "wave":  dict(dy=0,  rsa=158, rea=28,  lsa=-18, lea=-4,  rha=8,  rka=4,  lha=-8, lka=4),
    "wave2": dict(dy=0,  rsa=158, rea=-12, lsa=-18, lea=-4,  rha=8,  rka=4,  lha=-8, lka=4),
    "point": dict(dy=0,  rsa=90,  rea=2,   lsa=-22, lea=-6,  rha=10, rka=4,  lha=-10,lka=4),
    "crouch":dict(dy=26, rsa=120, rea=30,  lsa=-120,lea=-30, rha=30, rka=60, lha=-30,lka=60),
    "jump":  dict(dy=-46,rsa=172, rea=8,   lsa=-172,lea=-8,  rha=14, rka=10, lha=-14,lka=10),
}
# Timeline: (pose, frames-to-reach-it). First entry sets the start pose instantly.
TIMELINE = [("idle", 1), ("wave", 12), ("wave2", 8), ("wave", 8), ("idle", 10),
            ("point", 12), ("idle", 12), ("crouch", 10), ("jump", 8), ("idle", 14)]


def smooth(t):
    return t * t * (3 - 2 * t)      # smoothstep easing


def lerp(a, b, t):
    return a + (b - a) * t


def blend(p, q, t):
    return {k: lerp(p[k], q[k], t) for k in p}


def draw_pose(P):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    cx = W / 2
    neck = (cx, 150 + P["dy"])
    hip = (cx, neck[1] + 130)
    head_c = (cx, neck[1] - 8 - HEAD_R)
    # body
    d.line([neck, hip], fill=INK, width=6)
    d.ellipse([head_c[0]-HEAD_R, head_c[1]-HEAD_R, head_c[0]+HEAD_R, head_c[1]+HEAD_R], outline=INK, width=6)
    # face: two dot eyes + smile
    d.ellipse([head_c[0]-12, head_c[1]-6, head_c[0]-6, head_c[1]], fill=INK)
    d.ellipse([head_c[0]+6, head_c[1]-6, head_c[0]+12, head_c[1]], fill=INK)
    d.arc([head_c[0]-12, head_c[1]-2, head_c[0]+12, head_c[1]+14], 20, 160, fill=INK, width=3)
    # red headband across the top of the head
    d.line([(head_c[0]-HEAD_R+2, head_c[1]-HEAD_R+12), (head_c[0]+HEAD_R-2, head_c[1]-HEAD_R+12)], fill=BAND, width=8)
    # arms (shoulder=neck)
    for sa, ea in ((P["rsa"], P["rea"]), (P["lsa"], P["lea"])):
        elbow = pt(neck, L_UPARM, sa)
        hand = pt(elbow, L_FOREARM, sa + ea)
        d.line([neck, elbow], fill=INK, width=6)
        d.line([elbow, hand], fill=INK, width=6)
    # legs (from hip)
    for ha, ka in ((P["rha"], P["rka"]), (P["lha"], P["lka"])):
        knee = pt(hip, L_THIGH, ha)
        foot = pt(knee, L_SHIN, ha + ka)
        d.line([hip, knee], fill=INK, width=6)
        d.line([knee, foot], fill=INK, width=6)
    return img


def main():
    log("=== programmatic stick figure: skeletal pose tweening ===")
    for f in glob.glob(os.path.join(OUTDIR, "*.png")):
        try: os.remove(f)
        except Exception: pass
    os.makedirs(OUTDIR, exist_ok=True)
    idx = 0
    cur = POSES[TIMELINE[0][0]]
    draw_pose(cur).save(os.path.join(OUTDIR, "f_%05d.png" % idx)); idx += 1
    for name, frames in TIMELINE[1:]:
        nxt = POSES[name]
        for i in range(1, frames + 1):
            t = smooth(i / frames)
            draw_pose(blend(cur, nxt, t)).save(os.path.join(OUTDIR, "f_%05d.png" % idx)); idx += 1
        cur = nxt
    log("frames=%d (~%.1fs)" % (idx, idx / FPS))
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out = os.path.join(HOME, "oshal-stick.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUTDIR, "f_%05d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
                       capture_output=True, text=True, timeout=300)
    log("ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out, os.path.getsize(out) if os.path.exists(out) else 0))


main()
