#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# ═══════════════════════════════════════════════════════════════════════════════
# benchmark-advisor.sh — Compare interactive advisor speed & accuracy across
# 2 harnesses: Codex CLI (ChatGPT OAuth), Claude Code CLI
#
# Usage:  bash scripts/benchmark-advisor.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

RESULT_DIR="$(cd "$(dirname "$0")" && pwd)/benchmark-results"
rm -rf "$RESULT_DIR"
mkdir -p "$RESULT_DIR"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)

# ── Incident context from live cluster ───────────────────────────────────────
read -r -d '' INCIDENT_CONTEXT << 'CTXEOF' || true
You are an SRE advisor for a Kubernetes alert operations platform.

Current firing alerts:
- KubeProxyDown: critical, status=firing, 'Target disappeared from Prometheus target discovery'
- KubeContainerWaiting: warning, ns=demo, pod=ai-assistant-7d9f4c2b1-x4k2p, 'Pod container waiting >1h'
- KubeSchedulerDown: critical, status=firing, 'Target disappeared from Prometheus target discovery'
- KubeControllerManagerDown: critical, status=firing, 'Target disappeared from Prometheus target discovery'
- CPUThrottlingHigh: info, ns=demo, pod=opensearch-primary-0, status=firing
- CloudWatch: mail-relay/postfix-bc54d7475-jxhkw AccessDenied errors on AWS
- CloudWatch: gpu-operator/nvidia-driver-daemonset-479fz CrashLoopBackOff
- Enriched RCA: postfix pod rejecting SMTP relay from internal K8s pod

Be concise and precise. No disclaimers.
CTXEOF

# ── Benchmark prompts ────────────────────────────────────────────────────────
PROMPTS=(
  "Rank the current firing alerts by blast radius. Which 2 are most dangerous?"
  "KubeSchedulerDown and KubeControllerManagerDown are both firing. Single control plane node failure or independent? What to check first?"
  "The ai-assistant pod is stuck ContainerWaiting in the demo namespace. What downstream pipeline impact does this cause?"
  "The postfix pod has AccessDenied from AWS AND is rejecting internal SMTP. Related or independent? Diagnosis sequence?"
  "Write a 3-step remediation runbook for the KubeProxyDown alert."
)

PROMPT_LABELS=(
  "triage-ranking"
  "control-plane-diag"
  "container-waiting"
  "mail-relay-rca"
  "kubeproxy-runbook"
)

# Expected keywords for basic accuracy scoring (pipe-separated)
EXPECTED_KEYWORDS=(
  "KubeSchedulerDown|KubeControllerManagerDown|control plane|critical|blast"
  "control plane|etcd|apiserver|node|single|both"
  "enrichment|pipeline|RCA|downstream|alerts"
  "IAM|IRSA|service account|AccessDenied|SMTP|relay"
  "kube-proxy|iptables|daemonset|service|restart|logs"
)

# ── Accuracy scorer ──────────────────────────────────────────────────────────
score_response() {
  local response="$1"
  local keywords="$2"
  local hits=0 total=0
  IFS='|' read -ra KW_ARRAY <<< "$keywords"
  for kw in "${KW_ARRAY[@]}"; do
    total=$((total + 1))
    if echo "$response" | grep -qi "$kw"; then
      hits=$((hits + 1))
    fi
  done
  echo "$hits $total"
}

# ── Harness: Claude Code CLI (claude.ai OAuth) ──────────────────────────────
run_claude_code() {
  local prompt="$1"
  claude --print --model sonnet --max-turns 1 "${INCIDENT_CONTEXT}

${prompt}" 2>/dev/null || echo "(claude-code: failed)"
}

# ── Harness: Codex CLI (ChatGPT OAuth) ──────────────────────────────────────
run_codex() {
  local prompt="$1"
  local tmpout
  tmpout=$(mktemp)
  # Uses default model from ~/.codex/config.toml (gpt-5.4 with ChatGPT OAuth)
  echo "" | codex exec -o "$tmpout" "${INCIDENT_CONTEXT}

${prompt}" 2>/dev/null &
  local pid=$!
  # Wait up to 120s
  local waited=0
  while kill -0 $pid 2>/dev/null && [ $waited -lt 120 ]; do
    sleep 2; waited=$((waited + 2))
  done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  if [ -s "$tmpout" ]; then
    cat "$tmpout"
  else
    echo "(codex: empty response or timeout)"
  fi
  rm -f "$tmpout"
}

# ── Main ─────────────────────────────────────────────────────────────────────
HARNESSES=("claude-code" "codex")

echo "═══════════════════════════════════════════════════════════════"
echo "  OSHAL Advisor Benchmark"
echo "  Harnesses: Claude Code CLI / Codex CLI"
echo "  Prompts:   ${#PROMPTS[@]}"
echo "  Output:    $RESULT_DIR"
echo "═══════════════════════════════════════════════════════════════"
echo ""

for harness in "${HARNESSES[@]}"; do
  echo "══ Harness: $harness ══"
  for i in "${!PROMPTS[@]}"; do
    label="${PROMPT_LABELS[$i]}"
    prompt="${PROMPTS[$i]}"
    printf "  %-25s " "$label..."

    start_ms=$(python3 -c "import time; print(int(time.time()*1000))")

    case "$harness" in
      claude-code) response=$(run_claude_code "$prompt") ;;
      codex)       response=$(run_codex "$prompt") ;;
    esac

    end_ms=$(python3 -c "import time; print(int(time.time()*1000))")
    duration_ms=$((end_ms - start_ms))

    read -r hits total <<< "$(score_response "$response" "${EXPECTED_KEYWORDS[$i]}")"
    score=$(python3 -c "print(round($hits / max($total, 1), 2))")
    char_count=${#response}

    python3 -c "
import json
json.dump({
    'harness': '$harness',
    'prompt_label': '$label',
    'duration_ms': $duration_ms,
    'response_chars': $char_count,
    'keyword_hits': $hits,
    'keyword_total': $total,
    'keyword_score': $score,
}, open('$RESULT_DIR/${harness}-${label}.json', 'w'), indent=2)
"
    echo "$response" > "$RESULT_DIR/${harness}-${label}.txt"

    printf "%6s ms  accuracy: %s/%s  (%s chars)\n" "$duration_ms" "$hits" "$total" "$char_count"
  done
  echo ""
done

# ── Summary report ───────────────────────────────────────────────────────────
SUMMARY_FILE="$RESULT_DIR/summary-${TIMESTAMP}.md"
export RESULT_DIR SUMMARY_FILE

python3 << 'PYEOF'
import json, glob, os

result_dir = os.environ['RESULT_DIR']
summary_file = os.environ['SUMMARY_FILE']
files = sorted(glob.glob(os.path.join(result_dir, '*.json')))
results = []
for f in files:
    try:
        results.append(json.load(open(f)))
    except:
        pass

if not results:
    print('No results found'); exit(0)

harnesses = {}
for r in results:
    h = r['harness']
    if h not in harnesses:
        harnesses[h] = {'durations': [], 'scores': [], 'chars': []}
    harnesses[h]['durations'].append(r['duration_ms'])
    harnesses[h]['scores'].append(r['keyword_score'])
    harnesses[h]['chars'].append(r['response_chars'])

rpt = []
rpt.append('# OSHAL Advisor Benchmark — 2 Harnesses')
rpt.append('')
rpt.append('| Harness | Backend | Auth |')
rpt.append('|---------|---------|------|')
rpt.append('| Claude Code CLI | Anthropic (claude.ai) | OAuth |')
rpt.append('| Codex CLI | OpenAI (ChatGPT) | OAuth |')
rpt.append('')
rpt.append('## Summary')
rpt.append('')
rpt.append('| Harness | Avg Latency | Min | Max | Avg Accuracy | Avg Response |')
rpt.append('|---------|------------|-----|-----|-------------|-------------|')

for h in ['claude-code', 'codex']:
    if h not in harnesses: continue
    d = harnesses[h]
    durations = sorted(d['durations'])
    avg = sum(durations) // len(durations)
    mn, mx = durations[0], durations[-1]
    avg_score = sum(d['scores']) / len(d['scores'])
    avg_chars = sum(d['chars']) // len(d['chars'])
    rpt.append(f'| **{h}** | {avg:,}ms | {mn:,}ms | {mx:,}ms | {avg_score:.0%} | {avg_chars:,} chars |')

rpt.append('')
rpt.append('## Per-Prompt Comparison')
rpt.append('')

labels = list(dict.fromkeys(r['prompt_label'] for r in results))
for label in labels:
    rpt.append(f'### {label}')
    rpt.append('')
    rpt.append('| Harness | Latency | Accuracy | Length |')
    rpt.append('|---------|---------|----------|--------|')
    for h in ['claude-code', 'codex']:
        matches = [r for r in results if r['harness'] == h and r['prompt_label'] == label]
        if not matches:
            rpt.append(f'| {h} | - | - | - |')
            continue
        r = matches[0]
        rpt.append(f'| {h} | {r["duration_ms"]:,}ms | {r["keyword_score"]:.0%} | {r["response_chars"]:,} chars |')
    rpt.append('')

text = '\n'.join(rpt)
with open(summary_file, 'w') as f:
    f.write(text)
print(text)
print(f'\nSaved: {summary_file}')
PYEOF
