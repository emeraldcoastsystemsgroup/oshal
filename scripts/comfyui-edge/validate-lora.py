# Box-side VALIDATOR for a trained character LoRA (LoRA Studio P2). Loads the LoRA in ComfyUI
# (LoraLoader) and generates ONE image per cell of a FIXED, held-out matrix (poses/cameras/
# expressions the trainer never used, with PINNED seeds), then scores each cell:
#   identity = CLIP-image cosine to the locked hero (does it still look like THE character)
#   quality  = CLIP good-vs-bad proxy + the character's OWN structural guard (declared per
#              character as an identity/violation prompt pair; absent when it declares none)
#   score    = 0.6*identity + 0.4*quality      (mirrors src/features/lora-studio/scorecard.ts)
# Because the matrix + seeds + hero + CLIP model are fixed, score(vN) is directly comparable to
# score(v1) - the objective "is it better" number. Writes a scorecard JSON + an index.html gallery
# and POSTs the scorecard back to the controller's /api/lora/ingest (x-service-secret).
#
# Usage (on the GPU box, ComfyUI running on :8188) - the identity arguments come from the
# controller's `oshal_lora_characters` row, never from a constant in this file:
#   python validate-lora.py --character <subject> --version 1 --lora-name <subject>_v1.safetensors \
#       --trigger <word> --hero <hero.png> --ident "<look sentence>" \
#       --controller http://100.64.0.1:35457 --owner-sub-b64 <subject>
# 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Bind callbacks to the initiating owner's
# canonical base64url identity header; a fleet secret without owner attribution is insufficient.
# 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Read the callback fleet secret only from
# the edge process environment so it cannot leak through task payloads, argv, or shell history.
# 2026-09-21 | maintainer@emeraldcoastsystemsgroup.com | POST a bounded thumbnail per scored cell to
# the controller. The scorecard carried only a ComfyUI filename, which lives on THIS box and no
# browser can fetch, so the studio rendered no image at all for any cell. One small JPEG per cell
# goes to /api/lora/ingest/cell-image, which stores it owner-scoped with an expiry; the full-size
# render stays here.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Take the trigger word, hero image, identity
#     sentence, negative prompt, structural guard prompts, base checkpoint and output directory
#     from the character's own configuration instead of the first character this script ever
#     validated. The single-eye guard is now that character's declared structural pair and is
#     simply absent for a character that declares none - validating a two-eyed character against a
#     cyclops guard halved its quality score on every cell.
#
# Free-first: CLIP scoring is local ($0). The optional LLM-vision judge is a separate, metered,
# opt-in step on the controller - never the primary score here.
import urllib.request, urllib.parse, json, time, os, glob, argparse, io, sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from character_config import add_character_arguments, character_config  # noqa: E402

# Bounds for the per-cell thumbnails the controller hosts. The route refuses anything above
# MAX_CELL_IMAGE_BYTES (lora/src-routes/lora-cell-images.ts), so the encoder aims well under it and
# gives up rather than posting a body the controller will reject.
THUMB_MAX_EDGE = 320
THUMB_MAX_BYTES = 240 * 1024
THUMB_QUALITIES = (82, 70, 58, 45, 32)

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")

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


def gen_cell(cfg, lora_name, prompt, seed, pfx):
    """txt2img through the trained LoRA - tests the identity the LoRA learned from the trigger word."""
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": cfg.base_model}},
        "lora": {"class_type": "LoraLoader", "inputs": {"model": ["ck", 0], "clip": ["ck", 1],
                 "lora_name": lora_name, "strength_model": 0.8, "strength_clip": 0.8}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": cfg.negative, "clip": ["lora", 1]}},
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


def build_parser():
    """
    @description The CLI. Every identity option is supplied by the controller's lora dispatch from
      this character's `oshal_lora_characters` row; this file holds no character constant.
    @returns The argparse parser.
    """
    ap = argparse.ArgumentParser(description="Validate one trained character LoRA on the held-out matrix")
    add_character_arguments(ap)
    ap.add_argument("--version", type=int, required=True)
    ap.add_argument("--lora-name", required=True, help="LoRA filename as ComfyUI sees it (in models/loras)")
    ap.add_argument("--controller", default=os.environ.get("OSHAL_CONTROLLER", ""))
    ap.add_argument("--owner-sub-b64", default=os.environ.get("OSHAL_USER_SUB_B64", ""))
    return ap


def hero_path_for(cfg):
    """
    @description Locate this character's locked hero image: ComfyUI's input directory first, then
      its output directory. Returns None when the character has no hero on the box yet, which
      degrades identity scoring rather than scoring against somebody else's hero.
    @param cfg - The resolved CharacterConfig.
    @returns An absolute path or None.
    """
    return cfg.hero_image_path(INP, OUT)


def structural_probe(cfg, clip):
    """
    @description Embed this character's declared structural pair (for a cyclops: 'a single big eye'
      against 'two eyes'). A character that declares no pair gets no structural penalty - applying
      another character's anatomy guard is a scoring defect, not a safety net.
    @param cfg - The resolved CharacterConfig.
    @param clip - The CLIP scorer.
    @returns {'ok', 'violation'} text vectors, or None.
    """
    prompts = cfg.structural_prompts()
    if not prompts or not clip.ok:
        return None
    return {"ok": clip.txt_vec(prompts["identity_structure"]),
            "violation": clip.txt_vec(prompts["identity_violation"])}


def score_image(clip, img_path, hero_vec, good, bad, probe):
    """
    @description Score one rendered cell: CLIP-image cosine to this character's own hero for
      identity, the good-versus-bad proxy for quality, then this character's structural penalty.
    @param clip - The CLIP scorer.
    @param img_path - The rendered image.
    @param hero_vec - This character's hero embedding (None degrades identity to 0.5).
    @param good - "good render" text embedding.
    @param bad - "bad render" text embedding.
    @param probe - structural_probe() result or None.
    @returns (identity, quality), each 0..1.
    """
    if not clip.ok or hero_vec is None:
        return 0.5, 0.5
    v = clip.img_vec(img_path)
    identity = clamp01((clip.cos(v, hero_vec) + 1) / 2)  # cosine -> 0..1
    q = clamp01(0.5 + 6.0 * (clip.cos(v, good) - clip.cos(v, bad)))
    if probe and clip.cos(v, probe["violation"]) > clip.cos(v, probe["ok"]):
        q *= 0.55
    return identity, clamp01(q)


def rollup(cells):
    """
    @description Summarize the scored cells (mirrors scorecard.ts summarizeScore/computeWeakCells).
    @param cells - Scored cell dictionaries.
    @returns (overall, identity_mean, quality_mean, min_cell, weak_cells).
    """
    if not cells:
        return 0.0, 0.0, 0.0, 0.0, []
    scs = [c["score"] for c in cells]
    overall = round(sum(scs) / len(scs), 4)
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
    return (overall,
            round(sum(c["identity"] for c in cells) / len(cells), 4),
            round(sum(c["quality"] for c in cells) / len(cells), 4),
            round(min(scs), 4), weak)


def score_matrix(cfg, a, clip):
    """
    @description Render and score every held-out cell for this character.
    @param cfg - The resolved CharacterConfig.
    @param a - Parsed arguments (version, lora_name).
    @param clip - The CLIP scorer.
    @returns (cells, gallery_meta).
    """
    hero_path = hero_path_for(cfg)
    hero_vec = clip.img_vec(hero_path) if (clip.ok and hero_path) else None
    good = clip.txt_vec("a sharp, clean, highly detailed 3d render of a single character") if clip.ok else None
    bad = clip.txt_vec("a blurry, deformed, low quality, messy image") if clip.ok else None
    probe = structural_probe(cfg, clip)
    cells, meta = [], []
    for i, (act, cam, exp, lit) in enumerate(VAL_CELLS):
        desc = "%s, %s, %s, %s" % (act, cam, exp, lit)
        pfx = "val_%s_v%d_%02d" % (cfg.subject, a.version, i)
        o = gen_cell(cfg, a.lora_name, cfg.prompt(desc), 500000 + i, pfx)
        if not o:
            log("cell %d FAILED | %s" % (i, desc)); continue
        fn = o["save"]["images"][0]["filename"]
        identity, quality = 0.5, 0.5
        try:
            identity, quality = score_image(clip, os.path.join(OUT, fn), hero_vec, good, bad, probe)
        except Exception as e:
            log("score err cell %d: %r" % (i, e))
        score = round(0.6 * identity + 0.4 * quality, 4)
        cells.append({"cell": "%s|%s|%s" % (act, cam, exp), "action": act, "camera": cam, "expression": exp,
                      "identity": round(identity, 4), "quality": round(quality, 4), "score": score, "image": fn})
        meta.append({"f": fn, "desc": desc, "id": identity, "q": quality, "s": score})
        log("cell %d ok | id %.2f q %.2f score %.2f | %s" % (i, identity, quality, score, desc))
    return cells, meta


def main():
    """Validate one version of one character and report its scorecard to the controller."""
    a = build_parser().parse_args()
    cfg = character_config(a)
    secret = os.environ.get("SWARM_SERVICE_SECRET", "")
    os.makedirs(cfg.validate_dir, exist_ok=True)

    clip = Clip()
    cells, meta = score_matrix(cfg, a, clip)
    overall, identity_mean, quality_mean, min_cell, weak = rollup(cells)

    scorecard = {"kind": "score", "character": cfg.subject, "version": a.version,
                 "overall": overall, "identity_mean": identity_mean, "quality_mean": quality_mean,
                 "min_cell": min_cell, "cells": cells, "weak_cells": weak,
                 "scorer": ("clip-" + clip.kind) if clip.ok else "degraded"}
    json.dump(scorecard, open(os.path.join(cfg.validate_dir, "scorecard_v%d.json" % a.version), "w"), indent=2)
    write_gallery(cfg, a, scorecard, meta)
    log("==== VALIDATION v%d: overall %.3f (id %.3f / q %.3f), %d cells, %d weak ===="
        % (a.version, overall, identity_mean, quality_mean, len(cells), len(weak)))

    if a.controller and secret and a.owner_sub_b64:
        post_ingest(a.controller, secret, a.owner_sub_b64, scorecard)
        # The scorecard lands first: a cell thumbnail is an illustration of a score that already
        # exists, so losing one must never cost the run its numbers.
        post_cell_images(a.controller, secret, a.owner_sub_b64, a.character, a.version, meta)
    else:
        log("no complete controller/secret/owner binding given; scorecard saved locally only")


def write_gallery(cfg, a, sc, meta):
    """Write this character's own scorecard gallery into its own validate directory."""
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
            % (cfg.subject, a.version, cfg.subject, a.version, sc["overall"], sc["identity_mean"],
               sc["quality_mean"], sc["min_cell"], "".join(cards)))
    open(os.path.join(cfg.validate_dir, "scorecard_v%d.html" % a.version), "w", encoding="utf-8").write(html)


def thumbnail_bytes(path):
    """Shrink one validation render to a bounded JPEG the controller will accept.

    Returns (bytes, content_type) or None. None is a normal outcome, not an error: Pillow may be
    absent on a minimal box, and a cell with no thumbnail simply renders without an image. The
    encoder walks the quality ladder down and REFUSES rather than returning something over the
    controller's bound, because a body the route rejects is worse than no body at all.
    """
    try:
        from PIL import Image
    except Exception as e:
        log("Pillow unavailable (%r) - cells will have no hosted thumbnail" % e)
        return None
    try:
        im = Image.open(path)
        im.load()
        im = im.convert("RGB")
        im.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE))
        for quality in THUMB_QUALITIES:
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if len(data) <= THUMB_MAX_BYTES:
                return data, "image/jpeg"
        log("thumbnail for %s stayed above %d bytes - not posting it" % (path, THUMB_MAX_BYTES))
        return None
    except Exception as e:
        log("thumbnail err %s: %r" % (path, e))
        return None


def post_cell_image(controller, secret, owner_sub_b64, character, version, cell_index, filename, data, content_type):
    """POST one bounded thumbnail. Same guard pair as the scorecard callback: the fleet secret from
    this process's environment plus the separately encoded exact owner. The body is the raw image -
    the controller's global JSON limit is 100kb, which a matrix of base64 cells would blow past."""
    url = "%s/api/lora/ingest/cell-image?character=%s&version=%d&cell=%d&filename=%s" % (
        controller.rstrip("/"),
        urllib.parse.quote(str(character), safe=""),
        int(version), int(cell_index),
        urllib.parse.quote(str(filename or ""), safe=""),
    )
    try:
        req = urllib.request.Request(
            url, data=data,
            headers={"Content-Type": content_type, "x-service-secret": secret,
                     "x-oshal-user-sub-b64": owner_sub_b64})
        urllib.request.urlopen(req, timeout=30).read()
        return True
    except Exception as e:
        log("cell %d image POST FAILED (%r) - the scorecard is unaffected" % (cell_index, e))
        return False


def post_cell_images(controller, secret, owner_sub_b64, character, version, meta):
    """Copy every scored cell's render to the controller as a bounded thumbnail. Best-effort per
    cell: a failure costs that one image, never the scorecard that already landed."""
    posted = 0
    for cell_index, m in enumerate(meta):
        made = thumbnail_bytes(os.path.join(OUT, m["f"]))
        if not made:
            continue
        data, content_type = made
        if post_cell_image(controller, secret, owner_sub_b64, character, version, cell_index, m["f"], data, content_type):
            posted += 1
    log("posted %d/%d cell thumbnails to the controller" % (posted, len(meta)))
    return posted


def post_ingest(controller, secret, owner_sub_b64, scorecard):
    url = controller.rstrip("/") + "/api/lora/ingest"
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(scorecard).encode(),
            headers={"Content-Type": "application/json", "x-service-secret": secret,
                     "x-oshal-user-sub-b64": owner_sub_b64})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())
        log("ingest ok: %s" % r)
    except Exception as e:
        log("ingest FAILED (%r) - scorecard is saved locally; re-post later" % e)


if __name__ == "__main__":
    main()
