# Box-side STORYBOARD-FED video maker. The proper staged pipeline (ADR-070):
#   1. generate a keyframe IMAGE per scene (SD1.5)  -> the storyboard
#   2. feed each keyframe to LTXVImgToVideo (image-to-video) so the clip animates THAT image
#   3. stitch the clips into one ~30s mp4
# Gives continuity + control vs disjoint text-to-video. 8GB lowvram. Logs to make-sb.log.
import urllib.request, json, time, os, subprocess, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
LOG = os.path.join(HOME, "make-sb.log")
VID_PREFIX = "oshal_sb"
W, H = 768, 512
FRAMES = 97          # ~3.9s @ 25fps
FPS = 25

SCENES = [
    "cinematic film still, a muscular orange tabby cat cracking eggs into a metal bowl beside a glowing campfire at night, warm firelight, detailed fur, shallow depth of field",
    "cinematic film still, a muscular orange tabby cat whisking cake batter by a campfire, sparks drifting up, dramatic rim light, detailed",
    "cinematic film still, a muscular orange tabby cat pouring batter into a cast-iron pan over the flames, embers floating, warm glow",
    "cinematic macro film still, cake batter bubbling in a pan over a campfire, steam curling, golden firelight",
    "cinematic film still, a muscular orange tabby cat sitting proudly watching a cake bake over a fire, starry night sky behind",
    "cinematic film still, a muscular orange tabby cat sprinkling toppings on a finished cake by a campfire, sparks and bokeh",
    "cinematic hero film still, a glowing finished cake on a rustic wooden plate by a roaring campfire, drifting sparks, golden hour light",
    "cinematic film still, a muscular orange tabby cat taking a happy bite of cake by the fire, contented, warm firelight",
]


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def submit(wf):
    pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    for _ in range(300):
        time.sleep(4)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h:
            if h[pid].get("outputs"):
                return h[pid]["outputs"]
            if h[pid].get("status", {}).get("status_str") == "error":
                log("error " + json.dumps(h[pid]["status"])[:300]); return None
    return None


def keyframe_wf(prompt, seed, prefix):
    return {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality, deformed, text, watermark", "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 22, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}},
    }


def i2v_wf(image_name, prompt, seed):
    return {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt + ", smooth cinematic camera motion", "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, jittery, distorted, static", "clip": ["te", 0]}},
        "i2v": {"class_type": "LTXVImgToVideo", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "image": ["img", 0], "width": W, "height": H, "length": FRAMES, "batch_size": 1, "strength": 1.0}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["i2v", 0], "negative": ["i2v", 1], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 30, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["i2v", 2]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": VID_PREFIX}},
    }


def main():
    log("=== storyboard video: %d scenes, keyframe->LTXVImgToVideo, %dx%d x%d ===" % (len(SCENES), W, H, FRAMES))
    for f in glob.glob(os.path.join(OUT, VID_PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    os.makedirs(INP, exist_ok=True)
    ok = 0
    for i, sc in enumerate(SCENES):
        out = submit(keyframe_wf(sc, 3000 + i, "kf%d" % i))
        if not out:
            log("scene %d keyframe FAILED" % i); continue
        # find the saved keyframe file, copy into ComfyUI input/ for LoadImage
        try:
            fn = out["save"]["images"][0]["filename"]
        except Exception:
            log("scene %d no keyframe filename" % i); continue
        dst = "sbkey_%d.png" % i
        shutil.copy(os.path.join(OUT, fn), os.path.join(INP, dst))
        log("scene %d keyframe ready (%s)" % (i, dst))
        if submit(i2v_wf(dst, sc, 4000 + i)):
            ok += 1; log("scene %d clip done" % i)
        else:
            log("scene %d clip FAILED" % i)
    frames = sorted(glob.glob(os.path.join(OUT, VID_PREFIX + "_*.png")))
    log("clips ok=%d frames=%d" % (ok, len(frames)))
    if not frames:
        log("no frames"); return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out_mp4 = os.path.join(HOME, "oshal-storyboard-video.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, VID_PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d" % r.returncode)
    if r.returncode:
        log("ffmpeg err " + r.stderr[-400:])
    log("DONE mp4=%s bytes=%d" % (out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
