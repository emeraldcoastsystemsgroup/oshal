# Box-side 30-second video maker. Runs ON the edge node's embedded python against
# 127.0.0.1:8188. Storyboards a prompt into scenes, generates a short LTX-Video clip per
# scene (8GB-friendly, lowvram) saving frames as a single growing PNG sequence, then
# ffmpeg-stitches the whole sequence into one ~30s mp4. Downloads a static ffmpeg if needed.
# Heavily logged to make-30s.log; launched detached, progress read by polling the log.
import urllib.request, json, time, os, subprocess, glob

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
LOG = os.path.join(HOME, "make-30s.log")
PREFIX = "oshal_30s"
FRAMES_PER_CLIP = 33          # ~1.3s @ 25fps (proven on 8GB)
TARGET_SECONDS = 30
FPS = 25
CLIPS = (TARGET_SECONDS * FPS) // FRAMES_PER_CLIP + 1   # ~23

SCENES = [
    "a muscular cat cracking eggs into a metal bowl beside a glowing campfire at night, cinematic, smooth motion",
    "a muscular cat whisking cake batter, sparks rising from the campfire, dramatic firelight, smooth motion",
    "a muscular cat pouring batter into a cast-iron pan over the flames, embers flying, cinematic",
    "close up of cake batter bubbling in a pan over a campfire, steam rising, warm light, smooth motion",
    "a muscular cat watching a cake bake over the fire, proud, warm firelight, gentle camera push",
    "a muscular cat sprinkling toppings on a finished cake by the campfire, starry night sky",
    "a glowing finished cake on a rustic plate by a campfire, drifting sparks, cinematic",
    "a muscular cat taking a happy bite of cake by the fire, warm light, smooth motion",
]


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def ensure_ffmpeg():
    for c in ["ffmpeg", os.path.join(HOME, "ffmpeg", "ffmpeg.exe")]:
        try:
            subprocess.run([c, "-version"], capture_output=True, timeout=15); return c
        except Exception:
            pass
    log("downloading static ffmpeg")
    zp = os.path.join(HOME, "ffmpeg.zip")
    subprocess.run(["curl.exe", "-L", "--fail", "-o", zp,
                    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"], timeout=600)
    subprocess.run(["tar", "-xf", zp, "-C", HOME], timeout=300)
    found = glob.glob(os.path.join(HOME, "ffmpeg-*", "bin", "ffmpeg.exe"))
    if found:
        dst = os.path.join(HOME, "ffmpeg"); os.makedirs(dst, exist_ok=True)
        import shutil; shutil.copy(found[0], os.path.join(dst, "ffmpeg.exe"))
        log("ffmpeg ready"); return os.path.join(dst, "ffmpeg.exe")
    log("ffmpeg NOT found after extract"); return None


def wf(prompt):
    return {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, blurry, distorted, jittery", "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": 512, "height": 320, "length": FRAMES_PER_CLIP, "batch_size": 1}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 25, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": PREFIX}},
    }


def gen(prompt, seed):
    w = wf(prompt); w["ks"]["inputs"]["seed"] = seed
    pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": w}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    for _ in range(240):
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
    log("=== make-30s start: %d clips x %d frames ===" % (CLIPS, FRAMES_PER_CLIP))
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    ff = ensure_ffmpeg()
    ok = 0
    for i in range(CLIPS):
        if gen(SCENES[i % len(SCENES)], 1000 + i):
            ok += 1; log("clip %d/%d done" % (i + 1, CLIPS))
        else:
            log("clip %d/%d FAILED (continuing)" % (i + 1, CLIPS))
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("generated %d clips, %d frames total" % (ok, len(frames)))
    if not ff or not frames:
        log("cannot stitch (ffmpeg=%s frames=%d)" % (ff, len(frames))); return
    out_mp4 = os.path.join(HOME, "oshal-30s-video.mp4")
    cmd = [ff, "-y", "-framerate", str(FPS), "-pattern_type", "sequence", "-i",
           os.path.join(OUT, PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4]
    log("stitching: " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d" % r.returncode)
    if r.returncode != 0:
        log("ffmpeg stderr tail: " + r.stderr[-500:])
    sz = os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0
    log("DONE mp4=%s bytes=%d" % (out_mp4, sz))


main()
