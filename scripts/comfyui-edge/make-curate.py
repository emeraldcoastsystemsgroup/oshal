# Box-side PRE-CURATION: the HQ pool grew to ~1200 (matrix repeats); a LoRA wants ~60-100, not 1000.
# Sample an even, diverse subset of the HIGH-QUALITY (h-prefixed) images, copy png+caption into a curated
# folder, build a review contact-sheet + a ready-to-train zip. Human still yanks any duds, but this turns
# 1200 raw cards into a clean reviewable set. Out ~/overnight/curated/, curated-sheet.png, curated.zip.
import glob, os, shutil, zipfile, math
from PIL import Image

HOME = os.path.expanduser("~")
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
DATA = os.path.join(HOME, "lora-brainrot", "img")
DEST = os.path.join(HOME, "overnight")
CUR = os.path.join(DEST, "curated")
TARGET = 90        # aim for ~90 curated images

hq = sorted(glob.glob(os.path.join(DATA, "oshbrainrot_h*.png")))
if not hq:
    hq = sorted(glob.glob(os.path.join(DATA, "oshbrainrot_*.png")))
step = max(1, len(hq) // TARGET)
sel = hq[::step][:TARGET]

if os.path.isdir(CUR):
    shutil.rmtree(CUR, ignore_errors=True)
os.makedirs(CUR, exist_ok=True)
for p in sel:
    base = os.path.splitext(os.path.basename(p))[0]
    shutil.copy(p, os.path.join(CUR, base + ".png"))
    t = os.path.join(DATA, base + ".txt")
    if os.path.exists(t):
        shutil.copy(t, os.path.join(CUR, base + ".txt"))

# zip (images + captions) for the off-box trainer
zp = os.path.join(OUT, "curated.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(glob.glob(os.path.join(CUR, "*"))):
        z.write(f, os.path.basename(f))

# contact sheet of the curated set
th, cols = 220, 9
rows = math.ceil(len(sel) / cols)
sheet = Image.new("RGB", (cols * th, rows * th), (24, 24, 24))
for i, p in enumerate(sel):
    try:
        im = Image.open(p).convert("RGB").resize((th - 4, th - 4))
        sheet.paste(im, ((i % cols) * th + 2, (i // cols) * th + 2))
    except Exception:
        pass
sheet.save(os.path.join(OUT, "curated-sheet.png"))
print("curated %d of %d (step %d); zip=%d bytes" % (len(sel), len(hq), step, os.path.getsize(zp)))
