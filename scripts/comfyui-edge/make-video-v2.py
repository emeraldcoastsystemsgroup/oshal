# Box-side refined video maker (v2). Higher res (768x512) + longer shots (97 frames ~3.9s,
# one per storyboard scene) so the result is a smooth sequence, not a flickery montage.
# Same LTX-Video pipeline (8GB lowvram). Logs to make-v2.log; launched detached.
import urllib.request, json, time, os, subprocess, glob

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
LOG = os.path.join(HOME, "make-v2.log")
PREFIX = "oshal_v2"
W, H = 768, 512
FRAMES = 97          # ~3.9s @ 25fps
FPS = 25
STEPS = 30

SCENES = [
    "cinematic close-up, a muscular orange cat cracking eggs into a metal bowl beside a glowing campfire at night, warm firelight, slow camera push, film grain",
    "cinematic, a muscular orange cat whisking cake batter, sparks drifting up from the campfire, dramatic rim light, smooth motion",
    "cinematic, a muscular orange cat carefully pouring batter into a cast-iron pan set over the flames, embers floating, shallow depth of field",
    "cinematic macro shot, cake batter gently bubbling in a pan over a campfire, steam curling, warm glow, slow motion",
    "cinematic, a muscular orange cat sitting proudly watching the cake bake over the fire, starry night behind, gentle dolly in",
    "cinematic, a muscular orange cat sprinkling toppings onto a finished cake by the campfire, sparks and bokeh, smooth motion",
    "cinematic hero shot, a glowing finished cake on a rustic wooden plate by a roaring campfire, drifting sparks, golden light",
    "cinematic, a muscular orange cat taking a happy bite of cake by the fire, contented, warm firelight, soft slow motion",
]


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def ensure_ffmpeg():
    p = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    return p if os.path.exists(p) else "ffmpeg"


def wf(prompt, seed):
    return {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, blurry, distorted, jittery, low detail, deformed", "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": W, "height": H, "length": FRAMES, "batch_size": 1}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": STEPS, "cfg": 3.2, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": PREFIX}},
    }


def gen(prompt, seed):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf(prompt, seed)}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    except Exception as e:
        log("submit error " + repr(e)); return False
    for _ in range(300):
        time.sleep(4)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h:
            if h[pid].get("outputs"):
                return True
            if h[pid].get("status", {}).get("status_str") == "error":
                log("clip error " + json.dumps(h[pid]["status"])[:300]); return False
    return False


def main():
    log("=== v2 start: %dx%d, %d frames x %d scenes, %d steps ===" % (W, H, FRAMES, len(SCENES), STEPS))
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    ok = 0
    for i, sc in enumerate(SCENES):
        if gen(sc, 2000 + i):
            ok += 1; log("scene %d/%d done" % (i + 1, len(SCENES)))
        else:
            log("scene %d/%d FAILED" % (i + 1, len(SCENES)))
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("scenes ok=%d frames=%d" % (ok, len(frames)))
    if not frames:
        log("no frames; aborting"); return
    ff = ensure_ffmpeg()
    out_mp4 = os.path.join(HOME, "oshal-video-v2.mp4")
    cmd = [ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, PREFIX + "_%05d_.png"),
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d" % r.returncode)
    if r.returncode != 0:
        log("ffmpeg stderr: " + r.stderr[-400:])
    log("DONE mp4=%s bytes=%d" % (out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
