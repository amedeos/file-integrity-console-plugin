#!/usr/bin/env bash
#
# The whole lab round trip: install the bundle on the cluster and check it,
# then bring up a console for each of the other generations.
#
#   hack/lab/all.sh 0.1.0
#   hack/lab/all.sh 0.1.0 4.16          only one extra console
#
# Deliberately two scripts underneath rather than one. They answer different
# questions — bundle.sh asks whether OLM installs this correctly on the
# cluster's own generation, console.sh asks whether a generation's build loads
# at all — and when something fails it should be obvious which question
# answered no. Either can be run on its own.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

VERSION=${1:-}
[ $# -gt 0 ] && shift

[ -n "$VERSION" ] || {
  echo "usage: $0 <version> [generations...]" >&2
  exit 1
}

"$HERE/bundle.sh" "$VERSION"

# The bundle round trip has to pass before the consoles are worth looking at:
# if the plugin does not install, a browser window proves nothing.
"$HERE/console.sh" "$VERSION" "$@"
