#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | 15-point smoke/health check for the local docker deployment (deploy, UI, ticketing, config-sync ADR-034, mesh/remote)
# -----------------------------------------------------------------------------
# Usage: bash scripts/oshal-local-checks.sh
# Env:   OSHAL_BASE (default http://localhost:35457), OSHAL_DB_CONTAINER, OSHAL_REDIS_CONTAINER, OSHAL_API_CONTAINER, OSHAL_PM_AGENT
# Exit:  0 if all checks pass, else the number of failures.
set -uo pipefail

BASE="${OSHAL_BASE:-http://localhost:35457}"
DB="${OSHAL_DB_CONTAINER:-oshal-local-db}"
REDIS="${OSHAL_REDIS_CONTAINER:-oshal-local-redis}"
API="${OSHAL_API_CONTAINER:-oshal-local-api}"
PM="${OSHAL_PM_AGENT:-project-manager}"
pass=0; fail=0

chk(){ # $1 name  $2 ok(1/0)  $3 detail
  if [ "${2:-0}" = "1" ]; then printf '  [PASS] %s — %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  [FAIL] %s — %s\n' "$1" "$3"; fail=$((fail+1)); fi
}
jget(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let v=o;for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v))}catch(e){}})' "$1"; }

echo "OSHAL local deployment — 15 checks against $BASE"
echo "-------------------------------------------------------------"

# 1. Core containers healthy
n=$(docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep oshal | grep -c healthy)
[ "${n:-0}" -ge 10 ] && chk "1  containers healthy" 1 "$n healthy" || chk "1  containers healthy" 0 "only ${n:-0} healthy (need >=10)"

# 2. Controller HTTP health
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/health" 2>/dev/null)
[ "$code" = "200" ] && chk "2  controller /api/health" 1 "HTTP 200" || chk "2  controller /api/health" 0 "HTTP ${code:-none}"

# 3. Postgres reachable + agents seeded (migrations applied)
ag=$(docker exec "$DB" psql -U oshal -d oshal -tAc "SELECT count(*) FROM agents" 2>/dev/null | tr -d '[:space:]')
[ "${ag:-0}" -gt 0 ] 2>/dev/null && chk "3  postgres + agents seeded" 1 "$ag agents in DB" || chk "3  postgres + agents seeded" 0 "agents query failed (${ag:-none})"

# 4. Redis reachable + runtime agents registered
ra=$(docker exec "$REDIS" redis-cli KEYS 'oshal:runtime-agent:*' 2>/dev/null | grep -c .)
[ "${ra:-0}" -ge 8 ] && chk "4  redis runtime agents online" 1 "$ra registered" || chk "4  redis runtime agents online" 0 "only ${ra:-0} (need >=8)"

# 5. Cockpit UI served
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/cockpit/" 2>/dev/null)
[ "$code" = "200" ] && chk "5  cockpit UI" 1 "HTTP 200" || chk "5  cockpit UI" 0 "HTTP ${code:-none}"

# 6. Metrics summary (agents + tickets)
ms=$(curl -s --max-time 10 "$BASE/api/v1/metrics/summary" 2>/dev/null)
agents=$(printf '%s' "$ms" | jget data.agents.total); total=$(printf '%s' "$ms" | jget data.total)
[ -n "$agents" ] && [ "${agents:-0}" -gt 0 ] 2>/dev/null && chk "6  metrics summary" 1 "$agents agents, $total tickets tracked" || chk "6  metrics summary" 0 "no agent metrics"

# 7. Ticketing: create then read back
cr=$(curl -s --max-time 15 -X POST "$BASE/api/tickets/" -H 'Content-Type: application/json' \
  -d '{"title":"10-check smoke ticket","description":"created by scripts/oshal-local-checks.sh","ticketType":"build","priority":"low"}' 2>/dev/null)
tid=$(printf '%s' "$cr" | jget ticketId)
if [ -n "$tid" ]; then
  back=$(curl -s --max-time 10 "$BASE/api/tickets/$tid" 2>/dev/null | jget ticketId)
  [ "$back" = "$tid" ] && chk "7  ticketing create+read" 1 "ticket $tid persisted" || chk "7  ticketing create+read" 0 "created but read-back mismatch"
else
  chk "7  ticketing create+read" 0 "create failed: $(printf '%s' "$cr" | head -c 120)"
fi

# 8. Config ownership contract exposes perAgentRuntime (ADR-034)
owner=$(curl -s --max-time 10 "$BASE/api/config/ownership" 2>/dev/null | jget ownership.perAgentRuntime.owner)
case "$owner" in *OSHAL*) chk "8  perAgentRuntime ownership" 1 "owner: $owner";; *) chk "8  perAgentRuntime ownership" 0 "missing (got '${owner}')";; esac

# 9. Config-sync push-down: PUT runtime records authoritatively (ADR-034)
pd=$(curl -s --max-time 15 -X PUT "$BASE/api/agents/$PM/runtime" -H 'Content-Type: application/json' \
  -d '{"providerId":"anthropic","modelId":"claude-sonnet-4-5"}' 2>/dev/null)
nv=$(printf '%s' "$pd" | jget newVersion); ok=$(printf '%s' "$pd" | jget success)
[ "$ok" = "true" ] && [ -n "$nv" ] && chk "9  config-sync push-down" 1 "recorded, version=$nv" || chk "9  config-sync push-down" 0 "push failed: $(printf '%s' "$pd" | head -c 120)"

# 10. Config-sync broadcast-up: bot-style envelope reconciled by controller (ADR-034)
vq="SELECT COALESCE((config_values->>'configVersion')::int,0) FROM agent_config WHERE agent_id=(SELECT agent_id FROM agents WHERE lower(name)='$PM')"
v0=$(docker exec "$DB" psql -U oshal -d oshal -tAc "$vq" 2>/dev/null | tr -d '[:space:]')
docker exec "$API" node -e "const R=require('ioredis');const r=new R(process.env.REDIS_URL);const e={correlationId:'check-10',fromAgentId:'$PM',toAgentId:'*',channel:'swarm.config-change',payload:{agentId:'$PM',params:{providerId:'gemini',modelId:'gemini-3.1-pro'},source:'bot-local'},messageType:'broadcast'};r.xadd('oshal:mesh:swarm.config-change','MAXLEN','~','10000','*','data',JSON.stringify(e)).then(()=>r.quit()).catch(()=>process.exit(1))" >/dev/null 2>&1
sleep 4
v1=$(docker exec "$DB" psql -U oshal -d oshal -tAc "$vq" 2>/dev/null | tr -d '[:space:]')
[ "${v1:-0}" -gt "${v0:-0}" ] 2>/dev/null && chk "10 config-sync broadcast-up" 1 "controller reconciled (v${v0:-0} -> v${v1:-0})" || chk "10 config-sync broadcast-up" 0 "no version bump (v${v0:-?} -> v${v1:-?})"

# 11. /api/education must be GONE (Little Monsters carved out to the app store, ADR-085 —
#     a 200 here means stale LM code is still baked into the running image)
ed=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$BASE/api/education/dashboard" 2>/dev/null)
[ "$ed" != "200" ] && chk "11 LM carved out (/api/education gone)" 1 "HTTP ${ed:-none} (expected non-200)" || chk "11 LM carved out (/api/education gone)" 0 "still serving 200 — stale image?"

echo "-------------------------------------------------------------"
echo "RESULT: $pass/11 passed, $fail failed"
exit "$fail"
