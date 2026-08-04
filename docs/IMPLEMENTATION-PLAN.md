# File Integrity Console Plugin — implementation plan

## Context

The Red Hat File Integrity Operator (FIO) is an AIDE-based HIDS: installing and configuring it
is easy, but **consuming its results is not**. Today, understanding what changed on a node means
connecting to the cluster, finding the right `FileIntegrityNodeStatus`, tracing it back to the
result ConfigMap and reading a raw AIDE log by hand (sometimes gzipped and base64-encoded).
There is no node-by-node overview, and no way to inspect the file that was reported as changed.

Goal: a web dashboard for cluster admins giving (a) integrity status node by node, (b) the
parsed and filterable AIDE report instead of a wall of text, (c) triage actions (baseline
re-init) and (d) a button to retrieve the current contents of a reported file straight from the
node.

Decisions taken with the user:
- **Dynamic console plugin** (not a standalone route).
- **File retrieve through a backend acting with the user's token** (no privileged SA).
- **Helm chart now, OLM bundle in a later phase.**
- v1 scope: node-by-node overview + parsed AIDE report + remediation actions.
  **History and trends explicitly out of v1.**

## Verified facts (the basis of the design — do not re-derive them)

Lab cluster `https://api.ocp-lab.duckdns.org:6443`: OCP **4.22.5**, k8s 1.35.5, 3 compact nodes
(`control-plane-0/1/2`, master+worker roles), ingress `apps.ocp-lab.duckdns.org`.
**FIO was not yet installed when this plan was written** — it is available as
`file-integrity-operator` in the `redhat-operators` CatalogSource (current upstream bundle:
v1.4.0). The `openshift-file-integrity` namespace did not exist yet.

FIO data model (from `github.com/openshift/file-integrity-operator`, verified against master):
- CRDs `fileintegrities` and `fileintegritynodestatuses`, group
  `fileintegrity.openshift.io/v1alpha1`, fixed namespace `openshift-file-integrity`
  (`pkg/common/var.go`).
- `FileIntegrityNodeStatus`: `.nodeName`, `.results[]`, `.lastResult` →
  `condition` ∈ {`Succeeded`,`Failed`,`Errored`}, `lastProbeTime`, `errorMsg`,
  `resultConfigMapName`/`resultConfigMapNamespace`, `filesAdded`/`filesChanged`/`filesRemoved`.
- Result ConfigMap: named `aide-<fileintegrity>-<node>-failed`, labels
  `file-integrity.openshift.io/result-log`, `.../owner`, `.../node`; data key **`integritylog`**.
  When the `file-integrity.openshift.io/compressed` annotation is present the content is
  **gzip → base64** (`cmd/manager/logcollector_util.go`). Beyond roughly 1 MB the log is
  **replaced** by a "fetch it from /etc/kubernetes/aide.log on node X" message.
- **The ConfigMap is overwritten on every new failure** → only the latest report per node
  exists. `Succeeded` scans leave no ConfigMap (the temporary one is deleted by the
  controller). This is why history is out of scope for v1.
- **Never use hand-built names**: always read `lastResult.resultConfigMapName`.
- The `aide-<fileintegrity>` DaemonSet has a **`daemon`** container, `privileged: true`, which
  mounts the host `/` at **`/hostroot`**. Its image is based on `rhel9-4-els/rhel-minimal` with
  `aide` and `tar` installed (`build/Dockerfile.openshift`) → the binaries needed to read a file
  are present.
- Baseline re-init: the **`file-integrity.openshift.io/re-init`** annotation on the
  `FileIntegrity` CR (value = comma-separated node list; absent or empty = all nodes) and
  **`file-integrity.openshift.io/re-init-on-failed`** (re-init every failing node).
  `file-integrity.openshift.io/holdoff` is managed by the operator during a re-init → in v1 it
  is shown read-only, never driven.
- AIDE report format: the parser must handle **both 0.16 (`CONTENTEX`) and 0.18 (`CONTENT_EX`)**.
  ⚠️ Do not set `report_format=json` in `aide.conf`: it would pass through the converter
  (`pkg/controller/fileintegrity/config.go`) unharmed but break FIO's own regexes
  (`Added entries:\s+(\d+)`), zeroing the summary annotations.

Console 4.22:
- The cluster's `ConsolePlugin` `console.openshift.io/v1` supports
  **`proxy[].authorization: UserToken`** (verified against the live CRD schema) → the console
  forwards the **logged-in user's** OAuth token to the backend. This is the linchpin of the
  retrieve feature's security. It also supports `contentSecurityPolicy` and `i18n.loadType`.
- Mandated stack (from `console-plugin-template@release-4.22`): SDK `4.22-latest`,
  **React 18.3**, **react-router 7.13**, **PatternFly 6.4**, webpack ≥5.107, TypeScript 5.9.3,
  yarn 4. Breaking changes relative to 4.19: no `@openshift-console/plugin-shared`, no
  `console.page/resource/tab`, `jsx: "react-jsx"`, explicit `children` in props.

## Other considerations that came up (to keep in mind while implementing)

1. **No cluster-wide ServiceAccount for reading.** The frontend reads CRs and ConfigMaps
   directly from the browser through the SDK: RBAC is applied natively by the API server. The
   backend exists *only* for the exec, because the browser does not speak SPDY.
2. **The retrieve is the risk surface.** `/hostroot` on a master holds `static-pod-resources`
   (etcd keys), kubeconfigs and TLS keys: reading them is a takeover. The mitigations are
   mandatory and go together: user token (not SA), path deny list, size limit, read-only access
   to a single path (never an arbitrary command), an audit record for every read.
3. **Operational noise.** MCO updates and certificate rotation generate hundreds of legitimate
   changes: without the re-init button the dashboard becomes unusable after the first update.
4. **Scale.** The lab has 3 nodes, production has 100+: do not watch every result ConfigMap,
   load them on demand per node.
5. **The nav item must disappear when FIO is not installed** — gated on `console.flag/model`.
6. **GPLv3 licence** already in the repo: mind the dependencies (PatternFly MIT, SDK
   Apache-2.0 → fine).
7. **i18n**: the plugin is for an Italian user; providing `locales/en` + `locales/it` from the
   start costs little, adding it later is a rewrite of every string.

## Approach

A **single Go binary** in **a single image**, serving both the plugin's static assets and the
`/api/v1/...` API. One Deployment, one Service, one ConsolePlugin. No separate nginx: TLS comes
from the service serving certificate (`service.beta.openshift.io/serving-cert-secret-name`).

```
Browser (console session, user token)
  ├── K8s API directly (SDK)  → FileIntegrity, FileIntegrityNodeStatus, result ConfigMap
  └── /api/proxy/plugin/.../fio-backend/api/v1/nodes/{node}/file?path=…
        └── console proxy (authorization: UserToken) → Go backend
              └── k8s client built WITH THE USER'S TOKEN
                    └── exec into the `aide-<fi>` pod on the node, `daemon` container
```

The backend **holds no credentials of its own** for the exec: it uses the bearer token it
receives. Anyone without `create pods/exec` in `openshift-file-integrity` gets a 403 from the
API server. No escalation.

## Repository layout

```
package.json                    # consolePlugin section: name/displayName/exposedModules
webpack.config.ts, tsconfig.json, console-extensions.json
locales/{en,it}/plugin__file-integrity-console-plugin.json
src/
  models.ts                     # K8sModel for FileIntegrity, FileIntegrityNodeStatus
  components/
    NodeStatusOverviewPage.tsx  # node-by-node table
    NodeReportPage.tsx          # one node's parsed report
    AideReportTable.tsx         # filterable added/changed/removed table
    FileContentModal.tsx        # retrieve + viewer
    actions/ReinitActions.tsx
  hooks/useFileIntegrities.ts, useNodeStatuses.ts, useResultConfigMap.ts
  lib/aide-parser.ts            # + __tests__/aide-parser.test.ts with 0.16 and 0.18 fixtures
  lib/decode.ts                 # gunzip via DecompressionStream('gzip')
backend/
  cmd/server/main.go            # static assets + API, TLS serving cert
  internal/authz/               # k8s client from the user token, SelfSubjectAccessReview
  internal/nodefile/            # aide pod lookup + exec
  internal/policy/              # path deny list, limits
charts/file-integrity-console-plugin/
Containerfile                   # multi-stage: node build → go build → runtime
```

## Implementation

### 1. Scaffolding (base: `console-plugin-template@release-4.22`)

Start from that template, **not** from 4.19 or earlier: React, the router and PatternFly all
change. In `package.json` → `consolePlugin.name: "file-integrity-console-plugin"`,
`dependencies: {"@console/pluginAPI": ">=4.22.0-0"}`.

`console-extensions.json`:
- `console.flag/model` on `FileIntegrity` → `FILE_INTEGRITY` flag; every other extension is
  `required: ["FILE_INTEGRITY"]` so the menu disappears when FIO is absent.
- `console.navigation/href` under the Compliance/Administration section → `/file-integrity`.
- `console.page/route` for `/file-integrity` and `/file-integrity/:fiName/nodes/:nodeName`.

### 2. Node-by-node overview (`NodeStatusOverviewPage.tsx`)

`useK8sWatchResource` on `FileIntegrity` and `FileIntegrityNodeStatus` (namespace
`openshift-file-integrity`). A PF6 table with: node, condition as a coloured badge
(Succeeded/Failed/Errored), files added/changed/removed from `lastResult`, relative
`lastProbeTime`, `errorMsg` when Errored, an indicator for holdoff / re-init in progress.
Filters by condition and search by node. Clicking a row opens the report page.
A header with aggregate counts (n nodes ok / failed / errored / without status).

**Do not** watch ConfigMaps here.

### 3. Parsed AIDE report (`NodeReportPage.tsx` + `lib/aide-parser.ts`)

Fetch the single ConfigMap named by `lastResult.resultConfigMapName` on demand (`k8sGet`, not a
watch). Decoding lives in `lib/decode.ts`: when the `file-integrity.openshift.io/compressed`
annotation is present → `atob` → `DecompressionStream('gzip')` (native in browsers, no
dependency).

`aide-parser.ts` produces:
```ts
type AideReport = {
  summary: { added: number; changed: number; removed: number; totalEntries?: number };
  entries: Array<{
    path: string;
    kind: 'added' | 'changed' | 'removed';
    fileType?: string;
    attrs?: Array<{ name: string; old?: string; new?: string }>; // mtime, ctime, size, md5, sha256…
  }>;
  aideVersion?: string;
  truncated: boolean;     // recognises the "too large for a configMap" message
  raw: string;
};
```
It must handle both grammars (0.16 `CONTENTEX` / 0.18 `CONTENT_EX`), the `Added entries:` /
`Removed entries:` / `Changed entries:` sections and `Detailed information about changes`.
**If parsing fails or the report is truncated → fall back to the raw text in a read-only
`CodeEditor`**, never an empty page. Unit tests with fixtures from both versions (generate them
from the lab, see Verification).

`AideReportTable.tsx`: a table filterable by kind and by path, with expandable columns showing
the old→new attribute diff. The ConfigMap's summary annotations
(`files-added`/`-changed`/`-removed`) act as a cross-check against what was parsed: when they
disagree, show an inline warning (it signals an incomplete parse).

### 4. Remediation actions (`actions/ReinitActions.tsx`)

Patch the `FileIntegrity` CR through `k8sPatch`:
- **Re-init the baseline on one node** → add the node to the list in
  `metadata.annotations["file-integrity.openshift.io/re-init"]`.
- **Re-init every failing node** → `file-integrity.openshift.io/re-init-on-failed: ""`.
- **Cluster-wide re-init** → `file-integrity.openshift.io/re-init: ""`.

All of them behind a confirmation modal that says explicitly that **the baseline is rebuilt and
the currently reported changes stop being reported**. Holdoff stays read-only.

### 5. Go backend — file retrieve

`GET /api/v1/nodes/{node}/file?path=<abs>&fileIntegrity=<name>`

1. Extract the bearer token from the `Authorization` header (forwarded by the console proxy with
   `authorization: UserToken`). **If it is missing → 401, never fall back to the pod's token.**
2. Build a `rest.Config` whose `BearerToken` is the user's token.
3. `SelfSubjectAccessReview` for `create` on `pods/exec` in `openshift-file-integrity` → a 403
   with a clear message when denied (the real enforcement remains the API server's).
4. `internal/policy`: reject non-absolute paths and `..`, and apply a **deny list**:
   `/etc/kubernetes/static-pod-resources/**`, `**/*.key`, `**/*.pem`, `**/kubeconfig*`,
   `/etc/kubernetes/kubelet.conf`, `**/.ssh/**`. The deny list is configurable through Helm
   values.

   **It matches the path as written, and a symbolic link is not followed by the check but is
   followed by the read.** `head` resolves links, so a link whose own name the list allows returns
   the bytes of whatever it points at — a denied path included — and the audit line names the
   link rather than the file. This is stated because an earlier version of this step claimed the
   opposite; the deny list has never inspected a link.

   That is tolerable only because of what sits above it: reaching this code at all requires
   `create` on `pods/exec` in the operator's namespace, and anyone holding that can exec into the
   pod and read the file directly, without this service. **The deny list is a guard rail against
   reading a secret by accident, not a boundary that contains an attacker** — the API server's
   authorization is the boundary, and it is checked first and with the caller's own token.
   Resolving the link before matching would close the gap and costs one more command in the exec;
   it is deliberately not done yet, and the reason it is written down is so that the next person
   decides it rather than inherits it.
5. Find the pod: a pod in `openshift-file-integrity` labelled
   `file-integrity.openshift.io/pod` with `spec.nodeName == node` (or via the `aide-<fi>`
   DaemonSet's ownerRef), in Running state.
6. Exec into the `daemon` container with a fixed command — **never a string built by the user**:
   `["/usr/bin/head", "-c", "<maxBytes>", "/hostroot"+path]`, separate argv, no shell.
   `maxBytes` defaults to 1 MiB and is configurable.
7. JSON response: `{path, node, size, truncated, contentBase64, sha256, binary: bool}`.
   Detect binary content (NUL bytes) and show a hex dump or a download instead of text.
8. **Audit**: a structured log with the user (from the `TokenReview`), node, path and outcome —
   plus a k8s `Event` on the node's `FileIntegrityNodeStatus`. The log is part of the
   deliverable, not an extra.

`FileContentModal.tsx` calls the endpoint and shows the content in a read-only `CodeEditor` with
metadata and a download button. Distinct messages for 403/404/413.

### 6. Helm chart (`charts/file-integrity-console-plugin/`)

- `Deployment` (1 replica, `restricted-v2` SCC, readOnlyRootFilesystem, no privileges),
  `Service` with the `service.beta.openshift.io/serving-cert-secret-name` annotation,
  `ServiceAccount` **with no permissions on nodes or pods** (needed only for the `TokenReview`:
  a minimal ClusterRole with `authentication.k8s.io/tokenreviews: create`).
- `ConsolePlugin`:
  ```yaml
  backend: { type: Service, service: { name, namespace, port: 9443, basePath: / } }
  proxy:
    - alias: fio-backend
      authorization: UserToken
      endpoint: { type: Service, service: { name, namespace, port: 9443 } }
  i18n: { loadType: Preload }
  ```
- **`post-install`/`post-upgrade` hook**: a Job that patches
  `consoles.operator.openshift.io/cluster` `.spec.plugins` to add the plugin (idempotently),
  with a `pre-delete` hook that removes it. The Job needs a ClusterRole of its own.
  This is where Helm is weaker than OLM — document it in the README alongside the equivalent
  manual command (`oc patch consoles.operator.openshift.io cluster --type=json ...`).
- Values: image, path deny list, maxBytes, and a switch for the retrieve feature
  (`features.fileRetrieve: false` by default → whoever does not want it does not expose the
  endpoint).

### 7. Phase 2 (out of v1, not to be implemented now)

An OLM bundle with `console.openshift.io/plugins: '["file-integrity-console-plugin"]'` on the
CSV (which enables the plugin automatically, addressing the weak point of the Helm hook), and
history/trends from the `file_integrity_operator_*` metrics in Thanos plus Events.

## Verification

Prerequisite: install FIO on the lab and generate real data.

```bash
export OC="oc --server=https://api.ocp-lab.duckdns.org:6443 --token=… --insecure-skip-tls-verify"
# 1. install FIO: Namespace openshift-file-integrity + OperatorGroup + Subscription
#    (channel stable, source redhat-operators) and wait for CSV Succeeded
# 2. create a minimal FileIntegrity CR (e.g. name: example-fileintegrity) with a *concrete*
#    nodeSelector — see below, an empty one never settles
# 3. wait for PhaseActive and the FileIntegrityNodeStatus objects (AIDE init: several minutes)
```

**`spec.nodeSelector` must select something; `{}` is not "all nodes", it is a restart loop.**
Observed on FIO 1.4.0, console 4.16.55, three nodes labelled both `master` and `worker` and
carrying no taint. With `nodeSelector: {}` the operator logs, every thirty seconds and for as long
as you leave it:

```
FileIntegrity needed nodeSelector update
FileIntegrity daemon configuration changed - pods restarted.
```

Thirty-four restarts in ten minutes. A `FileIntegrityNodeStatus` is written when a node's *first*
AIDE scan completes, and no scan ever completes, so the namespace stays empty while the CR reports
`Active` and the daemon pods report `Running` — the failure shows only as pods whose age never
exceeds thirty seconds. `nodeSelector: {node-role.kubernetes.io/worker: ""}` stopped it on the
spot, and all three statuses appeared ninety seconds later.

The trigger is observed; the mechanism is not. The likely reading is that an empty map on the CR
and the absent (`nil`) selector on the DaemonSet compare unequal, so the reconciler finds work to
do on every pass — but that was not read in FIO's source, and it is written here as the inference
it is.

1. **Generate a real failure** — on a node, create a file under a monitored path
   (e.g. `/etc/testfile-fio`) through `oc debug node/control-plane-0`, then wait out the grace
   period. Check `oc get fileintegritynodestatuses -n openshift-file-integrity` → `Failed`.
2. **Parser fixture** — extract the real report and save it as a test fixture:
   `$OC get cm <resultConfigMapName> -n openshift-file-integrity -o jsonpath='{.data.integritylog}'`
   (when annotated `compressed`: `| base64 -d | gunzip`). Establish **which AIDE version**
   produces the report on the cluster and cover the other one with a synthetic fixture.
   `yarn test` must pass on both.
3. **Frontend dev loop** — `yarn start` + `yarn start-console` (the console in a container
   pointed at the lab): check the overview, clicking through to a node, the parsed report,
   the filters and the raw fallback.
4. **Deploy to the lab** — build the image, push it to a registry the cluster can reach,
   `helm install`, then check that the Job enables the plugin
   (`$OC get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}'` contains the
   name) and that the menu entry appears in the console.
5. **Retrieve — happy path**: as cluster-admin, the button on a reported file returns the right
   contents.
6. **Retrieve — negatives, all four mandatory**:
   - a path on the deny list (`/etc/kubernetes/static-pod-resources/...`) → 403 from the backend;
   - a request **without** an Authorization header → 401 (no fallback to the pod's SA);
   - a request with the token of a user **without** `pods/exec` in `openshift-file-integrity`
     (create a test user or SA with only `view`) → 403;
   - a file larger than maxBytes → `truncated: true` in the response, no OOM.
7. **Gating**: uninstall (or simulate the absence of) the `FileIntegrity` CRD → the menu entry
   must disappear rather than error.
8. **Re-init**: press the button on a failed node → check the annotation on the CR, the
   `aide-ini-*` DaemonSet starting, and the return to `Succeeded`.
