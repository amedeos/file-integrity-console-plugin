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
`@console/pluginAPI: >=4.22.0-0`, so on 4.16/4.18 the plugin is not loaded at all. Lowering that
bound is a one-line change and the worst way to proceed, because three real incompatibilities sit
underneath:

- **PatternFly 6** here, 5 there: `pf-v6-*` markup served against a `pf-v5` stylesheet gives a
  structurally correct, visually broken page.
- **react-router 7** here, v5 there. This is the treacherous one: routes are registered by the
  console and `useParams()` reads *its* router's context. With a different copy of the package
  that context does not exist, `useParams()` returns `{}`, `nodeName` becomes an empty string and
  the page says "node not found" with no error at all — it looks like a logic bug and is a
  packaging one.
- **React 18** here; what the 4.16 console provides still needs checking.

A useful first step regardless of the approach: install on a 4.16/4.18 cluster and check that the
refusal is **clean** — no menu entry, no error in the user's face, console otherwise working.

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
- The lab cluster token is supplied by the user in chat; it is not stored in the repository.
