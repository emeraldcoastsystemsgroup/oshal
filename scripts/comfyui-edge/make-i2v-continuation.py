# Box-side COHERENT animation via image-to-video CONTINUATION (no two-keyframe morph).
# Why: LTXVAddGuide tweens BETWEEN two stills -> when they don't align it morphs (cat->pot, blur).
# Instead: make ONE cartoon keyframe, then LTXVImgToVideo animates REAL motion forward from it; the
# next segment STARTS from this segment's LAST frame -> true continuity, the character persists, the
# GPU invents the in-between motion (a real flipbook, not a guessed tween). ffmpeg stitches it all.
# 8GB lowvram. argv[1]=number of beats to run (default 4 for a quick check). Log ~/i2v.log, out ~/oshal-i2v.mp4
import urllib.request, json, time, os, subprocess, glob, shutil, sys

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
LOG = os.path.join(HOME, "i2v.log")
PREFIX = "oshal_i2v"
W, H, FPS, SEG = 768, 512, 25, 49        # 49 frames (~2s) of real motion per segment (8n+1)
STYLE = ", cute 2D cartoon illustration, flat vibrant colors, bold clean outlines, cel shaded, storybook, NOT realistic"
CHAR = "a muscular orange tabby cartoon cat by a glowing campfire at night"
# Motion-focused beats: describe the ACTION as continuous motion (i2v animates, it doesn't redraw).
BEATS = [
    "the cat slowly stirs cake batter in a metal bowl with a wooden spoon, arm moving in circles",
    "the cat lifts the wooden spoon up, thick batter dripping back down into the bowl",
    "the cat tips the bowl and pours the batter into a round cast-iron pan",
    "the cat slides the cast-iron pan forward onto the campfire flames",
    "the cat leans in and watches the cake slowly rise in the pan over the fire",
    "the cat lifts the finished golden cake up and smiles proudly",
]
KEYFRAME = CHAR + ", sitting cross-legged stirring cake batter in a metal mixing bowl" + STYLE


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


def txt2img(scene, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "realistic, photo, 3d render, blurry, low quality, deformed, text, watermark", "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def i2v(start_img, motion):
    # Animate real motion forward from start_img; SaveImage uses the continuous PREFIX so every
    # segment's frames join into one sequence.
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": start_img}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": motion + STYLE + ", smooth animation", "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, jittery, distorted, flicker, morphing, melting, blurry", "clip": ["te", 0]}},
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
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    beats = BEATS[:n]
    log("=== i2v CONTINUATION: 1 keyframe -> %d motion segments (no morph) ===" % len(beats))
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    os.makedirs(INP, exist_ok=True)
    o = txt2img(KEYFRAME, 42, "i2vkf")
    if not o:
        log("keyframe failed"); return
    start = "i2v_start.png"
    shutil.copy(os.path.join(OUT, o["save"]["images"][0]["filename"]), os.path.join(INP, start))
    log("keyframe ready")
    for i, beat in enumerate(beats):
        if not i2v(start, beat):
            log("segment %d FAILED" % (i + 1)); break
        last = newest()
        if last:
            start = "i2v_start.png"
            shutil.copy(last, os.path.join(INP, start))   # next segment continues from this frame
        log("segment %d/%d done (continues from last frame)" % (i + 1, len(beats)))
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("total frames=%d (~%.1fs)" % (len(frames), len(frames) / FPS))
    if not frames:
        return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out_mp4 = os.path.join(HOME, "oshal-i2v.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
