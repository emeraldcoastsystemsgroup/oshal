# Box-side LTX-Video generator. Runs ON the edge node (ComfyUI portable's embedded python),
# talking to 127.0.0.1:8188 — avoids the flaky api->box network hop. Submits a lean LTXV
# text-to-video workflow (8GB-friendly), polls to completion, logs the result filename to
# ltxv-gen.log. Launched detached by the swarm; progress read by polling the log.
import urllib.request, json, time, os

BASE = "http://127.0.0.1:8188"
LOG = os.path.join(os.path.expanduser("~"), "ltxv-gen.log")
PROMPT = "a futuristic muscle cat baking a cake over a campfire at night, cinematic, smooth camera motion, glowing embers"


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def workflow():
    return {
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "te": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "ltxv"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": PROMPT, "clip": ["te", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, blurry, distorted, jittery", "clip": ["te", 0]}},
        "lat": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": 512, "height": 320, "length": 33, "batch_size": 1}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": 25.0}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 25, "cfg": 3.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveAnimatedWEBP", "inputs": {"images": ["dec", 0], "filename_prefix": "oshal_ltxv", "fps": 25.0, "lossless": False, "quality": 85, "method": "default"}},
    }


def main():
    log("=== ltxv-gen start (lean 512x320 x33, lowvram) ===")
    try:
        req = urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": workflow()}).encode(), headers={"Content-Type": "application/json"})
        pid = json.loads(urllib.request.urlopen(req, timeout=180).read())["prompt_id"]
        log("queued " + pid)
    except urllib.error.HTTPError as e:
        log("REJECTED %s %s" % (e.code, e.read().decode()[:800])); return
    except Exception as e:
        log("submit error " + repr(e)); return
    for i in range(360):
        time.sleep(5)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h:
            if h[pid].get("outputs"):
                log("DONE " + json.dumps(h[pid]["outputs"])[:400]); return
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                log("EXEC ERROR " + json.dumps(st)[:700]); return
    log("timeout (still grinding or stuck)")


main()
