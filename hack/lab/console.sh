#!/usr/bin/env bash
#
# Run a real OpenShift console of a given generation against a published plugin
# image, so a release branch can be exercised without a cluster of that
# generation.
#
#   hack/lab/console.sh 0.1.0            4.16 and 4.19
#   hack/lab/console.sh 0.1.0 4.19       one generation
#   hack/lab/console.sh 0.1.0 4.16 --keep  leave the containers running
#
# PLUGIN_IMAGE names an image outright, in place of the one derived from a
# version, and the version argument is then not needed:
#
#   PLUGIN_IMAGE=quay.io/asalvati/file-integrity-console-plugin:fix_something \
#     hack/lab/console.sh 4.16
#
# That is what a build which is not a release looks like: Quay builds an image
# on every branch push and names it after the ref, with slashes turned into
# underscores. Without this the only way to look at a fix before publishing it
# was to run the two podman commands underneath this script by hand.
#
# BRIDGE_TOKEN names the identity the console browses as, in place of whoever
# `oc` is logged in as. The bridge makes every request — the API server and the
# Prometheus proxy alike — with this one token, which is normally the thing this
# script cannot do anything about; given a narrow one it becomes the way to see
# what the plugin shows a user who is not an administrator:
#
#   oc create serviceaccount fio-reader -n default
#   oc adm policy add-cluster-role-to-user view -z fio-reader
#   BRIDGE_TOKEN=$(oc create token fio-reader -n default --duration=4h) \
#     hack/lab/console.sh 4.16
#
# `oc` still has to be logged in as someone who can read the API server's
# address and the Thanos route. That does not weaken the test: those are two
# addresses, read once before any container starts, and no request the console
# makes carries that identity.
#
# What it exercises is authorization **against the API server**, faithfully. It
# does not exercise authorization against Prometheus, and believing otherwise
# reads a healthy plugin as a broken one. The `thanos-querier` route targets
# port `web`, 9091, whose kube-rbac-proxy authorizes `get` on
# `prometheuses/api` named `k8s` — the `cluster-monitoring-view` ClusterRole.
# The *tenancy* port, 9092, is the one the console's per-namespace proxy uses
# and it authorizes something else entirely: `get pods` in `metrics.k8s.io`,
# in the namespace taken from the query's own `namespace` parameter. No route
# exposes it, so off-cluster every query lands on the cluster-wide endpoint
# whatever the plugin asked for.
#
# `cluster-reader` is exactly the identity that separates the two: refused here,
# allowed on a real console. Read off the running cluster — the route's target
# port, both kube-rbac-proxy config secrets, and `oc auth can-i` for each — not
# inferred.
#
# --no-thanos starts the console with no Prometheus proxy at all, which is the
# only way to reach the history panels' error state deliberately:
#
#   hack/lab/console.sh 4.16 --no-thanos
#
# Getting that state right matters more than it looks. It is what a reader sees
# when monitoring is broken or when they are not allowed to query it, and a
# panel that renders it badly makes a healthy plugin look like the fault.
#
# What this does NOT test: OLM. The plugin is loaded through BRIDGE_PLUGINS,
# which bypasses the ConsolePlugin resource, the CSV, the Subscription and the
# catalogue entirely — use hack/lab/bundle.sh for that, against a cluster of
# the matching generation. Nor can file retrieve work here: the proxy alias is
# declared in the ConsolePlugin resource, which only a cluster has, and the
# backend builds its client from rest.InClusterConfig(). Node reports do
# render, because those come from the API server through the console's own
# Kubernetes proxy.
#
# Requires: oc logged in (the console reads a real cluster), and podman.

set -euo pipefail

# shellcheck source=hack/lab/tools.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tools.sh"

VERSION=${1:-}
# A generation or a flag where the version belongs means no version was given,
# which is allowed only when PLUGIN_IMAGE says what to run instead.
if [[ $VERSION =~ ^4\.(16|19|22)$ ]] || [[ $VERSION == --* ]]; then
  VERSION=
else
  [ $# -gt 0 ] && shift
fi

KEEP=false
NO_THANOS=false
GENERATIONS=()
for arg in "$@"; do
  case $arg in
  --keep) KEEP=true ;;
  --no-thanos) NO_THANOS=true ;;
  4.16 | 4.19 | 4.22) GENERATIONS+=("$arg") ;;
  *) die "unknown argument '$arg' — expected a generation (4.16, 4.19, 4.22), --keep or --no-thanos" ;;
  esac
done
[ ${#GENERATIONS[@]} -gt 0 ] && : || GENERATIONS=(4.16 4.19)

[ -n "$VERSION" ] || [ -n "${PLUGIN_IMAGE:-}" ] ||
  die "usage: $0 <version> [4.16] [4.19] [4.22] [--keep] [--no-thanos]
  <version> is the base release version. Each generation's own image is
  derived from it: 0.1.0 -> 0.1.0-ocp4.16 on the 4.16 console.
  Set PLUGIN_IMAGE to name an image outright and omit the version.
  Set BRIDGE_TOKEN to browse as somebody other than the logged-in user.
  --no-thanos withholds the Prometheus proxy, which is how the history
  panels' error state is reached on purpose."

# port <generation> — 4.16 -> 9016. Distinct per generation so several can run
# at once, which is the point of running them at all.
port_for() { printf '90%s' "${1#4.}"; }
slug_for() { printf '4%s' "${1#4.}"; }

# --------------------------------------------------------------------------

cleanup() {
  [ "$KEEP" = true ] && return 0
  log "Cleaning up"
  local gen slug
  for gen in "${GENERATIONS[@]}"; do
    slug=$(slug_for "$gen")
    podman rm -f "fio-console-$slug" >/dev/null 2>&1 || true
    podman rm -f "fio-plugin-$slug" >/dev/null 2>&1 || true
    podman network rm "fio-lab-$slug" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------------

log "Preflight"
require_oc
require_podman
# Both images are pulled, so the same missing signature policy that stops
# bundle.sh stops this.
setup_containers_policy
POLICY=(${PODMAN_POLICY_ARGS[@]+"${PODMAN_POLICY_ARGS[@]}"})

if [ -n "${BRIDGE_TOKEN:-}" ]; then
  TOKEN=$BRIDGE_TOKEN
  info "browsing as BRIDGE_TOKEN, not as $(oc whoami 2>/dev/null || echo 'the logged-in user')"
else
  TOKEN=$(oc whoami --show-token 2>/dev/null) ||
    die "could not read a bearer token — the console needs one to reach the API server"
fi
SERVER=$(oc whoami --show-server)

# The console proxies Prometheus itself, and running off-cluster it cannot find
# Thanos by its in-cluster service name, so it has to be told. Without this the
# history panels ask a proxy that is not there and report an error rather than
# an absence — which looks like a defect in the plugin.
#
# Everything else here still works without it, so this warns rather than dies:
# a cluster with no monitoring route is a fine place to check that a build
# loads. Every query runs as the one token the bridge was started with — and
# against this endpoint, which is the cluster-wide one whatever the plugin
# asked for. See the note on BRIDGE_TOKEN above before reading a refusal here
# as the answer a real console would give.
#
# --no-thanos withholds it deliberately, so it is announced rather than warned
# about: the panels failing to reach a proxy is then the thing being looked at,
# not an accident of the cluster.
if [ "$NO_THANOS" = true ]; then
  THANOS=
  info "--no-thanos: the history panels have no proxy to query"
else
  THANOS=$(oc get route thanos-querier -n openshift-monitoring \
    -o jsonpath='https://{.spec.host}' 2>/dev/null) || THANOS=
  [ -n "$THANOS" ] ||
    warn "no thanos-querier route: the history panels will have nothing to query"
fi

for gen in "${GENERATIONS[@]}"; do
  slug=$(slug_for "$gen")
  net="fio-lab-$slug"
  port=$(port_for "$gen")
  # One image for every generation when it is named outright — running two at
  # once then makes no sense, but nothing stops it either: the same build
  # loaded by two consoles is exactly the comparison this script exists for.
  plugin_image=${PLUGIN_IMAGE:-$IMAGE_REPO:$(generation_version "$VERSION" "$gen")}
  console_image="quay.io/openshift/origin-console:$gen"
  zstream=$(generation_zstream "$gen")

  log "Console $gen"
  info "plugin   $plugin_image"
  info "console  $console_image"
  info "version  $zstream"

  podman rm -f "fio-console-$slug" "fio-plugin-$slug" >/dev/null 2>&1 || true
  podman network exists "$net" || podman network create "$net" >/dev/null

  # Pulled explicitly rather than by `podman run --pull`, because the signature
  # policy has to be named and only pull takes the flag.
  podman pull "${POLICY[@]}" "$plugin_image" >/dev/null
  podman pull "${POLICY[@]}" "$console_image" >/dev/null

  # Plain HTTP: the serving certificate is issued by the cluster, and there is
  # no cluster here. The console reaches this over the container network, not
  # the host, so nothing is exposed by doing so.
  podman run -d --name "fio-plugin-$slug" --network "$net" \
    "$plugin_image" \
    --listen=:9001 --tls-cert-file= --tls-key-file= >/dev/null

  # BRIDGE_RELEASE_VERSION is not decoration. With it unset the console skips
  # the plugin's @console/pluginAPI check entirely, so the run would prove
  # nothing about the bound — which is most of the reason to do this at all.
  # The image tag and the declared version are independent, which is also how
  # a deliberate mismatch can be staged.
  podman run -d --name "fio-console-$slug" --network "$net" \
    -p "$port:9000" \
    -e BRIDGE_USER_AUTH=disabled \
    -e BRIDGE_K8S_MODE=off-cluster \
    -e BRIDGE_K8S_AUTH=bearer-token \
    -e BRIDGE_K8S_MODE_OFF_CLUSTER_SKIP_VERIFY_TLS=true \
    -e BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT="$SERVER" \
    -e BRIDGE_K8S_MODE_OFF_CLUSTER_THANOS="$THANOS" \
    -e BRIDGE_K8S_AUTH_BEARER_TOKEN="$TOKEN" \
    -e BRIDGE_USER_SETTINGS_LOCATION=localstorage \
    -e BRIDGE_I18N_NAMESPACES="plugin__$PLUGIN_NAME" \
    -e BRIDGE_PLUGINS="$PLUGIN_NAME=http://fio-plugin-$slug:9001" \
    -e BRIDGE_RELEASE_VERSION="${BRIDGE_RELEASE_VERSION_OVERRIDE:-$zstream}" \
    "$console_image" >/dev/null

  waited=0
  until curl -fsS -o /dev/null "http://localhost:$port/" 2>/dev/null; do
    if [ "$waited" -ge 60 ]; then
      podman logs "fio-console-$slug" 2>&1 | tail -20
      die "console $gen did not answer on port $port"
    fi
    sleep 2
    waited=$((waited + 2))
  done
  info "ready    http://localhost:$port"
done

log "Running"
for gen in "${GENERATIONS[@]}"; do
  info "$gen  http://localhost:$(port_for "$gen")"
done
printf '\n'
info "In each: Compute -> File Integrity, then open a node's report."
info "A generation whose plugin did not load shows no menu entry at all —"
info "check the browser console for the plugin's own load error."
printf '\n'

if [ "$KEEP" = true ]; then
  info "--keep: containers left running. Remove them with:"
  for gen in "${GENERATIONS[@]}"; do
    slug=$(slug_for "$gen")
    info "  podman rm -f fio-console-$slug fio-plugin-$slug && podman network rm fio-lab-$slug"
  done
  exit 0
fi

info "Ctrl-C to stop and remove the containers."
while sleep 5; do :; done
