# Box-side brainrot ANIMATION: i2v continuation from the locked cyclops hero (no LoRA needed).
# Starts from input/br_hero.png (the screaming cyclops), animates real motion forward with LTXVImgToVideo,
# each segment continues from the prior segment's last frame -> consistent character, no morph. ffmpeg mp4.
# Out ~/oshal-brainrot.mp4, log ~/branim.log
import urllib.request, json, time, os, subprocess, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
LOG = os.path.join(HOME, "branim.log")
PREFIX = "oshal_branim"
W, H, FPS, SEG = 512, 512, 25, 49
START = "br_hero.png"          # the cyclops, copied to input by the dataset builder
STYLE = ", glossy 3d render, italian brainrot meme style, smooth animation"
BEATS = [
    "the one-eyed orange creature waves an arm and screams with its mouth wide open",
    "the one-eyed creature jumps up and down excitedly, arms flailing",
    "the one-eyed creature does a silly wiggly dance, swinging its arms",
    "the one-eyed creature leans toward the camera, big eye blinking, mouth open",
]


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def run(wf):
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
                log("ERROR " + json.dumps(h[pid]["status"])[:400]); return None
    return None


def i2v(start_img, motion):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": start_img}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": motion + STYLE, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, jittery, distorted, flicker, morphing, melting, blurry, extra eyes", "clip": ["te", 0]}},
        "i2v": {"class_type": "LTXVImgToVideo", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "image": ["img", 0], "width": W, "height": H, "length": SEG, "batch_size": 1, "strength": 1.0}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["i2v", 0], "negative": ["i2v", 1], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 30, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["i2v", 2]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": PREFIX}},
    })


def newest():
    fs = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    return fs[-1] if fs else None


def main():
    log("=== brainrot anim: i2v continuation from %s (%d beats) ===" % (START, len(BEATS)))
    if not os.path.exists(os.path.join(INP, START)):
        log("START MISSING in input: " + START); return
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    start = START
    for i, beat in enumerate(BEATS):
        if not i2v(start, beat):
            log("segment %d FAILED" % (i + 1)); break
        last = newest()
        if last:
            shutil.copy(last, os.path.join(INP, "branim_cont.png")); start = "branim_cont.png"
        log("segment %d/%d done" % (i + 1, len(BEATS)))
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("total frames=%d (~%.1fs)" % (len(frames), len(frames) / FPS))
    if not frames:
        return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out = os.path.join(HOME, "oshal-brainrot.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out, os.path.getsize(out) if os.path.exists(out) else 0))


main()
