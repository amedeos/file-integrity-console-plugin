# Status — updated 26 July 2026

The approved plan is in [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md): it holds the
decisions taken, the verified facts about the File Integrity Operator's data model (do **not**
re-derive them) and the verification procedure. Read it before picking the work back up.

## Done

1. **File Integrity Operator installed on the lab cluster** — namespace
   `openshift-file-integrity`, a `FileIntegrity` CR created, `FileIntegrityNodeStatus` objects
   present.
2. **Console plugin scaffolding** from `console-plugin-template@release-4.22` — `package.json`,
   `webpack.config.ts`, `tsconfig.json`, `console-extensions.json`, jest, yarn 4.
3. **AIDE parser and decoding** — `src/lib/aide-parser.ts` (0.16 `CONTENTEX` and 0.18
   `CONTENT_EX` grammars, truncation detection), `src/lib/decode.ts` (base64 + gzip through
   `DecompressionStream`). Fixtures in `src/lib/__fixtures__/`, specs next to the sources.
4. **Frontend** — `NodeStatusOverviewPage`, `NodeReportPage`, `AideReportTable`,
   `FileContentModal`, `ReinitActions`, `ConditionLabel`, the `useFileIntegrityData` hooks,
   `models.ts`, `types.ts`. `en` and `it` locales aligned (89 keys).
5. **Go backend** (`backend/`) — `cmd/server/main.go`, `internal/authz` (k8s client from the
   user's token + `SelfSubjectReview`/`SelfSubjectAccessReview`), `internal/nodefile` (finds the
   `aide-*` pod on the node and execs into the `daemon` container), `internal/policy` (path deny
   list, limits) with `policy_test.go`. `go vet`, `go build` and `go test` all pass.
6. **Helm chart** (`charts/file-integrity-console-plugin/`) — rewritten around the single Go
   binary: the `nginx.conf` ConfigMap is gone, a policy ConfigMap carries the deny lists, the
   Deployment passes the binary's flags and has a `/healthz` probe and `readOnlyRootFilesystem`,
   the Service carries `service.beta.openshift.io/serving-cert-secret-name`, the `ConsolePlugin`
   declares `proxy[].alias: fio-backend` with `authorization: UserToken`, the ServiceAccount has
   **no role at all**, a `post-install`/`post-upgrade` Job enables the plugin and a `pre-delete`
   Job removes it.
7. **Multi-stage Containerfile** (node assets → Go build → ubi-minimal runtime, non-root, port
   9443) and **`.containerignore`**.
8. **README** — architecture, security model, install, values table, dev loop.
9. **CI** — `.github/workflows/ci.yml`, see below.

## Deliberate departures from the plan

- **No `tokenreviews: create` ClusterRole** for the backend's ServiceAccount. The plan assumed
  `TokenReview`; the code uses `SelfSubjectReview`, which runs *as the user* and needs no
  privilege at all. The account therefore has no roles, which is tighter than planned.
- **The `ConsolePlugin` always declares the `proxy`**, even with
  `backend.features.fileRetrieve: false`. The real switch is the backend flag, which answers 501
  with a message the modal already renders as "feature disabled"; dropping the proxy would make
  the console answer 404, which the UI can only report as "no scan pod on this node" — the wrong
  reason.
- **An `--extra-deny-list-file` flag was added** to the backend so that values can *add* patterns
  to the deny list without copying the defaults (a copy of the defaults goes stale and ends up
  permitting what a newer default would deny).
- **`features.fileRetrieve` defaults to `true`**, where the plan said `false` — "whoever does not
  want it does not expose the endpoint". Reversed on 26 July 2026 because the premise does not
  hold: the switch grants nobody anything. Every read runs as the browsing user, is refused unless
  they hold `pods/exec` in the scan namespace, obeys the deny list whoever asks, and is recorded
  against their name in the API server's audit log. Off did not withhold a capability, it withheld
  an answer from people already entitled to it — and left a node report that says a file changed
  but cannot show what it now contains, which is the half of the feature an administrator opens
  the page for. `false` remains available and remains meaningful: it makes the path not exist at
  all, which is the right choice on 4.16 until the SPDY fallback has been exercised.
  The *binary's* default stays `false`, and the asymmetry is deliberate — see the comment on the
  flag in `backend/cmd/server/main.go`. It applies only when nothing sets the value, which in
  practice means running outside a cluster, where enabling the feature makes startup reach for
  `rest.InClusterConfig()` and the process exit instead of serving its assets.
- **No k8s `Event` for the audit trail** (plan item 5.8): the structured log is all there is.
  Creating the Event with the caller's token fails precisely for the users who matter — someone
  denied `pods/exec` is usually denied `create events` too, and a request with no token has no
  user to act as; creating it with the backend's SA would hand that account the only permission
  it otherwise does not need, and since the deny-list check runs before authentication it would
  open Event creation to anonymous callers. Verified on the lab that the authoritative record
  already exists: the kube-apiserver audit log records the `pods/exec` with the user, the pod,
  the **full command (hence the path)** and the RBAC decision. Events on this cluster have
  `event-ttl: 3h`, so they would be a poor audit store anyway. The README documents both sources
  and the command to extract the first.

## Verified on the lab (25 July 2026)

The image was built **in-cluster** with `oc new-build --binary --strategy=docker` plus
`dockerfilePath: Containerfile`, because the development environment has no podman. The
cluster's internal registry was `Removed`: re-enabled with `managementState: Managed` and
`emptyDir` storage (a reversible patch, images do not persist — fine for a lab). After that
patch the `openshift-controller-manager` pods need a restart, otherwise builds fail with
`InvalidOutputReference` because the controller still has "registry not configured" cached.

- Containerfile: all three stages build, the image is 146 MB, the push succeeds.
- `helm install` and the patch Job: the plugin is added to `consoles.operator/cluster`
  **preserving** the ones already there (`monitoring-plugin`, `odf-console`, …).
- The console registers the plugin and mounts the proxy route
  `/api/proxy/plugin/file-integrity-console-plugin/fio-backend/`, which is exactly the URL the
  frontend builds from `BACKEND_BASE_URL`.
- Static assets served over TLS by the Go binary, `plugin-manifest.json` with
  `cache-control: no-cache`, `en` and `it` locales reachable, `/healthz` 200.
- Retrieve, all eight cases exercised against the Service: happy path 200 with real node
  content; **401** without `Authorization`; **403** on the deny list; **403** for an SA with only
  `view` (no `pods/exec`); **403** on `..`; **404** for a missing file; **404** for a node with
  no scan pod; a 50 MB file → `size: 1048576`, `truncated: true`, `binary: true`, no OOM.
- Audit records present for every attempt, with the right user (`admin` and
  `system:serviceaccount:…:fio-viewer`) and outcome.

Two bugs the cluster found, both fixed:

- `--max-file-bytes` rendered as `1.048576e+06` (Helm parses YAML numbers as float64) and the
  binary rejected the flag → `| int64` in the template.
- the executor's fallback predicate returned `true` for **any** error, so the command was re-run
  over SPDY and its output appended to the same buffer → now uses
  `httpstream.IsUpgradeFailure`/`IsHTTPSProxyError`, the same conditions as kubectl.

  This was first written up as "the stderr appeared twice", which understated it. When the
  WebSocket attempt failed *after* streaming its output, a **successful** read returned 200 with
  the file's contents **duplicated**, and a `sha256` computed over the doubled bytes. Confirmed
  on 25 July by comparing a read taken before the fix against the file on the node: the node's
  `/etc/fio-demo-changed.conf` is 32 bytes with an mtime predating both reads, the pre-fix
  response was 64 bytes, and the two `sha256` values match the real and the doubled content
  exactly. Nothing had changed on the node — the endpoint was misreporting it.

  For a file integrity tool this is the worst class of defect there is: it showed content that
  had never been on disk and certified it with a hash. It also passes silently, because a
  doubled file still looks plausible. Worth remembering when touching `newExecutor` in
  `backend/internal/nodefile`: a fallback that re-runs a command must not share the output
  buffer with the attempt it is replacing.

## CI and code quality (25 July 2026)

- `yarn lint` **had never run**: the config imported `eslint-plugin-playwright`, which is not a
  dependency here. Removed along with the block covering `integration-tests/`, which does not
  exist in this repository. Underneath were 143 violations; now **zero**.
- `.prettierrc.yml` said `printWidth: 100` while the code is written at 80: aligned to 80, since
  otherwise every `--fix` reformats the whole repository.
- Substantive fixes surfaced by the linter: `errorMessage()` in `src/lib/errors.ts` replacing
  five `(e as Error)?.message ?? String(e)` (which rendered `[object Object]`); real narrowing of
  the JSON error body in `backend.ts`; four state resets moved from `useEffect` to render phase,
  which also removes a frame showing the previous node's data.
- Two configuration choices rather than code changes, documented next to the rules in
  `eslint.config.mjs`: numbers allowed in template literals, and `no-non-null-assertion` off in
  `.spec` files only.
- `.github/workflows/ci.yml`: frontend (lint without `--fix`, tsc, test, build, `en`/`it`
  alignment), backend (vet, test, build), chart (`helm lint` plus `helm template` with assertions
  on the **defaults**, the case that produced `1.048576e+06`, and an assertion that the backend's
  SA still has no roles), image (`podman build` plus a smoke test of the binary). Every check was
  run by hand here except the image job: no podman in this environment.

## Compatibility with older consoles — decided, not yet done

Stated goal: also try OCP **4.16 and 4.18**. Chosen approach: **one branch per console
generation** (as `odf-console` and `netobserv` do), `main` on 4.22 and a `release-4.x` built
against that generation's SDK. **To be tackled after** 4.22 is finished.

Why trying it and seeing is not enough: the manifest declares
`@console/pluginAPI: >=4.22.0-0`, so an older console does not load the plugin at all. Lowering
that bound is a one-line change and the worst way to proceed.

### Observed on a real 4.16 console, 25 July 2026

Run without a second cluster: `quay.io/openshift/origin-console:4.16` locally, pointed at the
published plugin image and at the 4.22 lab's API, with `BRIDGE_RELEASE_VERSION` supplying the
version the gate compares against. The recipe is in `AGENTS.md`.

**Declaring 4.16.55 — the gate refuses, cleanly.** Browser console:

```
Failed to resolve dependencies of plugin file-integrity-console-plugin
Unmet dependency on Console plugin API:
@console/pluginAPI: required >=4.22.0-0, current 4.16.55
```

No menu entry, nothing else affected. Note the message is written by the plugin loader in the
**browser**, not by bridge: it does not appear in the console pod's log.

**Declaring 4.22.5 to the same 4.16 console — it tries to load, and fails outright:**

```
ReferenceError: __load_plugin_entry__ is not defined
Failed to load scripts of plugin file-integrity-console-plugin
  ... loaded without entry callback
```

The entry-registration contract changed at 4.22: the SDK changelog deprecates `loadPluginEntry`
in favour of `__load_plugin_entry__` and says runtime support for plugins built for 4.21 or
older will be removed later. A 4.16 console defines only the old one.

**This corrects an earlier claim in these documents**, which said that widening the bound would
give a page rendering unstyled with empty route parameters. It does not: the plugin never
executes, so nothing renders at all. The PatternFly and react-router mismatches below remain
real, but they are *predictions* about a build that registers successfully — that is, about the
release branch — and are not what happens today.

### Still to establish, and only observable with a real old build

- **PatternFly 6 here, 5 there.** The plugin ships no CSS of its own, so every class name it
  emits resolves against the console's stylesheet. Additionally, on 4.16–4.18 PatternFly is a
  module the console *shares* with plugins, so the components that render may come from the
  console's build rather than the lockfile's.
- **react-router 7 here, v5 there.** Routes are registered by the console and `useParams()` reads
  *its* router's context; with a different copy of the package that context does not exist,
  `useParams()` returns `{}` and the page says "node not found" with no error at all.
- **React 18 here, 17 there.**

The mandatory consequence of the entry-callback finding: the release branch **must** be built
with the older `ConsoleRemotePlugin` (SDK webpack plugin 1.1.0), which emits the registration
call older consoles implement. It was already planned as a dependency pin; it is not optional.

## To do

10. **Browser verification of the UI** — partly done: the raw-report toggle was confirmed
    working. Still open: the overview, the filters, the file content modal, re-init, and the
    gating when the `FileIntegrity` CRD is absent (which cannot be exercised on this lab without
    uninstalling the operator).

    A trap found in the field: the console reads a plugin's manifest **once and caches it**.
    After a new build, `oc rollout restart deployment/console -n openshift-console` is required,
    otherwise the browser keeps loading the old bundle no matter how hard it is reloaded.
    Documented in the README.
11. **Publishing to `quay.io/asalvati`** — decided on 25 July 2026: **linux/amd64 only**, and the
    build is done by **Quay** through an automatic rule on the GitHub repository, not a release
    workflow. The Containerfile therefore stays free of `TARGETARCH`. To configure in the Quay
    trigger: path `/Containerfile` (the wizard looks for a `Dockerfile`, which deliberately does
    not exist here) and context `/`. Multi-arch, if it is ever needed, is cheap: the assets are
    JavaScript and the binary is `CGO_ENABLED=0`, so both build stages stay native with no
    emulation.

    Two tag streams: a push to `main` produces `latest` (mutable — install it with
    `plugin.imagePullPolicy=Always`), a git tag `vX.Y.Z` produces `X.Y.Z` (immutable — what an
    installation should point at). Since the git tag names the image, CI now fails when
    `package.json` `version`, `consolePlugin.version` and the chart's `appVersion` disagree.

    Two traps already verified in the field, both in the README: with a mutable tag such as
    `:latest`, `plugin.imagePullPolicy=Always` is required, otherwise the kubelet reuses the
    cached image and the rollout reports success while running the previous binary; and after
    every new build the console has to be restarted, since it caches the plugin manifest.

## Where to pick up — 25 July 2026, end of day

Everything below is on `main`; no work is uncommitted and no branch holds anything `main` does
not already have.

**Done today, after the 4.22 work:** the console-versioned APIs were routed through
`src/lib/k8s.ts`, `src/lib/router.ts` and `src/lib/styles.ts`; `AGENTS.md` grew the
multi-generation section and the shim invariant; CI grew a `hygiene` job that fails on a NUL byte
in a tracked file; and the gate's behaviour was observed on a real 4.16 console rather than
predicted (see the section above).

**Decided:** three branches, one per console generation, named after the **floor** of the range —
`release-4.16` covers 4.16–4.18, `release-4.19` covers 4.19–4.21, `main` covers 4.22+. The floor
is deliberate: ranges grow upward, so the name stays true as releases are added, and someone on
4.18 who guesses wrong lands on `main` and gets a clean refusal rather than concluding their
version is unsupported. The README needs a table mapping console version to image tag.

**Still standing on the lab cluster**, put there to get here and not yet removed: the internal
registry re-enabled with `emptyDir`, the `file-integrity-console-plugin` BuildConfig and
ImageStream, the `fio-curl` pod and the `fio-viewer` ServiceAccount with its RoleBinding. The
plugin itself now runs from `quay.io/asalvati/file-integrity-console-plugin:latest`, so the
in-cluster build path is no longer needed.

## `release-4.16` — 26 July 2026

The branch exists and is green: `tsc`, `eslint --max-warnings 0`, all 45 tests and a production
`webpack` build all pass against the 4.16 dependency set. Two commits, plus one on `main` that it
depends on.

**The pin that mattered was confirmed, not assumed.** The remote entry that
`ConsoleRemotePlugin` 1.1.0 emits calls `loadPluginEntry`; a 4.22 build emits
`__load_plugin_entry__`, which is what was seen failing on a real 4.16 console. Checked directly
in `dist/plugin-entry.*.min.js` rather than inferred from the version number.

Four things the plan did not have right:

- **`src/lib/k8s.ts` does not change.** SDK 1.2.0 already exports `k8sGet` and `k8sPatch` as
  aliases of the long names, so the shim is byte-identical across branches. One fewer file in the
  delta than expected.
- **PatternFly pins to `~5.2.2`, not `^5.1.1`.** The plugin ships no CSS, so every class it emits
  must exist in the stylesheet the console loaded — `@patternfly/patternfly` 5.2.1 on 4.16 and
  4.17, 5.4.0 on 4.18. A caret range resolves to 5.4 and would emit names the two older consoles
  do not have. The floor of the branch decides the pin, exactly as the floor decides its name.
- **A resolution for `@patternfly/react-core` was needed.** `@patternfly/react-table` asks for
  `^5.2.3`, and yarn answered with a nested 5.4.14 — and *that copy*, not the top-level one, was
  what webpack published as the shared module. Visible only in the build output's
  `provide shared module` line: the plugin was advertising 5.4.14 to a console serving 5.2.
- **`@types/react` and `@types/react-dom` need resolutions too.** `@types/react-router` and
  `@types/react-router-dom` each depend on `@types/react: "*"` and pulled their own copy of 19,
  under which `Link` stops being usable as a JSX element in React 17.

`src/lib/router.ts` now wraps `useParams` rather than re-exporting it: v5 types parameters as
present and v7 as possibly undefined, so a bare re-export makes the same component code correct on
one generation and wrong on the other. The shim narrows both to the weaker type — which is the
kind of difference it exists to hold.

`charts/` gains its **one intentional divergence**: `version` and `appVersion` carry the
generation, `0.1.0-ocp4.16`. They name the build the chart installs, which is per-generation by
definition, and CI requires them to agree with `package.json`.

**Not yet verified, and only a browser can:** that the page actually renders correctly against a
4.16 console. `tsc` and 45 passing tests say nothing about markup that PatternFly 5 lays out
differently, and jsdom measures every element as zero-sized. Once the branch is pushed and Quay
has built the `release-4.16` tag, the two-container recipe in `AGENTS.md` covers it without a
second cluster — with `BRIDGE_RELEASE_VERSION=4.16.55`, which is what makes the version gate
evaluate at all.

**The first thing to check on a 4.16 cluster is the SPDY fallback, not the interface.** 4.16 is
Kubernetes 1.29, before the WebSocket exec subprotocol was on by default, so `NewWebSocketExecutor`
fails at negotiation and *every* file read goes through `NewSPDYExecutor`. On 4.22 the WebSocket
attempt succeeds, so that branch never runs: the only path on the older generation is the one with
no field use behind it — and it is where the duplicated-content defect lived. The fix is
structural and the 4.16 case is the clean one on paper (the upgrade fails before any byte is
streamed), which is exactly what was said the first time. Repeat the byte-count and `sha256`
comparison against the file on the node before trusting it.

Deliberately **not** disabled on the release branch by a change of its own. Forcing it off there
would mean a semantic divergence in
`charts/`, which is how three branches become three products, and it would hide the untested path
instead of testing it. The historical failure mode was silent, and only the byte comparison
catches that — never a default.

### Verified in a browser, on a real 4.16 console

The two-container recipe in `AGENTS.md`, `origin-console:4.16` against the 4.22 lab's data. The
gate accepts the build, the plugin loads and enables, the navigation item appears, the overview and
a node's report render, and the parameters reach the page. Two defects came out of it, both fixed:

- **The feature flag was a race the plugin lost.** `console.flag/model` is evaluated only when API
  discovery completes; a plugin registering afterwards adds its model to the console's map and
  nothing re-reads it — `frontend/public/reducers/features.ts` carries a `TODO(vojtech)` beside
  that code, and 4.22 fixed it with an `UpdateModelFlags` action. Discovery does not run again
  either: for a caller allowed to watch CRDs it runs once at startup. `src/flags.ts` now sets the
  flag from a `console.flag/hookProvider`, which the console mounts through `useResolvedExtensions`
  whenever the plugin arrives, with `useK8sModel` as a live selector. One mechanism on all three
  generations.
- **The router shim named the wrong package.** 4.16 runs `react-router-dom` 5.3, but
  `app-contents.tsx` builds plugin page routes with `Route`/`Routes` from
  `react-router-dom-v5-compat`, so components are mounted in the v6 context. Both contexts exist —
  `CompatRouter` nested inside the v5 router — so reading the wrong one returns `{}` rather than
  throwing, and every node report claimed the node had been removed, naming it as the empty string.

**Still not seen:** the file-content modal's successful state. Local bridge serves no plugin proxy
unless `BRIDGE_PLUGIN_PROXY` is configured, and even with it the backend needs the in-cluster
environment `rest.InClusterConfig()` reads. It closes on a 4.16 cluster, together with the SPDY
path.

## The branch-delta check — 26 July 2026

`AGENTS.md` had said since the strategy was written that CI *should* assert the release branch
delta; now it does. `.github/branch-delta.json` on `main` declares what each branch may differ in,
and the `branch-delta` job fails on anything outside it. Two deliberate consequences: a fix landing
on `main` turns the release branch red until it is merged forward, and a release branch with no
entry is refused rather than waved through. A nightly sweep covers the case nobody touches the
branch for weeks, which is the only way that drift would ever be noticed.

Pushes to release branches now trigger CI at all, which they did not — merging a pull request into
one is a push, and the tip Quay builds from was never checked as a whole.

## `release-4.19` — 26 July 2026

Built, merged as #23, and verified against a real 4.19 console. The middle generation was expected
to be the awkward one — "a subset of neither neighbour" — and it is the cheapest of the three
branches. **Four files** differ from `main`: `package.json`, `yarn.lock`, the chart's two version
fields, and `src/lib/router.ts`. No markup port; `src/lib/k8s.ts` and `src/lib/styles.ts` are
untouched, which is two of the three shims identical.

`src/lib/router.ts` is the same line as `release-4.16` and for the same reason, checked rather than
carried over: 4.19's `app-contents.tsx` imports `Route` and `Routes` from
`react-router-dom-v5-compat`, exactly as 4.16's does.

### What the plan predicted and the build refuted

Three of them, all found by executing rather than by reading versions — which is the pattern by now.

- **"Do not pin webpack."** Wrong, and fatally: the 4.19 SDK plugin depends on `webpack` `^5.75.0`
  and installing over `main`'s lockfile resolved a *second* copy at 5.109.0 beside the workspace's
  5.107.2. The build dies with `runtimeTemplate.optionalChaining is not a function` — the newer
  copy's `ConsumeSharedRuntimeModule` calling a method the older compiler driving the compilation
  does not have. A `resolutions` entry at 5.107.2 keeps one copy and keeps it `main`'s compiler.
  `yarn dedupe webpack` collapses it too, but upwards to 5.109.0, and that drops
  `terser-webpack-plugin` — see below.
- **"From 4.19 PatternFly is no longer a shared module."** It still is, with a fallback allowed;
  the `provide shared module` lines say so. If it stops being shared, it is later than 4.19.
- **"PatternFly at ~6.2.3 across the set."** The console pins the stylesheet at `^6.2.3` but
  `react-core`, `react-icons` and `react-table` at `^6.2.2`, and **6.2.3 does not exist for
  `react-icons`**. The floor is per package, not per generation: `~6.2.2` for the React packages,
  `~6.2.3` for the stylesheet.

The nested-copy trap did recur, identically to `release-4.16`: `react-table` 6.2.3 asks for
`react-core` `^6.2.3` and was given **6.6.0** nested. Closed with `resolutions`; the build now
provides `react-core` 6.2.3, `react-icons` 6.2.2 and `Table` 6.2.3, all inside the 6.2 line. The
build output remains the only place that is visible.

### Checked on the published image, not only the local build

Pulled back out of the registry and unpacked: version `0.1.0-ocp4.19`, `@console/pluginAPI`
`>=4.19.0-0 <4.22.0-0`, `console.flag/hookProvider`, `loadPluginEntry` present and
`__load_plugin_entry__` absent, `react-router-dom-v5-compat` referenced from the entry, both
locales present. The CI style check passes against the 6.2.3 stylesheet: 10 names, 10 present —
which also confirms `pf-v6-u-text-color-subtle`, the replacement for the dead class, exists in 6.2
and not only in 6.4.

### Seen in a browser, on a real 4.19 console

Navigation item on first load, no console errors, overview laid out, node report for
`control-plane-1` with the node name populated. That last one is the router shim: an empty name is
what the wrong context produces, and it is what 4.16 showed before the shim was corrected.

File retrieve errors, as on 4.16 and for the same reason — the two-container harness configures no
`BRIDGE_PLUGIN_PROXY`, so the bridge's own `notFoundHandler` answers and the request never reaches
the backend. Not a finding about the branch.

### A correction this turned up in the README

The README said file retrieve was unverified on "4.16 – 4.18" because those consoles run different
code. Only 4.16 does. The API server's WebSocket exec subprotocol sits behind
`TranslateStreamCloseWebsocketRequests`, alpha and off in Kubernetes 1.29, beta and on from 1.30;
OpenShift 4.16 is 1.29, 4.17 is 1.30, 4.19 is 1.32. So the SPDY fallback — the path with no field
use behind it — runs on 4.16 alone, and 4.17 upwards take the same path as `main`. Narrower, not
closed: nobody has read a file through the plugin on any cluster older than 4.22.

## The OLM bundle — 26 July 2026

The plugin is packaged as an operator bundle, to be published as a **community operator**. It is
standalone for now; folding it into `openshift/file-integrity-operator` upstream stays a later
question.

**No controller was needed.** `ConsolePlugin` is a kind OLM accepts in a bundle — cluster-scoped,
listed in `operator-registry/pkg/lib/bundle/supported_resources.go` — so the CSV carries the
Deployment and the ConsolePlugin and Service ship as manifests beside it. What looked like it
might need a small operator needs none.

**The bundle is generated from the chart**, by `hack/bundle/build-bundle.mjs`. Writing it by hand
would have made a second description of the same Deployment, Service and ConsolePlugin, with
nothing comparing the two — the defect this repository has already built one CI job against. Only
`hack/bundle/csv-base.yaml` is hand-written, and it contains nothing a chart has an opinion about.

The generation is read from `package.json`'s version suffix and mapped, by a table in the
generator, to an OpenShift range and a channel:

| branch | version | `com.redhat.openshift.versions` | channel | `minKubeVersion` |
|---|---|---|---|---|
| `main` | `0.1.0` | `v4.22` | `stable-4.22` | 1.35.0 |
| `release-4.19` | `0.1.0-ocp4.19` | `v4.19-v4.21` | `stable-4.19` | 1.32.0 |
| `release-4.16` | `0.1.0-ocp4.16` | `v4.16-v4.18` | `stable-4.16` | 1.29.0 |

The Kubernetes versions were read from `openshift/kubernetes`'s `go.mod` on each branch, not
recalled. One package, three bundles that never meet: the range annotation decides which per-OCP
catalogue each lands in.

### What the research found, and where

- **A community catalogue is not trusted.** `isCatalogSourceTrusted` in the console's OLM package
  returns true for `redhat-operators` and nothing else, so the install form defaults our plugin to
  *Disabled* and shows a trust warning. Install without touching it and the operator runs with no
  menu entry — the same symptom as the 4.16 flag race, from an entirely different cause. This is
  now the first paragraph of the README's OperatorHub section.
- **`console.openshift.io/plugins` on the CSV** is what makes that control appear at all
  (`operator-hub-subscribe.tsx`, `console-plugin-form-group.tsx`). Without it, nothing registers
  the plugin and nothing says so.
- **The console-patching Job cannot ship.** `Job` is not a supported bundle kind. It is not needed
  either — the install form is what patches `consoles.operator.openshift.io`. The consequence is
  that Helm enables the plugin automatically and OLM does not.
- **The ServiceAccount must not ship.** OLM derives it from the deployment's `serviceAccountName`
  and creates it itself; shipping the chart's copy as well is a duplicate that
  `operator-sdk bundle validate` rejects outright. Dropping it costs nothing and keeps the
  invariant: with no `permissions` in the CSV, the account OLM creates is bound to nothing.

### Three defects the cluster found and no validator could

The bundle passed `operator-sdk bundle validate` — the `operatorframework` suite plus `community`,
`good-practices`, `capabilities` and `categories` — before, between and after each of these. Every
one took installing it from a real catalogue.

1. **The CSV declared only `AllNamespaces`, and the namespace it suggests refused it.**
   `openshift-file-integrity` already carries an OperatorGroup with `targetNamespaces:
   ["openshift-file-integrity"]`, created when the File Integrity Operator was installed — the very
   reason the plugin wants to live there. "The OperatorGroup in the openshift-file-integrity
   Namespace does not support the global installation mode."
2. **Adding the other modes did not fix it.** The console does not pick a workable mode: it reduces
   over the supported ones and prefers `AllNamespaces` whenever it is offered at all, then applies
   the suggested namespace to that choice, rebuilding the impossible pair by default. Only
   *withdrawing* the global mode changes the default. `OwnNamespace` alone is also the honest
   answer — a global install would put the pod in `openshift-operators`, which is not the namespace
   the ConsolePlugin names.
3. **Dropping the ServiceAccount left the pod unschedulable.** `operator-sdk` rejects a
   ServiceAccount in a bundle whose name matches one a deployment runs as, comparing against the
   deployment alone whether or not anything is granted. That reads as "OLM will create it", and OLM
   will not: it creates accounts from `permissions` and nothing else. So the deployment referenced
   an account nobody made — "error looking up service account ... not found" — and the CSV sat in
   `Installing`. The fix is a `permissions` entry with an empty rule list; see the invariant in
   AGENTS.md, which no longer implies the chart and the bundle spell it the same way.

### Seen on a real 4.22 console

Installed from a one-bundle catalogue built with `opm`, against `:latest` rather than a tag, on the
lab cluster:

- **The install form offers the *Console plugin* control and defaults it to Disabled**, with the
  untrusted-catalogue warning. Confirmed by hand, not inferred — it is the claim the README's
  OperatorHub section opens with, and the reason it opens with it.
- The operator installed into `openshift-file-integrity`; CSV `Succeeded`, deployment 2/2, the
  service-serving certificate issued, and `/healthz` answering inside the pod.
- **The invariant survives OLM.** A dedicated ServiceAccount, a Role and a RoleBinding whose rules
  are empty, and no ClusterRole or ClusterRoleBinding anywhere.
- **The console rolled itself.** Its pods were replaced when the plugin was enabled, so the manifest
  cache that makes `oc rollout restart deployment/console` necessary after a `helm upgrade` is not a
  step on this path.
- Navigation entry present and the node reports rendering — the plugin works, installed this way.
- **File retrieve returning a file's contents through the console.** This is the first time that
  path has been seen end to end: it had been exercised only with `curl` against the Service, and
  the modal's successful state had never been rendered by anything — jsdom cannot, and every
  earlier harness answered 404 or 501 before reaching it. Reached through the console proxy, with
  the browsing user's own token, from a bundle installed by OLM.

And a fourth defect, found by using the plugin rather than by installing it: **"View file" answered
"Feature disabled … enable it in the plugin Helm values"**, on a cluster with no Helm values. That
was the visible half. The invisible half was worse — every setting arrived as a command-line flag,
and an OLM install cannot change a container's args: they come from the CSV. So file retrieve was
not merely off, it was **unreachable**, and the same went for the deny lists and the byte limit. The
chart now renders the tunable settings as environment variables, which a Subscription *can* override
(`spec.config.env`, merged by name), and the binary reads each as the default for the matching flag
so nothing that passed flags before has changed.

Still unverified: the other two generations' bundles have been generated and validated but never
installed, there being no 4.16 or 4.19 cluster; and nothing has been submitted anywhere.

### One limit worth knowing before publishing

**The `ConsolePlugin` outlives the operator.** It is cluster-scoped and OLM gives it no
ownerReference, so deleting the CSV leaves it behind — observed. Whoever uninstalls is left with a
plugin name that resolves to nothing, and the console logs a failed load on every page view. The
chart avoids this with a pre-delete Job; a bundle cannot, because `Job` is not a kind OLM accepts.
Uninstalling therefore needs `oc delete consoleplugin file-integrity-console-plugin` by hand, and
the README has to say so.

## The tag carries no `v` — 27 July 2026

`v0.1.0` was cut on `main` and pushed, and Quay immediately queued a build tagged **`v0.1.0`**: the
build trigger names the image after the git ref verbatim and offers no way to edit it. Everything
that references a release says `0.1.0` — the bundle's `containerImage`, the CI check asserting it,
four lines of the README. So the bundle would have named an image that does not exist.

Nothing would have caught it. `operator-sdk bundle validate` does not resolve images, and neither
does the community pipeline; the first symptom would have been a user installing the operator and
watching the pod fail to pull. It was found only because the Quay build API was read to see what
the tag had actually produced — the same habit that found the three install-time defects above.

The fix is the cheap direction: the git tag drops the prefix, so `0.1.0` is at once the version in
`package.json`, the version in `Chart.yaml`, the git tag and the image tag. One string, not two
that differ by one character. `v0.1.0` is deleted from GitHub and from Quay rather than left as a
stray alias for the same commit — two tags naming one release is the ambiguity the rule removes.

## Where to pick up — 27 July 2026

All three generations are merged and in step. The OLM bundle landed on `main` (#27) as a merge
commit, eleven commits, and was merged forward into `release-4.16` (#28) and `release-4.19` (#29).
`main` is contained in both: zero commits ahead of either.

Two predictions in the previous entry were wrong, and both were wrong in the safe direction.
`src/components/FileContentModal.tsx` did **not** conflict on `release-4.16` — the PatternFly 5
markup and the 501 string live far enough apart in the file that git merged them separately. And
the merge-forward needed no manual work at all: both branches came out at their declared deltas,
four files on `release-4.19` and nine on `release-4.16`, with `yarn install --immutable` accepting
the auto-merged lockfile on both.

**The three tags are cut** — `0.1.0` on `main`, `0.1.0-ocp4.19` and `0.1.0-ocp4.16` on the release
branches — and each names an image on Quay with exactly the same string. The first release this
repository has ever made, and what finally makes the README's install command true.

Getting there cost one more silent failure, recorded in `AGENTS.md`: pushing two tags in a single
command produced **one** build. `0.1.0-ocp4.16` never appeared in Quay's build history at all —
not failed, absent — because Quay builds one image at a time here and drops what it cannot queue.
Re-pushing that tag alone against an empty queue built it immediately. Push one tag at a time, and
read the build API rather than believing the push.

## The lab round trip is a script now — 27 July 2026

`hack/lab/` holds what had been a page of `oc` commands run by hand. Two scripts, because there
are two questions and they are not the same one:

- **`bundle.sh <version>`** — tear down, generate from the chart, build a one-bundle catalogue,
  install, and then *check*. The install half is the boring half. The checks are the point: the
  CSV phase, the image and its pull policy, the running image's digest against what Quay says the
  tag is, that nothing bound to the plugin's ServiceAccount grants a rule, that `console.operator`
  lists the plugin, that `/healthz` answers. A failed check fails the run.
- **`console.sh <version> [4.16 4.19]`** — a real console of each generation against that
  generation's published image, one podman network and one host port each.

`console.sh` cannot answer `bundle.sh`'s question: `BRIDGE_PLUGINS` bypasses the ConsolePlugin
resource, the CSV, the Subscription and the catalogue. Nor can it exercise file retrieve — the
proxy alias lives in the ConsolePlugin resource and the backend builds its client from
`rest.InClusterConfig()`. And `bundle.sh` refuses to install a generation the cluster is not,
because crossing the `@console/pluginAPI` bound produces a plugin that never executes rather than
an error anyone would recognise.

Three things the teardown deliberately does not do, all for one reason: the namespace
`openshift-file-integrity` belongs to the File Integrity Operator as much as to the plugin.

- no `oc delete all`, no label selector, no deleting the namespace;
- the OperatorGroup is never created blindly. Two in one namespace make both invalid, and one of
  them would be FIO's;
- a Helm release of the plugin stops the run rather than being removed, because which installation
  is wanted is a decision.

The RBAC check is asked twice on purpose: once of the manifests, by following every RoleBinding and
ClusterRoleBinding that names the ServiceAccount and requiring the roles behind them to be empty,
and once of the API server, with `oc auth can-i` as that account. The manifests are what we
control; the API server is what actually decides.

### What the first scripted install found — 27 July 2026

`hack/lab/bundle.sh 0.1.0` ran end to end on the lab cluster: catalogue READY in 50s, CSV
`Succeeded` in 35s, 13 of 14 checks green on the first attempt. Two of those greens are new
information rather than confirmation:

- **`imagePullPolicy: IfNotPresent`.** Every previous install pointed at `:test`, so the branch the
  generator takes for an immutable reference had never executed on a cluster.
- **The running image's digest equals the tag's.** The check was left strict knowing a manifest
  list would have made it fail wrongly; it does not, so the tag is a single-architecture image and
  the check means what it says.

Getting there cost three defects in the script itself, none of them in the bundle, and each found
only by running it:

1. **`opm` from the OpenShift mirror unpacks as `opm-rhel8`.** The script looked for `opm`.
2. **Pulling an image needs a containers signature policy**, which the build host did not have.
   Everything up to `podman push` worked and everything after it was unreachable. The script now
   carries a throwaway policy of its own — `HOME` redirected for `opm`, which has no flag for it,
   and `--signature-policy` for podman, which cannot be given a different `HOME` without losing
   sight of its own image storage. Prerequisites are all checked in the preflight now.
3. **podman hides `--signature-policy` from `--help`**, so asking the help text whether it is
   supported answered no on a podman that accepts it. The probe invokes podman with the flag and a
   context that does not exist: only an absent flag says `unknown flag`.

Verified from outside the script afterwards, because a script is a poor witness to itself: both
CSVs `Succeeded` — ours and `file-integrity-operator.v1.4.0`, untouched — one OperatorGroup, FIO's
deployment still 1/1.

And `console.operator` read back as
`["monitoring-plugin","networking-console-plugin","odf-console","file-integrity-console-plugin"]`.
That cluster had **three other plugins already enabled**. Both halves of the script handle the list
element-wise — the install appends, the teardown removes its own index — so those three survived
untouched. A merge patch on the whole field would have been shorter to write and would have
switched off monitoring, networking and ODF on somebody else's cluster. Now observed rather than
argued.

And one finding that was not about the script at all — see the RBAC invariant in `AGENTS.md`.
**OLM grants the ServiceAccount one rule regardless of what the bundle declares**: `get`, `update`
and `patch` on its own `OperatorCondition`, restricted by `resourceNames` to that single object.
Our own Role is genuinely empty. The check reported both, because a Role with no rules reads back
through jsonpath as the string `null` — neither empty nor `[]` — so it called our empty Role a
grant too. Both halves are fixed: `null` counts as empty, and OLM's rule is tolerated by shape,
not by its `olm.managed` label, which the Role holding the CSV's own permissions also carries.

The teardown is checked too, and that took a second pass. `--clean-only` originally deleted and
printed "worth confirming by hand" — but the check that matters cannot be done by hand afterwards:
whether the other operators' plugins are *the ones that were there before* needs the list read
**before** the deletion. Confirming it from memory of an earlier run is not verification. The
script now snapshots it, and asserts after the teardown that nothing of the plugin survives, that
the list is unchanged, that FIO's CSV and deployment are untouched and that there is still exactly
one OperatorGroup. Five checks, run in both modes, so the full round trip is nineteen.

**Nineteen of nineteen on the lab cluster, and the plugin visible and working in the console.**
Install, teardown and re-install were each run, in that order, so the round trip is idempotent as
well as correct. This is the first installation of this operator from a release tag rather than a
hand-pushed `:test` image.

### The community submission — 27 July 2026

[PR #10572][sub] submits the 4.22 bundle. The hosted pipeline ran and **failed one task**,
`static-tests`, on one thing:

```
check_osdk_bundle_validate_operator_framework
  Error: Value console.openshift.io/v1, Kind=ConsolePlugin:
         unsupported media type registry+v1 for bundle object
```

**Our CI passes the same validation, and the difference is the `operator-sdk` version.** Bisected
against this bundle: 1.28.1, 1.34.1, 1.36.1, 1.37.0, 1.38.0 and 1.39.2 all reject `ConsolePlugin`;
**1.40.0 and later accept it**, and we pin 1.42.3. So the community pipeline runs something older
than 1.40.0. `operator-registry` lists `ConsolePlugin` in `supportedResources` as cluster-scoped,
and OLM installs the bundle without complaint — which is exactly why nothing on a cluster ever
showed this.

Two things it did *not* complain about, both of which were open questions:

- **The missing `tests/scorecard/`.** Every operator examined ships one and we deliberately did
  not, because three of the four stock tests concern CRDs this operator does not own. Not
  required.
- **The `ConsolePlugin` kind itself, at install time.** Only the validator objects.

There is also a non-blocking warning that new operators should adopt the FBC workflow rather than
`registry+v1` bundles. Worth reading before the 4.19 and 4.16 submissions, since it may change how
the three bundles are kept apart.

The fix is not ours to make: removing the `ConsolePlugin` would remove the product. The ask is for
the pipeline's `operator-sdk` to be updated, or the check waived — the pipeline has an
`apply-test-waivers` task, though the documented route is to ask the maintainers on the PR.

[sub]: https://github.com/redhat-openshift-ecosystem/community-operators-prod/pull/10572

### 0.2.0 — the plugin registers itself — 27 July 2026

Waiting for someone else's pipeline to be upgraded is not a plan, so the bundle stops shipping the
object it cannot ship. **An init container creates the `ConsolePlugin` at startup**, reading its
own namespace through the downward API. `operator-sdk bundle validate` 1.39.2 — the version that
rejected us — now passes.

The second reason is the better one and would have justified the change on its own: OLM templates
nothing inside a cluster-scoped manifest, so a shipped `ConsolePlugin` had to name its Service's
namespace literally, and an install anywhere but `openshift-file-integrity` produced a plugin the
console could not reach. That class of failure is now gone.

**An init container rather than a controller**, and the reason is the failure mode rather than the
feature. The object is written once and never drifts, so reconciliation would buy only recovery
from a manual deletion — at the price of the worse silence: a controller that cannot write it logs
and retries while the pod stays `Running`, the deployment stays `Ready`, and the console shows
nothing. That is a shape this repository has chased three times. `Init:Error` is loud.

It is a subcommand of the same binary, so the image and its supply chain are unchanged.

**The invariant is rewritten, not dropped**, and `AGENTS.md` now states it as *the request-serving
path has no authority of its own*. Namespaced rules: still none, on both paths. Cluster-wide: two,
`create` on `consoleplugins` and `get`/`update`/`patch` on this plugin's own — `resourceNames`
narrows everything it can, and it cannot narrow `create`, because the object has no name yet when
the request is admitted. Neither reaches data belonging to anyone. In `manifest` mode, which is
what a Helm install gets, even those two are absent.

`plugin.consolePlugin.mode` selects between the two, and the object's spec is defined once in
`_helpers.tpl` — rendered either as a manifest or as the body of the ConfigMap the init container
mounts. Two copies of that spec would be the defect the generator exists to prevent.

**Next, in order:**

1. **`hack/lab/bundle.sh 0.2.0`** on the lab cluster, after the tag and the image exist. Then
   install once into a namespace that is *not* `openshift-file-integrity` and confirm the plugin
   still loads — the failure this design removes, and the only way to see that it is gone.
2. **Update PR #10572** to 0.2.0, or open a fresh one. Answer the maintainers with the version
   bisection either way, since their pipeline will keep rejecting the kind for everyone else.
3. **`hack/lab/console.sh 0.2.0 4.16 4.19`** — but note the release branches are *not* being
   merged forward yet, by decision, so those images stay at 0.1.0 until they are.

**Deliberately deferred:** folding the three branches into one image that picks its frontend at
runtime — attractive, and expensive in exactly the place that has already cost this project twice,
so it gets its own change rather than a ride-along here. *Moving the plugin out of
`openshift-file-integrity` was deferred here too, and undeferred a day later — see 0.3.0 below.*

**Still on the lab cluster right now:** the plugin installed from the test catalogue
(`fio-plugin-test` in `openshift-marketplace`), running
`quay.io/asalvati/file-integrity-console-plugin:test`. Tear it down with `oc delete subscription`,
`oc delete csv`, `oc delete consoleplugin file-integrity-console-plugin` — the last one is
cluster-scoped and has no owner reference, so nothing else removes it — and `oc delete
catalogsource fio-plugin-test -n openshift-marketplace`.

### 0.2.0 installed from the catalogue — 28 July 2026

Released and installed: PR #40 merged, tag `0.2.0` on the merge commit, image built (it waited
eight minutes behind the `main` build and neither was dropped — see the note on Quay's queue),
`hack/lab/bundle.sh 0.2.0` run against the lab. **Twenty-two checks, twenty passed**, and the two
that failed were the check being wrong rather than the plugin.

They asserted the ServiceAccount cannot `list` or `watch` consoleplugins. It can, and so can every
authenticated identity on the cluster: the release payload binds `console-extensions-reader` to
`system:authenticated`. Written blind the day before and never executed until now, which is the
whole argument for running these against a cluster rather than reasoning about them. The invariant
is untouched — our ClusterRole holds the two rules it declares and no verb more, read back off the
installed object — and `create` is refused to an unrelated account, which is what gives the check
next to it any content. Recorded in `AGENTS.md`; the script now asks an unrelated account instead.

The plugin registered itself, `console.operator` lists it, `/healthz` answers. **Not yet done: the
install into another namespace**, which is the one thing 0.2.0 exists to make work.

### 0.3.0 — the plugin gets its own namespace — 28 July 2026

Until now the plugin installed into `openshift-file-integrity`, and the CSV argued for it at
length: a shipped `ConsolePlugin` names its Service's namespace literally, OLM fills nothing in
inside a cluster-scoped manifest, so the pod had to land where the manifest said. **0.2.0 removed
that premise and the argument was left standing on top of it.** The suggested namespace is now
`file-integrity-console-plugin`.

It never needed to sit beside the operator. It reads `FileIntegrity` objects through the browsing
user's token, and *where* to read them is a setting of its own — `fio-namespace`, still defaulting
to `openshift-file-integrity`. Those two uses of one name were always distinct in the code; only
the prose confused them.

**Not an `openshift-` name.** That prefix and `kube-` are the cluster's own: a project request
carrying either is refused to anyone who is not cluster-admin. `openshift-file-integrity` belongs
to a Red Hat operator; this is a community one.

`AllNamespaces` was the alternative and would put the pod in `openshift-operators`, shared with
every other globally-installed operator — where a namespaced rule granted to something else, for
its own reasons, is inherited by everything living there. A plugin built around holding no
namespaced rule at all has nothing to gain from that address. `OwnNamespace` stays, for a reason
that is now about isolation rather than about reachability.

Version 0.3.0 and not 0.2.1: where an operator installs by default is not a patch.

**Still to do:** tag and image, then `hack/lab/bundle.sh 0.3.0` — which now installs into the new
namespace by default, so the round trip *is* the verification that the baked-in namespace is gone.
`PLUGIN_NAMESPACE` overrides it for a run somewhere unexpected.

### Closed: every dialog on 4.16 came up without buttons — 30 July 2026

Reported on 27 July from `hack/lab/console.sh 0.1.0 4.16`, the first time that build had been
loaded by a console since it was published: clicking **Re-initialize baseline** opened the
confirmation, which showed its warning and then nothing below. Absent, not disabled. Deferred
deliberately, and closed on 30 July by
`fix/modal-resolves-to-the-preview-api` (#45) — two import lines.

It was never about `ReinitActions`. **Every dialog on the branch was affected**, and the cause is
in our own build, not in the console.

**What the browser said.** The discriminator recorded here in July was *View file* on the same
console, and it showed the same thing: no `Close`. Inspecting the box was what broke it open:

```
pf-v5-c-modal-box pf-m-lg   data-ouia-component-type="PF5/ModalContent"
  DIV.pf-v5-c-modal-box__close
  DL.pf-v5-c-description-list …          ← our children, unwrapped
  DIV.pf-v5-u-mt-md
```

No footer, but also **no header and no `__body`** — our children hang directly off the box. And
the box carried `title="/etc/fio-demo-changed.conf"` and `actions="[object Object]"` as **HTML
attributes**. A component that spells props onto the DOM has not been given those props: it has
swept them up as the rest and spread them. PatternFly 5.2.3's classic `ModalContent` destructures
`title` and `actions` and can never do that. Its **preview** `ModalContent` — `next/components/`,
the shape that became PatternFly 6's API — renders exactly `ModalBox → close button → children`
and spreads the rest onto the box. That is the component, character for character.

**Why the preview one answered.** The console SDK rewrites imports. `ConsoleRemotePlugin` turns a
bare

```ts
import { Modal } from '@patternfly/react-core';
```

into a per-component path, and picks that path in `utils/dynamic-module-parser.js` by globbing
every `dist/dynamic/**/package.json` and, for a name exported by more than one, preferring the
**deepest** path. react-core 5.2.3 ships two that export `Modal`:

```
dist/dynamic/components/Modal        → esm/components/Modal/index.js
dist/dynamic/next/components/Modal   → esm/next/components/Modal/index.js     ← one segment deeper
```

The preview wins on depth. The tie-break's other rule — prefer non-`deprecated` paths — does not
help, because in 5.2.3 the classic Modal is not under `deprecated`.

**Two wrong turns worth keeping.** First: "crun fails before it reads the filesystem, so our tree
cannot matter" — sound about crun, and applied to the wrong question. Second: `Modal` was searched
for in the *console's* shared scope, on the strength of the July finding that console 4.16 shares
PatternFly 4 — 4.278.0, read off the running console and recorded in `AGENTS.md`. That finding is
real and stands; it was simply not this. The
July conclusion that **the plugin renders with its own copy was right all along** — the module
inside that copy was the wrong one.

**What settled it, in order:** the package's own entry (`dist/esm/index.js` re-exports
`./components`, `./layouts`, `./helpers`, `./styles` — never `./next`, so the source is correct);
the published image, pulled straight from Quay's blob API and unpacked, where `ModalHeader`
sits in a chunk of its own beside backdrop, button and modal-box; then a build of the branch in a
worktree, whose chunk was named
`vendors-…_dist_esm_next_components_Modal_index_js-chunk.js`. After the fix that chunk is
`…_dist_esm_components_Modal_index_js-chunk.js`, and in the production bundle the string
`ModalHeader` does not appear anywhere at all.

**The fix** is to import the path the rewriter leaves alone. It rewrites the index import only —
`isIndexImport = moduleSpecifier === dynamicModuleName` — so an explicit path survives:

```ts
import { Modal } from '@patternfly/react-core/dist/dynamic/components/Modal';
```

Both files are already in `release-4.16`'s declared delta, so nothing widened. Disabling dynamic
modules in `webpack.config.ts` would have worked too and was rejected: that file is *not* in the
delta, so a defect affecting one generation would have had to change `.github/branch-delta.json`
on `main`.

**Scope.** Only `Modal`, because `dist/dynamic/next` in 5.2.3 holds nothing else. Only
`release-4.16`, because PatternFly 6.2.3 and 6.4.3 ship no `dist/dynamic/next` at all — checked by
unpacking both, not inferred.

**Nothing could have caught this.** The rewrite happens at build time, so the source reads
correctly and review sees nothing; the branch's CI compiles the same source that produced the
broken bundle; and jsdom measures every element as zero-sized, so no unit test can assert that a
button is there to click. Verified the only way it can be — in a browser, on a 4.16 console, with
`PLUGIN_IMAGE` pointing at the branch's Quay build.

**Left over:** on a real 4.16 cluster, the SPDY exec fallback — read a file through the plugin, read
it on the node, compare byte count and `sha256` before looking at the interface. The lab leftovers
are gone: the internal registry's BuildConfig, ImageStream, builds, the `fio-curl` pod and the
`fio-viewer` account were all removed on 26 July. The cluster's image registry itself is still
`Managed` on `emptyDir`, deliberately untouched — 60 ImageStreams belonging to other work now
depend on it, so turning it off is no longer a cleanup.

### The release branches are level with `main` again — 30 July 2026

Both had been left behind deliberately while the community submission was prepared, so both sat 19
commits back and red on `branch-delta`. Merged forward in #43 and #44 — merge commits, and `main`
is an ancestor of both tips again: `git merge-base --is-ancestor main release-4.16` succeeds, and
so does its 4.19 twin. That is the property squashing a merge-forward destroys.

The delta is back to what it should be. Nothing outside `src/` differs any more except the
dependency pins and the chart's version:

| | files differing from `main` | outside `src/` |
|---|---|---|
| `release-4.19` | 4 | `Chart.yaml`, `package.json`, `yarn.lock` |
| `release-4.16` | 9 | the same three |

Only the version conflicted, in `Chart.yaml` and `package.json`, and it was resolved in the
branch's favour — no merge-forward has ever moved it, it is written once when the branch is cut.
`main` had changed nothing else in either file, so `--ours` discarded nothing.

**What that leaves open:** both branches now carry 0.3.x code under a version that says
`0.1.0-ocp4.x`, and the image that version names on Quay is the July build — the one that still
ships a `ConsolePlugin` manifest and installs beside the operator. Coherent for CI, which derives
everything from the branch's own `package.json`, but **not submittable**. Cutting `0.3.1-ocp4.16`
and `0.3.1-ocp4.19` is a release of its own, and it also restores `hack/lab/console.sh 0.3.1 4.16`
as the ordinary way to look at a branch.

### `Container image` is a lottery on GitHub's runners — 30 July 2026

Five of ten runs on 30 July failed, always the same job, always in the first `RUN` of the first
stage, in 13–17 seconds:

```
error running container: from /usr/bin/crun creating container for
  [/bin/sh -c node .yarn/releases/yarn-4.14.1.cjs install --immutable]:
  unknown version specified
```

crun rejecting the `ociVersion` podman wrote — podman newer than the crun beside it. The build
context is irrelevant: nothing has been copied yet that could matter, and the same command in the
same stage on the same base image succeeds elsewhere.

It looks like the tree and is not. The clinching pair: `release-4.19`'s merge commit **passed** on
its pull request and **failed** on the branch tip minutes later, and a fast-forward changes nothing
about what is built. What differs is in `Set up job`:

| | runner image | |
|---|---|---|
| failing | `ubuntu-24.04` **20260726.254.1** | |
| passing | `ubuntu-24.04` **20260720.247.2** | |

A pool mid-rollout, and which machine answers is a draw. Two things follow, both learned by getting
them wrong first:

- **`runs-on: ubuntu-24.04` fixes nothing.** The failing machines already are `ubuntu-24.04`;
  GitHub offers no way to pin the image *build*. This was proposed here and would have cost a pull
  request on `main` and two merge-forwards to change nothing.
- **Three failures in a row do not prove the tree.** They did not: a fourth attempt on the same
  commit went green. Distinguishing "always" from "often" needs the runner image, which is one line
  in the log and settles it immediately.

Left alone deliberately. Every candidate fix — installing a current crun, `--runtime runc`,
`docker build` — is permanent work against a fault that is almost certainly temporary, and the
last of them would stop the job doing the one thing it exists for, which is to check that *podman*
digests the `Containerfile`. Re-run until it lands on an older image; revisit if it is still like
this in a few days.

## Environment notes

- The Go toolchain is **not preinstalled** and `/tmp` is a 1 GB tmpfs, too small for the module
  cache. Install Go under `/var/tmp` (46 GB) and export:
  ```sh
  export PATH=/var/tmp/go/bin:$PATH GOPATH=/var/tmp/gopath \
         GOMODCACHE=/var/tmp/gomod GOCACHE=/var/tmp/gocache
  ```
  `/var/tmp` is a tmpfs: it empties when the container restarts, so this has to be redone every
  time. The same goes for `helm`, also absent (`oc` and `kubectl` are present).
- Building the OLM bundle needs `helm` and, to check it, `operator-sdk`; neither is preinstalled
  and both are single binaries. `hack/lab/tools.sh` now fetches and checksums them — set
  `FIO_TOOLS_DIR=/var/tmp/fio-tools` so they survive somewhere with room. By hand:
  ```sh
  curl -sfL https://get.helm.sh/helm-v3.16.4-linux-amd64.tar.gz | tar xz -C /var/tmp \
    --strip-components=1 linux-amd64/helm
  curl -sfL -o /var/tmp/operator-sdk \
    https://github.com/operator-framework/operator-sdk/releases/download/v1.42.3/operator-sdk_linux_amd64
  chmod +x /var/tmp/operator-sdk && export PATH=/var/tmp:$PATH
  ```
  The `multiarch` validator additionally wants to pull the image and will warn that it cannot;
  there is no container runtime here.
- **`opm` from `mirror.openshift.com` unpacks as `opm-rhel8`, not `opm`.** The OpenShift build
  names the binary after the base it was built on. `hack/lab/tools.sh` finds it rather than
  assuming the name; a script that assumed it looked for a file that was never there.
  Its version need not match the cluster's — the binary writes the catalogue and never reaches
  the cluster, which talks gRPC to the catalogue image, whose server comes from
  `quay.io/operator-framework/opm:latest`. Point `OPM` at another binary if a lab ever needs one.
- `yarn` is not on the PATH: use the committed binary,
  `node .yarn/releases/yarn-4.14.1.cjs <cmd>`.
- `/home/agent` is a 1 GB tmpfs and the yarn cache lives under it, so an install eventually fails
  with `ENOSPC` while copying into `~/.yarn/berry/cache`. Relocate it with environment variables
  rather than editing `.yarnrc.yml`, which is committed:
  ```sh
  export YARN_GLOBAL_FOLDER=/var/tmp/yarn YARN_CACHE_FOLDER=/var/tmp/yarn/cache TMPDIR=/var/tmp
  ```
- The lab cluster token is supplied by the user in chat; it is not stored in the repository.
