# Box-side PROOF of the "same scene, only the difference moves" idea (the operator's talking-head model).
# Morph happens when two keyframes are DIFFERENT scenes. Fix: ONE base image, then make tiny variants
# of it via img2img at LOW denoise + SAME seed -> everything stays locked except the one prompted change
# (mouth closed -> open -> smile). Interp each near-identical pair over a SHORT gap (~0.36s) so the GPU
# only fills the small difference. Stitch -> a short talking cycle, no morph. 8GB lowvram.
# Log ~/talk.log, out ~/oshal-talk.mp4
import urllib.request, json, time, os, subprocess, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
LOG = os.path.join(HOME, "talk.log")
PREFIX = "oshal_talk"
W, H, FPS, SEG = 512, 512, 25, 9          # 9 frames (~0.36s) per micro-clip; tiny gap = only the diff moves
SEED = 100
DEN = 0.32                                  # low denoise: keep everything but the mouth
STYLE = ", cute 2D cartoon character, flat vibrant colors, bold clean outlines, cel shaded, plain solid background, centered, facing forward, NOT realistic"
NEG = "realistic, photo, 3d render, blurry, low quality, deformed, extra limbs, text, watermark"
BASE_SCENE = "a friendly cartoon person, head and shoulders portrait, neutral expression, mouth closed" + STYLE
VARIANTS = {
    "open":  "a friendly cartoon person, head and shoulders portrait, mouth wide open mid-speech, talking" + STYLE,
    "smile": "a friendly cartoon person, head and shoulders portrait, big warm closed-mouth smile, happy" + STYLE,
}
# Micro-clip sequence: which two poses each ~0.36s clip interpolates between (a talking cycle then a smile).
CLIPS = [("closed", "open"), ("open", "closed"), ("closed", "open"), ("open", "smile")]


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def run(wf):
    pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    for _ in range(200):
        time.sleep(3)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h:
            if h[pid].get("outputs"):
                return h[pid]["outputs"]
            if h[pid].get("status", {}).get("status_str") == "error":
                log("ERROR " + json.dumps(h[pid]["status"])[:400]); return None
    return None


def nm(o):
    return o["save"]["images"][0]["filename"]


def txt2img(scene, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": SEED, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def img2img(src, scene, pfx):
    # SAME seed + low denoise: only the prompted feature (mouth) changes; rest stays locked.
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": SEED, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": DEN, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def interp(kfA, kfB):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "imgA": {"class_type": "LoadImage", "inputs": {"image": kfA}},
        "imgB": {"class_type": "LoadImage", "inputs": {"image": kfB}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cartoon person talking, only the mouth moves, smooth", "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "morphing, melting, distorted, jittery, blurry", "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": W, "height": H, "length": SEG, "batch_size": 1}},
        "g0": {"class_type": "LTXVAddGuide", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "latent": ["lat", 0], "image": ["imgA", 0], "frame_idx": 0, "strength": 1.0}},
        "g1": {"class_type": "LTXVAddGuide", "inputs": {"positive": ["g0", 0], "negative": ["g0", 1], "vae": ["ck", 2], "latent": ["g0", 2], "image": ["imgB", 0], "frame_idx": SEG - 1, "strength": 1.0}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["g1", 0], "negative": ["g1", 1], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 26, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["g1", 2]}},
        "crop": {"class_type": "LTXVCropGuides", "inputs": {"positive": ["cond", 0], "negative": ["cond", 1], "latent": ["ks", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["crop", 2], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": PREFIX}},
    })


def main():
    log("=== talking head: 1 base + low-denoise variants -> short interps (only the diff moves) ===")
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    os.makedirs(INP, exist_ok=True)
    poses = {}
    o = txt2img(BASE_SCENE, "thbase")
    if not o:
        log("base failed"); return
    shutil.copy(os.path.join(OUT, nm(o)), os.path.join(INP, "th_closed.png")); poses["closed"] = "th_closed.png"
    log("base (closed) ready")
    for k, scene in VARIANTS.items():
        o = img2img("th_closed.png", scene, "th" + k)
        if not o:
            log("variant %s failed" % k); return
        dst = "th_%s.png" % k
        shutil.copy(os.path.join(OUT, nm(o)), os.path.join(INP, dst)); poses[k] = dst
        log("variant %s ready (same scene, mouth only)" % k)
    for i, (a, b) in enumerate(CLIPS):
        if interp(poses[a], poses[b]):
            log("clip %d/%d %s->%s done" % (i + 1, len(CLIPS), a, b))
        else:
            log("clip %d FAILED" % (i + 1))
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("total frames=%d (~%.1fs)" % (len(frames), len(frames) / FPS))
    if not frames:
        return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out_mp4 = os.path.join(HOME, "oshal-talk.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
