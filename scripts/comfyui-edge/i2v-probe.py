# Box-side probe: discover the correct LTX-Video image-to-video node + inputs by submitting a
# minimal workflow to localhost ComfyUI (it validates instantly and returns node errors if wrong).
# Writes the result to i2v-probe.log.
import urllib.request, json, os, time
BASE = "http://127.0.0.1:8188"
LOG = os.path.join(os.path.expanduser("~"), "i2v-probe.log")


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


# pull the LTXV / image-to-video node names + the img2vid required inputs straight from object_info
try:
    oi = json.loads(urllib.request.urlopen(BASE + "/object_info", timeout=90).read())
    cand = sorted([k for k in oi if 'ltxv' in k.lower() or 'imgtovideo' in k.lower() or 'imagetovideo' in k.lower() or 'img2vid' in k.lower()])
    log("candidate nodes: " + json.dumps(cand))
    for n in cand:
        if any(x in n.lower() for x in ['img', 'image', 'i2v']):
            req = oi[n]['input'].get('required', {})
            shape = {k: (v[0] if isinstance(v, list) and v and isinstance(v[0], str) else ('ENUM' if isinstance(v, list) and v and isinstance(v[0], list) else 'X')) for k, v in req.items()}
            log("%s required=%s" % (n, json.dumps(shape)))
    # also confirm LoadImage exists for feeding a keyframe
    log("LoadImage present: " + str('LoadImage' in oi))
except Exception as e:
    log("object_info error: " + repr(e))
