# FREE 2D puppet walk - no diffusion video, no GPU. Takes a clean cyclops sprite (LoRA-generated),
# chroma-keys out the plain background, then animates a programmatic walk cycle (forward bob,
# squash-and-stretch on footfall, lean, swinging stubby legs, scrolling ground). Perfect identity
# (it's the same sprite every frame) and full motion control - the make-stickman idea applied to the
# cyclops. CPU/PIL only. ffmpeg stitches an mp4 + a frame strip.
#   python make-walk2d.py --src <cyclops.png> --frames 24 --cycles 2
import os, glob, math, subprocess, argparse
from PIL import Image, ImageDraw, ImageFilter

HOME = os.path.expanduser("~")
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output"); DEST = os.path.join(HOME, "lora-walk2d")
FF = os.path.join(HOME, "ffmpeg", "ffmpeg.exe"); FF = FF if os.path.exists(FF) else "ffmpeg"


def keyed_sprite(src):
    """Load the sprite and remove its near-uniform background -> RGBA cutout cropped to the body."""
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    # background colour = average of the four corners
    cs = [im.getpixel((1, 1)), im.getpixel((w - 2, 1)), im.getpixel((1, h - 2)), im.getpixel((w - 2, h - 2))]
    br = sum(c[0] for c in cs) // 4; bg = sum(c[1] for c in cs) // 4; bb = sum(c[2] for c in cs) // 4
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if abs(r - br) < 38 and abs(g - bg) < 38 and abs(b - bb) < 38:
                px[x, y] = (r, g, b, 0)
    # crop to non-transparent bbox
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    return im


def leg(draw, x, y, ang, col, ln=26, wd=12):
    """Draw a simple swinging leg (a rounded stub) from hip (x,y) at angle ang (radians)."""
    ex = x + ln * math.sin(ang); ey = y + ln * math.cos(ang)
    draw.line([(x, y), (ex, ey)], fill=col, width=wd)
    draw.ellipse([ex - wd / 2, ey - wd / 2, ex + wd / 2, ey + wd / 2], fill=col)
    draw.ellipse([ex - 2, ey + wd / 2 - 6, ex + 16, ey + wd / 2 + 4], fill=(250, 250, 250))  # little sneaker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="")
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--cycles", type=int, default=3)
    a = ap.parse_args()
    os.makedirs(DEST, exist_ok=True)
    src = a.src
    if not src:
        c = sorted(glob.glob(os.path.join(OUT, "walk_key*.png")) + glob.glob(os.path.join(OUT, "story_00*.png")))
        src = c[-1] if c else None
    if not src or not os.path.exists(src):
        print("no source sprite found"); return
    print("sprite:", src)
    sp = keyed_sprite(src)
    # scale sprite to ~58% of a 512 stage height
    W, H = 512, 512
    sh = int(H * 0.52); sw = int(sp.width * sh / sp.height)
    sp = sp.resize((sw, sh), Image.LANCZOS)
    legcol = (200, 70, 40)  # match the orange-red body for the stub legs

    fdir = os.path.join(DEST, "frames"); os.makedirs(fdir, exist_ok=True)
    for f in list(glob.glob(os.path.join(fdir, "*.png"))):
        os.remove(f)
    N = a.frames
    for f in range(N):
        t = f / N
        ph = t * a.cycles * 2 * math.pi          # 1 step per half-cycle
        bob = -abs(math.sin(ph)) * 16             # body lifts then drops (footfall)
        squash = 1.0 + 0.06 * math.cos(ph * 2)    # squash on contact
        lean = math.sin(ph) * 0.04                # slight rock
        scroll = int(t * 64) % 64                 # ground scroll => forward motion

        fr = Image.new("RGB", (W, H), (180, 205, 225))  # sky
        d = ImageDraw.Draw(fr)
        d.rectangle([0, H - 90, W, H], fill=(120, 150, 110))           # ground band
        for gx in range(-64 + scroll, W + 64, 64):                      # scrolling tufts
            d.ellipse([gx, H - 96, gx + 30, H - 80], fill=(95, 130, 90))
        cx, cy = W // 2, H - 90
        # legs swing opposite phase
        leg(d, cx - 16, cy - 18, math.sin(ph) * 0.5, legcol)
        leg(d, cx + 16, cy - 18, math.sin(ph + math.pi) * 0.5, legcol)
        # body sprite, squashed + leaning + bobbing, sat above the hips
        body = sp.resize((max(1, int(sp.width / squash)), max(1, int(sp.height * squash))), Image.LANCZOS).rotate(math.degrees(lean), expand=True, resample=Image.BICUBIC)
        bx = cx - body.width // 2; by = int(cy - body.height + 22 + bob)
        fr.paste(body, (bx, by), body)
        fr.save(os.path.join(fdir, "f_%03d.png" % f))
    print("rendered", N, "frames")
    # loop it x3 for a longer clip
    mp4 = os.path.join(DEST, "walk2d.mp4")
    subprocess.run([FF, "-y", "-stream_loop", "3", "-framerate", "16", "-i", os.path.join(fdir, "f_%03d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4], capture_output=True)
    print("mp4:", mp4, os.path.getsize(mp4) if os.path.exists(mp4) else 0, "bytes")
    # frame strip (8 sampled)
    pick = [f * (N - 1) // 7 for f in range(8)]
    th = 150; strip = Image.new("RGB", (th * 8, th), (20, 20, 30))
    for i, fi in enumerate(pick):
        strip.paste(Image.open(os.path.join(fdir, "f_%03d.png" % fi)).convert("RGB").resize((th, th)), (i * th, 0))
    strip.save(os.path.join(DEST, "walk2d-strip.png"))
    print("WALK2D DONE")


if __name__ == "__main__":
    main()
