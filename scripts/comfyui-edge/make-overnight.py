# Box-side OVERNIGHT batch: keep the GPU productive while unattended.
#  A) expand the brainrot LoRA dataset (+more poses) for a stronger future train.
#  B) animation LOOK SWEEP: same action across strength/seg settings -> pick the best look in the morning.
#  C) content LIBRARY: the cyclops doing many actions, 2-segment continuation clips.
# Everything is generation on the WORKING ComfyUI (no risky installs). Out ~/overnight/, log ~/overnight.log
import urllib.request, json, time, os, subprocess, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
DEST = os.path.join(HOME, "overnight")
DATA = os.path.join(HOME, "lora-brainrot", "img")
LOG = os.path.join(HOME, "overnight.log")
W, H, FPS = 512, 512, 25
HERO = "hero_brainrot_00002_.png"
HERO_PROMPT = ("an angry muscular cappuccino coffee cup creature with skinny chicken legs, big googly eyes, "
               "tiny white sneakers, surreal funny glossy 3d render, italian brainrot meme style, plain background, full body")
IDENT = "a one-eyed leathery brown screaming cyclops creature, big single eye, wide open mouth, glossy 3d render, italian brainrot meme style"
STYLE = ", glossy 3d render, italian brainrot meme style, smooth animation"
NEG_I = "worst quality, jittery, distorted, flicker, morphing, melting, blurry, extra eyes"
NEG_T = "blurry, low quality, deformed, extra eyes, text, watermark, multiple characters"
FF = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
FF = FF if os.path.exists(FF) else "ffmpeg"
MANIFEST = []      # one entry per produced clip, for the morning review gallery


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def run(wf, tries=300):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    except Exception as e:
        log("submit err " + repr(e)); return None
    for _ in range(tries):
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


def txt2img(scene, seed, pfx, neg=NEG_T):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def img2img(src, scene, seed, den, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG_T, "clip": ["ck", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": den, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def i2v_seg(start_img, motion, strength, seg, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": start_img}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": motion + STYLE, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG_I, "clip": ["te", 0]}},
        "i2v": {"class_type": "LTXVImgToVideo", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ck", 2], "image": ["img", 0], "width": W, "height": H, "length": seg, "batch_size": 1, "strength": strength}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["i2v", 0], "negative": ["i2v", 1], "frame_rate": float(FPS)}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 30, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["i2v", 2]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def stitch(pfx, out_mp4):
    frames = sorted(glob.glob(os.path.join(OUT, pfx + "_*.png")))
    if not frames:
        return 0
    subprocess.run([FF, "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, pfx + "_%05d_.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4],
                   capture_output=True, text=True, timeout=600)
    return len(frames)


def clear(pfx):
    for f in glob.glob(os.path.join(OUT, pfx + "_*.png")):
        try: os.remove(f)
        except Exception: pass


def clip(start_img, beats, strength, seg, label, kind, note):
    pfx = "ov_" + label
    clear(pfx)
    cur = start_img
    for b in beats:
        if not i2v_seg(cur, b, strength, seg, pfx):
            log("  seg fail in " + label); break
        fs = sorted(glob.glob(os.path.join(OUT, pfx + "_*.png")))
        if fs:
            shutil.copy(fs[-1], os.path.join(INP, pfx + "_cont.png")); cur = pfx + "_cont.png"
    n = stitch(pfx, os.path.join(DEST, label + ".mp4"))
    log("  clip %s frames=%d" % (label, n))
    if n:
        MANIFEST.append({"file": label + ".mp4", "kind": kind, "strength": strength, "seg": seg,
                         "secs": round(n / FPS, 1), "beats": beats, "note": note})


def write_gallery(ds_count):
    """Browsable accept/reject gallery: each clip with its params explained."""
    rows = []
    for m in MANIFEST:
        rows.append(
            "<div class=card><video src='%s' controls loop muted width=320></video>"
            "<div class=meta><b>%s</b><br><span class=k>%s</span><br>"
            "motion-strength <b>%.2f</b> &middot; segment <b>%d</b> frames (~%ss)<br>"
            "<i>%s</i><br>action: %s</div>"
            "<div class=vote>[ ] keep&nbsp;&nbsp;[ ] reject</div></div>"
            % (m["file"], m["file"], m["kind"], m["strength"], m["seg"], m["secs"], m["note"],
               " &rarr; ".join(b[:60] for b in m["beats"])))
    html = (
        "<html><head><meta charset=utf-8><title>OSHAL brainrot - overnight review</title>"
        "<style>body{font:14px system-ui;background:#111;color:#eee;margin:20px}"
        ".card{display:inline-block;vertical-align:top;width:340px;margin:10px;background:#1c1c1c;"
        "border:1px solid #333;border-radius:10px;padding:10px}.meta{margin:6px 2px;font-size:13px}"
        ".k{color:#f86;font-weight:bold}.vote{color:#7c7;font-family:monospace}h1{color:#f86}"
        ".legend{background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:12px;margin:10px 0}</style></head><body>"
        "<h1>oshbrainrot - the screaming cyclops &mdash; overnight tuning gallery</h1>"
        "<div class=legend><b>How to use:</b> the CHARACTER is fixed (the cyclops). These clips vary the "
        "ANIMATION settings so you can pick the best look, then tell me which to keep.<br><br>"
        "<b>motion-strength</b> (0.85&ndash;1.0): how strongly the GPU re-animates the start frame. "
        "Higher = more movement but more risk of the image getting soft/wobbly. Lower = steadier but stiffer.<br>"
        "<b>segment frames</b> (49 vs 65): clip length per beat. 49&asymp;2.0s, 65&asymp;2.6s &mdash; longer can drift more.<br>"
        "<b>SWEEP</b> cards = same action, different settings (compare the knobs). "
        "<b>LIBRARY</b> cards = the cyclops doing different actions at the default setting.<br>"
        "Dataset for the future LoRA train is now <b>%d images</b>.</div>%s</body></html>"
        % (ds_count, "".join(rows)))
    open(os.path.join(DEST, "index.html"), "w", encoding="utf-8").write(html)
    md = ["# Overnight review - oshbrainrot (cyclops)\n", "Character is FIXED; these tune the animation.\n"]
    for m in MANIFEST:
        md.append("- [ ] **%s** (%s) - strength %.2f, seg %d (~%ss) - %s" %
                  (m["file"], m["kind"], m["strength"], m["seg"], m["secs"], m["note"]))
    open(os.path.join(DEST, "review.md"), "w", encoding="utf-8").write("\n".join(md))
    log("gallery written: %d clips" % len(MANIFEST))


def ensure_hero():
    if os.path.exists(os.path.join(OUT, HERO)):
        return HERO
    o = txt2img(HERO_PROMPT, 22, "hero_brainrot")
    return o["save"]["images"][0]["filename"] if o else None


# --- phases ---
EXTRA_POSES = ["from behind looking over shoulder", "sitting down relaxed", "flexing muscles", "shrugging",
               "pointing forward", "covering its eye", "tip-toeing sneaky", "belly laughing", "thinking pose hand on chin",
               "scared shaking", "thumbs up", "yelling into a megaphone", "holding a coffee mug", "doing a backflip",
               "lying on the ground", "peeking around a corner", "arms crossed annoyed", "blowing a kiss",
               "running fast motion blur", "celebrating with arms up"]
SWEEP = [(0.85, 49), (0.95, 49), (1.0, 49), (1.0, 65)]
LIBRARY = {
    "wave": ["the creature waves both arms and screams happily", "the creature keeps waving, bouncing"],
    "dance": ["the creature does a wiggly dance, swinging its arms", "the creature spins and dances"],
    "jump": ["the creature jumps up and down excitedly", "the creature lands and jumps again"],
    "yell": ["the creature leans forward yelling, mouth wide", "the creature shakes its head still yelling"],
    "run": ["the creature runs to the right, legs pumping", "the creature keeps running, arms swinging"],
    "spin": ["the creature spins around in a circle", "the creature stops, dizzy, wobbling"],
    "nod": ["the creature nods its head up and down", "the creature tilts its head, big eye blinking"],
    "celebrate": ["the creature throws its arms up celebrating", "the creature does a little victory wiggle"],
}


def main():
    os.makedirs(DEST, exist_ok=True)
    log("==== OVERNIGHT BATCH START ====")
    hero = ensure_hero()
    if not hero:
        log("hero regen failed; abort"); return
    shutil.copy(os.path.join(OUT, hero), os.path.join(INP, "ov_hero.png"))
    # A) dataset expansion
    log("PHASE A: dataset expansion (+%d poses)" % len(EXTRA_POSES))
    os.makedirs(DATA, exist_ok=True)
    base = 100
    for i, phrase in enumerate(EXTRA_POSES):
        o = img2img("ov_hero.png", IDENT + ", " + phrase, 200 + i, 0.55, "ovset")
        if o:
            src = os.path.join(OUT, o["save"]["images"][0]["filename"])
            b = "oshbrainrot_%03d" % (base + i)
            shutil.copy(src, os.path.join(DATA, b + ".png"))
            open(os.path.join(DATA, b + ".txt"), "w").write("oshbrainrot, " + phrase)
    log("PHASE A done; dataset now %d imgs" % len(glob.glob(os.path.join(DATA, "*.png"))))
    # B) look sweep
    log("PHASE B: animation look sweep (%d settings)" % len(SWEEP))
    for strn, seg in SWEEP:
        clip("ov_hero.png", ["the creature waves an arm and screams, mouth wide open"], strn, seg,
             "sweep_s%02d_seg%d" % (int(strn * 100), seg), "SWEEP",
             "same action, this setting only - compare against the other sweep cards")
    # C) content library
    log("PHASE C: content library (%d actions)" % len(LIBRARY))
    for name, beats in LIBRARY.items():
        clip("ov_hero.png", beats, 1.0, 49, "lib_" + name, "LIBRARY",
             "the cyclops doing '%s' at the default setting" % name)
    ds_count = len(glob.glob(os.path.join(DATA, "*.png")))
    write_gallery(ds_count)
    log("==== OVERNIGHT BATCH DONE ====")


main()
