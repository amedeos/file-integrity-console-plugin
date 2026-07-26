# Status — updated 25 July 2026

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

Deliberately **not** disabled on the release branch. It is already off by default in the chart and
in the binary, so nobody inherits it; forcing it off further would mean a semantic divergence in
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

## Where to pick up — 26 July 2026

Everything is on `origin`; no branch holds anything unpushed. `main` is at #19, `release-4.16` at
#20 and contains `main`.

**Next is `release-4.19`, and the plan is already researched.** The middle generation was expected
to be the awkward one; it is the cheapest. Checked against the published packages and the console
source, not inferred:

- consoles 4.19, 4.20 and 4.21 all load `@patternfly/patternfly` ^6.2.3, run React 17, and mount
  plugin routes through `react-router-dom-v5-compat` exactly as 4.16 does;
- the 4.19 webpack plugin still emits `loadPluginEntry`, so the SDK pin is load-bearing here too;
- the 4.19 SDK exports `k8sGet`/`k8sPatch` and supports `console.flag/hookProvider`;
- **every PatternFly API the components use exists in 6.2.3 with the same shape**, so there is no
  markup port. The delta is six paths, already declared in `.github/branch-delta.json`: the
  dependency pins, the lockfile, the chart's two version fields, and the three shims — of which
  only `src/lib/router.ts` actually changes.

Concretely: push `release-4.19` as a pointer at `main` (that is the branch creation, nothing to
review), then one pull request into it with the pins — SDK `4.19-latest`, PatternFly `~6.2.3`
including `@patternfly/patternfly`, React 17 with the `@types/react` resolutions,
`react-router-dom-v5-compat`, `react-i18next` ^11.12.0, `@testing-library/react` ^12.1.5,
`@console/pluginAPI` `>=4.19.0-0 <4.22.0-0`, version `0.1.0-ocp4.19`. **Do not pin webpack**: the
4.19 plugin depends on `^5.75.0`, which `main`'s `^5.107.2` already satisfies, so the exact pin
that `release-4.16` needs has no reason to exist here.

Verify in the browser with `origin-console:4.19` and `BRIDGE_RELEASE_VERSION=4.19.38` — the current
stable-4.19 z-stream, looked up rather than invented.

**Then the small debts:** `terser-webpack-plugin` is used by `webpack.config.ts` but resolved only
transitively; and the lab cluster still has the internal registry on `emptyDir`, the BuildConfig,
the ImageStream, the `fio-curl` pod and the `fio-viewer` ServiceAccount, none of them needed now
that the image comes from Quay.

## Environment notes

- The Go toolchain is **not preinstalled** and `/tmp` is a 1 GB tmpfs, too small for the module
  cache. Install Go under `/var/tmp` (46 GB) and export:
  ```sh
  export PATH=/var/tmp/go/bin:$PATH GOPATH=/var/tmp/gopath \
         GOMODCACHE=/var/tmp/gomod GOCACHE=/var/tmp/gocache
  ```
  `/var/tmp` is a tmpfs: it empties when the container restarts, so this has to be redone every
  time. The same goes for `helm`, also absent (`oc` and `kubectl` are present).
- `yarn` is not on the PATH: use the committed binary,
  `node .yarn/releases/yarn-4.14.1.cjs <cmd>`.
- `/home/agent` is a 1 GB tmpfs and the yarn cache lives under it, so an install eventually fails
  with `ENOSPC` while copying into `~/.yarn/berry/cache`. Relocate it with environment variables
  rather than editing `.yarnrc.yml`, which is committed:
  ```sh
  export YARN_GLOBAL_FOLDER=/var/tmp/yarn YARN_CACHE_FOLDER=/var/tmp/yarn/cache TMPDIR=/var/tmp
  ```
- The lab cluster token is supplied by the user in chat; it is not stored in the repository.
