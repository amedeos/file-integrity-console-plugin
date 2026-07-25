# File Integrity Console Plugin

An OpenShift console plugin for the [File Integrity Operator][fio]: a node-by-node
view of AIDE scan results, with the failing files parsed out of the operator's
result ConfigMaps instead of read as raw log text.

Adds a **Compute → File Integrity** entry to the administrator perspective,
visible only on clusters where the `FileIntegrity` CRD exists.

[fio]: https://github.com/openshift/file-integrity-operator

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
  audit record with user, node, path and outcome.
- The whole feature is **off by default** (`backend.features.fileRetrieve`).
  When off, the endpoint answers 501 and the backend does not even build a
  Kubernetes client.

## Install

### Build and push the image

```sh
podman build -t quay.io/<org>/file-integrity-console-plugin:0.1.0 .
podman push quay.io/<org>/file-integrity-console-plugin:0.1.0
```

### Install the chart

```sh
helm install file-integrity-console-plugin charts/file-integrity-console-plugin \
  --namespace openshift-file-integrity \
  --set plugin.image=quay.io/<org>/file-integrity-console-plugin:0.1.0
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
is maintained alongside it and must stay key-for-key aligned.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
