# Box-side TRAINER for a character LoRA (LoRA Studio P3). Takes the curated dataset (curated.zip:
# paired <name>.png/.txt with the trigger word), trains an SD1.5 LoRA with kohya/sd-scripts on the
# GPU (free), writes oshbrainrot_v{N}.safetensors + a metrics JSON, copies the model into ComfyUI's
# models/loras so validate-lora.py can load it, and POSTs the metrics to the controller's
# /api/lora/ingest (x-service-secret). This script is launched ONLY by the OSHAL worker node's gated
# shell.exec, dispatched from a queue-manager ticket (ADR-070 privilege rule) - never a direct call.
#
# Prereq: run setup-kohya.ps1 once (installs ~/kohya_ss + venv). 8GB-safe hyperparameters are baked in.
#
# Usage (typically invoked by the worker via shell.exec):
#   python train-lora.py --character oshbrainrot --version 1 --dataset ~/overnight/curated.zip \
#       --controller http://100.64.0.1:35457 --owner-sub-b64 <subject>
# 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Bind callbacks to the initiating owner's
# canonical base64url identity header; a fleet secret without owner attribution is insufficient.
# 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Read the callback fleet secret only from
# the edge process environment so it cannot leak through task payloads, argv, or shell history.
import argparse, json, os, re, shutil, subprocess, time, zipfile, glob, urllib.request

HOME = os.path.expanduser("~")
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
CKPT_DIR = os.path.join(COMFY, "models", "checkpoints")
LORA_DIR = os.path.join(COMFY, "models", "loras")
KOHYA = os.path.join(HOME, "kohya_ss")
VENV_PY = os.path.join(KOHYA, "venv", "Scripts", "python.exe")
TRAIN_PY = os.path.join(KOHYA, "sd-scripts", "train_network.py")
WORK = os.path.join(HOME, "lora-train")
MODELS = os.path.join(HOME, "lora-brainrot", "models")
# 8GB-safe SD1.5 LoRA defaults (RTX 4060).
REPEATS = 2            # 90 imgs * 2 = ~180/epoch -> ~1080 steps over 12 epochs at batch1/accum2
NETWORK_DIM = 32
NETWORK_ALPHA = 16
EPOCHS = 12
SAVE_EVERY = 2


def log(m):
    print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def prepare_dataset(dataset_zip, trigger, version, character):
    """Unzip curated.zip into the kohya layout: <root>/img/<repeats>_<trigger>/<name>.png+.txt."""
    root = os.path.join(WORK, "%s_v%d" % (character, version))
    img_root = os.path.join(root, "img", "%d_%s" % (REPEATS, trigger))
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    os.makedirs(img_root, exist_ok=True)
    n = 0
    if os.path.isdir(dataset_zip):                       # a folder of pairs also accepted
        for f in glob.glob(os.path.join(dataset_zip, "*")):
            shutil.copy(f, img_root); n += 1 if f.lower().endswith(".png") else 0
    else:
        with zipfile.ZipFile(dataset_zip) as z:
            for name in z.namelist():
                if name.endswith("/"):
                    continue
                data = z.read(name)
                open(os.path.join(img_root, os.path.basename(name)), "wb").write(data)
                if name.lower().endswith((".png", ".jpg", ".jpeg")):
                    n += 1
    return root, img_root, n


def base_checkpoint(base_name):
    p = os.path.join(CKPT_DIR, base_name)
    if not os.path.exists(p):
        # fall back to any SD1.5 checkpoint present
        cands = glob.glob(os.path.join(CKPT_DIR, "*.safetensors"))
        if not cands:
            raise SystemExit("no base checkpoint found in %s - install the SD1.5 base first" % CKPT_DIR)
        p = cands[0]
        log("base %s not found; using %s" % (base_name, os.path.basename(p)))
    return p


def train(character, version, dataset_zip, base_name, controller, secret, owner_sub_b64,
          parent_version, resolution=512, epochs=EPOCHS, rank=NETWORK_DIM):
    if not os.path.exists(VENV_PY) or not os.path.exists(TRAIN_PY):
        fail(character, version, controller, secret, owner_sub_b64,
             "kohya not installed (%s missing) - run setup-kohya.ps1 first" % VENV_PY)
        return 2
    os.makedirs(MODELS, exist_ok=True); os.makedirs(LORA_DIR, exist_ok=True)
    root, img_root, count = prepare_dataset(dataset_zip, character, version, character)
    base_ckpt = base_checkpoint(base_name)
    out_name = "%s_v%d" % (character, version)
    log_dir = os.path.join(root, "logs")
    alpha = rank // 2
    started = time.time()
    log("training %s from %d images (rank %d, %d epochs, res %d) on %s"
        % (out_name, count, rank, epochs, resolution, os.path.basename(base_ckpt)))

    cmd = [VENV_PY, "-m", "accelerate.commands.launch", "--num_cpu_threads_per_process", "8", TRAIN_PY,
           "--pretrained_model_name_or_path", base_ckpt,
           "--train_data_dir", os.path.join(root, "img"),
           "--output_dir", MODELS, "--output_name", out_name,
           "--resolution", "%d,%d" % (resolution, resolution), "--network_module", "networks.lora",
           "--network_dim", str(rank), "--network_alpha", str(alpha),
           "--train_batch_size", "1", "--gradient_accumulation_steps", "2",
           "--max_train_epochs", str(epochs), "--save_every_n_epochs", str(SAVE_EVERY),
           "--mixed_precision", "fp16", "--save_precision", "fp16",
           "--xformers", "--gradient_checkpointing", "--cache_latents",
           "--optimizer_type", "AdamW8bit", "--learning_rate", "1e-4", "--lr_scheduler", "cosine",
           "--save_model_as", "safetensors", "--caption_extension", ".txt",
           "--mem_eff_attn", "--max_data_loader_n_workers", "2",
           "--logging_dir", log_dir, "--seed", "42"]

    final_loss, steps = None, None
    proc = subprocess.Popen(cmd, cwd=os.path.join(KOHYA, "sd-scripts"),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(line, flush=True)
        m = re.search(r"avr_loss[=:]\s*([0-9.]+)", line) or re.search(r"\bloss[=:]\s*([0-9.]+)", line)
        if m:
            try: final_loss = float(m.group(1))
            except Exception: pass
        ms = re.search(r"(\d+)\s*/\s*\d+\s*\[", line)   # tqdm "123/456 ["
        if ms:
            try: steps = int(ms.group(1))
            except Exception: pass
    rc = proc.wait()

    out_path = os.path.join(MODELS, out_name + ".safetensors")
    if rc != 0 or not os.path.exists(out_path):
        fail(character, version, controller, secret, owner_sub_b64,
             "kohya exited rc=%s, no model at %s" % (rc, out_path))
        return rc or 1

    # Make the model loadable by ComfyUI's LoraLoader (validate-lora.py uses --lora-name <file>).
    lora_name = out_name + ".safetensors"
    shutil.copy(out_path, os.path.join(LORA_DIR, lora_name))
    duration = int(time.time() - started)

    metrics = {"kind": "training", "character": character, "version": version, "status": "trained",
               "lora_path": out_path, "lora_name": lora_name, "base_model": os.path.basename(base_ckpt),
               "dataset_count": count, "network_dim": rank, "epochs": epochs, "steps": steps,
               "final_loss": final_loss, "duration_sec": duration,
               "parent_version": parent_version,
               "metrics": {"repeats": REPEATS, "alpha": alpha, "optimizer": "AdamW8bit",
                           "lr": 1e-4, "scheduler": "cosine", "resolution": resolution}}
    json.dump(metrics, open(os.path.join(MODELS, out_name + ".json"), "w"), indent=2)
    log("DONE %s in %ds (loss %s, %s steps) -> %s" % (out_name, duration, final_loss, steps, out_path))
    print("OSHAL_TRAIN_RESULT " + json.dumps(metrics), flush=True)   # captured by shell.exec
    if controller and secret and owner_sub_b64:
        post_ingest(controller, secret, owner_sub_b64, metrics)
    return 0


def fail(character, version, controller, secret, owner_sub_b64, msg):
    log("TRAIN FAILED: " + msg)
    payload = {"kind": "training", "character": character, "version": version, "status": "failed",
               "metrics": {"error": msg}}
    print("OSHAL_TRAIN_RESULT " + json.dumps(payload), flush=True)
    if controller and secret and owner_sub_b64:
        post_ingest(controller, secret, owner_sub_b64, payload)


def post_ingest(controller, secret, owner_sub_b64, payload):
    url = controller.rstrip("/") + "/api/lora/ingest"
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-service-secret": secret,
                     "x-oshal-user-sub-b64": owner_sub_b64})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())
        log("ingest ok: %s" % r)
    except Exception as e:
        log("ingest FAILED (%r) - metrics saved locally; re-post later" % e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--version", type=int, required=True)
    ap.add_argument("--dataset", required=True, help="curated.zip (or a folder of <name>.png/.txt pairs)")
    ap.add_argument("--base", default="v1-5-pruned-emaonly-fp16.safetensors")
    ap.add_argument("--parent-version", type=int, default=None)
    ap.add_argument("--resolution", type=int, default=512)
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    ap.add_argument("--rank", type=int, default=NETWORK_DIM)
    ap.add_argument("--controller", default=os.environ.get("OSHAL_CONTROLLER", ""))
    ap.add_argument("--owner-sub-b64", default=os.environ.get("OSHAL_USER_SUB_B64", ""))
    a = ap.parse_args()
    secret = os.environ.get("SWARM_SERVICE_SECRET", "")
    raise SystemExit(train(a.character, a.version, os.path.expanduser(a.dataset), a.base,
                           a.controller, secret, a.owner_sub_b64, a.parent_version,
                           a.resolution, a.epochs, a.rank))


if __name__ == "__main__":
    main()
