# Box-side: a short of the trained cyclops WALKING. The SD1.5 LoRA can't drive LTX-Video, so we
# generate a clean walking keyframe WITH the v1 LoRA (identity), then image-to-video animate it with
# LTX-Video (the proven i2v graph from make-overnight). ffmpeg stitches an mp4 + a sampled frame-strip.
#   python make-walk.py --lora-name oshbrainrot_v1.safetensors --frames 73
import urllib.request, json, time, os, glob, shutil, subprocess, argparse
from PIL import Image

HOME = os.path.expanduser("~"); BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output"); INP = os.path.join(COMFY, "input"); DEST = os.path.join(HOME, "lora-walk")
FF = os.path.join(HOME, "ffmpeg", "ffmpeg.exe"); FF = FF if os.path.exists(FF) else "ffmpeg"
SD = "v1-5-pruned-emaonly-fp16.safetensors"; LTX = "ltx-video-2b-v0.9.5.safetensors"; T5 = "t5xxl_fp8_e4m3fn_scaled.safetensors"
IDENT = "oshbrainrot, a one-eyed orange-red cyclops creature, big single eye, wide toothy mouth, stubby clawed legs, long thin arms, glossy 3d render, italian brainrot meme style"
QUAL = ", highly detailed, sharp focus, clean render, best quality"
NEG = "blurry, low quality, deformed, extra eyes, two eyes, text, watermark, multiple characters, jpeg artifacts"
STYLE = ", glossy 3d render, italian brainrot meme style, smooth motion"
NEG_I = "blurry, distorted, morphing into a different creature, extra limbs, flicker, low quality, two eyes"


def log(m): print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def run(wf, tmo=300):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(
            BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(),
            headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    except Exception as e:
        log("submit err " + repr(e)); return None
    for _ in range(tmo // 3):
        time.sleep(3)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h and h[pid].get("outputs"):
            return h[pid]["outputs"]
        if pid in h and h[pid].get("status", {}).get("status_str") == "error":
            log("workflow error"); return None
    return None


def keyframe(lora):
    wf = {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SD}},
        "lora": {"class_type": "LoraLoader", "inputs": {"model": ["ck", 0], "clip": ["ck", 1], "lora_name": lora, "strength_model": 0.85, "strength_clip": 0.85}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": IDENT + ", walking, full body in frame, side profile view, mid-stride, plain grey studio background" + QUAL, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["lora", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7777, "steps": 30, "cfg": 7.0, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0, "model": ["lora", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": "walk_key"}},
    }
    o = run(wf, 180); return o["save"]["images"][0]["filename"] if o else None


def i2v(start_img, frames):
    motion = "the one-eyed cyclops creature walking forward in a steady walk cycle, legs stepping, arms swinging, full body in frame, side view" + STYLE
    wf = {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": LTX}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": T5, "type": "ltxv"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": start_img}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": motion, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG_I, "clip": ["te", 0]}},
        "i2v": {"class_type": "LTXVImgToVideo", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "image": ["img", 0], "width": 512, "height": 512, "length": frames, "batch_size": 1, "strength": 0.92}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["i2v", 0], "negative": ["i2v", 1], "frame_rate": 25.0}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 30, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["i2v", 2]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": "walkvid/frame"}},
    }
    return run(wf, 600)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--lora-name", default="oshbrainrot_v1.safetensors"); ap.add_argument("--frames", type=int, default=73); a = ap.parse_args()
    os.makedirs(DEST, exist_ok=True)
    log("generating walking keyframe with the LoRA...")
    kf = keyframe(a.lora_name)
    if not kf: log("keyframe FAILED"); return
    shutil.copy(os.path.join(OUT, kf), os.path.join(INP, "walk_key.png"))
    log("keyframe ok -> %s. animating walk (%d frames)..." % (kf, a.frames))
    o = i2v("walk_key.png", a.frames)
    if not o: log("i2v FAILED"); return
    # collect frames (SaveImage prefix 'walkvid/frame' -> OUT/walkvid/frame_00001_.png ...)
    fs = sorted(glob.glob(os.path.join(OUT, "walkvid", "frame_*.png")))
    log("got %d frames" % len(fs))
    if not fs: return
    # mp4 via ffmpeg
    mp4 = os.path.join(DEST, "walk.mp4")
    cmd = [FF, "-y", "-framerate", "24", "-i", os.path.join(OUT, "walkvid", "frame_%05d_.png"),
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=512:512", mp4]
    try:
        subprocess.run(cmd, check=False, capture_output=True)
        log("mp4 -> %s (%d bytes)" % (mp4, os.path.getsize(mp4) if os.path.exists(mp4) else 0))
    except Exception as e:
        log("ffmpeg err " + repr(e))
    # gif too (easy to view)
    gif = os.path.join(DEST, "walk.gif")
    try:
        subprocess.run([FF, "-y", "-framerate", "18", "-i", os.path.join(OUT, "walkvid", "frame_%05d_.png"),
                        "-vf", "scale=256:256", gif], check=False, capture_output=True)
        log("gif -> %s" % gif)
    except Exception:
        pass
    # 8-frame sampled strip (so the walk is viewable as a static image)
    pick = [fs[int(i * (len(fs) - 1) / 7)] for i in range(8)]
    th = 200; strip = Image.new("RGB", (th * len(pick), th), (20, 20, 30))
    for i, p in enumerate(pick):
        try: strip.paste(Image.open(p).convert("RGB").resize((th, th)), (i * th, 0))
        except Exception: pass
    strip.save(os.path.join(DEST, "walk-strip.png"))
    log("WALK DONE -> %s + walk.mp4/gif + walk-strip.png" % DEST)


if __name__ == "__main__":
    main()
