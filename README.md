# File Integrity Console Plugin

[![CI](https://github.com/amedeos/file-integrity-console-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/amedeos/file-integrity-console-plugin/actions/workflows/ci.yml)
[![Licence: GPL-3.0-or-later](https://img.shields.io/badge/licence-GPL--3.0--or--later-blue.svg)](LICENSE)

An OpenShift console plugin for the [File Integrity Operator][fio]: a node-by-node
view of AIDE scan results, with the failing files parsed out of the operator's
result ConfigMaps instead of read as raw log text.

Adds a **Compute → File Integrity** entry to the administrator perspective,
visible only on clusters where the `FileIntegrity` CRD exists.

**Installable from OperatorHub** on any OpenShift from **4.16** upwards: it is
published in [`community-operators-prod`][cop] as the community operator *File
Integrity Console Plugin*, one bundle per console generation, and a cluster is
offered only the one built for it. Read [Install from
OperatorHub](#install-from-operatorhub) first — the install form defaults the
plugin to *Disabled*, and installing without changing that leaves the operator
running and no menu entry anywhere.

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

| Console | Branch | Image tag | OperatorHub channel |
|---|---|---|---|
| 4.22 and later | `main` | `latest`, `X.Y.Z` | `stable-4.22` |
| 4.19 – 4.21 | `release-4.19` | `release-4.19`, `X.Y.Z-ocp4.19` | `stable-4.19` |
| 4.16 – 4.18 | `release-4.16` | `release-4.16`, `X.Y.Z-ocp4.16` | `stable-4.16` |

A console outside every range loads none of them rather than loading the wrong
one: each build declares a closed `@console/pluginAPI` range, so the mismatch is
a clean refusal in the console's own plugin list instead of a page that renders
half-way.

The channel is not something an installation has to get right by hand. Each
per-OpenShift community catalogue is built from the bundles whose declared range
covers it, so a 4.19 cluster is offered the 4.19 bundle and no other, and the
channel above is the only one its install form lists.

### File retrieve on 4.16 takes a path of its own

It runs different code there, and **only** there. The API server's WebSocket
exec subprotocol is behind `TranslateStreamCloseWebsocketRequests`, which is
alpha and off in Kubernetes 1.29 and beta and on from 1.30. OpenShift 4.16 is
1.29, so the backend's WebSocket attempt fails at negotiation and every read
falls back to SPDY. 4.17 is 1.30 and 4.19 is 1.32, so from 4.17 upwards the
WebSocket attempt succeeds and the fallback never runs — the same path `main`
takes.

That fallback is where this project's worst defect lived: an earlier version of
it re-ran the command into the buffer of the attempt it was replacing and
returned the file's contents **duplicated**, with a `sha256` of the doubled
bytes — a wrong answer that looks entirely plausible. So the check that counts
on this generation is not whether the dialog opens. It is whether the bytes are
the node's:

```sh
oc debug node/<node> -q -- chroot /host sha256sum <path>
```

and compare with the size and the `SHA-256 of bytes read` the dialog shows.

**Done on 5 August 2026**, on a 4.16.55 cluster running `0.4.0-ocp4.16`
installed from OperatorHub: 23 bytes and `6c05d11f…aaaae9cd` through the
plugin, the same 23 bytes and the same digest on the node. Repeat it after
touching `newExecutor` — a doubled file still looks plausible, and no test or
review catches it.

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
- **File retrieve** — show the current contents of a reported file, read from
  the node itself. On by default, and gated by the browsing user's own
  `pods/exec` rights rather than by this switch. See
  [Security model](#security-model).
- **History** — over 24 hours, 7 days or 30 days: a band showing when a node
  was reporting changes, how many nodes were failing over time, and how many
  baseline re-initialisations happened, separating the ones a person asked for
  from the operator's own. See [History needs the operator's metrics to be
  collected](#history-needs-the-operators-metrics-to-be-collected).

The UI ships English and Italian locales.

### History needs the operator's metrics to be collected

The history panels read the File Integrity Operator's own metrics through the
console's Prometheus proxy. **On a fresh cluster nobody collects them**: the
operator ships a `ServiceMonitor`, but its namespace carries no
`openshift.io/cluster-monitoring` label, so Prometheus does not scrape it. The
plugin says so where the panels would be, rather than drawing an empty chart —
but the remedy belongs to a cluster administrator:

```sh
oc label namespace openshift-file-integrity openshift.io/cluster-monitoring=true
```

The plugin holds no permission anywhere near that label and will not do it for
you. Everything else keeps working without it; only the history is affected.

Two limits worth knowing. **History begins when collection begins** — labelling
the namespace does not recover the past, and choosing a window longer than the
cluster's retention shows what there is and says where the data actually
starts. And **there is no per-file history**: the operator overwrites a node's
result each time and a successful scan leaves nothing behind, so "which files
changed last Tuesday" is not somewhere to be read.

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
- The backend's ServiceAccount has **no rule that reaches any data**. It
  resolves the caller with `SelfSubjectReview` and checks `pods/exec` with
  `SelfSubjectAccessReview`, both of which run as the user. On the Helm path it
  is bound to nothing at all; on the OLM path it may write one object, its own
  `ConsolePlugin`, which is how the plugin registers itself with the console.
- A **deny list** blocks paths that would turn "can exec in the file-integrity
  namespace" into "can read every key on a control-plane node":
  `/etc/kubernetes/static-pod-resources/**`, `**/*.key`, `**/*.pem`,
  `**/.ssh/**`, `**/shadow*` and more — the star matters, because RHCOS keeps
  `/etc/shadow-` beside `/etc/shadow` with the same hashes in it. The full
  built-in list is in
  [`backend/internal/policy/policy.go`](backend/internal/policy/policy.go).
  It is checked *before* the caller is even authenticated, so probing costs
  nothing and is never attributed to a session.
- Reads are capped at `backend.maxFileBytes` (1 MiB by default) and executed as
  a fixed argv (`head -c N -- /hostroot<path>`), never a shell string.
- Every attempt, allowed or denied, is written to the pod log as a structured
  audit record with user, node, path and outcome. See
  [Where the audit trail lives](#where-the-audit-trail-lives).
- The whole feature can be switched off (`backend.features.fileRetrieve`), and
  then the endpoint answers 501 and the backend does not even build a Kubernetes
  client. It is **on by default**, because switching it off takes nothing away
  from anyone: every read already runs as the browsing user, is refused unless
  they hold `pods/exec` in the scan namespace, and is recorded against their
  name. Off means the path does not exist at all — worth choosing where that
  matters, and not the state most installations want.

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
| `X.Y.Z` | the git tag `X.Y.Z` | no — this is what an installation should point at, and the default `IfNotPresent` pull policy is correct for it |
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
under the name *File Integrity Console Plugin*, in the `community-operators`
catalogue every cluster already reads. Nothing has to be added first: no
`CatalogSource`, no registry to mirror, no image reference to supply — the
bundle names the published image itself.

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

**It installs into its own namespace**, `file-integrity-console-plugin`, which
the form pre-selects as *Operator recommended Namespace* and creates. It does
not belong beside the File Integrity Operator: it reads that operator's objects
through the browsing user's token, and which namespace to read them from is a
setting of its own ([`fio-namespace`](#values-worth-knowing)). The bundle offers
only the single-namespace install mode, which is why the form defaults this way
— a global install would put the pod in `openshift-operators`, shared with every
other globally-installed operator, and a plugin built around holding no
namespaced rule has nothing to gain from living there.

Any other namespace works. The plugin reads the one it was installed into and
registers with the console for that one.

**The bundle ships no `ConsolePlugin`.** An init container creates it when the
pod starts, reading its own namespace through the downward API. Two reasons,
and the second is the better one: `operator-sdk bundle validate` rejects the
kind as a bundle manifest in every release up to 1.39.2, which is what the
community pipeline runs — and OLM templates nothing inside a cluster-scoped
manifest, so a shipped `ConsolePlugin` had to name its Service's namespace
literally and an install anywhere else produced a plugin the console could not
reach.

The ServiceAccount is granted **no namespaced rule**, exactly as on the Helm
path, and cluster-wide exactly two: `create` a `ConsolePlugin`, and
`get`/`update`/`patch` the one named after this plugin. That is how it
registers itself and it is all it can do — `resourceNames` narrows every verb
that can be narrowed, and there is no `delete`, `list` or `watch`. Nothing
there reaches data belonging to anyone: every API-server call made for a
browsing user still uses that user's token.

OLM also materialises the empty `permissions` entry as a Role and a
RoleBinding carrying no rules, so unlike a chart install you will see those two
objects sitting there permitting nothing.

The console restarts itself once the plugin is enabled, so the manifest-cache
problem described under [Upgrading to a new build](#upgrading-to-a-new-build)
does not arise on this path.

**Configuring it afterwards** goes through the Subscription, not through Helm
values, which do not exist here. A Subscription can override the container's
environment by name, and every setting the chart exposes is read from the
environment for exactly that reason — so to turn *off* reading files from nodes,
which the bundle ships on exactly as the chart does:

```sh
oc patch subscription file-integrity-console-plugin \
  -n file-integrity-console-plugin --type=merge -p '
spec:
  config:
    env:
      - name: PLUGIN_ENABLE_FILE_RETRIEVE
        value: "false"'
```

The names are the flags in [Values worth knowing](#values-worth-knowing),
upper-cased with hyphens as underscores and a `PLUGIN_` prefix:
`PLUGIN_MAX_FILE_BYTES`, `PLUGIN_FIO_NAMESPACE`, and so on. Switching file
retrieve off withholds nothing from anyone — every read already runs as the
browsing user and is refused unless they hold `pods/exec` in the scan namespace
— so read [Security model](#security-model) before deciding it is a hardening
step; what it does is make the path not exist at all.

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
  --namespace file-integrity-console-plugin --create-namespace \
  --set plugin.image=quay.io/asalvati/file-integrity-console-plugin:0.3.1
```

To switch off reading files from nodes:

```sh
  --set backend.features.fileRetrieve=false
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
| `plugin.consolePlugin.mode` | `manifest` | How the `ConsolePlugin` is created. `manifest`: the chart creates it, and nothing is granted any RBAC. `initContainer`: created at startup from the pod's own namespace, which needs two rules on `consoleplugins`. The bundle uses the latter. |
| `backend.fileIntegrityNamespace` | `openshift-file-integrity` | Where the operator runs its scans. |
| `backend.features.fileRetrieve` | `true` | Reading files from nodes. Set to `false` to make the endpoint answer 501 and skip building a Kubernetes client at all; it grants nothing on its own, since every read runs as the calling user. |
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

### Trying a release the way a user gets it

Two scripts under `hack/lab/`, for the two questions a release has to answer.
Both need `oc` logged in and `podman`. Beyond that, `helm` and `opm` are
downloaded, checksum-verified and cached rather than assumed to be installed —
`helm` because the bundle is rendered from the chart and `opm` because it
builds the catalogue. `operator-sdk` is fetched only under `--validate`, since
its one use here is the check CI already runs on every pull request.

```sh
hack/lab/bundle.sh 0.1.0              # install from OLM, then check the result
hack/lab/bundle.sh 0.1.0 --clean-only # remove an installation and stop
hack/lab/console.sh 0.1.0 4.16 4.19   # a console per generation, ports 9016/9019
hack/lab/all.sh 0.1.0                 # both, in order
```

`bundle.sh` tears down any previous installation, generates the bundle from the
chart, builds a one-bundle catalogue, installs it, and then **checks what it
produced** — the CSV phase, the image and its pull policy, the running image's
digest against the tag's, that no Role or ClusterRole bound to the plugin's
ServiceAccount grants anything, and that `/healthz` answers. Any failed check
fails the run. It refuses to install a bundle whose generation does not match
the cluster's, and it deletes only objects it names: the namespace is shared
with the File Integrity Operator, and a sweep there would take that down too.

`console.sh` answers a different question — whether a generation's build loads
at all — and cannot answer the first, because it bypasses OLM entirely. See
[AGENTS.md](AGENTS.md#test-against-another-generation-without-another-cluster).

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
git tag 0.1.1 && git push origin 0.1.1
```

Quay builds the tag into `quay.io/asalvati/file-integrity-console-plugin:0.1.1`
— but **push one tag at a time and check that it did.** Quay builds one image
at a time, and a tag pushed while the queue is busy can be dropped without any
record of it: the git tag exists, the build history does not mention it, and
nothing says so until something tries to pull the image. Verify before
believing it:

```sh
curl -s https://quay.io/api/v1/repository/asalvati/file-integrity-console-plugin?includeTags=true \
  | python3 -c 'import sys,json; print(sorted(json.load(sys.stdin)["tags"]))'
```

Re-pushing the tag on its own, once the queue is empty, is the whole remedy.

**The tag carries no `v`.** Quay's build trigger names the image after the git
ref verbatim, so `v0.1.1` would produce `:v0.1.1` — while the bundle, the CSV
and this document all say `:0.1.1`. Dropping the prefix makes the version, the
git tag and the image tag one string instead of three that have to be kept in
agreement by hand. A release branch tags the same way: `0.1.1-ocp4.16`.

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

**Update `replaces` in that table before generating.** A channel must have
exactly one head — one bundle that nothing else replaces — and `opm validate`
refuses a catalogue where it does not, so a release into a channel that already
holds a bundle has to name it. That is a fact about what is published in
`community-operators-prod` and cannot be derived from anything here, which is
why it is the one row entry that has to be maintained by hand. A channel still
empty declares nothing: naming a predecessor that was never published leaves a
dangling edge. The build prints what it used, or `— (first in channel)`.

**Tag first.** A bundle names an immutable image, so `X.Y.Z` has to exist and
Quay has to have built it before the bundle is generated for submission.

What the tag pins is the **image**, not the bundle. The bundle is generated
when it is submitted, and is not byte-identical to what checking out the tag
would produce — `createdAt` alone differs on every run, and metadata a chart has
no opinion about, such as the maintainer address, can be corrected after a tag
without reissuing it. The submitted bundle's own provenance is the pull request
in `community-operators-prod`, which is a permanent public record of exactly
what was published. Reissue the tag only when the *image* has to change.

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
