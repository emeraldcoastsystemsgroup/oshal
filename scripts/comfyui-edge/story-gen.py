# Box-side STORY demo: generate a short narrative with the reusable character LoRA. Proves the point
# of the whole LoRA Studio - the SAME trained cyclops across a sequence of story beats. Uses the v1
# LoRA via ComfyUI LoraLoader (trigger word "oshbrainrot"), then tiles the frames into a contact sheet.
#   python story-gen.py --lora-name oshbrainrot_v1.safetensors
import urllib.request, json, time, os, shutil, argparse
from PIL import Image

HOME = os.path.expanduser("~"); BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output"); DEST = os.path.join(HOME, "lora-story")
CKPT = "v1-5-pruned-emaonly-fp16.safetensors"
STYLE = ", glossy 3d render, italian brainrot meme style, highly detailed, sharp focus, clean render"
NEG = "blurry, low quality, deformed, extra eyes, two eyes, text, watermark, multiple characters, jpeg artifacts"
SCENES = [
    ("wakes up", "the cyclops sleepy and yawning, stretching its arms, cozy bedroom, soft morning light"),
    ("finds coffee", "the cyclops wide-eyed and excited holding a giant cup of coffee, kitchen counter"),
    ("zooms out", "the cyclops running fast and happy down a sunny city street, motion"),
    ("trips", "the cyclops tripping and falling over comically, surprised face, sidewalk"),
    ("gets back up", "the cyclops standing back up determined, fists clenched, dramatic spotlight"),
    ("celebrates", "the cyclops celebrating with both arms raised, huge grin, confetti, victory pose"),
]


def log(m): print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def run(wf):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(
            BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(),
            headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    except Exception as e:
        log("submit err " + repr(e)); return None
    for _ in range(120):
        time.sleep(3)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h and h[pid].get("outputs"):
            return h[pid]["outputs"]
        if pid in h and h[pid].get("status", {}).get("status_str") == "error":
            return None
    return None


def gen(lora, prompt, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "lora": {"class_type": "LoraLoader", "inputs": {"model": ["ck", 0], "clip": ["ck", 1], "lora_name": lora, "strength_model": 0.85, "strength_clip": 0.85}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["lora", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 30, "cfg": 7.0, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0, "model": ["lora", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--lora-name", default="oshbrainrot_v1.safetensors"); a = ap.parse_args()
    os.makedirs(DEST, exist_ok=True)
    frames = []
    for i, (beat, desc) in enumerate(SCENES):
        prompt = "oshbrainrot, a one-eyed orange-red cyclops creature, " + desc + STYLE
        o = gen(a.lora_name, prompt, 4242 + i, "story_%02d" % i)
        if not o: log("scene %d FAILED" % i); continue
        src = os.path.join(OUT, o["save"]["images"][0]["filename"])
        dst = os.path.join(DEST, "story_%02d.png" % i); shutil.copy(src, dst); frames.append((beat, dst))
        log("scene %d ok | %s" % (i, beat))
    # 3x2 contact sheet with captions
    cols, th, cap = 3, 360, 26
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * th, rows * (th + cap)), (14, 14, 22))
    for i, (beat, p) in enumerate(frames):
        try:
            im = Image.open(p).convert("RGB").resize((th - 6, th - 6))
            x, y = (i % cols) * th + 3, (i // cols) * (th + cap) + 3
            sheet.paste(im, (x, y))
        except Exception as e:
            log("tile err " + repr(e))
    out = os.path.join(DEST, "story-sheet.png"); sheet.save(out)
    log("STORY DONE -> %s (%d frames)" % (out, len(frames)))


if __name__ == "__main__":
    main()
