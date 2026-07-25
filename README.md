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
`@console/pluginAPI: >=4.22.0-0`, so an older console skips it outright: no menu
entry, an entry in the console pod log, and nothing else broken.

That gate is deliberate and should not be widened on its own. The UI targets
PatternFly 6 and takes its router context from the console, both of which differ
across console generations — lowering the bound would replace a clean refusal
with a page that renders unstyled and reads its route parameters as empty.
Support for earlier generations, when it comes, belongs on its own branch built
against that generation's SDK.

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

Released images are built by Quay from this repository, for **linux/amd64
only**. On another architecture the pod fails with `exec format error`; making
the image multi-arch is cheap when it is needed, because the web assets are
architecture-independent and the Go binary is `CGO_ENABLED=0`, so both build
stages can stay native and only the runtime layer varies.

Two things to get right when configuring the Quay build trigger:

- **Dockerfile path: `/Containerfile`.** Quay's wizard calls the field
  "Dockerfile" and offers to detect one; this repository has none, on purpose.
  Point it at `/Containerfile` explicitly. If a Quay version refuses a path
  whose basename is not `Dockerfile`, add a `Dockerfile` symlink rather than
  renaming the file.
- **Build context: `/`.** The Containerfile copies `backend/`, `src/`,
  `locales/` and `.yarn/releases`, so it needs the repository root. Nothing
  outside version control is required — the image builds from a clean checkout.

Two streams of tags come out of that trigger:

| Source | Image tag | Mutable? |
| --- | --- | --- |
| a push to `main` | `latest` | yes — install it with `plugin.imagePullPolicy=Always`, or the kubelet reuses the cached layer and a rollout reports success while running the previous binary |
| a git tag `vX.Y.Z` | `X.Y.Z` | no — the default `IfNotPresent` is correct, and this is what an installation should point at |

To build it yourself instead:

```sh
podman build -f Containerfile -t quay.io/asalvati/file-integrity-console-plugin:0.1.0 .
podman push quay.io/asalvati/file-integrity-console-plugin:0.1.0
```

### Install the chart

```sh
helm install file-integrity-console-plugin charts/file-integrity-console-plugin \
  --namespace openshift-file-integrity \
  --set plugin.image=quay.io/asalvati/file-integrity-console-plugin:0.1.0
```

To also enable reading files from nodes:

```sh
  --set backend.features.fileRetrieve=true
```

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

### Cutting a release

The version lives in four places and they have to agree, because the git tag is
what names the image and the plugin manifest is what the console reads:

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

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
