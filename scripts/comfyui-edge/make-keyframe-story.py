# Box-side COHERENT STORY via keyframe interpolation (the keeper architecture).
# 1) build a CONSISTENT keyframe chain: kf0 = txt2img; kf[i] = img2img(kf[i-1]) so every keyframe is
#    the same evolving image (one locked style/subject) - the "similar images a couple seconds apart".
# 2) interpolate each consecutive pair with LTXVAddGuide (kf[i] at frame 0, kf[i+1] at last) - the GPU
#    tweens the motion between; SaveImage uses ONE prefix so all segments form a continuous sequence.
# 3) ffmpeg the whole sequence -> one smooth, consistent story mp4.
# 8GB lowvram. Logs to story.log. Output ~/oshal-story.mp4
import urllib.request, json, time, os, subprocess, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
LOG = os.path.join(HOME, "story.log")
PREFIX = "oshal_story"
W, H, FPS, SEG = 768, 512, 25, 65        # 65 frames (~2.6s) between each keyframe pair (smaller=more coherent motion)
STYLE = ", cute 2D cartoon illustration, flat vibrant colors, bold clean outlines, animated cartoon style, cel shaded, storybook, consistent character, NOT realistic"
# One locked character + small logical steps so every tween "makes sense" (each is the natural next moment).
CHAR = "a muscular orange tabby cartoon cat by a glowing campfire at night, "
ACTIONS = [
    "sitting cross-legged with an empty metal mixing bowl in front of it",
    "reaching one paw toward a brown egg sitting beside the bowl",
    "holding the brown egg up in one paw above the bowl",
    "cracking the egg, the yolk dropping down into the bowl",
    "pouring white flour from a small bag into the bowl",
    "stirring the cake batter in the bowl with a wooden spoon",
    "lifting the wooden spoon, thick batter dripping back into the bowl",
    "pouring the cake batter into a round cast-iron pan",
    "setting the cast-iron pan down onto the campfire flames",
    "watching the cake slowly rise in the pan over the fire",
    "lifting the finished golden cake up out of the pan",
    "proudly holding up the finished golden cake, smiling",
]
SCENES = [CHAR + a for a in ACTIONS]


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


def name(o):
    return o["save"]["images"][0]["filename"]


def txt2img(scene, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene + STYLE, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "realistic, photo, photorealistic, 3d render, blurry, low quality, deformed, text, watermark", "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def img2img(src, scene, seed, pfx, denoise=0.5):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene + STYLE, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "realistic, photo, photorealistic, 3d render, blurry, low quality, deformed, text, watermark", "clip": ["ck", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": denoise, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def interp(kfA, kfB, motion):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "imgA": {"class_type": "LoadImage", "inputs": {"image": kfA}},
        "imgB": {"class_type": "LoadImage", "inputs": {"image": kfB}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": motion + ", smooth cinematic motion, warm firelight", "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, jittery, distorted, flicker", "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": W, "height": H, "length": SEG, "batch_size": 1}},
        "g0": {"class_type": "LTXVAddGuide", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "latent": ["lat", 0], "image": ["imgA", 0], "frame_idx": 0, "strength": 1.0}},
        "g1": {"class_type": "LTXVAddGuide", "inputs": {"positive": ["g0", 0], "negative": ["g0", 1], "vae": ["ck", 2], "latent": ["g0", 2], "image": ["imgB", 0], "frame_idx": SEG - 1, "strength": 1.0}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["g1", 0], "negative": ["g1", 1], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 30, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["g1", 2]}},
        "crop": {"class_type": "LTXVCropGuides", "inputs": {"positive": ["cond", 0], "negative": ["cond", 1], "latent": ["ks", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["crop", 2], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": PREFIX}},
    })


def main():
    log("=== keyframe STORY: %d consistent keyframes -> %d tween segments ===" % (len(SCENES), len(SCENES) - 1))
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    os.makedirs(INP, exist_ok=True)
    # 1) consistent keyframe chain (img2img so each looks like the last)
    kfs = []
    o = txt2img(SCENES[0], 42, "kf0")
    if not o:
        log("kf0 failed"); return
    shutil.copy(os.path.join(OUT, name(o)), os.path.join(INP, "story_kf0.png")); kfs.append("story_kf0.png")
    log("keyframe 0 ready")
    for i in range(1, len(SCENES)):
        o = img2img(kfs[-1], SCENES[i], 42 + i, "kf%d" % i, denoise=0.45)
        if not o:
            log("kf%d failed" % i); return
        dst = "story_kf%d.png" % i
        shutil.copy(os.path.join(OUT, name(o)), os.path.join(INP, dst)); kfs.append(dst)
        log("keyframe %d ready (consistent chain)" % i)
    # 2) interpolate each consecutive pair
    for i in range(len(kfs) - 1):
        if interp(kfs[i], kfs[i + 1], SCENES[i + 1]):
            log("segment %d/%d (kf%d->kf%d) done" % (i + 1, len(kfs) - 1, i, i + 1))
        else:
            log("segment %d FAILED" % (i + 1))
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("total frames=%d (~%.1fs)" % (len(frames), len(frames) / FPS))
    if not frames:
        return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out_mp4 = os.path.join(HOME, "oshal-story.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
