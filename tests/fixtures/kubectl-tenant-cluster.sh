#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — a STATEFUL kubectl stand-in for tests/unit/accept-tenant-isolation.spec.ts. The acceptance script creates and deletes namespaces, so a stateless stand-in could not tell "cleaned up" from "never created": this one keeps the emulated cluster in a state directory, answers the network-policy reads from the manifest that was actually applied (so a rendering that dropped a grant fails the check), and routes each exec probe by the pod IPs it handed out.
#
# Installed as `kubectl` on the case's PATH. Every call is appended to $OSHAL_TEST_KUBECTL_LOG
# ("$*", one line) and a leading `--context <ctx>` is honoured. State lives under
# $OSHAL_TEST_CLUSTER_STATE: ns/<namespace> holds the manifest applied for it, pod/<namespace>
# holds its web pod's IP.
#
# $OSHAL_TEST_KUBECTL_CLUSTER selects the cluster:
#   isolating        same-namespace traffic flows, cross-namespace traffic is refused
#   open             all traffic flows
#   self-broken      even same-namespace traffic fails (the web pod is not serving)
#   pod-never-ready  `wait` times out
#   delete-stuck     `delete namespace` fails and the namespace stays
#   preexisting      every namespace already exists
#   get-errors       `get namespace` fails with an error that is not NotFound
#   unreachable      no API server answers

printf '%s\n' "$*" >> "$OSHAL_TEST_KUBECTL_LOG"
[ "${1:-}" = "--context" ] && shift 2
mode="${OSHAL_TEST_KUBECTL_CLUSTER:-unreachable}"
state="$OSHAL_TEST_CLUSTER_STATE"
mkdir -p "$state/ns" "$state/pod"

# The value after a flag, e.g. `arg_after -n "$@"`.
arg_after() {
  local flag="$1"; shift
  while [ "$#" -gt 0 ]; do [ "$1" = "$flag" ] && { printf '%s' "${2:-}"; return; }; shift; done
}

# The egress peers of one applied policy, as kubectl -o json would carry them.
policy_json() {
  local doc
  doc="$(awk -v name="$2" 'BEGIN { RS = "---\n" } index($0, "\n  name: " name "\n") { print; exit }' "$1")"
  printf '{"spec":{"egress":['
  printf '%s\n' "$doc" | sed -n \
    -e 's|^ *kubernetes\.io/metadata\.name: \(.*\)$|{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"\1"}}}]},|p' \
    -e 's|^ *cidr: \(.*\)$|{"to":[{"ipBlock":{"cidr":"\1"}}]},|p'
  printf '{}]}}\n'
}

if [ "$mode" = unreachable ]; then
  echo "The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?" >&2
  exit 1
fi

case "$1" in
  cluster-info) echo "Kubernetes control plane is running at https://127.0.0.1:6443"; exit 0 ;;
  get)
    case "$2" in
      namespace)
        [ "$mode" = get-errors ] && { echo "Unable to connect to the server: EOF" >&2; exit 1; }
        if [ "$mode" = preexisting ] || [ -e "$state/ns/$3" ]; then printf 'NAME STATUS AGE\n%s Active 1d\n' "$3"; exit 0; fi
        echo "Error from server (NotFound): namespaces \"$3\" not found" >&2
        exit 1 ;;
      pod)
        ns="$(arg_after -n "$@")"
        [ -e "$state/pod/$ns" ] || exit 0
        case "$*" in *metadata.name*) printf 'web' ;; *podIP*) cat "$state/pod/$ns" ;; esac
        exit 0 ;;
      networkpolicy)
        ns="$(arg_after -n "$@")"; file="$state/ns/$ns"
        if [ ! -e "$file" ] || ! grep -q "^  name: $3\$" "$file"; then
          echo "Error from server (NotFound): networkpolicies.networking.k8s.io \"$3\" not found" >&2; exit 1
        fi
        case "$*" in *"-o json"*) policy_json "$file" "$3" ;; esac
        exit 0 ;;
    esac ;;
  apply)
    file="$(arg_after -f "$@")"
    ns="$(awk '/^kind: Namespace$/ { found = 1 } found && /^  name: / { print $2; exit }' "$file")"
    [ -n "$ns" ] || { echo "error: no Namespace in $file" >&2; exit 1; }
    cp "$file" "$state/ns/$ns"
    echo "namespace/$ns created"
    exit 0 ;;
  run)
    ns="$(arg_after -n "$@")"
    [ -e "$state/ns/$ns" ] || { echo "Error from server (NotFound): namespaces \"$ns\" not found" >&2; exit 1; }
    count="$(find "$state/pod" -type f | wc -l)"
    echo "10.$((count + 1)).0.10" > "$state/pod/$ns"
    echo "pod/web created"
    exit 0 ;;
  wait)
    [ "$mode" = pod-never-ready ] && { echo "error: timed out waiting for the condition on pods/web" >&2; exit 1; }
    exit 0 ;;
  exec)
    src="$(arg_after -n "$@")"; target="${*: -1}"; ip="${target#http://}"; ip="${ip%/}"; dst=''
    for pod in "$state"/pod/*; do [ -e "$pod" ] && [ "$(cat "$pod")" = "$ip" ] && dst="${pod##*/}"; done
    [ -n "$dst" ] || exit 1
    case "$mode" in
      open) exit 0 ;;
      self-broken) exit 1 ;;
      *) [ "$src" = "$dst" ] && exit 0; exit 1 ;;
    esac ;;
  delete)
    [ "$mode" = delete-stuck ] && { echo "error: timed out waiting for the condition on namespaces/$3" >&2; exit 1; }
    rm -f "$state/ns/$3" "$state/pod/$3"
    echo "namespace \"$3\" deleted"
    exit 0 ;;
esac
echo "kubectl stand-in: unhandled call: $*" >&2
exit 1
