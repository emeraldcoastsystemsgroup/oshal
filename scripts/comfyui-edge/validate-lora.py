# Box-side VALIDATOR for a trained character LoRA (LoRA Studio P2). Loads the LoRA in ComfyUI
# (LoraLoader) and generates ONE image per cell of a FIXED, held-out matrix (poses/cameras/
# expressions the trainer never used, with PINNED seeds), then scores each cell:
#   identity = CLIP-image cosine to the locked hero (does it still look like THE character)
#   quality  = CLIP good-vs-bad proxy + a single-eye guard (a cyclops must keep ONE eye)
#   score    = 0.6*identity + 0.4*quality      (mirrors src/features/lora-studio/scorecard.ts)
# Because the matrix + seeds + hero + CLIP model are fixed, score(vN) is directly comparable to
# score(v1) - the objective "is it better" number. Writes a scorecard JSON + an index.html gallery
# and POSTs the scorecard back to the controller's /api/lora/ingest (x-service-secret).
#
# Usage (on the GPU box, ComfyUI running on :8188):
#   python validate-lora.py --character oshbrainrot --version 1 --lora-name oshbrainrot_v1.safetensors \
#       --controller http://100.64.0.1:35457 --secret $SWARM_SERVICE_SECRET
#
# Free-first: CLIP scoring is local ($0). The optional LLM-vision judge is a separate, metered,
# opt-in step on the controller - never the primary score here.
import urllib.request, json, time, os, glob, argparse

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
DEST = os.path.join(HOME, "lora-validate")
HERO = "hero_brainrot_00002_.png"
TRIG = "oshbrainrot"
IDENT_TAGS = ", glossy 3d render, italian brainrot meme style"
QUAL = ", highly detailed, sharp focus, intricate, clean render, best quality"
NEG = "blurry, low quality, deformed, extra eyes, two eyes, text, watermark, multiple characters, jpeg artifacts, lowres"
CKPT = "v1-5-pruned-emaonly-fp16.safetensors"

# FIXED held-out validation matrix - same vocab as the generator, but reserved combos + seeds
# (500000+ band) the trainer never emitted. Each tuple: (action, camera, expression, lighting).
VAL_CELLS = [
    ("standing", "front view", "big happy grin", "plain grey studio background"),
    ("running", "side profile view", "screaming wide open mouth", "white cyclorama studio"),
    ("jumping high", "three-quarter view", "shocked surprised", "neon city night background"),
    ("sitting cross-legged", "low angle looking up", "angry scowl", "dramatic spotlight on dark background"),
    ("waving an arm", "high angle looking down", "laughing hard", "warm sunny outdoor"),
    ("crouching low", "extreme close-up of the face", "sleepy half-closed eye", "soft even studio light"),
    ("celebrating arms up", "full body wide shot", "smug smirk", "moody rim lighting"),
    ("thinking hand on chin", "from behind over the shoulder", "scared trembling", "standing on coffee beans"),
    ("pointing forward", "front view", "angry scowl", "neon city night background"),
    ("doing a backflip", "three-quarter view", "big happy grin", "soft even studio light"),
    ("marching", "side profile view", "smug smirk", "plain grey studio background"),
    ("stretching tall", "low angle looking up", "screaming wide open mouth", "dramatic spotlight on dark background"),
]


def log(m):
    print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def run(wf):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(
            BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(),
            headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    except Exception as e:
        log("submit err " + repr(e)); return None
    for _ in range(240):
        time.sleep(4)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h and h[pid].get("outputs"):
            return h[pid]["outputs"]
        if pid in h and h[pid].get("status", {}).get("status_str") == "error":
            return None
    return None


def gen_cell(lora_name, prompt, seed, pfx):
    """txt2img through the trained LoRA - tests the identity the LoRA learned from the trigger word."""
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "lora": {"class_type": "LoraLoader", "inputs": {"model": ["ck", 0], "clip": ["ck", 1],
                 "lora_name": lora_name, "strength_model": 0.8, "strength_clip": 0.8}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["lora", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 30, "cfg": 7.0,
               "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
               "model": ["lora", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


# ---- CLIP scorer (free, local). Tries open_clip, then transformers; degrades to identity=0.5 ----
class Clip:
    def __init__(self):
        self.ok = False
        try:
            import torch, open_clip
            self.torch = torch
            self.dev = "cuda" if torch.cuda.is_available() else "cpu"
            self.model, _, self.pp = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
            self.tok = open_clip.get_tokenizer("ViT-B-32")
            self.model = self.model.to(self.dev).eval()
            self.kind = "open_clip"; self.ok = True
        except Exception as e:
            log("open_clip unavailable (%r) - trying transformers" % e)
            try:
                import torch
                from transformers import CLIPModel, CLIPProcessor
                self.torch = torch
                self.dev = "cuda" if torch.cuda.is_available() else "cpu"
                self.model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32").to(self.dev).eval()
                self.proc = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
                self.kind = "transformers"; self.ok = True
            except Exception as e2:
                log("CLIP unavailable (%r) - identity scoring degraded to 0.5" % e2)

    def img_vec(self, path):
        from PIL import Image
        im = Image.open(path).convert("RGB")
        with self.torch.no_grad():
            if self.kind == "open_clip":
                x = self.pp(im).unsqueeze(0).to(self.dev)
                v = self.model.encode_image(x)
            else:
                x = self.proc(images=im, return_tensors="pt").to(self.dev)
                v = self.model.get_image_features(**x)
        return (v / v.norm(dim=-1, keepdim=True))[0]

    def txt_vec(self, text):
        with self.torch.no_grad():
            if self.kind == "open_clip":
                t = self.tok([text]).to(self.dev)
                v = self.model.encode_text(t)
            else:
                t = self.proc(text=[text], return_tensors="pt", padding=True).to(self.dev)
                v = self.model.get_text_features(**t)
        return (v / v.norm(dim=-1, keepdim=True))[0]

    def cos(self, a, b):
        return float((a * b).sum().item())


def clamp01(x):
    return max(0.0, min(1.0, x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--version", type=int, required=True)
    ap.add_argument("--lora-name", required=True, help="LoRA filename as ComfyUI sees it (in models/loras)")
    ap.add_argument("--controller", default=os.environ.get("OSHAL_CONTROLLER", ""))
    ap.add_argument("--secret", default=os.environ.get("SWARM_SERVICE_SECRET", ""))
    a = ap.parse_args()
    os.makedirs(DEST, exist_ok=True)

    clip = Clip()
    hero_path = os.path.join(INP, HERO)
    if not os.path.exists(hero_path):
        alt = os.path.join(OUT, HERO)
        hero_path = alt if os.path.exists(alt) else None
    hero_vec = clip.img_vec(hero_path) if (clip.ok and hero_path) else None
    good = clip.txt_vec("a sharp, clean, highly detailed 3d render of a single character") if clip.ok else None
    bad = clip.txt_vec("a blurry, deformed, low quality, messy image") if clip.ok else None
    one_eye = clip.txt_vec("a one-eyed cyclops creature with a single big eye") if clip.ok else None
    two_eye = clip.txt_vec("a creature with two eyes") if clip.ok else None

    cells, meta = [], []
    for i, (act, cam, exp, lit) in enumerate(VAL_CELLS):
        desc = "%s, %s, %s, %s" % (act, cam, exp, lit)
        prompt = "%s, a one-eyed orange-red cyclops creature%s, %s%s" % (TRIG, IDENT_TAGS, desc, QUAL)
        seed = 500000 + i
        pfx = "val_%s_v%d_%02d" % (a.character, a.version, i)
        o = gen_cell(a.lora_name, prompt, seed, pfx)
        if not o:
            log("cell %d FAILED | %s" % (i, desc)); continue
        fn = o["save"]["images"][0]["filename"]
        img_path = os.path.join(OUT, fn)

        identity, quality = 0.5, 0.5
        if clip.ok and hero_vec is not None:
            try:
                v = clip.img_vec(img_path)
                identity = clamp01((clip.cos(v, hero_vec) + 1) / 2)  # cosine -> 0..1
                q = clamp01(0.5 + 6.0 * (clip.cos(v, good) - clip.cos(v, bad)))
                if clip.cos(v, two_eye) > clip.cos(v, one_eye):       # single-eye guard
                    q *= 0.55
                quality = clamp01(q)
            except Exception as e:
                log("score err cell %d: %r" % (i, e))
        score = round(0.6 * identity + 0.4 * quality, 4)
        cell = {"cell": "%s|%s|%s" % (act, cam, exp), "action": act, "camera": cam, "expression": exp,
                "identity": round(identity, 4), "quality": round(quality, 4), "score": score, "image": fn}
        cells.append(cell)
        meta.append({"f": fn, "desc": desc, "id": identity, "q": quality, "s": score})
        log("cell %d ok | id %.2f q %.2f score %.2f | %s" % (i, identity, quality, score, desc))

    # Rollup (mirrors scorecard.ts summarizeScore / computeWeakCells).
    if cells:
        scs = [c["score"] for c in cells]
        overall = round(sum(scs) / len(scs), 4)
        identity_mean = round(sum(c["identity"] for c in cells) / len(cells), 4)
        quality_mean = round(sum(c["quality"] for c in cells) / len(cells), 4)
        min_cell = round(min(scs), 4)
        weak = []
        for axis in ("action", "camera", "expression"):
            buckets = {}
            for c in cells:
                buckets.setdefault(c[axis], []).append(c["score"])
            for val, xs in buckets.items():
                mean = sum(xs) / len(xs)
                if mean <= overall - 0.08:
                    weak.append({"axis": axis, "value": val, "mean": round(mean, 4)})
        weak.sort(key=lambda w: w["mean"])
    else:
        overall = identity_mean = quality_mean = min_cell = 0.0
        weak = []

    scorecard = {"kind": "score", "character": a.character, "version": a.version,
                 "overall": overall, "identity_mean": identity_mean, "quality_mean": quality_mean,
                 "min_cell": min_cell, "cells": cells, "weak_cells": weak,
                 "scorer": ("clip-" + clip.kind) if clip.ok else "degraded"}
    json.dump(scorecard, open(os.path.join(DEST, "scorecard_v%d.json" % a.version), "w"), indent=2)
    write_gallery(a, scorecard, meta)
    log("==== VALIDATION v%d: overall %.3f (id %.3f / q %.3f), %d cells, %d weak ===="
        % (a.version, overall, identity_mean, quality_mean, len(cells), len(weak)))

    if a.controller and a.secret:
        post_ingest(a.controller, a.secret, scorecard)
    else:
        log("no --controller/--secret given; scorecard saved locally only")


def write_gallery(a, sc, meta):
    cards = []
    for m in meta:
        cards.append("<div class=c><img src='file:///%s' width=220><div class=m>%s</div>"
                     "<div class=s>score <b>%.2f</b> &middot; id %.2f &middot; q %.2f</div></div>"
                     % (os.path.join(OUT, m["f"]).replace("\\", "/"), m["desc"], m["s"], m["id"], m["q"]))
    html = ("<html><head><meta charset=utf-8><title>%s v%d scorecard</title><style>"
            "body{font:13px system-ui;background:#0e0e16;color:#e6e6f0;margin:18px}.c{display:inline-block;"
            "vertical-align:top;width:232px;margin:6px;background:#15151f;border:1px solid #272735;border-radius:8px;padding:6px}"
            ".m{font-size:11px;margin:4px 2px;color:#8b8ba3}.s{font-family:monospace;color:#6c7bff;font-size:11px}"
            "h1{color:#6c7bff}.lg{background:#15151f;border:1px solid #272735;padding:10px;border-radius:8px;margin:8px 0}</style></head><body>"
            "<h1>%s &mdash; v%d validation</h1><div class=lg>Overall <b>%.3f</b> &middot; identity <b>%.3f</b> &middot; "
            "quality <b>%.3f</b> &middot; worst cell <b>%.3f</b>. Scored on the FIXED held-out matrix, so this is "
            "directly comparable across versions.</div>%s</body></html>"
            % (a.character, a.version, a.character, a.version, sc["overall"], sc["identity_mean"],
               sc["quality_mean"], sc["min_cell"], "".join(cards)))
    open(os.path.join(DEST, "scorecard_v%d.html" % a.version), "w", encoding="utf-8").write(html)


def post_ingest(controller, secret, scorecard):
    url = controller.rstrip("/") + "/api/lora/ingest"
    try:
        req = urllib.request.Request(url, data=json.dumps(scorecard).encode(),
                                     headers={"Content-Type": "application/json", "x-service-secret": secret})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())
        log("ingest ok: %s" % r)
    except Exception as e:
        log("ingest FAILED (%r) - scorecard is saved locally; re-post later" % e)


if __name__ == "__main__":
    main()
