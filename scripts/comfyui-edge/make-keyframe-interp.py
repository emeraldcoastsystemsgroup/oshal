# Box-side KEYFRAME INTERPOLATION demo — the right way to a coherent, consistent clip.
# 1) make keyframe A (txt2img, SD1.5).
# 2) make keyframe B as an img2img of A (low denoise) so it's the SAME image, slightly progressed
#    -> consistent style (the storyboard is "similar images a couple seconds apart").
# 3) LTXVAddGuide A at frame 0 and B at the last frame; LTX-Video generates the in-between frames
#    (the GPU tweens between the keyframes) -> one smooth ~4s clip.
# Stitch the frames to mp4. 8GB lowvram. Logs to keyframe.log.
import urllib.request, json, time, os, subprocess, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
LOG = os.path.join(HOME, "keyframe.log")
PREFIX = "oshal_kfi"
W, H, FPS, LENGTH = 768, 512, 25, 97   # ~3.9s between the two keyframes
STYLE = ", cinematic film still, warm firelight, detailed, shallow depth of field"
SCENE_A = "a muscular orange tabby cat sitting by a glowing campfire at night holding a cake pan" + STYLE
SCENE_B = "a muscular orange tabby cat lifting a finished glowing cake over the campfire, proud" + STYLE


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
                log("ERROR " + json.dumps(h[pid]["status"])[:500]); return None
    return None


def txt2img(scene, seed, prefix):
    wf = {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality, deformed, text", "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}},
    }
    return run(wf)


def img2img(src_name, scene, seed, prefix, denoise=0.5):
    wf = {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src_name}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality, deformed, text", "clip": ["ck", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 24, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": denoise, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}},
    }
    return run(wf)


def interp(kfA, kfB):
    wf = {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "imgA": {"class_type": "LoadImage", "inputs": {"image": kfA}},
        "imgB": {"class_type": "LoadImage", "inputs": {"image": kfB}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": "a muscular orange cat by a campfire, smooth cinematic motion, warm firelight", "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, jittery, distorted", "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": W, "height": H, "length": LENGTH, "batch_size": 1}},
        "g0": {"class_type": "LTXVAddGuide", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "latent": ["lat", 0], "image": ["imgA", 0], "frame_idx": 0, "strength": 1.0}},
        "g1": {"class_type": "LTXVAddGuide", "inputs": {"positive": ["g0", 0], "negative": ["g0", 1], "vae": ["ck", 2], "latent": ["g0", 2], "image": ["imgB", 0], "frame_idx": LENGTH - 1, "strength": 1.0}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["g1", 0], "negative": ["g1", 1], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 30, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["g1", 2]}},
        "crop": {"class_type": "LTXVCropGuides", "inputs": {"positive": ["cond", 0], "negative": ["cond", 1], "latent": ["ks", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["crop", 2], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": PREFIX}},
    }
    return run(wf)


def saved_name(outputs):
    return outputs["save"]["images"][0]["filename"]


def main():
    log("=== keyframe interpolation: 2 consistent keyframes -> LTXV tween ===")
    for f in glob.glob(os.path.join(OUT, PREFIX + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    os.makedirs(INP, exist_ok=True)
    a = txt2img(SCENE_A, 42, "kfA")
    if not a:
        log("keyframe A failed"); return
    shutil.copy(os.path.join(OUT, saved_name(a)), os.path.join(INP, "kfA.png"))
    log("keyframe A ready")
    b = img2img("kfA.png", SCENE_B, 43, "kfB", denoise=0.55)
    if not b:
        log("keyframe B failed"); return
    shutil.copy(os.path.join(OUT, saved_name(b)), os.path.join(INP, "kfB.png"))
    log("keyframe B ready (img2img of A — consistent)")
    if not interp("kfA.png", "kfB.png"):
        log("interpolation failed"); return
    frames = sorted(glob.glob(os.path.join(OUT, PREFIX + "_*.png")))
    log("interp frames=%d" % len(frames))
    if not frames:
        return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out_mp4 = os.path.join(HOME, "oshal-keyframe-interp.mp4")
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, PREFIX + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], capture_output=True, text=True, timeout=600)
    log("ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
