# File Integrity Console Plugin

[![CI](https://github.com/amedeos/file-integrity-console-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/amedeos/file-integrity-console-plugin/actions/workflows/ci.yml)
[![Licence: GPL-3.0-or-later](https://img.shields.io/badge/licence-GPL--3.0--or--later-blue.svg)](LICENSE)

An OpenShift console plugin for the [File Integrity Operator][fio]: a node-by-node
view of AIDE scan results, with the failing files parsed out of the operator's
result ConfigMaps instead of read as raw log text.

Adds a **Compute → File Integrity** entry to the administrator perspective,
visible only on clusters where the `FileIntegrity` CRD exists.

[fio]: https://github.com/openshift/file-integrity-operator

## Compatibility

Built against the OpenShift **4.22** console SDK. The plugin manifest declares
`@console/pluginAPI: >=4.22.0-0`, so an older console skips it outright, saying
so in the browser console and nowhere else:

```
Failed to resolve dependencies of plugin file-integrity-console-plugin
Unmet dependency on Console plugin API:
@console/pluginAPI: required >=4.22.0-0, current 4.16.55
```

No menu entry, no error in the user's face, and the rest of the console
unaffected. If the plugin is missing from a cluster you believe should have it,
that message is the first place to look.

The bound is not conservatism. Told to load anyway, a 4.22 build on a 4.16
console **fails outright** — `__load_plugin_entry__ is not defined`, because the
entry-registration contract between console and plugin changed in 4.22
(`loadPluginEntry` before it). The plugin does not execute a line, so nothing
renders at all. Verified against a real 4.16 console, not inferred.

Support for earlier consoles therefore has to be a build of its own, against
that generation's SDK, on its own branch — see
[AGENTS.md](AGENTS.md#supporting-more-than-one-console-generation).

| Console | Branch | Image tag |
|---|---|---|
| 4.22 and later | `main` | `latest`, `X.Y.Z` |
| 4.19 – 4.21 | `release-4.19` | `release-4.19`, `X.Y.Z-ocp4.19` |
| 4.16 – 4.18 | `release-4.16` | `release-4.16`, `X.Y.Z-ocp4.16` |

A console outside every range loads none of them rather than loading the wrong
one: each build declares a closed `@console/pluginAPI` range, so the mismatch is
a clean refusal in the console's own plugin list instead of a page that renders
half-way.

### File retrieve on 4.16 is not verified yet

The optional file-retrieve feature is off by default everywhere, and on 4.16 it
should stay off until someone has checked it against a real cluster of that
version.

Not because it is expected to fail — because it runs different code there, and
**only** there. The API server's WebSocket exec subprotocol is behind
`TranslateStreamCloseWebsocketRequests`, which is alpha and off in Kubernetes
1.29 and beta and on from 1.30. OpenShift 4.16 is 1.29, so the backend's
WebSocket attempt fails at negotiation and every read falls back to SPDY. 4.17
is 1.30 and 4.19 is 1.32, so from 4.17 upwards the WebSocket attempt succeeds
and the fallback never runs — the same path `main` takes.

That narrows the gap rather than closing it: the SPDY fallback is the *only*
path on 4.16 and has no field use behind it anywhere. Note also what this
paragraph is and is not. The version mapping and the gate defaults were read
from the Kubernetes and OpenShift sources; no read has been performed on a
4.16, 4.17, 4.18 or 4.19 cluster.

It is also where this project's worst defect lived: a fallback that re-ran the
command into the buffer of the attempt it was replacing returned the file's
contents **duplicated**, with a `sha256` of the doubled bytes — a wrong answer
that looks entirely plausible. That has been fixed structurally, and the 4.16
case is the clean one in theory: the upgrade fails before a single byte is
streamed. "In theory" is what was said the first time.

So the first check on a 4.16 cluster is not the interface. Read a file through
the plugin, read the same file on the node, and compare the byte count and the
`sha256`. If they agree, the fallback is sound.

## What it does

- **Overview** — every `FileIntegrityNodeStatus` in the cluster, its phase and
  the count of files added, changed and removed.
- **Node report** — the AIDE report for one node, parsed into a filterable
  table (added / changed / removed, with the attribute diffs for changes).
  Both the AIDE 0.16 (`CONTENTEX`) and 0.18 (`CONTENT_EX`) report grammars are
  supported, and a report the operator truncated is labelled as such rather
  than half-parsed.
- **Re-init** — re-initialise the AIDE database for one node or for every
  currently failing node, behind a confirmation that says plainly that the
  currently reported changes stop being reported.
- **File retrieve** (optional, off by default) — show the current contents of a
  reported file, read from the node itself. See [Security model](#security-model).

The UI ships English and Italian locales.

## Architecture

```
console  ──► plugin assets            ──┐
         └─► /api/proxy/plugin/…/fio-backend/api/v1/nodes/{node}/file
                                        │  (console proxy, authorization: UserToken)
                                        ▼
                          one Go binary, one Deployment, one Service
                                        │
frontend ──► Kubernetes API directly (SDK): FileIntegrity, FileIntegrityNodeStatus,
             result ConfigMaps — all with the logged-in user's own RBAC
```

The listing and report views talk to the Kubernetes API through the console SDK
and need no backend at all. The backend exists for one thing: reading a file off
a node, which requires exec'ing into the operator's privileged AIDE pod.

Serving the assets and serving that API from the same binary is why there is no
nginx sidecar: the console needs one HTTPS endpoint per plugin, and TLS is
terminated by the Go server with the service-serving certificate.

## Security model

The file-retrieve endpoint is the only privileged thing here, and it is built so
that the plugin never lends its own authority to a caller:

- The console forwards the **logged-in user's** OAuth token, because the
  `ConsolePlugin` proxy is declared with `authorization: UserToken`. Every API
  call the backend makes uses that token. A request without one is rejected with
  401 — there is no service-account fallback.
- The backend's ServiceAccount has **no Role or ClusterRole bound to it**. It
  resolves the caller with `SelfSubjectReview` and checks `pods/exec` with
  `SelfSubjectAccessReview`, both of which run as the user.
- A **deny list** blocks paths that would turn "can exec in the file-integrity
  namespace" into "can read every key on a control-plane node":
  `/etc/kubernetes/static-pod-resources/**`, `**/*.key`, `**/*.pem`,
  `**/.ssh/**`, `**/shadow` and more. The full built-in list is in
  [`backend/internal/policy/policy.go`](backend/internal/policy/policy.go).
  It is checked *before* the caller is even authenticated, so probing costs
  nothing and is never attributed to a session.
- Reads are capped at `backend.maxFileBytes` (1 MiB by default) and executed as
  a fixed argv (`head -c N -- /hostroot<path>`), never a shell string.
- Every attempt, allowed or denied, is written to the pod log as a structured
  audit record with user, node, path and outcome. See
  [Where the audit trail lives](#where-the-audit-trail-lives).
- The whole feature is **off by default** (`backend.features.fileRetrieve`).
  When off, the endpoint answers 501 and the backend does not even build a
  Kubernetes client.

### Where the audit trail lives

Two places, and the important one is not ours.

**The API server's audit log is the authoritative record.** Every read goes
through a `pods/exec` against the node's AIDE pod, and the API server logs it
with the caller, the pod, the full command — which contains the file path — and
the RBAC decision that allowed it. This plugin can neither forge nor suppress
those entries:

```sh
oc adm node-logs --role=master --path=kube-apiserver/audit.log \
  | sed 's/^[^ ]* //' | grep -F '%2Fhostroot' \
  | python3 -c 'import sys, json, urllib.parse as u
for line in sys.stdin:
    try: e = json.loads(line)
    except ValueError: continue
    q = u.parse_qs(u.urlparse(e["requestURI"]).query)
    print(e["requestReceivedTimestamp"], e["user"]["username"],
          e["objectRef"]["name"], q["command"][-1],
          e["annotations"].get("authorization.k8s.io/decision"))'
```

**The plugin's own log is the convenient one.** `kubectl logs` on the plugin
pods, filtered on `"audit":true`, gives one JSON record per attempt with the
resolved username, node, path and outcome (`allowed`, `denied-rbac`,
`no-pod`, `read-failed`). Unlike the API server's record it also covers the
attempts that never reached the API server at all — a path refused by the deny
list, a request with no bearer token — which are the ones worth alerting on.

No Kubernetes `Event` is emitted, although an earlier design called for one.
Creating it with the caller's token fails exactly for the users whose attempts
matter most, since someone denied `pods/exec` is usually also denied
`create events`, and a request with no token has no user at all. Creating it
with the plugin's own ServiceAccount would mean giving that account a
permission it otherwise does not need, and the deny-list check runs before
authentication, so unauthenticated callers could drive event creation. An
Event is also the wrong store for this: the default `event-ttl` is three hours.

## Install

### The image

Published images live at **`quay.io/asalvati/file-integrity-console-plugin`**,
built for **linux/amd64 only** — on another architecture the pod fails with
`exec format error`.

| Tag | Built from | Mutable? |
| --- | --- | --- |
| `X.Y.Z` | the git tag `vX.Y.Z` | no — this is what an installation should point at, and the default `IfNotPresent` pull policy is correct for it |
| `latest` | every push to `main` | yes — needs `plugin.imagePullPolicy=Always`, or the kubelet reuses the cached layer and a rollout reports success while running the previous binary |

**Building your own.** Only the maintainer can push to the repository above, and
an air-gapped or otherwise restricted cluster will need its own copy anyway.
Build from a clean checkout and push wherever your cluster can pull from:

```sh
podman build -f Containerfile -t <your-registry>/<your-namespace>/file-integrity-console-plugin:0.1.0 .
podman push <your-registry>/<your-namespace>/file-integrity-console-plugin:0.1.0
```

Nothing outside version control is needed, and no build arguments: the image
builds from the repository as it is. Then pass your own reference to
`plugin.image` below.

Multi-arch is cheap to add when someone needs it: the web assets are
architecture-independent and the Go binary is `CGO_ENABLED=0`, so both build
stages stay native and only the runtime layer varies — no emulation.

### Install from OperatorHub

Published as a community operator, so it appears in **Operators → OperatorHub**
under the name *File Integrity Console Plugin*.

**On the install form, set "Console plugin" to Enable.** It defaults to
*Disable*, with a warning about trusting the plugin, and installing without
changing it leaves the operator running and **no menu entry at all** — no error,
nothing in the console's face. That default is not about this plugin: the
console trusts exactly one catalogue, `redhat-operators`
([`isCatalogSourceTrusted`][trusted]), and every community operator that ships a
console plugin gets the same treatment. If it is already installed and there is
no menu entry, this is why:

```sh
oc patch consoles.operator.openshift.io cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"file-integrity-console-plugin"}]'
```

**Install it into `openshift-file-integrity`**, which the form pre-selects as
*Operator recommended Namespace*. The `ConsolePlugin` the bundle ships names
that namespace literally — OLM fills nothing in inside a cluster-scoped
manifest — so installing elsewhere leaves the console unable to fetch the
plugin's assets. That failure is at least visible: the plugin is listed as
failed under **Administration → Cluster Settings → Console plugins**.

The bundle offers only the single-namespace install mode, and that is why the
form defaults the way it does. It is also the only mode that works: a global
install would put the pod in `openshift-operators`, which is not the namespace
the ConsolePlugin names. `openshift-file-integrity` is where the File Integrity
Operator runs, and the plugin belongs beside the operator it reads.

The bundle grants its ServiceAccount nothing, exactly as the chart does — the
CSV declares one permissions entry with an empty rule list and no cluster
permissions. OLM turns that into the account, plus a Role and a RoleBinding
carrying no rules, so unlike the chart install you will see two RBAC objects
here. They permit nothing; the backend acts only as the user browsing the
console.

The console restarts itself once the plugin is enabled, so the manifest-cache
problem described under [Upgrading to a new build](#upgrading-to-a-new-build)
does not arise on this path.

**Configuring it afterwards** goes through the Subscription, not through Helm
values, which do not exist here. A Subscription can override the container's
environment by name, and every setting the chart exposes is read from the
environment for exactly that reason — so to turn on reading files from nodes:

```sh
oc patch subscription file-integrity-console-plugin \
  -n openshift-file-integrity --type=merge -p '
spec:
  config:
    env:
      - name: PLUGIN_ENABLE_FILE_RETRIEVE
        value: "true"'
```

The names are the flags in [Values worth knowing](#values-worth-knowing),
upper-cased with hyphens as underscores and a `PLUGIN_` prefix:
`PLUGIN_MAX_FILE_BYTES`, `PLUGIN_FIO_NAMESPACE`, and so on. Read the security
note under [File retrieve](#security-model) before enabling it — it is off by
default deliberately, on both install paths.

A Subscription can also mount volumes, which is how a deny list of your own
reaches the pod: mount a ConfigMap and point `PLUGIN_EXTRA_DENY_LIST_FILE` at
the file inside it.

**Uninstalling leaves the `ConsolePlugin` behind.** It is cluster-scoped and OLM
gives it no owner reference, so removing the operator does not remove it, and
the console is left with a plugin name that resolves to nothing — it logs a
failed load on every page view. The chart has a pre-delete Job for this; a
bundle cannot, because `Job` is not a kind OLM accepts. Remove it by hand:

```sh
oc delete consoleplugin file-integrity-console-plugin
oc patch consoles.operator.openshift.io cluster --type=json \
  -p '[{"op":"remove","path":"/spec/plugins/0"}]'   # check the index first
```

[trusted]: https://github.com/openshift/console/blob/master/frontend/packages/operator-lifecycle-manager/src/utils.tsx

### Install the chart

Nothing about the chart changed when the bundle arrived, and it remains the way
to install from a checkout, into a namespace of your choosing, or with a
non-default configuration.

```sh
helm install file-integrity-console-plugin charts/file-integrity-console-plugin \
  --namespace openshift-file-integrity \
  --set plugin.image=quay.io/asalvati/file-integrity-console-plugin:0.1.0
```

To also enable reading files from nodes:

```sh
  --set backend.features.fileRetrieve=true
```

The chart renders that, and every other tunable setting, as an environment
variable on the container rather than as a command-line flag. The binary reads
each one as the default for the matching flag, so a flag still wins and nothing
that passed flags before has changed. The reason is the OLM path: a Subscription
can override a container's environment but not its arguments, so as flags these
settings were unreachable from OperatorHub.

The chart runs a post-install Job that adds the plugin to
`consoles.operator.openshift.io/cluster`, and a pre-delete Job that removes it
again on uninstall. This is where Helm is weaker than an OLM bundle, which would
declare the plugin on its CSV: if the Job is disabled
(`plugin.jobs.patchConsoles.enabled=false`) or fails, enable the plugin by hand
with

```sh
oc patch consoles.operator.openshift.io cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"file-integrity-console-plugin"}]'
```

The console rolls out a new pod after the patch; the menu entry appears once it
is ready.

### Upgrading to a new build

The console reads a plugin's manifest once and caches it, so a new image alone
is not enough — it will keep serving the asset filenames it learned at startup,
and the browser will keep loading the old bundle no matter how hard you reload:

```sh
oc rollout restart deployment/console -n openshift-console
```

Note also that `plugin.imagePullPolicy` defaults to `IfNotPresent`, which is
right for an immutable tag and wrong for a mutable one. Deploying `:latest`
twice without `Always` leaves the kubelet reusing the cached image, and the
rollout reports success while running the previous binary.

### Values worth knowing

| Value | Default | Meaning |
| --- | --- | --- |
| `plugin.image` | *(required)* | Image built from this repository. |
| `plugin.replicas` | `2` | |
| `plugin.name` | chart name | ConsolePlugin name. It is baked into the frontend's proxy URL (`PLUGIN_NAME` in `src/constants.ts`); changing one without the other breaks file retrieve. |
| `backend.fileIntegrityNamespace` | `openshift-file-integrity` | Where the operator runs its scans. |
| `backend.features.fileRetrieve` | `false` | Enables reading files from nodes. |
| `backend.maxFileBytes` | `1048576` | Bytes returned before the response is flagged truncated. |
| `backend.denyList` | `[]` | **Replaces** the built-in deny globs. |
| `backend.extraDenyList` | `[]` | **Adds** to whichever list is in effect — the safe way to harden, since a copied default list goes stale. |

## Development

```sh
yarn install
yarn test           # jest, including the AIDE parser fixtures
yarn lint
yarn build          # production assets into dist/

cd backend
go test ./...
go build ./...
```

Live loop against a real cluster — the console runs in a container and loads the
plugin from the local dev server:

```sh
yarn start          # plugin dev server on :9001
oc login …          # in another shell
yarn start-console  # console on :9000, pointed at the logged-in cluster
```

Translations live in `locales/<lang>/plugin__file-integrity-console-plugin.json`.
`yarn i18n` regenerates the English catalogue from the sources; the Italian one
is maintained alongside it and must stay key-for-key aligned — CI fails if the
two drift apart.

Note that `yarn lint` passes `--fix`, so it repairs rather than reports. CI runs
`yarn eslint src --max-warnings 0` instead, which does not.

`.github/workflows/ci.yml` runs all of the above on every pull request, plus a
`podman build` of the Containerfile and a set of `helm template` assertions —
including one that renders the chart with its *defaults*, which is the case that
once shipped `--max-file-bytes=1.048576e+06` to a cluster.

See [AGENTS.md](AGENTS.md) for the conventions and the invariants that a change
must not break silently.

## Releasing

Only useful to whoever owns `quay.io/asalvati`; everyone else builds their own
image as described under [The image](#the-image).

Images are built by a Quay build trigger on this repository rather than by CI,
so nothing here holds registry credentials. Two things to get right when
configuring that trigger:

- **Dockerfile path: `/Containerfile`.** Quay's wizard calls the field
  "Dockerfile" and offers to detect one; this repository has none, on purpose.
  Point it at `/Containerfile` explicitly. If a Quay version refuses a path
  whose basename is not `Dockerfile`, add a `Dockerfile` symlink rather than
  renaming the file.
- **Build context: `/`.** The Containerfile copies `backend/`, `src/`,
  `locales/` and `.yarn/releases`, so it needs the repository root.

To cut a release, the version has to agree everywhere it is written down,
because the git tag is what names the image and the plugin manifest is what the
console reads:

- `version` and `consolePlugin.version` in `package.json`
- `appVersion` in `charts/file-integrity-console-plugin/Chart.yaml`
- and `version` in the same file, which is the chart's own version — free to
  move independently in principle, kept in step here because the chart ships
  nothing but this plugin

CI fails if the first three disagree. So:

```sh
# bump all four, commit, then
git tag v0.1.1 && git push origin v0.1.1
```

Quay builds the tag into `quay.io/asalvati/file-integrity-console-plugin:0.1.1`.

### Publishing the OLM bundle

The bundle is **generated from the chart**, never written beside it, so there is
one description of what an installation creates and it cannot drift:

```sh
node hack/bundle/build-bundle.mjs        # -> dist/bundle/, not committed
```

Only the parts a chart has no opinion about — display name, description, icon,
install modes, annotations — are written by hand, in `hack/bundle/csv-base.yaml`.
Which console generation the bundle targets is decided by the version in
`package.json`: the suffix selects a row of the table in `build-bundle.mjs`, and
that table lives on `main` and is merged forward, for the same reason
`.github/branch-delta.json` does.

| branch | version | published to catalogues | channel |
|---|---|---|---|
| `main` | `X.Y.Z` | `v4.22` and later | `stable-4.22` |
| `release-4.19` | `X.Y.Z-ocp4.19` | `v4.19-v4.21` | `stable-4.19` |
| `release-4.16` | `X.Y.Z-ocp4.16` | `v4.16-v4.18` | `stable-4.16` |

One package, three bundles that never meet: each per-OpenShift catalogue is
built from the bundles whose range covers it, so a 4.16 cluster is never offered
the 4.22 build. A channel per generation says the same thing a second way — in
semver `0.1.0-ocp4.16` is a *prerelease* of `0.1.0` and sorts before it, so a
single shared channel would describe an upgrade from the 4.16 build to the 4.22
one.

**Tag first.** A bundle names an immutable image, so `vX.Y.Z` has to exist and
Quay has to have built it before the bundle is generated for submission.

Then copy `dist/bundle/manifests` and `dist/bundle/metadata` into a fork of
[`community-operators-prod`][cop] at
`operators/file-integrity-console-plugin/<version>/` and open a pull request
there. `dist/bundle/bundle.Dockerfile` is not part of that submission; it is
there to build a bundle image for a local catalogue when testing.

CI generates and validates the bundle on every pull request, so a change to the
chart that would break it is caught here rather than in someone else's
repository.

[cop]: https://github.com/redhat-openshift-ecosystem/community-operators-prod

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
