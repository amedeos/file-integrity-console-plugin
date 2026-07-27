# shellcheck shell=bash
#
# Shared setup for the lab scripts. Sourced, never executed.
#
# Holds the three things the round trips have in common: the names of the
# objects an installation creates, the pinned binaries the scripts fetch, and
# the reporting helpers that turn "it looked right" into a check that either
# passes or fails.

# Everything below is read by the scripts that source this file, which cannot
# be seen from here — hence the blanket disable.
# shellcheck disable=SC2034

# The names an installation uses. These are not settings — they have to match
# what the chart renders and what src/constants.ts builds its proxy URL from,
# so they are stated once here rather than typed again in each script.
PLUGIN_NAME=file-integrity-console-plugin
NAMESPACE=openshift-file-integrity
IMAGE_REPO=quay.io/asalvati/file-integrity-console-plugin
CATALOG_SOURCE=fio-plugin-test
MARKETPLACE_NS=openshift-marketplace
PLUGIN_PORT=9443

# Real z-streams, taken from the stable-4.x channels on mirror.openshift.com
# rather than invented. BRIDGE_RELEASE_VERSION is what makes a local console
# evaluate the @console/pluginAPI bound at all: with it unset the check is
# skipped entirely, so a run proves nothing about the thing it was started to
# prove. An invented number would be refused by the console's own parsing.
OCP_ZSTREAM_416=4.16.55
OCP_ZSTREAM_419=4.19.38
OCP_ZSTREAM_422=4.22.5

# Pinned tools. Every checksum here was read from the publisher, not computed
# locally: a checksum generated from whatever happened to download is a record
# of the download, not a check on it.
#
# Only two of the three are always needed. helm is structural — the bundle is
# rendered from the chart, so there is no bundle without it — and opm builds
# the catalogue. operator-sdk is fetched only under bundle.sh --validate,
# because its one use here is the check CI already runs.
HELM_VERSION=3.16.4
HELM_SHA256=fc307327959aa38ed8f9f7e66d45492bb022a66c3e5da6063958254b9767d179
SDK_VERSION=1.42.3
SDK_SHA256=887a3bb0d63ccc4ca47a522d0c8ffac56d9d5246f6a2bd886b4ed23eb2e2672f

# opm's version does not have to match the cluster's, and this one is simply a
# recent build rather than a choice about 4.22. Two reasons, both checked
# rather than assumed:
#
#   - this binary never reaches the cluster. It writes the file-based catalogue
#     and generates a Dockerfile whose base image is
#     quay.io/operator-framework/opm:latest — that image, not this binary, is
#     what serves the catalogue over gRPC once the CatalogSource runs it. The
#     cluster consumes a gRPC service, not a file format it has to parse.
#   - the file-based catalogue format has been stable across every generation
#     this repository targets; 4.16 is well past its introduction.
#
# So a lab of another version needs nothing changed here. If one ever does,
# set OPM to a binary of your own — see need_tools — rather than editing this,
# because a version bumped without its checksum is worse than no pin at all.
OPM_VERSION=4.22.5
OPM_SHA256=6bf95f88311026b2f0582eb180a053aa71ebd76e426b689f3da56535f0578392

# Where the binaries land. /tmp is a 1 GB tmpfs on some of the machines this
# runs on — the three binaries fit, a Go module cache would not, which is why
# docs/STATUS.md sends Go to /var/tmp. FIO_TOOLS_DIR exists so the cache can be
# moved without editing this file.
TOOLS_DIR=${FIO_TOOLS_DIR:-${TMPDIR:-/tmp}/fio-plugin-tools}

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# --------------------------------------------------------------------------
# Reporting
#
# Two separate ideas, deliberately not one. `log` narrates what the script is
# doing; `check` records whether something is true. Only the second decides the
# exit status, because a script that says "installed" and exits 0 is exactly
# what let four defects through the manual round trips.

CHECKS_FAILED=0
CHECKS_RUN=0

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33mwarning\033[0m %s\n' "$*" >&2; }

die() {
  printf '\n\033[31merror\033[0m %s\n' "$*" >&2
  exit 1
}

# check <description> <expected> <actual>
check() {
  local what=$1 want=$2 got=$3
  CHECKS_RUN=$((CHECKS_RUN + 1))
  if [ "$want" = "$got" ]; then
    printf '    \033[32mPASS\033[0m  %s\n' "$what"
  else
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
    printf '    \033[31mFAIL\033[0m  %s\n' "$what"
    printf '          expected: %s\n' "$want"
    printf '          actual:   %s\n' "${got:-<empty>}"
  fi
}

# skip <description> <why> — a check that could not run. Printed rather than
# silently dropped: silence reads as success, which is the failure mode this
# whole file exists to avoid.
skip() {
  printf '    \033[33mSKIP\033[0m  %s (%s)\n' "$1" "$2"
}

checks_report() {
  printf '\n'
  if [ "$CHECKS_FAILED" -eq 0 ]; then
    printf '\033[32m%d checks, all passed\033[0m\n' "$CHECKS_RUN"
    return 0
  fi
  printf '\033[31m%d checks, %d failed\033[0m\n' "$CHECKS_RUN" "$CHECKS_FAILED"
  return 1
}

# --------------------------------------------------------------------------
# Version handling
#
# One argument drives every script: the release version. The generation
# suffixes are the same ones hack/bundle/build-bundle.mjs keys its table on, so
# `0.1.0` here names `0.1.0-ocp4.16` on the 4.16 branch without either place
# having to know about the other's spelling.

# generation_version <base> <generation> — 0.1.0 4.16 -> 0.1.0-ocp4.16
generation_version() {
  case $2 in
  4.22) printf '%s' "$1" ;;
  *) printf '%s-ocp%s' "$1" "$2" ;;
  esac
}

# generation_zstream <generation>
generation_zstream() {
  case $1 in
  4.16) printf '%s' "$OCP_ZSTREAM_416" ;;
  4.19) printf '%s' "$OCP_ZSTREAM_419" ;;
  4.22) printf '%s' "$OCP_ZSTREAM_422" ;;
  *) die "unknown console generation '$1' — expected 4.16, 4.19 or 4.22" ;;
  esac
}

# --------------------------------------------------------------------------
# Tools

fetch_verify() {
  local url=$1 want=$2 out=$3
  [ -s "$out" ] && return 0
  info "downloading $(basename "$url")"
  curl -fsSL "$url" -o "$out.part" ||
    die "could not download $url"
  local got
  got=$(sha256sum "$out.part" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    rm -f "$out.part"
    die "checksum mismatch for $url
  expected $want
  actual   $got"
  fi
  mv "$out.part" "$out"
}

# need_tools <name>... — make HELM, OPM and SDK point at usable binaries.
#
# Each honours a pre-set variable of the same name, so a lab that needs its own
# build of one of these says so without editing this file and without losing
# the pin on the other two:
#
#   OPM=/usr/local/bin/opm hack/lab/bundle.sh 0.1.0
need_tools() {
  mkdir -p "$TOOLS_DIR"
  local t found
  for t in "$@"; do
    case $t in
    helm)
      if [ -n "${HELM:-}" ] && [ -x "${HELM:-}" ]; then
        info "helm     $HELM (supplied)"
      else
        HELM=$TOOLS_DIR/helm
        if [ ! -x "$HELM" ]; then
          fetch_verify \
            "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
            "$HELM_SHA256" "$TOOLS_DIR/helm.tar.gz"
          tar -xzf "$TOOLS_DIR/helm.tar.gz" -C "$TOOLS_DIR" \
            --strip-components=1 linux-amd64/helm
          chmod +x "$HELM"
        fi
      fi
      export HELM
      ;;
    opm)
      if [ -n "${OPM:-}" ] && [ -x "${OPM:-}" ]; then
        info "opm      $OPM (supplied)"
      else
        OPM=$TOOLS_DIR/opm
        if [ ! -x "$OPM" ]; then
          fetch_verify \
            "https://mirror.openshift.com/pub/openshift-v4/x86_64/clients/ocp/${OPM_VERSION}/opm-linux-${OPM_VERSION}.tar.gz" \
            "$OPM_SHA256" "$TOOLS_DIR/opm.tar.gz"
          # The OpenShift build names the binary after the base it was built
          # on — opm-rhel8 today — not `opm`. Found rather than assumed,
          # because assuming it cost one round of this script doing nothing.
          tar -xzf "$TOOLS_DIR/opm.tar.gz" -C "$TOOLS_DIR"
          found=$(find "$TOOLS_DIR" -maxdepth 1 -type f -name 'opm-rhel*' |
            head -1)
          [ -n "$found" ] ||
            die "no opm binary in the tarball — it used to unpack as opm-rhel8"
          mv "$found" "$OPM"
          chmod +x "$OPM"
        fi
      fi
      export OPM
      ;;
    operator-sdk)
      if [ -n "${SDK:-}" ] && [ -x "${SDK:-}" ]; then
        info "sdk      $SDK (supplied)"
      else
        SDK=$TOOLS_DIR/operator-sdk
        fetch_verify \
          "https://github.com/operator-framework/operator-sdk/releases/download/v${SDK_VERSION}/operator-sdk_linux_amd64" \
          "$SDK_SHA256" "$SDK"
        chmod +x "$SDK"
      fi
      export SDK
      ;;
    *) die "no rule to fetch '$t'" ;;
    esac
  done
}

# --------------------------------------------------------------------------
# Preflight
#
# Each of these fails with one line saying what to do. The alternative is
# discovering halfway through a teardown that podman has no credential.

require_oc() {
  command -v oc >/dev/null || die "oc is not on PATH"
  oc whoami >/dev/null 2>&1 ||
    die "not logged in to a cluster — run 'oc login' first"
  info "cluster  $(oc whoami --show-server)"
  info "user     $(oc whoami)"
}

require_podman() {
  command -v podman >/dev/null ||
    die "podman is not on PATH — it builds and pushes the bundle and catalog images"
}

require_registry_auth() {
  podman login --get-login quay.io >/dev/null 2>&1 ||
    die "not logged in to quay.io — run 'podman login quay.io'"
}

# cluster_generation — 4.16 / 4.19 / 4.22 from the cluster's own version
cluster_generation() {
  local v
  v=$(oc get clusterversion version -o jsonpath='{.status.desired.version}' 2>/dev/null) ||
    die "could not read the cluster version"
  case $v in
  4.16.* | 4.17.* | 4.18.*) printf '4.16' ;;
  4.19.* | 4.20.* | 4.21.*) printf '4.19' ;;
  *) printf '4.22' ;;
  esac
}
