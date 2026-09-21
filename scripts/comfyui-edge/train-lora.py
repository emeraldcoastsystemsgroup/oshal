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
#
# THE DATASET IS NOT TRUSTED. --dataset also accepts a FOLDER, and a folder is what the LoRA Studio
# dispatch actually sends (lora-train-dispatch passes ~/overnight/curated to both /train and
# /improve-overnight). curation_judge.py writes its verdicts as curation.json INTO that same folder,
# so the trainer has the judge's decisions sitting next to the pairs it stages. Staging the folder
# wholesale ignored them, which is how a rejected pair - restored by hand, or left there by a
# dataset builder that never ran the judge - still reached kohya. The folder branch now stages the
# survivors only and REFUSES a folder that carries no verdicts, matching curation_judge's own
# fail-closed stance; --allow-unjudged-dataset is the human's explicit way past it.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Box-side kohya SD1.5 LoRA trainer: stage the
#     curated dataset, train, publish the model to ComfyUI and POST metrics to the controller.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Bind callbacks to the initiating owner's
#     canonical base64url identity header; a fleet secret without owner attribution is insufficient.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Read the callback fleet secret only from
#     the edge process environment so it cannot leak through task payloads, argv, or shell history.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Honour the curation judge at the TRAINING SET: a
#     dataset folder is staged through its curation.json so only survivors reach kohya, the report
#     itself never becomes a training file, an unjudged folder is refused rather than trained on,
#     and the refusal happens before the previous staging directory is destroyed.
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
# curation_judge.curate() writes its verdicts here, inside the folder it builds.
CURATION_REPORT = "curation.json"


def log(m):
    print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


class DatasetRefused(Exception):
    """A dataset that may not become a training set; train() reports it as a failed run."""


def curation_verdicts(dataset_dir):
    """
    @description Read the curation judge's verdicts that sit beside a dataset FOLDER. curate()
      writes curation.json into the folder it builds, keyed by the source paths it copied, so the
      basename of each staged file is what identifies its verdict here.
    @param dataset_dir - The folder handed to --dataset.
    @returns basename -> decision for every file the report covers, or None when the folder carries
      no curation.json at all (i.e. nothing judged it).
    """
    report_path = os.path.join(dataset_dir, CURATION_REPORT)
    if not os.path.exists(report_path):
        return None
    try:
        with open(report_path, "r", encoding="utf-8") as fh:
            report = json.load(fh)
    except Exception as exc:
        raise DatasetRefused("REFUSING to train: %s is unreadable (%r), so the judge's verdicts "
                             "cannot be applied to the training set" % (report_path, exc))
    verdicts = {}
    for row in report.get("candidates") or []:
        for key in ("image", "caption"):
            path = row.get(key)
            if path:
                verdicts[os.path.basename(path)] = row.get("decision")
    if not verdicts:
        raise DatasetRefused("REFUSING to train: %s judged no candidates" % report_path)
    return verdicts


def approved_dataset_files(dataset_dir, allow_unjudged=False):
    """
    @description Decide which files in a dataset FOLDER may become training data. The judge's
      report is in that folder; a trainer that ignores it trains on whatever happens to be there,
      which is the one thing the judge exists to prevent. Fail-closed, like curation_judge itself.
    @param dataset_dir - The folder handed to --dataset.
    @param allow_unjudged - The human's explicit override for a folder with no verdicts.
    @returns (paths to stage, curation state). Raises DatasetRefused rather than train on rejects.
    """
    files = sorted(glob.glob(os.path.join(dataset_dir, "*")))
    verdicts = curation_verdicts(dataset_dir)
    if verdicts is None:
        if not allow_unjudged:
            raise DatasetRefused(
                "REFUSING to train on an unjudged dataset: %s carries no %s. Run make-curate.py "
                "so rejected candidates cannot enter the training set, or pass "
                "--allow-unjudged-dataset (LORA_ALLOW_UNJUDGED_DATASET=1) to override."
                % (dataset_dir, CURATION_REPORT))
        log("dataset %s is UNJUDGED and the override was given - staging it as-is" % dataset_dir)
        return [f for f in files if os.path.basename(f) != CURATION_REPORT], "unjudged-override"
    staged, left_out = [], []
    for path in files:
        name = os.path.basename(path)
        if name == CURATION_REPORT:
            continue                                     # the report is evidence, never a pair
        if verdicts.get(name) == "keep":
            staged.append(path)
        else:
            left_out.append("%s (%s)" % (name, verdicts.get(name) or "not judged"))
    if left_out:
        log("curation: %d file(s) kept OUT of the training set: %s"
            % (len(left_out), ", ".join(left_out[:12])))
    if not staged:
        raise DatasetRefused("REFUSING to train: no curation-approved pair in %s" % dataset_dir)
    return staged, "judged"


def prepare_dataset(dataset_zip, trigger, version, character, allow_unjudged=False):
    """
    @description Stage the dataset into the kohya layout <root>/img/<repeats>_<trigger>/. A FOLDER
      is filtered through the curation judge's verdicts first, and the decision is taken BEFORE the
      previous staging directory is removed so a refusal destroys nothing.
    @param dataset_zip - curated.zip, or a folder of <name>.png/.txt pairs.
    @param trigger - Trigger word naming the kohya repeats directory.
    @param version - Model version being trained.
    @param character - Character whose staging root this is.
    @param allow_unjudged - Explicit override for a dataset folder with no curation.json.
    @returns (root, img_root, image_count, curation_state).
    """
    is_folder = os.path.isdir(dataset_zip)
    approved, state = approved_dataset_files(dataset_zip, allow_unjudged) if is_folder \
        else (None, "zip")
    root = os.path.join(WORK, "%s_v%d" % (character, version))
    img_root = os.path.join(root, "img", "%d_%s" % (REPEATS, trigger))
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    os.makedirs(img_root, exist_ok=True)
    n = 0
    if is_folder:
        for f in approved:
            shutil.copy(f, img_root)
            n += 1 if f.lower().endswith((".png", ".jpg", ".jpeg")) else 0
    else:
        with zipfile.ZipFile(dataset_zip) as z:
            for name in z.namelist():
                if name.endswith("/"):
                    continue
                data = z.read(name)
                open(os.path.join(img_root, os.path.basename(name)), "wb").write(data)
                if name.lower().endswith((".png", ".jpg", ".jpeg")):
                    n += 1
    return root, img_root, n, state


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
          parent_version, resolution=512, epochs=EPOCHS, rank=NETWORK_DIM, allow_unjudged=False):
    if not os.path.exists(VENV_PY) or not os.path.exists(TRAIN_PY):
        fail(character, version, controller, secret, owner_sub_b64,
             "kohya not installed (%s missing) - run setup-kohya.ps1 first" % VENV_PY)
        return 2
    os.makedirs(MODELS, exist_ok=True); os.makedirs(LORA_DIR, exist_ok=True)
    try:
        root, img_root, count, curation_state = prepare_dataset(
            dataset_zip, character, version, character, allow_unjudged)
    except DatasetRefused as exc:
        # A refused dataset is a FAILED run, not a crash: the controller has to see why.
        fail(character, version, controller, secret, owner_sub_b64, str(exc))
        return 2
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
                           "lr": 1e-4, "scheduler": "cosine", "resolution": resolution,
                           "dataset_curation": curation_state}}
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
    ap.add_argument("--allow-unjudged-dataset", action="store_true",
                    default=os.environ.get("LORA_ALLOW_UNJUDGED_DATASET", "") == "1",
                    help="train on a dataset FOLDER that carries no curation.json (human override)")
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
                           a.resolution, a.epochs, a.rank, a.allow_unjudged_dataset))


if __name__ == "__main__":
    main()
