#!/usr/bin/env bash
#
# Install the OLM bundle on a cluster from a one-bundle catalogue, and check
# what it produced.
#
# Everything this does was done by hand first, one `oc` command at a time, and
# the defects that mattered were found by looking at the result rather than by
# any validator. The install half is the boring half; the checks at the end are
# the reason this file exists.
#
#   hack/lab/bundle.sh 0.1.0                 tear down, install, check
#   hack/lab/bundle.sh 0.1.0 --clean-only    remove an installation and stop
#   hack/lab/bundle.sh 0.1.0 --keep-catalog  leave the CatalogSource in place
#   hack/lab/bundle.sh 0.1.0 --validate      also run operator-sdk on the bundle
#
# Requires: oc logged in, podman, and a quay.io credential. helm and opm are
# downloaded and cached; operator-sdk only with --validate, because the check
# it performs is the one CI already runs on every pull request.

set -euo pipefail

# shellcheck source=hack/lab/tools.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tools.sh"

VERSION=${1:-}
[ $# -gt 0 ] && shift
CLEAN_ONLY=false
KEEP_CATALOG=false
VALIDATE=false

for arg in "$@"; do
  case $arg in
  --clean-only) CLEAN_ONLY=true ;;
  --keep-catalog) KEEP_CATALOG=true ;;
  --validate) VALIDATE=true ;;
  *) die "unknown option '$arg'" ;;
  esac
done

[ -n "$VERSION" ] || die "usage: $0 <version> [--clean-only] [--keep-catalog] [--validate]
  <version> is the release version, which is also the git tag and the image
  tag — 0.1.0 on main, 0.1.0-ocp4.19 on release-4.19."

BUNDLE_IMAGE="$IMAGE_REPO:bundle-$VERSION"
CATALOG_IMAGE="$IMAGE_REPO:catalog-$VERSION"
PLUGIN_IMAGE="$IMAGE_REPO:$VERSION"

# --------------------------------------------------------------------------
# Small helpers used below

wait_for() {
  local what=$1 seconds=$2
  shift 2
  local waited=0
  until "$@" >/dev/null 2>&1; do
    [ "$waited" -ge "$seconds" ] &&
      die "timed out after ${seconds}s waiting for $what"
    sleep 5
    waited=$((waited + 5))
  done
  info "$what (${waited}s)"
}

catalog_ready() {
  [ "$(oc get catalogsource "$CATALOG_SOURCE" -n "$MARKETPLACE_NS" \
    -o jsonpath='{.status.connectionState.lastObservedState}')" = READY ]
}

csv_succeeded() {
  [ "$(oc get csv "$CSV_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.status.phase}')" = Succeeded ]
}

deployment_ready() {
  local want got
  want=$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')
  got=$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')
  [ -n "$want" ] && [ "$want" = "$got" ]
}

# The console.operator entry is what the install form's radio sets. Nothing
# does it for a scripted Subscription, and without it the operator runs and no
# menu entry appears — a symptom this repository has chased more than once.
plugin_index() {
  oc get console.operator.openshift.io cluster \
    -o jsonpath='{range .spec.plugins[*]}{@}{"\n"}{end}' 2>/dev/null |
    grep -n "^${PLUGIN_NAME}$" | cut -d: -f1 | head -1
}

# --------------------------------------------------------------------------

log "Preflight"
require_oc

# Everything the run needs is checked here rather than where it is first used.
# The alternative is what happened the first time this script was run for real:
# a bundle generated, an image built and pushed, and then a failure to pull it
# back because the host had no containers policy — minutes in, for something
# knowable at the start. --clean-only touches no image, so it is spared.
if [ "$CLEAN_ONLY" = false ]; then
  require_podman
  require_registry_auth
  setup_containers_policy
fi

# The bundle is generated from the checkout, not from the tag, so the two have
# to be the same thing. Refusing here beats installing a bundle whose CSV says
# one version and whose image says another.
CHECKOUT_VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
[ "$CHECKOUT_VERSION" = "$VERSION" ] ||
  die "this checkout is version $CHECKOUT_VERSION, not $VERSION.
  The bundle is generated from the working tree, so check out the branch or
  tag that carries $VERSION first."

# A generation's plugin does not run on another generation's console — that is
# what the @console/pluginAPI bound is for, and crossing it produces a plugin
# that never executes rather than an error anyone would recognise.
CLUSTER_GEN=$(cluster_generation)
case $VERSION in
*-ocp4.16) WANT_GEN=4.16 ;;
*-ocp4.19) WANT_GEN=4.19 ;;
*) WANT_GEN=4.22 ;;
esac
[ "$CLUSTER_GEN" = "$WANT_GEN" ] ||
  die "this cluster is generation $CLUSTER_GEN and $VERSION targets $WANT_GEN.
  The console would refuse the plugin, which is the version gate working.
  Use hack/lab/console.sh to exercise another generation without a cluster."
info "generation $CLUSTER_GEN"

# --------------------------------------------------------------------------

log "Removing any previous installation"

# Read before deleting, because afterwards there is nothing to compare against.
# A glance at the list after a teardown cannot tell whether it is intact — only
# whether it looks plausible — and on this cluster it holds three plugins
# belonging to other operators.
PLUGINS_BEFORE=$(oc get console.operator.openshift.io cluster \
  -o jsonpath='{range .spec.plugins[*]}{@}{"\n"}{end}' 2>/dev/null |
  grep -v "^${PLUGIN_NAME}$" | sort || true)
FIO_CSV=$(oc get csv -n "$NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null |
  grep '^file-integrity-operator\.' | head -1 || true)

# Every deletion below names its object. This namespace belongs to the File
# Integrity Operator as much as to the plugin, so a sweep — `oc delete all`, a
# label selector that happens to match, deleting the namespace — would take FIO
# down as a side effect. Nothing here is allowed to be that convenient.

if [ -n "$(oc get secret -n "$NAMESPACE" -l "owner=helm,name=$PLUGIN_NAME" \
  -o name 2>/dev/null)" ]; then
  die "a Helm release of $PLUGIN_NAME exists in $NAMESPACE.
  Two installations of one plugin would fight over one ConsolePlugin. Remove it
  with 'helm uninstall $PLUGIN_NAME -n $NAMESPACE' and re-run — deliberately
  not done here, because which installation is wanted is a decision."
fi

oc delete subscription "$PLUGIN_NAME" -n "$NAMESPACE" --ignore-not-found

for csv in $(oc get csv -n "$NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null |
  grep "^${PLUGIN_NAME}\." || true); do
  oc delete csv "$csv" -n "$NAMESPACE" --ignore-not-found
done

# Cluster-scoped and with no owner reference, so nothing removes it when the
# CSV goes. Left behind it names a plugin that no longer exists, and the console
# logs a failed load on every page view.
oc delete consoleplugin "$PLUGIN_NAME" --ignore-not-found

if [ "$KEEP_CATALOG" = false ]; then
  oc delete catalogsource "$CATALOG_SOURCE" -n "$MARKETPLACE_NS" --ignore-not-found
fi

idx=$(plugin_index || true)
if [ -n "$idx" ]; then
  oc patch console.operator.openshift.io cluster --type=json \
    -p "[{\"op\": \"remove\", \"path\": \"/spec/plugins/$((idx - 1))\"}]"
  info "removed $PLUGIN_NAME from console.operator"
fi

# --------------------------------------------------------------------------

log "Checking what the teardown left"

# OLM garbage-collects what the CSV owned, which is not instant. Nothing else
# here waits, so give it a moment before calling a survivor a leftover.
leftovers() {
  local out=""
  oc get consoleplugin "$PLUGIN_NAME" >/dev/null 2>&1 && out="$out consoleplugin"
  oc get catalogsource "$CATALOG_SOURCE" -n "$MARKETPLACE_NS" >/dev/null 2>&1 &&
    out="$out catalogsource"
  oc get subscription "$PLUGIN_NAME" -n "$NAMESPACE" >/dev/null 2>&1 &&
    out="$out subscription"
  oc get serviceaccount "$PLUGIN_NAME" -n "$NAMESPACE" >/dev/null 2>&1 &&
    out="$out serviceaccount"
  # Cluster-scoped, and owned by a namespaced CSV — an ownerReference Kubernetes
  # garbage collection will not follow, so removing these is OLM's own collector
  # and nothing else. The one leak this script could not see is the one the
  # self-registering plugin introduced.
  #
  # Found by who they name rather than by how OLM labels them: a binding that
  # still grants to this ServiceAccount is a leak whatever it is called, and
  # that reading cannot go stale the way a label spelling can. The ClusterRole
  # is matched by owner, which is the weaker of the two — a role surviving
  # without its binding grants nobody anything.
  oc get clusterrolebinding -o jsonpath='{range .items[*]}{range .subjects[*]}{.kind}/{.namespace}/{.name}{"\n"}{end}{end}' 2>/dev/null |
    grep -q "^ServiceAccount/${NAMESPACE}/${PLUGIN_NAME}$" &&
    out="$out clusterrolebinding"
  oc get clusterrole -o jsonpath='{range .items[*]}{.metadata.labels.olm\.owner}{"\n"}{end}' 2>/dev/null |
    grep -q "^${PLUGIN_NAME}\." && out="$out clusterrole"
  oc get csv -n "$NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null |
    grep -q "^${PLUGIN_NAME}\." && out="$out csv"
  printf '%s' "${out# }"
}
waited=0
while [ -n "$(leftovers)" ] && [ "$waited" -lt 30 ]; do
  sleep 5
  waited=$((waited + 5))
done
check "nothing of the plugin is left" "" "$(leftovers)"

# The list is shared. Removing our entry with a merge patch on the whole field
# would be shorter and would switch off every other operator's plugin, and the
# damage would look exactly like a successful teardown.
check "other consoles' plugins are untouched" "$PLUGINS_BEFORE" \
  "$(oc get console.operator.openshift.io cluster \
    -o jsonpath='{range .spec.plugins[*]}{@}{"\n"}{end}' 2>/dev/null | sort || true)"

# This namespace is the File Integrity Operator's. Uninstalling the plugin must
# be invisible to it — including its OperatorGroup, which is shared and which
# nothing here may recreate.
if [ -n "$FIO_CSV" ]; then
  check "the File Integrity Operator is still installed" Succeeded \
    "$(oc get csv "$FIO_CSV" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null)"
  check "its deployment is still ready" \
    "$(oc get deployment file-integrity-operator -n "$NAMESPACE" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null)" \
    "$(oc get deployment file-integrity-operator -n "$NAMESPACE" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
else
  skip "the File Integrity Operator is still installed" "not installed here"
fi

# The OperatorGroup in the default namespace is the File Integrity Operator's,
# shared, and the teardown must leave it exactly as it was. Somewhere the
# teardown may itself have created it — or that a run under FIO_NAMESPACE has
# not created yet — the question is only that there are not two.
if oc get namespace "$NAMESPACE" >/dev/null 2>&1; then
  og_left=$(oc get operatorgroup -n "$NAMESPACE" -o name 2>/dev/null | wc -l)
  if [ "$NAMESPACE" = openshift-file-integrity ]; then
    check "exactly one OperatorGroup" 1 "$og_left"
  else
    check "no more than one OperatorGroup" true "$([ "$og_left" -le 1 ] && echo true)"
  fi
else
  skip "exactly one OperatorGroup" "$NAMESPACE does not exist yet"
fi

if [ "$CLEAN_ONLY" = true ]; then
  log "Clean only — stopping here"
  checks_report
  exit 0
fi

# --------------------------------------------------------------------------

log "Generating the bundle"
need_tools helm

# No BUNDLE_IMAGE: the generator then names the release image and, because that
# reference cannot move, chooses IfNotPresent. That is the branch every earlier
# round trip skipped by pointing at :test.
(cd "$REPO_ROOT" && HELM="$HELM" node hack/bundle/build-bundle.mjs)

BUNDLE_DIR="$REPO_ROOT/dist/bundle"

# operator-sdk is off by default, and said out loud rather than passed over in
# silence. The check is the one the `bundle` job in CI runs on every pull
# request, so on a tag that CI has already passed it re-answers a settled
# question — at the cost of a download this script would otherwise not need.
# It earns its place while the chart or the generator is being changed, where
# failing in two seconds beats failing after two image builds.
if [ "$VALIDATE" = true ]; then
  need_tools operator-sdk
  "$SDK" bundle validate "$BUNDLE_DIR" \
    --select-optional suite=operatorframework \
    --select-optional name=community
else
  info "operator-sdk validation skipped (--validate to run it; CI runs it on every PR)"
fi

CSV_FILE=$(echo "$BUNDLE_DIR"/manifests/*.clusterserviceversion.yaml)
CSV_NAME=$(basename "$CSV_FILE" .clusterserviceversion.yaml)
CHANNEL=$(sed -n 's/.*bundle\.channels\.v1: *//p' \
  "$BUNDLE_DIR/metadata/annotations.yaml" | tr -d "\"' " | head -1)
[ -n "$CHANNEL" ] || die "could not read the channel from the bundle metadata"
info "csv      $CSV_NAME"
info "channel  $CHANNEL"

# --------------------------------------------------------------------------

log "Building and pushing the bundle and catalogue images"
need_tools opm

POLICY=(${PODMAN_POLICY_ARGS[@]+"${PODMAN_POLICY_ARGS[@]}"})

podman build "${POLICY[@]}" -f "$BUNDLE_DIR/bundle.Dockerfile" \
  -t "$BUNDLE_IMAGE" "$BUNDLE_DIR"
podman push "$BUNDLE_IMAGE"

CATALOG_DIR="$REPO_ROOT/dist/catalog"
rm -rf "$CATALOG_DIR" "$REPO_ROOT/dist/catalog.Dockerfile"
mkdir -p "$CATALOG_DIR/$PLUGIN_NAME"

{
  "$OPM" init "$PLUGIN_NAME" --default-channel="$CHANNEL" --output=yaml
  # HOME, because opm has no flag for the signature policy and
  # containers/image resolves the user policy path from it. On a host with a
  # policy of its own POLICY_HOME is $HOME and this changes nothing.
  HOME="$POLICY_HOME" "$OPM" render "$BUNDLE_IMAGE" --output=yaml
  # `opm init` writes the package and `opm render` the bundle; the channel that
  # joins them is ours to state. One entry and no `replaces` — this catalogue
  # exists to install one version once, not to describe an upgrade path.
  printf -- '---\nschema: olm.channel\npackage: %s\nname: %s\nentries:\n  - name: %s\n' \
    "$PLUGIN_NAME" "$CHANNEL" "$CSV_NAME"
} >"$CATALOG_DIR/$PLUGIN_NAME/index.yaml"

"$OPM" validate "$CATALOG_DIR"
(cd "$REPO_ROOT/dist" && "$OPM" generate dockerfile catalog)
podman build "${POLICY[@]}" -f "$REPO_ROOT/dist/catalog.Dockerfile" \
  -t "$CATALOG_IMAGE" "$REPO_ROOT/dist"
podman push "$CATALOG_IMAGE"

# --------------------------------------------------------------------------

log "Installing"

oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: $CATALOG_SOURCE
  namespace: $MARKETPLACE_NS
spec:
  sourceType: grpc
  image: $CATALOG_IMAGE
  displayName: File Integrity console plugin (test)
  publisher: local
  updateStrategy:
    registryPoll:
      interval: 10m
EOF

wait_for "catalogue READY" 180 catalog_ready

# Created rather than required, so that FIO_NAMESPACE can name somewhere that
# does not exist yet — which is the whole point of installing elsewhere. Never
# removed again, by this script or any other: tearing down a namespace takes
# everything in it, and this one is chosen by whoever ran the command. Delete
# it by hand when the test is over.
if ! oc get namespace "$NAMESPACE" >/dev/null 2>&1; then
  info "namespace $NAMESPACE does not exist — creating it (nothing here removes it)"
  oc create namespace "$NAMESPACE"
fi

# Two OperatorGroups in one namespace make both invalid, and one of them would
# be the File Integrity Operator's. Creating one blindly is how an install
# breaks the operator it was meant to sit beside.
og_count=$(oc get operatorgroup -n "$NAMESPACE" -o name 2>/dev/null | wc -l)
case $og_count in
0)
  info "no OperatorGroup in $NAMESPACE — creating one"
  oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: $NAMESPACE
  namespace: $NAMESPACE
spec:
  targetNamespaces:
    - $NAMESPACE
EOF
  ;;
1) info "using the existing OperatorGroup" ;;
*) die "$og_count OperatorGroups in $NAMESPACE — both are invalid while that is true" ;;
esac

oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: $PLUGIN_NAME
  namespace: $NAMESPACE
spec:
  channel: $CHANNEL
  name: $PLUGIN_NAME
  source: $CATALOG_SOURCE
  sourceNamespace: $MARKETPLACE_NS
  installPlanApproval: Automatic
  startingCSV: $CSV_NAME
EOF

wait_for "CSV $CSV_NAME Succeeded" 300 csv_succeeded

if [ -z "$(oc get console.operator.openshift.io cluster \
  -o jsonpath='{.spec.plugins}' 2>/dev/null)" ]; then
  oc patch console.operator.openshift.io cluster --type=json \
    -p "[{\"op\": \"add\", \"path\": \"/spec/plugins\", \"value\": [\"$PLUGIN_NAME\"]}]"
elif [ -z "$(plugin_index || true)" ]; then
  oc patch console.operator.openshift.io cluster --type=json \
    -p "[{\"op\": \"add\", \"path\": \"/spec/plugins/-\", \"value\": \"$PLUGIN_NAME\"}]"
fi
info "plugin enabled on console.operator"

wait_for "deployment available" 180 deployment_ready

# --------------------------------------------------------------------------

log "Checking what was installed"

check "CSV phase" Succeeded \
  "$(oc get csv "$CSV_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}')"

check "deployment ready replicas" \
  "$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')" \
  "$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')"

check "container image" "$PLUGIN_IMAGE" \
  "$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"

# The generator derives this from the reference rather than being told it, and
# a release tag is the only case that yields IfNotPresent. Every round trip
# before this one pointed at :test and so never executed that branch.
check "imagePullPolicy" IfNotPresent \
  "$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].imagePullPolicy}')"

# With IfNotPresent a node that already holds a layer for this tag reuses it,
# and the rollout reports success while running the previous binary. The only
# way to tell is to compare what is running against what the registry says the
# tag is now.
POD_DIGEST=$(oc get pod -n "$NAMESPACE" \
  -l "app.kubernetes.io/name=$PLUGIN_NAME" \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' 2>/dev/null |
  grep -oE 'sha256:[0-9a-f]+' || true)
QUAY_DIGEST=$(curl -fsS \
  "https://quay.io/api/v1/repository/asalvati/$PLUGIN_NAME/tag/?specificTag=$VERSION&onlyActiveTags=true" \
  2>/dev/null | grep -oE '"manifest_digest": *"sha256:[0-9a-f]+"' |
  grep -oE 'sha256:[0-9a-f]+' | head -1 || true)
if [ -z "$QUAY_DIGEST" ]; then
  skip "running image is the tag's current digest" "quay.io unreachable"
else
  # A mismatch is usually a stale layer. It can also mean the tag is a manifest
  # list, whose digest is not the per-architecture one the kubelet records — if
  # that turns out to be so here, this check needs the index resolving first
  # rather than removing.
  check "running image is the tag's current digest" "$QUAY_DIGEST" "$POD_DIGEST"
fi

# --------------------------------------------------------------------------
# The invariant this repository is built around: the backend has no authority
# of its own, and everything it does against the API server runs as the calling
# user. OLM creates a Role and a RoleBinding from the CSV's `permissions` entry
# whether or not anything is granted, so the question is not whether RBAC
# objects exist — they do — but whether any of them grants a rule.

SA=$(oc get deployment "$PLUGIN_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.serviceAccountName}')
check "ServiceAccount exists" "$SA" \
  "$(oc get serviceaccount "$SA" -n "$NAMESPACE" \
    -o jsonpath='{.metadata.name}' 2>/dev/null)"

# Which roles are bound to it, read from the bindings rather than guessed from
# names — OLM generates the names and they are not the account's.
# The ${...} inside the node program below belong to the JavaScript, not to
# the shell, so the single quotes are the point.
# shellcheck disable=SC2016
bound_roles() {
  oc get rolebinding,clusterrolebinding -A -o json |
    node -e '
      const [ns, sa] = process.argv.slice(1);
      let raw = "";
      process.stdin.on("data", (d) => (raw += d));
      process.stdin.on("end", () => {
        for (const b of JSON.parse(raw).items) {
          const hit = (b.subjects || []).some(
            (s) =>
              s.kind === "ServiceAccount" &&
              s.name === sa &&
              (s.namespace || b.metadata.namespace) === ns,
          );
          if (!hit) continue;
          const scope = b.roleRef.kind === "ClusterRole" ? "cluster" : b.metadata.namespace;
          console.log(`${b.roleRef.kind} ${scope} ${b.roleRef.name}`);
        }
      });
    ' "$NAMESPACE" "$SA"
}

# Exactly two things may be granted, and both are tolerated by *shape* rather
# than by the name or the label of the role carrying them. Widen either, or add
# a third, and this fails.
#
#   1. Writing this plugin's own ConsolePlugin. That is ours, declared in the
#      CSV's clusterPermissions, and is how the plugin registers itself with
#      the console now that a bundle cannot ship the object.
#   2. Updating its own OperatorCondition. That one is OLM's and cannot be
#      declined: every CSV gets a condition and the operator is allowed to
#      report through it. Observed on 4.22, restricted by resourceNames to that
#      single object.
#
# Tolerating anything labelled olm.managed would have been easier and blind:
# the Role carrying whatever the CSV's permissions declare wears that label too.
#
# `rules` reads back as the string "null" on a role with none, which is neither
# empty nor "[]" — an earlier version of this check called that a violation and
# reported our own empty Role as a grant.
# shellcheck disable=SC2016
rules_beyond_the_allowed() {
  node -e '
    const [csv, plugin] = process.argv.slice(1);
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      const text = raw.trim();
      const rules = !text || text === "null" ? [] : JSON.parse(text);
      const g = (r, k) => (r[k] || []).join();
      const allowed = [
        (r) =>
          g(r, "apiGroups") === "operators.coreos.com" &&
          g(r, "resources") === "operatorconditions" &&
          g(r, "resourceNames") === csv,
        (r) =>
          g(r, "apiGroups") === "console.openshift.io" &&
          g(r, "resources") === "consoleplugins" &&
          g(r, "verbs") === "create",
        (r) =>
          g(r, "apiGroups") === "console.openshift.io" &&
          g(r, "resources") === "consoleplugins" &&
          g(r, "resourceNames") === plugin &&
          g(r, "verbs") === "get,update,patch",
      ];
      const bad = rules.filter((r) => !allowed.some((ok) => ok(r)));
      if (bad.length) process.stdout.write(JSON.stringify(bad));
    });
  ' "$1" "$2"
}

GRANTED=""
while read -r kind scope name; do
  [ -z "$kind" ] && continue
  if [ "$kind" = ClusterRole ]; then
    rules=$(oc get clusterrole "$name" -o jsonpath='{.rules}' 2>/dev/null)
  else
    rules=$(oc get role "$name" -n "$scope" -o jsonpath='{.rules}' 2>/dev/null)
  fi
  if [ -n "$(printf '%s' "$rules" | rules_beyond_the_allowed "$CSV_NAME" "$PLUGIN_NAME")" ]; then
    GRANTED="$GRANTED $kind/$name"
  fi
done < <(bound_roles)

check "nothing bound to it grants more than registering the plugin" \
  "" "${GRANTED# }"

# And the same question asked of the API server rather than of the manifests,
# because that is what actually decides. A ServiceAccount always retains the
# self-review verbs every authenticated identity has; none of these is among
# them.
for verb_res in "get:secrets" "create:pods/exec" "list:pods"; do
  verb=${verb_res%%:*}
  res=${verb_res##*:}
  check "SA cannot $verb $res" no \
    "$(oc auth can-i "$verb" "$res" \
      --as="system:serviceaccount:$NAMESPACE:$SA" -n "$NAMESPACE" 2>/dev/null || true)"
done

# The narrowing, asked of the API server too. It can make a ConsolePlugin — it
# has to, that is how the plugin registers — and it must not be able to remove
# one.
check "SA can create consoleplugins" yes \
  "$(oc auth can-i create consoleplugins \
    --as="system:serviceaccount:$NAMESPACE:$SA" 2>/dev/null || true)"
check "SA cannot delete consoleplugins" no \
  "$(oc auth can-i delete consoleplugins \
    --as="system:serviceaccount:$NAMESPACE:$SA" 2>/dev/null || true)"

# Reading one is not ours to deny, and asserting otherwise asserted something
# false about OpenShift: the release payload binds `console-extensions-reader`
# to system:authenticated, granting get, list and watch on consoleplugins and
# seven sibling kinds to every authenticated identity on the cluster. Our
# ClusterRole carries no such verb — the rules read above are the whole of what
# this bundle grants — so `oc auth can-i list` answers yes for a reason that
# has nothing to do with us.
#
# Asked of an account with no relation to this plugin, so a yes says exactly
# that: the grant is the cluster's. If it ever answers no, the reading becomes
# ours to account for again and a "SA cannot list consoleplugins" check belongs
# back here.
check "reading consoleplugins is the cluster's grant, not this bundle's" yes \
  "$(oc auth can-i list consoleplugins \
    --as="system:serviceaccount:default:default" 2>/dev/null || true)"

# --------------------------------------------------------------------------

check "ConsolePlugin backend namespace" "$NAMESPACE" \
  "$(oc get consoleplugin "$PLUGIN_NAME" \
    -o jsonpath='{.spec.backend.service.namespace}' 2>/dev/null)"

check "console.operator lists the plugin" "$PLUGIN_NAME" \
  "$(oc get console.operator.openshift.io cluster \
    -o jsonpath='{range .spec.plugins[*]}{@}{"\n"}{end}' 2>/dev/null |
    grep "^${PLUGIN_NAME}$" || true)"

# Through the API server's service proxy rather than `oc exec … curl`: the
# plugin image carries no shell tools, and this asks the same question without
# depending on what is inside the container.
HEALTH=$(oc get --raw \
  "/api/v1/namespaces/$NAMESPACE/services/https:$PLUGIN_NAME:$PLUGIN_PORT/proxy/healthz" \
  2>/dev/null || true)
check "/healthz answers" ok "${HEALTH:-unreachable}"

log "Done"
info "console: $(oc whoami --show-console 2>/dev/null || echo '<unknown>')"
info "Compute -> File Integrity, once the console has reloaded."
checks_report
