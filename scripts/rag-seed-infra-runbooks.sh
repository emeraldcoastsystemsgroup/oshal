#!/usr/bin/env bash
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — seed infra-runbooks collection from public k8s/SRE/Prometheus docs
#
# Ingests a hand-picked set of public infrastructure runbook content into
# the swarm's RAG (collection: `infra-runbooks`). Run this once after
# bringing up oshal-local-api + oshal-local-chromadb. Re-running is safe —
# ChromaDB upserts by id, and we generate fresh ids per chunk.
#
# Source pages were fetched on 2026-04-25 from:
#   - kubernetes.io/docs/tasks/debug/...                           (CC-BY)
#   - kubernetes.io/docs/concepts/configuration/...                 (CC-BY)
#   - sre.google/sre-book/handling-overload                         (CC-BY-NC-SA)
#   - prometheus.io/docs/prometheus/latest/querying/basics          (Apache 2.0)
# Body content is stored as markdown with provenance metadata so a bot
# searching the collection sees source URL + license tag + fetched-on date.

set -euo pipefail

API="${OSHAL_API:-http://localhost:35457}"
COLLECTION="${COLLECTION:-infra-runbooks}"
SEED_DIR="$(cd "$(dirname "$0")" && pwd)/rag-seed-content"

if ! curl -sf -m 5 "${API}/api/rag/health" >/dev/null; then
  echo "ERR: oshal api not reachable at ${API}/api/rag/health" >&2
  echo "       bring up the stack first: docker compose -f docker-compose.oshal-local.yml up -d" >&2
  exit 1
fi

# -- Inline doc bodies ------------------------------------------------------
# Each doc body is intentionally embedded here rather than in separate files
# so the seed is a single self-contained shell script. To add a doc, append
# another `ingest_doc <id> <metadata-json> <<'EOF' ... EOF` block below.

ingest_doc() {
  local id="$1"
  local metadata_json="$2"
  local content
  content="$(cat)"

  # Compose the JSON payload. Use python to avoid quoting hell with embedded
  # backticks / quotes in the markdown body.
  local payload
  payload=$(python -c "
import json, sys
print(json.dumps({
    'collection': '${COLLECTION}',
    'format': 'md',
    'title': '${id}',
    'content': sys.stdin.read(),
    'metadata': ${metadata_json}
}))" <<<"$content")

  echo "── ingesting: $id"
  RESP=$(curl -sf -m 30 -X POST "${API}/api/rag/ingest" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" 2>&1)
  if [ $? -eq 0 ]; then
    echo "    $RESP"
  else
    echo "    ERR: $RESP" >&2
  fi
}

# === k8s-debug-pods ============================================================
ingest_doc "k8s-debug-pods" '{
  "doc_id": "k8s-debug-pods",
  "source_url": "https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/",
  "license": "CC-BY-4.0",
  "provenance": "fetched-from-web",
  "fetched_on": "2026-04-25",
  "topic": "kubernetes-troubleshooting"
}' <<'EOF'
# Kubernetes Pod Debugging Guide

Source: https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/
Fetched: 2026-04-25 (CC-BY-4.0)

## Initial Diagnosis Command

```bash
kubectl describe pods ${POD_NAME}
```

This is the primary diagnostic command. Check current state of containers,
whether containers are all `Running`, and recent restart events.

## Common Pod States and Solutions

### Pod Stuck in "Pending"

Cause: Pod cannot be scheduled onto a node due to insufficient resources.

Diagnostics: Check `kubectl describe` output for scheduler messages.

Common reasons:
- Insufficient resources (CPU/Memory exhausted) → delete other Pods,
  adjust resource requests, add new nodes.
- Using `hostPort` → Limited scheduling locations (one pod per node per
  port). Use Service object to expose Pod instead.

### Pod Stuck in "Waiting"

Cause: Pod scheduled to worker node but cannot run on it. Most common
cause: failure to pull the image.

Steps: Verify image name is correct, confirm image has been pushed to
registry, manually pull the image to verify with `docker pull <image>`.

### Pod Stuck in "Terminating"

Cause: Deletion issued but control plane cannot delete the Pod object,
typically due to finalizers and admission webhooks.

Diagnosis: Check for ValidatingWebhookConfiguration or
MutatingWebhookConfiguration targeting `UPDATE` operations on `pods`
resources.

### Pod Crashing or Unhealthy

Use Debug Running Pods documentation methods.

### Pod Running but Not Behaving as Expected

Common cause: Errors in pod description YAML that are silently ignored
(typos in field names, incorrect nesting).

Troubleshooting:

```bash
# Delete and recreate with validation
kubectl apply --validate -f mypod.yaml

# Compare local vs apiserver versions
kubectl get pods/mypod -o yaml > mypod-on-apiserver.yaml
```

## Debugging Replication Controllers

```bash
kubectl describe rc ${CONTROLLER_NAME}
```

## Debugging Services

```bash
kubectl get endpointslices -l kubernetes.io/service-name=${SERVICE_NAME}
```

Endpoints should match the number of Pod replicas expected to be members
of the service.

For missing endpoints, list pods matching Service selectors:

```bash
kubectl get pods --selector=name=nginx,type=frontend
```

Verify listed pods match expected pods, and Pod's `containerPort` matches
Service's `targetPort`.

## Next Steps

If unresolved, follow Debug Service documentation to verify:
- Service is running
- Service has Endpoints
- Pods are serving traffic
- DNS is working
- iptables rules are installed
- kube-proxy is functioning
EOF

# === k8s-debug-running-pod =====================================================
ingest_doc "k8s-debug-running-pod" '{
  "doc_id": "k8s-debug-running-pod",
  "source_url": "https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/",
  "license": "CC-BY-4.0",
  "provenance": "fetched-from-web",
  "fetched_on": "2026-04-25",
  "topic": "kubernetes-troubleshooting"
}' <<'EOF'
# Kubernetes — Debug Running Pods

Source: https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/
Fetched: 2026-04-25 (CC-BY-4.0)

## Inspecting Pod Details

```bash
kubectl describe pod <pod-name>
```

Output includes pod metadata, node, container details, status conditions,
events, resource requests/limits, restart count.

## Examining Pod Logs

```bash
kubectl logs <pod-name>                          # current container
kubectl logs <pod-name> -c <container-name>      # specific container
kubectl logs <pod-name> -f                       # stream
kubectl logs <pod-name> --previous               # previous container (after restart)
```

## Container Exec

```bash
kubectl exec -it <pod-name> -- /bin/bash         # interactive shell
kubectl exec <pod-name> -- <command>             # one-shot command
kubectl exec -it <pod-name> -c <container-name> -- /bin/bash
```

## Ephemeral Debug Container

Temporary debug container without restarting the pod:

```bash
kubectl debug <pod-name> -it --image=<debug-image>
kubectl debug <pod-name> -it --image=busybox
```

## Pod Copy for Debugging

```bash
kubectl debug <pod-name> -it --image=<debug-image> --target=<pod-name>
kubectl debug <pod-name> --image=<new-image> -- sh
kubectl debug <pod-name> --image=<debug-image> --set-image=<container>=<debug-image>
```

## Port Forwarding

```bash
kubectl port-forward <pod-name> <local-port>:<pod-port>
kubectl port-forward nginx-pod 8080:80
```

## Copying Files

```bash
kubectl cp <pod-name>:<path-in-pod> <local-path>
kubectl cp <local-path> <pod-name>:<path-in-pod>
kubectl cp nginx-pod:/var/log/nginx/access.log ./access.log
```

## Common Scenarios

### CrashLoopBackOff

```bash
kubectl logs <pod-name> --previous
kubectl describe pod <pod-name>
```

### OOMKilled Investigation

```bash
kubectl describe pod <pod-name>
# Look for: "Last State: Terminated (OOMKilled)"
```

Increase memory limit if needed in pod spec; if not a sizing issue,
investigate memory leak in the application.

### Image Pull Failures

```bash
kubectl describe pod <pod-name>
# Look for events mentioning image pull failures
```

Verify image exists, credentials are correct, image pull secrets in pod
spec.

## Key Commands Reference

| Command | Purpose |
|---|---|
| kubectl describe pod <name> | Get detailed pod information and events |
| kubectl logs <name> | View container logs |
| kubectl exec -it <name> -- /bin/bash | Interactive shell in pod |
| kubectl debug <name> -it --image=<img> | Attach ephemeral debug container |
| kubectl port-forward <name> <port>:<port> | Forward ports for access |
| kubectl cp <name>:<path> <local-path> | Copy files from pod |
| kubectl get events | View cluster events |
EOF

# === k8s-resource-management ===================================================
ingest_doc "k8s-resource-management" '{
  "doc_id": "k8s-resource-management",
  "source_url": "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
  "license": "CC-BY-4.0",
  "provenance": "fetched-from-web",
  "fetched_on": "2026-04-25",
  "topic": "kubernetes-resources"
}' <<'EOF'
# Kubernetes — Resource Management for Pods and Containers

Source: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
Fetched: 2026-04-25 (CC-BY-4.0)

## Requests vs Limits

- Requests define the minimum resources guaranteed; the scheduler uses
  this to place pods on nodes.
- Limits define the maximum resources a container can use; the kubelet
  enforces these limits.

```yaml
spec:
  containers:
  - name: myapp
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

CPU limits are hard limits enforced via cgroup CPU throttling — containers
cannot exceed CPU limits but throttling is non-fatal.

Memory limits are enforced reactively by the kernel — containers
exceeding memory limits may be OOM-killed (exit code 137).

## Resource Units

CPU: `1 cpu` = 1 physical core. `100m` (millicores) = 0.1 cpu. `0.5` = 500m.

Memory: `1024Mi` = 1 GiB (mebibytes). `256Mi` = 256 mebibytes. `1G` =
1 gigabyte (decimal, ~0.93 GiB).

## OOMKilled Root Causes

Container receives OOMKilled when it exceeds its memory limit. Common
causes:

1. Memory limit too low for the application
2. Memory leak in the application
3. Bursting traffic causing unexpected memory growth
4. Shared memory between containers in a pod

### Detecting OOM Events

```bash
kubectl describe pod <pod-name>
# Look for "OOMKilled" in the last state:
#   Terminated
#     Reason:    OOMKilled
#     Exit Code: 137

kubectl get events --field-selector involvedObject.name=<pod-name>
```

## Quality of Service (QoS) Classes

Kubernetes automatically assigns QoS classes based on requests/limits.

### Guaranteed (Highest Priority)

Requests = Limits for ALL containers. Killed last during node eviction.

```yaml
resources:
  requests: { cpu: 200m, memory: 256Mi }
  limits:   { cpu: 200m, memory: 256Mi }
```

### Burstable (Medium Priority)

Requests < Limits OR requests defined without limits. Killed before
BestEffort during eviction.

```yaml
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits:   { cpu: 500m, memory: 512Mi }
```

### BestEffort (Lowest Priority)

No requests or limits defined. Killed first during resource contention.

### Check QoS Class

```bash
kubectl get pod <pod-name> -o jsonpath='{.status.qosClass}'
# Output: Guaranteed | Burstable | BestEffort
```

## Monitoring Resource Usage

```bash
kubectl top nodes                                      # node usage
kubectl top pods -n <namespace>                        # pod usage
kubectl top pods -n <namespace> --containers           # per-container
kubectl top pod <pod-name> --containers --no-headers | watch
```

## Common Troubleshooting

### Pod Pending with FailedScheduling

```bash
kubectl describe pod <pod-name>
# Look for "Insufficient cpu", "Insufficient memory"

kubectl describe nodes

kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, allocatable: .status.allocatable}'
```

### Container Termination Debugging

```bash
kubectl get pod <pod-name> -o jsonpath='{.status.containerStatuses[0].lastState}'
kubectl logs <pod-name> --previous
kubectl get pod <pod-name> -o yaml | grep -A 20 "lastState"
```

## Key Takeaways

- Always set requests for proper scheduling.
- Set limits to prevent resource abuse.
- Use Guaranteed QoS for critical workloads.
- Monitor with `kubectl top` for right-sizing.
- OOMKilled = memory limit too low or memory leak.
- CPU throttling is non-fatal; OOM kills are fatal (exit 137).
EOF

# === sre-handling-overload =====================================================
ingest_doc "sre-handling-overload" '{
  "doc_id": "sre-handling-overload",
  "source_url": "https://sre.google/sre-book/handling-overload/",
  "license": "CC-BY-NC-SA-4.0",
  "provenance": "fetched-from-web",
  "fetched_on": "2026-04-25",
  "topic": "sre-load-management"
}' <<'EOF'
# Google SRE — Handling Overload

Source: https://sre.google/sre-book/handling-overload/
Fetched: 2026-04-25 (CC-BY-NC-SA-4.0)

## Core Load Shedding Strategies

Tiered approach to managing overload:

1. **Degraded Responses** — Rather than rejecting traffic entirely, serve
   simplified results that consume fewer resources (e.g., searching only
   a subset of candidate data).
2. **Error Responses** — When even degraded service becomes impossible,
   return errors gracefully rather than crashing.
3. **Traffic Balancing** — Distribute load across datacenters to prevent
   any single facility from exceeding processing capacity.

Quote: "At the end of the day, it's best to build clients and backends to
handle resource restrictions gracefully: redirect when possible, serve
degraded results when necessary, and handle resource errors transparently
when all else fails."

## Capacity Measurement: Beyond QPS

Modeling capacity as QPS (queries per second) is unreliable because
request costs vary dramatically. Measure actual consumed resources (CPU,
memory) directly. CPU consumption typically serves as the primary signal
since memory pressure often translates to increased CPU usage in
garbage-collected systems.

## Per-Customer Quota System

Capacity allocated based on negotiated agreements. Quotas intentionally
sum to more than total capacity, relying on the statistical unlikelihood
of simultaneous peak usage.

## Client-Side Throttling: Adaptive Throttling

Prevents rejected requests from consuming backend resources through local
rejection at the client level.

Mechanism: Clients track two metrics over a 2-minute window:
- `requests` — attempted by application layer
- `accepts` — accepted by backend

Rejection trigger: When `requests` exceeds `accepts` by a multiplier K
(typically 2), the client self-regulates using:

  Rejection probability = 1 - (accepts / requests) / K

Tuning: Reduce K (e.g., from 2 to 1.1) for more aggressive throttling
when rejection costs approach processing costs.

## Criticality Framework

Four criticality tiers affecting rejection priority:

| Level | Behavior |
|---|---|
| CRITICAL_PLUS | Most severe user impact if failed |
| CRITICAL | Default for production; expected user impact |
| SHEDDABLE_PLUS | Default for batch; partial unavailability acceptable |
| SHEDDABLE | Frequent unavailability expected |

Backends reject in criticality order: lower criticalities are rejected
first during overload. Criticality propagates through dependency chains.

## Retry Budget Strategy

Three layers prevent retry storms:

1. Per-request budget: Maximum 3 attempts per request.
2. Per-client budget: Retries capped at 10% of total request volume.
3. Attempt counter: Backends track retry counts; if histograms show
   widespread retries, return "overloaded; don't retry" instead of "task
   overloaded".

Combined effect caps traffic growth to ~1.1x under overload (worst case
without per-client limiting would be 3x).

Critical rule: Retries should only occur at the layer immediately above
the rejecting layer. Multi-layer retries cause combinatorial explosion.

## Utilization Signals

Backends monitor local utilization and reject traffic accordingly.

Primary signal: Executor load average (count of active/runnable threads,
smoothed with exponential decay). Reject requests when active threads
exceed available processors.

Secondary signals: Memory pressure or combined signals as needed.

## Overload Error Handling

- Large subset of tasks overloaded → don't retry; bubble errors to end
  users. Indicates datacenter-wide capacity exhaustion.
- Small subset of tasks overloaded → immediate retry on different task is
  preferred. Load-balancing system should redirect to backend with spare
  capacity.

Quote: "Retrying requests in different tasks becomes a form of organic
load balancing: it redirects load to tasks that may be better suited for
those requests."

## Connection Load Management

CPU/memory costs of maintaining idle connections and handling connection
churn are often overlooked.

Mitigation strategies:
1. Base load balancing on cluster utilization rather than just request
   count to redistribute connection burden.
2. Implement batch proxy architecture (batch client → batch proxy →
   backend) to shield actual backends and reduce downstream connection
   count.

## Rejection Philosophy

Quote: "A backend provisioned to serve a certain traffic rate should
continue to serve traffic at that rate without any significant impact on
latency, regardless of how much excess traffic is thrown at the task."

Recommended behavior: Accept and process maximum possible traffic while
gracefully rejecting remainder — not refuse all traffic. This prevents
cascading failures and maintains service functionality under stress.
EOF

# === prometheus-promql-basics ==================================================
ingest_doc "prometheus-promql-basics" '{
  "doc_id": "prometheus-promql-basics",
  "source_url": "https://prometheus.io/docs/prometheus/latest/querying/basics/",
  "license": "Apache-2.0",
  "provenance": "fetched-from-web",
  "fetched_on": "2026-04-25",
  "topic": "prometheus-querying"
}' <<'EOF'
# Prometheus — PromQL Basics

Source: https://prometheus.io/docs/prometheus/latest/querying/basics/
Fetched: 2026-04-25 (Apache-2.0)

## Query Types

- Instant queries — Evaluated at a single point in time, displayed in
  Table tab.
- Range queries — Evaluated at equally-spaced steps between start and
  end times, displayed in Graph tab.

## Expression Data Types

PromQL expressions evaluate to four types:
1. Instant vector — Single sample per time series at matching timestamp.
2. Range vector — Multiple data points per time series over time.
3. Scalar — Simple numeric floating-point value.
4. String — Currently unused.

## Time Series Selection

### Instant Vector Selectors

```promql
http_requests_total
```

### Label Matching Operators

- `=` — Exact string match
- `!=` — Not equal
- `=~` — Regex match (fully anchored)
- `!~` — Regex non-match

```promql
http_requests_total{job="prometheus",group="canary"}
http_requests_total{environment=~"staging|testing|development",method!="GET"}
```

### Range Vector Selectors

```promql
http_requests_total{job="prometheus"}[5m]
```

Left-open and right-closed interval — left boundary samples excluded,
right boundary samples included.

## Modifiers

### Offset

```promql
http_requests_total offset 5m
rate(http_requests_total[5m] offset 1w)
```

### @ (timestamp pin)

```promql
http_requests_total @ 1609746000
rate(http_requests_total[5m] @ 1609746000)
```

Supports `start()` and `end()` for range queries.

## Time Duration Syntax

Supported units (combinable, longest-to-shortest order):
- `ms` (milliseconds)
- `s` (seconds)
- `m` (minutes)
- `h` (hours)
- `d` (days)
- `w` (weeks)
- `y` (years, 365 days)

```promql
1h30m         # 5400 seconds
12h34m56s     # 45296 seconds
54s321ms      # 54.321 seconds
```

## Performance

Staleness — lookback period is 5 minutes by default; set with
`--query.lookback-delta` flag or per-query via `lookback_delta` parameter.

Query optimization — start in tabular view and filter to "hundreds, not
thousands, of time series at most" before switching to graph mode. Bare
metric selectors like `api_http_requests_total` can expand to thousands
of series.

## Restrictions

Vector selectors must specify either a metric name or at least one label
matcher that doesn't match empty strings.

Invalid:
```promql
{job=~".*"}
```

Valid:
```promql
{job=~".+"}
{job=~".*",method="get"}
```

Reserved keywords (`bool`, `on`, `ignoring`, `group_left`, `group_right`)
cannot be metric names. Workaround using `__name__`:

```promql
{__name__="on"}
```

## Regex Behavior

All regex uses RE2 syntax and is fully anchored — `env=~"foo"` is
treated as `env=~"^foo$"`.
EOF

echo ""
echo "── ingestion complete ──"
curl -sf "${API}/api/rag/collections" 2>&1 | python -c "import sys,json; d=json.load(sys.stdin); [print(f'  {c[\"name\"]:30s} chunks={c.get(\"count\", \"?\")}') for c in d.get('collections',[])]"
