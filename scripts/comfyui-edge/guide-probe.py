# Box-side probe for the LTX-Video keyframe-guide nodes (interpolation between keyframes).
# Writes the required inputs + outputs of the guide nodes to guide-probe.log.
import urllib.request, json, os, time
BASE = "http://127.0.0.1:8188"
LOG = os.path.join(os.path.expanduser("~"), "guide-probe.log")


def log(m):
    with open(LOG, "a") as f:
        f.write(str(m) + "\n")


try:
    oi = json.loads(urllib.request.urlopen(BASE + "/object_info", timeout=90).read())
    for n in ["LTXVAddGuide", "LTXVCropGuides", "LTXVConditioning", "EmptyLTXVLatentVideo", "LTXVImgToVideo", "LoadImage"]:
        if n in oi:
            req = oi[n]["input"].get("required", {})
            shape = {}
            for k, v in req.items():
                t = v[0] if isinstance(v, list) and v and isinstance(v[0], str) else ("ENUM" if isinstance(v, list) and v and isinstance(v[0], list) else "X")
                shape[k] = t
            outs = list(oi[n].get("output_name", oi[n].get("output", [])))
            log("%s INPUTS=%s OUTPUTS=%s" % (n, json.dumps(shape), json.dumps(outs)))
        else:
            log(n + " MISSING")
except Exception as e:
    log("err " + repr(e))
