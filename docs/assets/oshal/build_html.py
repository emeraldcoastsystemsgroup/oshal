"""Build a self-contained HTML slideshow of the OSHAL deck from the rendered PNGs.

Embeds each slide PNG (which contains the real vector diagrams) as base64, so the
output is one portable file that opens in any browser — no PowerPoint needed.
"""
import base64
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
THUMBS = os.path.join(HERE, "_thumbs")


def num(p):
    m = re.search(r"Slide(\d+)", os.path.basename(p))
    return int(m.group(1)) if m else 0


pngs = sorted(glob.glob(os.path.join(THUMBS, "Slide*.PNG")) + glob.glob(os.path.join(THUMBS, "Slide*.png")), key=num)
# de-dup case-insensitive on Windows
seen, files = set(), []
for p in pngs:
    k = os.path.basename(p).lower()
    if k not in seen:
        seen.add(k); files.append(p)

slides_b64 = []
for p in files:
    with open(p, "rb") as f:
        slides_b64.append(base64.b64encode(f.read()).decode("ascii"))

imgs = "\n".join(
    f'<img class="slide" data-i="{i}" src="data:image/png;base64,{b64}" alt="Slide {i+1}">'
    for i, b64 in enumerate(slides_b64)
)

html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OSHAL — Overview Deck</title>
<style>
  :root {{ --bg:#0B1020; --green:#34D399; --cyan:#7DD3FC; --muted:#94A3B8; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:#F8FAFC; font-family:'Segoe UI',system-ui,sans-serif; }}
  .stage {{ display:flex; align-items:center; justify-content:center; height:100vh; padding:24px; }}
  .slide {{ max-width:96vw; max-height:90vh; display:none; border:1px solid #1e293b; border-radius:8px;
            box-shadow:0 10px 40px rgba(0,0,0,.5); }}
  .slide.active {{ display:block; }}
  .bar {{ position:fixed; top:0; left:0; right:0; height:5px; background:var(--green); }}
  .nav {{ position:fixed; bottom:18px; left:50%; transform:translateX(-50%); display:flex; gap:14px;
          align-items:center; background:#0e1730cc; border:1px solid #1e293b; border-radius:999px; padding:8px 16px; }}
  .nav button {{ background:none; border:none; color:var(--cyan); font-size:20px; cursor:pointer; padding:2px 10px; }}
  .nav button:hover {{ color:var(--green); }}
  .count {{ color:var(--muted); font-size:14px; min-width:64px; text-align:center; }}
  .hint {{ position:fixed; top:14px; right:18px; color:var(--muted); font-size:12px; }}
  .all {{ display:none; }}
  body.allmode .stage {{ display:none; }}
  body.allmode .all {{ display:block; padding:24px; }}
  body.allmode .all img {{ width:100%; max-width:1280px; display:block; margin:0 auto 24px;
                           border:1px solid #1e293b; border-radius:8px; }}
</style></head>
<body>
<div class="bar"></div>
<div class="hint">← / → to move · F = scroll-all · {len(files)} slides</div>
<div class="stage">{imgs}</div>
<div class="all">{imgs}</div>
<div class="nav">
  <button onclick="go(-1)">‹ Prev</button>
  <span class="count" id="count">1 / {len(files)}</span>
  <button onclick="go(1)">Next ›</button>
</div>
<script>
  const slides=[...document.querySelectorAll('.stage .slide')]; let i=0;
  function show(n){{ i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach((s,k)=>s.classList.toggle('active',k===i));
    document.getElementById('count').textContent=(i+1)+' / '+slides.length; }}
  function go(d){{ show(i+d); }}
  show(0);
  document.addEventListener('keydown',e=>{{
    if(e.key==='ArrowRight'||e.key===' ') go(1);
    else if(e.key==='ArrowLeft') go(-1);
    else if(e.key.toLowerCase()==='f') document.body.classList.toggle('allmode');
  }});
  document.querySelector('.stage').addEventListener('click',()=>go(1));
</script>
</body></html>"""

out = os.path.join(HERE, "OSHAL-overview.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)
print(f"Wrote {out} ({len(html)//1024} KB) from {len(files)} slides")
