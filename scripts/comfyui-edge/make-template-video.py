# Box-side TEMPLATE video maker. Each template locks ONE consistent visual style across the whole
# ~10s clip (the fix for the storyboard's per-scene style drift): every beat uses the same style
# suffix + negative + settings, so the look stays consistent. Text-to-video LTX-Video (8GB lowvram).
# Usage (argv): python make-template-video.py <template-name>
# Output: ~/oshal-tmpl-<name>.mp4 ; log: ~/tmpl-<name>.log
import urllib.request, json, time, os, subprocess, glob, sys

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
W, H, FPS, FRAMES = 768, 512, 25, 81   # 3 beats x 81 frames = ~9.7s

# Reusable templates (mirrors scripts/comfyui-edge/video-templates.json). One locked style each.
TEMPLATES = {
    "sports": {"style": "dynamic TV sports broadcast footage, stadium, dramatic floodlights, cinematic, slight motion blur, high energy",
               "neg": "cartoon, drawing, low quality, blurry, text, watermark",
               "beats": ["wide aerial establishing shot of a packed stadium at night, floodlights blazing",
                         "athletes sprinting across the field in a fast play, crowd blurred behind",
                         "a dramatic game-winning moment, players celebrating, confetti falling, crowd roaring"]},
    "fantasy": {"style": "sports broadcast analysis graphic, clean modern studio, bold team colors, dynamic camera, premium broadcast look",
                "neg": "messy, low quality, blurry, deformed",
                "beats": ["a sleek sports analysis studio desk with glowing screens and stats",
                          "a star athlete in a heroic slow-motion pose, spotlight, bold backdrop",
                          "an energetic montage feel of players, bold graphic style, dynamic"]},
    "stick-figure": {"style": "simple 2D hand-drawn pencil line animation, black ink stick figures, plain white paper background, minimal doodle, flat 2D",
                     "neg": "realistic, 3d, photo, color, detailed, shading, texture",
                     "beats": ["two simple black stick figures talking and gesturing on a white background",
                               "a stick figure pointing at a simple hand-drawn bar chart on white paper",
                               "two stick figures high-fiving, simple motion lines, plain white background"]},
    "story": {"style": "cinematic film still, warm lighting, shallow depth of field, detailed, atmospheric, subtle film grain",
              "neg": "low quality, blurry, deformed, text, watermark",
              "beats": ["a cozy cabin interior at night lit by a warm fireplace, cinematic",
                        "a lone character gazing out a rain-streaked window, moody light",
                        "a warm hopeful sunrise breaking over misty mountains, cinematic wide shot"]},
    "tech": {"style": "sleek futuristic technology product render, glowing blue holographic UI, clean minimal, dark background, premium",
             "neg": "cluttered, low quality, blurry, hands, text",
             "beats": ["a sleek smartphone slowly rotating with glowing holographic interface elements",
                       "abstract flowing data streams and glowing network nodes, blue and cyan",
                       "a futuristic microchip on a circuit board with pulsing light, macro shot"]},
    "paper": {"style": "paper cutout stop motion animation, construction paper texture, handmade, soft shadows, layered papercraft, whimsical",
              "neg": "realistic, 3d render, photo, smooth, glossy",
              "beats": ["a paper cutout sun rising over layered paper hills, construction paper texture",
                        "a paper cutout character walking across a paper landscape, stop-motion feel",
                        "paper cutout birds flying across a paper sky, handmade craft style"]},
}


def log(name, m):
    with open(os.path.join(HOME, "tmpl-%s.log" % name), "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def clip_wf(prompt, neg, seed, prefix):
    return {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": W, "height": H, "length": FRAMES, "batch_size": 1}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 30, "cfg": 3.2, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}},
    }


def run_clip(wf):
    pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
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
                return False
    return False


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "story"
    t = TEMPLATES.get(name)
    if not t:
        log(name, "unknown template " + name); return
    prefix = "tmpl_" + name.replace("-", "")
    log(name, "=== template '%s': locked style, %d beats x %d frames ===" % (name, len(t["beats"]), FRAMES))
    for f in glob.glob(os.path.join(OUT, prefix + "_*.png")):
        try: os.remove(f)
        except Exception: pass
    for i, beat in enumerate(t["beats"]):
        prompt = beat + ", " + t["style"]
        if run_clip(clip_wf(prompt, t["neg"], 5000 + i, prefix)):
            log(name, "beat %d/%d done" % (i + 1, len(t["beats"])))
        else:
            log(name, "beat %d/%d FAILED" % (i + 1, len(t["beats"])))
    frames = sorted(glob.glob(os.path.join(OUT, prefix + "_*.png")))
    log(name, "frames=%d" % len(frames))
    if not frames:
        return
    ff = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
    ff = ff if os.path.exists(ff) else "ffmpeg"
    out_mp4 = os.path.join(HOME, "oshal-tmpl-%s.mp4" % name)
    r = subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, prefix + "_%05d_.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], capture_output=True, text=True, timeout=600)
    log(name, "ffmpeg exit=%d DONE mp4=%s bytes=%d" % (r.returncode, out_mp4, os.path.getsize(out_mp4) if os.path.exists(out_mp4) else 0))


main()
